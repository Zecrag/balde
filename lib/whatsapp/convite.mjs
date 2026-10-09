/**
 * @file lib/whatsapp/convite.mjs — convite para conectar o WhatsApp de outra pessoa
 * pela Evolution do dono (GB-47).
 *
 * O dono cria, no Mac dele, uma instância NOVA e exclusiva (balde-<slug>) na
 * Evolution, sem webhook, e entrega à pessoa um código curto com
 * {url, instância, token da instância}. O token da instância só abre aquela
 * instância — nunca a chave global.
 *
 * O que o token da instância alcança (Evolution v2: as rotas /:instanceName
 * aceitam a chave global OU o token da própria instância):
 *   - /chat/findMessages, /chat/getBase64FromMediaMessage   (leitura e mídia)
 *   - /group/fetchAllGroups, /group/inviteInfo               (grupos e convites)
 *   - /instance/connect, /instance/connectionState           (QR e estado)
 *   - /websocket/find, /webhook/find                         (diagnóstico)
 * Exige a chave GLOBAL: /instance/create e /instance/fetchInstances (todas) —
 * por isso só o bin/convite.mjs, no Mac do dono, chama essas rotas.
 *
 * Toda chamada de rede recebe `fetch` injetável (testes não tocam a Evolution).
 */

import { randomBytes } from 'node:crypto';

export const PREFIXO_INSTANCIA = 'balde-';
export const PORTA_SETUP = 7391;

/** "Maria José da Silva" → "maria-jose-da-silva" (no máximo 30 caracteres). */
export function slugNome(nome) {
  return String(nome ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/, '');
}

export function nomeInstancia(nome) {
  const slug = slugNome(nome);
  if (!slug) throw new Error('Nome vazio: informe o nome da pessoa (ex.: "Maria Silva")');
  return `${PREFIXO_INSTANCIA}${slug}`;
}

/** Só instâncias criadas por convite (balde-*) podem ser revogadas ou recebidas. */
export function ehInstanciaDeConvite(inst) {
  // Charset fechado: o nome vai para o .env (sem CR/LF nem espaço) e para a URL da Evolution
  return typeof inst === 'string' && inst.startsWith(PREFIXO_INSTANCIA)
    && /^[A-Za-z0-9_-]{1,60}$/.test(inst.slice(PREFIXO_INSTANCIA.length));
}

// ─── Código de convite ───────────────────────────────────────────────────────

/** {url, instancia, tokenInstancia} → base64url curto. */
export function codificarConvite({ url, instancia, tokenInstancia }) {
  const u = String(url ?? '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(u) || !instancia || !tokenInstancia) throw new Error('Convite incompleto');
  return Buffer.from(JSON.stringify({ u, i: instancia, t: tokenInstancia }), 'utf8').toString('base64url');
}

/**
 * Código (ou o link inteiro com #convite=...) → {url, instancia, tokenInstancia}.
 * Lança com mensagem legível se o código estiver errado.
 */
export function decodificarConvite(entrada) {
  let codigo = String(entrada ?? '').trim();
  const m = codigo.match(/convite=([A-Za-z0-9_-]+)/);
  if (m) codigo = m[1];
  codigo = codigo.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9_-]{16,2000}$/.test(codigo)) throw new Error('Código de convite inválido');
  let dados;
  try { dados = JSON.parse(Buffer.from(codigo, 'base64url').toString('utf8')); }
  catch { throw new Error('Código de convite inválido'); }
  const bruta = String(dados?.u ?? '');
  const instancia = String(dados?.i ?? '');
  const tokenInstancia = String(dados?.t ?? '');
  // A URL vai para o .env: recusa controles (o parser de URL engoliria um \n) e grava só a forma normalizada
  let url = '';
  let urlOk = false;
  try {
    const p = new URL(bruta);
    urlOk = ['http:', 'https:'].includes(p.protocol) && !/[\x00-\x1f\x7f\s]/.test(bruta) && !p.username && !p.password && !p.search && !p.hash;
    url = `${p.origin}${p.pathname.replace(/\/+$/, '')}`;
  } catch {}
  if (!urlOk || !ehInstanciaDeConvite(instancia) || !/^[\w-]{8,200}$/.test(tokenInstancia)) {
    throw new Error('Código de convite inválido');
  }
  return { url, instancia, tokenInstancia };
}

export function linkConvite(codigo, porta = PORTA_SETUP) {
  return `http://127.0.0.1:${porta}/setup#convite=${codigo}`;
}

// ─── Evolution ───────────────────────────────────────────────────────────────

async function chamar({ url, key, fetch: f = globalThis.fetch }, metodo, rota, corpo) {
  const headers = { apikey: key };
  if (corpo !== undefined) headers['Content-Type'] = 'application/json';
  const res = await f(`${String(url).replace(/\/+$/, '')}${rota}`, {
    method: metodo,
    headers,
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  if (!res.ok) {
    const txt = await res.text?.().catch(() => '') ?? '';
    const err = new Error(`Evolution respondeu HTTP ${res.status}${txt ? `: ${String(txt).slice(0, 200)}` : ''}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * Instâncias da Evolution (chave global). Aceita v2 ([{name, connectionStatus, ...}])
 * e v1 ([{instance: {instanceName, status}}]). Nunca devolve tokens.
 * @returns {Promise<{nome: string, estado: string, numero: string|null}[]>}
 */
export async function listarInstancias(conexao) {
  const data = await chamar(conexao, 'GET', '/instance/fetchInstances');
  const lista = Array.isArray(data) ? data : (data?.instances ?? data?.data ?? []);
  return lista.map(x => {
    const i = x?.instance ?? x ?? {};
    const nome = String(i.name ?? i.instanceName ?? '');
    const estado = String(i.connectionStatus ?? i.status ?? i.state ?? 'desconhecido');
    const dono = i.ownerJid ?? i.owner ?? null;
    return { nome, estado, numero: dono ? String(dono).split('@')[0] : null };
  }).filter(i => i.nome);
}

/**
 * Plano de criação (sem efeito colateral além da leitura das instâncias).
 * Recusa nome já existente e a instância principal do dono.
 */
export async function planejarConvite(conexao, nomePessoa, { instanciaDono } = {}) {
  const instancia = nomeInstancia(nomePessoa);
  if (instanciaDono && instancia === instanciaDono) throw new Error(`Recusado: ${instancia} é a instância principal do dono`);
  const existentes = await listarInstancias(conexao);
  if (existentes.some(i => i.nome === instancia)) {
    throw new Error(`Já existe a instância ${instancia} na Evolution (use "listar" ou outro nome)`);
  }
  return { instancia, totalInstancias: existentes.length };
}

/**
 * POST /instance/create — instância nova, só leitura, SEM webhook.
 * Devolve o token próprio dela (v2: `hash` string; v1: `hash.apikey`).
 */
export async function criarInstancia(conexao, instancia) {
  if (!ehInstanciaDeConvite(instancia)) throw new Error(`Recusado: instância de convite precisa começar com ${PREFIXO_INSTANCIA}`);
  const tokenGerado = randomBytes(24).toString('hex').toUpperCase();
  const data = await chamar(conexao, 'POST', '/instance/create', {
    instanceName: instancia,
    token: tokenGerado,
    integration: 'WHATSAPP-BAILEYS',
    qrcode: false,
    groupsIgnore: false,
    rejectCall: false,
    alwaysOnline: false,
    readMessages: false,
    readStatus: false,
    syncFullHistory: false,
  });
  const hash = data?.hash;
  const token = typeof hash === 'string' ? hash : (hash?.apikey ?? data?.instance?.token ?? tokenGerado);
  return { instancia, tokenInstancia: token };
}

/** Desconecta o WhatsApp e apaga a instância. Só instâncias balde-*. */
export async function revogarInstancia(conexao, instancia, { instanciaDono } = {}) {
  if (!ehInstanciaDeConvite(instancia)) throw new Error(`Recusado: só revogo instâncias ${PREFIXO_INSTANCIA}*`);
  if (instanciaDono && instancia === instanciaDono) throw new Error(`Recusado: ${instancia} é a instância principal do dono`);
  const enc = encodeURIComponent(instancia);
  let deslogou = true;
  try { await chamar(conexao, 'DELETE', `/instance/logout/${enc}`); }
  catch { deslogou = false; } // já desconectada: segue para o delete
  await chamar(conexao, 'DELETE', `/instance/delete/${enc}`);
  return { instancia, deslogou };
}

/** GET /instance/connectionState — 'open' | 'connecting' | 'close' | ... */
export async function estadoConexao(conexao, instancia) {
  const data = await chamar(conexao, 'GET', `/instance/connectionState/${encodeURIComponent(instancia)}`);
  return String(data?.instance?.state ?? data?.state ?? 'desconhecido');
}

/**
 * Estado para o assistente: conectado, ou o QR (data URL) a escanear.
 * @returns {Promise<{status: 'connected'} | {status: 'qr', qr: string|null, pairingCode: string|null}>}
 */
export async function qrDaInstancia(conexao, instancia) {
  const estado = await estadoConexao(conexao, instancia);
  if (estado === 'open') return { status: 'connected' };
  const data = await chamar(conexao, 'GET', `/instance/connect/${encodeURIComponent(instancia)}`);
  if (data?.instance?.state === 'open') return { status: 'connected' };
  const b64 = data?.base64 ?? data?.qrcode?.base64 ?? null;
  const qr = b64 ? (String(b64).startsWith('data:') ? b64 : `data:image/png;base64,${b64}`) : null;
  return { status: 'qr', qr, pairingCode: data?.pairingCode ?? null };
}
