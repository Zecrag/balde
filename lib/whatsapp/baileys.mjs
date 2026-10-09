/**
 * @file lib/whatsapp/baileys.mjs — Conector WhatsApp direto via QR (Baileys)
 *
 * Modo: SOMENTE LEITURA.
 * Nunca envia mensagem, nunca marca como lida, nunca vai online.
 *
 * API pública:
 *   iniciarBaileys({ pastaSessao, aoQR, aoConectar, aoMensagem, gruposPermitidos })
 *   → { listarGrupos, desconectar, estado }
 *
 * Dependências (em balde/conectores/baileys/node_modules):
 *   @whiskeysockets/baileys  — cliente WhatsApp não oficial
 *   qrcode                   — geração de PNG data-URL do QR code
 *
 * O módulo usa import() dinâmico para carregar as deps do conector sem
 * poluir o balde principal (que não tem node_modules).
 *
 * @see balde/conectores/baileys/LEIA.md
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Caminho para as dependências do conector
const CONECTOR_DIR = path.resolve(__dirname, '../../conectores/baileys');
const CONECTOR_MODULES = path.join(CONECTOR_DIR, 'node_modules');

/**
 * Carrega um pacote do diretório de deps do conector (não do balde principal).
 * @param {string} nome — nome do pacote
 */
async function importarDep(nome) {
  const require = createRequire(path.join(CONECTOR_MODULES, 'dummy.js'));
  try {
    // Tenta via require para resolver o caminho correto
    const pkgPath = require.resolve(nome);
    return await import(pkgPath);
  } catch {
    // Fallback: import direto (funciona se já estiver no NODE_PATH)
    return await import(nome);
  }
}

/**
 * Injeta as dependências do conector no caminho de busca do Node se ainda
 * não estiver lá. Necessário porque o balde principal não tem node_modules.
 */
function garantirModulesNoPath() {
  if (!fs.existsSync(CONECTOR_MODULES)) {
    throw new Error(
      `Dependências do conector Baileys não instaladas.\n` +
      `Execute: cd ${CONECTOR_DIR} && npm install`
    );
  }
}

/**
 * Carrega Baileys e qrcode dinamicamente do diretório do conector.
 * Retorna { makeWASocket, useMultiFileAuthState, DisconnectReason,
 *           downloadMediaMessage, fetchLatestBaileysVersion, jidNormalizedUser,
 *           QRCode }
 */
async function carregarDeps() {
  garantirModulesNoPath();

  const require = createRequire(path.join(CONECTOR_MODULES, '_dummy_'));

  // Resolve caminhos absolutos para as deps
  const baileysPkg = require.resolve('@whiskeysockets/baileys');
  const qrPkg = require.resolve('qrcode');

  const [baileys, qrcodeLib] = await Promise.all([
    import(baileysPkg),
    import(qrPkg),
  ]);

  return {
    makeWASocket:              baileys.default?.makeWASocket       ?? baileys.makeWASocket,
    useMultiFileAuthState:     baileys.useMultiFileAuthState,
    DisconnectReason:          baileys.DisconnectReason,
    downloadMediaMessage:      baileys.downloadMediaMessage,
    fetchLatestBaileysVersion: baileys.fetchLatestBaileysVersion,
    jidNormalizedUser:         baileys.jidNormalizedUser            ?? ((j) => j),
    isJidGroup:                baileys.isJidGroup                   ?? ((j) => j?.endsWith('@g.us')),
    proto:                     baileys.proto,
    QRCode: qrcodeLib.default ?? qrcodeLib,
  };
}

/* ─── Tipos JSDoc ─────────────────────────────────────────────────────────── */

/**
 * @typedef {Object} OpcoesBaileys
 * @property {string}   pastaSessao     — Diretório para persistir sessão (ex.: dados/whatsapp-sessao)
 * @property {Function} aoQR            — Chamado com (qrString: string, qrPngDataUrl: string)
 * @property {Function} aoConectar      — Chamado com (info: { telefone, nome, pushName })
 * @property {Function} aoMensagem      — Chamado com o payload no formato Baileys JSON (já filtrado)
 * @property {Function} [gruposPermitidos] — Retorna array de JIDs permitidos; null/[] = todos
 */

/**
 * @typedef {Object} HandleBaileys
 * @property {Function} listarGrupos   — async () → [{jid, nome, participantes}]
 * @property {Function} desconectar    — () → void
 * @property {Function} estado         — () → 'aguardando-qr'|'conectado'|'desconectado'|'reconectando'
 */

/* ─── Implementação principal ─────────────────────────────────────────────── */

/**
 * Inicia o conector WhatsApp via Baileys (modo leitura).
 *
 * @param {OpcoesBaileys} opcoes
 * @returns {Promise<HandleBaileys>}
 */
export async function iniciarBaileys(opcoes, _deps) {
  const {
    pastaSessao,
    aoQR,
    aoConectar,
    aoMensagem,
    gruposPermitidos = null,
  } = opcoes;

  // Suporte a injeção de deps para testes (sem rede)
  const deps = _deps ?? (await carregarDeps());

  const {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    downloadMediaMessage,
    fetchLatestBaileysVersion,
    isJidGroup,
    QRCode,
  } = deps;

  // Garante que o diretório da sessão existe
  fs.mkdirSync(pastaSessao, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(pastaSessao);

  // Versão mais recente compatível
  let version;
  try {
    const resultado = await fetchLatestBaileysVersion();
    version = resultado.version;
  } catch {
    version = [2, 3000, 1023509563]; // fallback conhecido
  }

  let _estado = 'aguardando-qr';
  let _socket = null;
  let _grupos = new Map(); // jid → { jid, nome, participantes[] }

  /**
   * Verifica se um jid de grupo é permitido.
   * @param {string} jid
   * @returns {boolean}
   */
  function grupoPermitido(jid) {
    if (typeof gruposPermitidos === 'function') {
      const lista = gruposPermitidos();
      if (!lista || lista.length === 0) return true;
      return lista.includes(jid);
    }
    if (Array.isArray(gruposPermitidos)) {
      if (gruposPermitidos.length === 0) return true;
      return gruposPermitidos.includes(jid);
    }
    return true; // null/undefined → todos permitidos
  }

  /**
   * Monta o payload no formato Baileys JSON que normalizar.mjs aceita.
   * Campos adicionais: chatName, groupInfo (para o normalizador popular chatNome).
   */
  function montarPayloadBaileys(rawMsg, grupoInfo) {
    const payload = {
      key:              rawMsg.key,
      messageTimestamp: rawMsg.messageTimestamp,
      pushName:         rawMsg.pushName,
      message:          rawMsg.message,
      isGroup:          true,
      chatName:         grupoInfo?.nome ?? rawMsg.key?.remoteJid,
    };

    if (grupoInfo) {
      payload.groupInfo = {
        subject:      grupoInfo.nome,
        participants: grupoInfo.participantes,
      };
    }

    return payload;
  }

  /**
   * Tenta baixar e descriptografar mídia de uma mensagem Baileys.
   * Retorna Buffer ou null em caso de erro.
   */
  async function baixarMidia(msg, tipoMidia) {
    try {
      const buf = await downloadMediaMessage(
        msg,
        'buffer',
        {},
        { logger: { info: () => {}, error: () => {} }, reuploadRequest: _socket?.updateMediaMessage }
      );
      return buf;
    } catch (err) {
      console.warn(`[Baileys] Falha ao baixar mídia (${tipoMidia}):`, err.message);
      return null;
    }
  }

  /**
   * Enriquece o payload com mídia descriptografada (base64) se houver.
   * Modifica o objeto in-place.
   */
  async function enriquecerMidia(payload, rawMsg) {
    const msg = rawMsg.message || {};
    let tipoMidia = null;
    let chaveMsg = null;

    if (msg.audioMessage)    { tipoMidia = 'audio';    chaveMsg = 'audioMessage';    }
    else if (msg.imageMessage)    { tipoMidia = 'imagem';   chaveMsg = 'imageMessage';    }
    else if (msg.documentMessage) { tipoMidia = 'documento';chaveMsg = 'documentMessage'; }
    else if (msg.videoMessage)    { tipoMidia = 'video';    chaveMsg = 'videoMessage';    }

    if (!tipoMidia) return;

    const buf = await baixarMidia(rawMsg, tipoMidia);
    if (buf) {
      payload.message[chaveMsg] = {
        ...payload.message[chaveMsg],
        base64: buf.toString('base64'),
      };
    }
  }

  /**
   * Cria e conecta o socket Baileys.
   * Retorna o socket criado.
   */
  async function conectar() {
    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,    // gerenciamos o QR nós mesmos
      markOnlineOnConnect: false,  // nunca ir online
      syncFullHistory: false,      // não baixar histórico
      logger: {
        // Logger silencioso — apenas erros críticos
        level: 'silent',
        trace: () => {},
        debug: () => {},
        info:  () => {},
        warn:  (msg) => console.warn('[Baileys]', typeof msg === 'object' ? JSON.stringify(msg) : msg),
        error: (msg) => console.error('[Baileys]', typeof msg === 'object' ? JSON.stringify(msg) : msg),
        fatal: (msg) => console.error('[Baileys FATAL]', typeof msg === 'object' ? JSON.stringify(msg) : msg),
        child: () => ({ trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {} }),
      },
      getMessage: async () => undefined, // modo leitura — não respondemos a retry
    });

    _socket = sock;

    // ── Eventos de conexão ───────────────────────────────────────────────
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        _estado = 'aguardando-qr';
        let qrPng = null;
        try {
          qrPng = await QRCode.toDataURL(qr);
        } catch {
          // qrcode não disponível — passa só a string
        }
        aoQR?.(qr, qrPng);
      }

      if (connection === 'open') {
        _estado = 'conectado';
        const info = sock.user ?? {};
        aoConectar?.({
          telefone: info.id ?? '',
          nome:     info.name ?? '',
          pushName: info.name ?? '',
        });
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut  = statusCode === DisconnectReason.loggedOut;

        if (loggedOut) {
          _estado = 'desconectado';
          console.warn('[Baileys] Sessão encerrada (logout). Remova a pasta de sessão e reconecte.');
        } else {
          _estado = 'reconectando';
          console.info('[Baileys] Conexão fechada. Reconectando em 3s…');
          setTimeout(conectar, 3000);
        }
      }
    });

    // ── Salva credenciais quando atualizadas ────────────────────────────
    sock.ev.on('creds.update', saveCreds);

    // ── Cache de grupos ─────────────────────────────────────────────────
    sock.ev.on('groups.upsert', (grupos) => {
      for (const g of grupos) {
        _grupos.set(g.id, {
          jid:          g.id,
          nome:         g.subject ?? g.id,
          participantes: (g.participants ?? []).map((p) => p.id ?? p),
        });
      }
    });

    sock.ev.on('groups.update', (atualizacoes) => {
      for (const upd of atualizacoes) {
        if (_grupos.has(upd.id)) {
          _grupos.set(upd.id, { ..._grupos.get(upd.id), ...upd, jid: upd.id });
        }
      }
    });

    sock.ev.on('group-participants.update', ({ id, participants, action }) => {
      const g = _grupos.get(id);
      if (!g) return;
      if (action === 'add') {
        g.participantes = [...new Set([...g.participantes, ...participants])];
      } else if (action === 'remove') {
        g.participantes = g.participantes.filter((p) => !participants.includes(p));
      }
    });

    // ── Mensagens recebidas ─────────────────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return; // ignora histórico

      for (const rawMsg of messages) {
        const jid = rawMsg.key?.remoteJid ?? '';

        // Só grupos
        if (!isJidGroup(jid)) continue;

        // Só grupos permitidos
        if (!grupoPermitido(jid)) continue;

        // Ignora mensagens enviadas por nós
        if (rawMsg.key?.fromMe) continue;

        // Ignora mensagens sem conteúdo
        if (!rawMsg.message) continue;

        const grupoInfo = _grupos.get(jid) ?? null;
        const payload   = montarPayloadBaileys(rawMsg, grupoInfo);

        // Baixa mídia se houver (descriptografa)
        await enriquecerMidia(payload, rawMsg);

        aoMensagem?.(payload);
      }
    });

    return sock;
  }

  // Inicia a conexão
  await conectar();

  /* ─── API pública ──────────────────────────────────────────────────────── */

  return {
    /**
     * Lista todos os grupos que o número participa.
     * @returns {Promise<Array<{jid: string, nome: string, participantes: string[]}>>}
     */
    async listarGrupos() {
      if (_socket && typeof _socket.groupFetchAllParticipating === 'function') {
        try {
          const resultado = await _socket.groupFetchAllParticipating();
          // Atualiza cache interno
          for (const [jid, meta] of Object.entries(resultado)) {
            _grupos.set(jid, {
              jid,
              nome:          meta.subject ?? jid,
              participantes: (meta.participants ?? []).map((p) => p.id ?? p),
            });
          }
        } catch (err) {
          console.warn('[Baileys] Não foi possível buscar grupos:', err.message);
        }
      }
      return [..._grupos.values()];
    },

    /**
     * Encerra a conexão permanentemente.
     */
    desconectar() {
      _estado = 'desconectado';
      try {
        _socket?.end(new Error('desconexão solicitada'));
      } catch { /* silencioso */ }
    },

    /**
     * Retorna o estado atual da conexão.
     * @returns {'aguardando-qr'|'conectado'|'desconectado'|'reconectando'}
     */
    estado() {
      return _estado;
    },
  };
}
