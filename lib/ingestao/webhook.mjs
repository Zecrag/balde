import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { normalizar, identificarChat } from './normalizar.mjs';
import { grupoAutorizado } from './autorizacao.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const getBaseDados = () => process.env.BALDE_DADOS || path.resolve(__dirname, '../../dados');

export const CORPO_MAX_BYTES = 5 * 1024 * 1024;

/** Comparação em tempo constante (o hash iguala os tamanhos). */
function tokenConfere(recebido, esperado) {
  const a = crypto.createHash('sha256').update(String(recebido)).digest();
  const b = crypto.createHash('sha256').update(String(esperado)).digest();
  return crypto.timingSafeEqual(a, b);
}

class CorpoGrandeDemais extends Error {}

/**
 * Cria o handler HTTP do webhook de ingestão.
 * @param {Object} [options]
 * @param {Function} [options.enriquecer]
 * @param {Function} [options.processar]
 * @param {Object} [options.store]
 * @param {string} [options.token]
 * @param {string} [options.mensagensPath]
 * @param {string} [options.midiaDir]
 * @param {Set<string>} [options.seenIds]
 * @param {Function} [options.onPipelineComplete] Hook opcional chamado ao terminar enriquecer+processar
 * @returns {Function} (req, res) => Promise<void>
 */
export function criarHandlerWebhook(options = {}) {
  const {
    enriquecer,
    processar,
    store,
    token: optToken,
    onPipelineComplete,
  } = options;

  const mensagensPath =
    options.mensagensPath || process.env.BALDE_MENSAGENS_PATH || path.join(getBaseDados(), 'mensagens.jsonl');
  const midiaDir =
    options.midiaDir || process.env.BALDE_MIDIA_DIR || path.join(getBaseDados(), 'midia');

  const seenIds = options.seenIds || new Set();

  // Carrega IDs já gravados no arquivo para manter a deduplicação após reinício
  if (fs.existsSync(mensagensPath)) {
    try {
      const conteudo = fs.readFileSync(mensagensPath, 'utf8');
      const linhas = conteudo.split('\n');
      for (const linha of linhas) {
        if (!linha.trim()) continue;
        try {
          const item = JSON.parse(linha);
          if (item && item.id) {
            seenIds.add(item.id);
          }
        } catch (_) {}
      }
    } catch (err) {
      console.warn('[ingestao/webhook] Aviso ao ler mensagens existentes:', err.message);
    }
  }

  return async function webhookHandler(req, res) {
    const parsedUrl = new URL(req.url, 'http://localhost');
    const pathname = parsedUrl.pathname;
    const method = (req.method || 'GET').toUpperCase();

    const expectedToken = optToken || process.env.BALDE_WEBHOOK_TOKEN;
    const isInseguro = process.env.BALDE_WEBHOOK_INSEGURO === '1';

    // Falha fechado: sem token configurado → 503, a menos que BALDE_WEBHOOK_INSEGURO=1
    if (!expectedToken) {
      if (!isInseguro) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'webhook_token_not_configured' }));
        return;
      }
      console.warn('[ingestao/webhook] AVISO: Operando em modo inseguro (BALDE_WEBHOOK_INSEGURO=1). Token de webhook desativado.');
    }

    // 1. Meta WhatsApp Cloud API verify-challenge (GET)
    if (method === 'GET') {
      const mode = parsedUrl.searchParams.get('hub.mode');
      const verifyToken = parsedUrl.searchParams.get('hub.verify_token');
      const challenge = parsedUrl.searchParams.get('hub.challenge');

      if (mode === 'subscribe' && challenge) {
        if (expectedToken && verifyToken && tokenConfere(verifyToken, expectedToken)) {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(challenge);
          return;
        }
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized', message: 'Token de verificação inválido' }));
        return;
      }
    }

    // 2. Validação de token para POST (ou outros métodos) — só por header, nunca pela URL (vaza em log)
    if (expectedToken) {
      const headerAuth = req.headers['authorization'];
      const bearerToken = headerAuth && headerAuth.startsWith('Bearer ') ? headerAuth.slice(7).trim() : null;
      const headerWebhook = req.headers['x-webhook-token'];
      const headerBalde = req.headers['x-balde-token'];
      const headerApiKey = req.headers['apikey'];

      const recebido = bearerToken || headerWebhook || headerBalde || headerApiKey;

      if (!recebido || !tokenConfere(recebido, expectedToken)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized', message: 'Token de webhook inválido ou ausente' }));
        return;
      }
    }

    if (method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'method_not_allowed' }));
      return;
    }

    // 3. Lê o corpo da requisição (teto de CORPO_MAX_BYTES)
    const declarado = Number(req.headers['content-length']);
    if (declarado > CORPO_MAX_BYTES) {
      // descarta o corpo sem guardar (o requestTimeout do servidor limita o tempo)
      req.resume();
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'payload_too_large', limite: CORPO_MAX_BYTES }));
      return;
    }
    let bodyRaw = '';
    try {
      bodyRaw = await new Promise((resolve, reject) => {
        const partes = [];
        let total = 0;
        req.on('data', (chunk) => {
          total += chunk.length;
          if (total > CORPO_MAX_BYTES) {
            req.removeAllListeners('data');
            req.resume();
            reject(new CorpoGrandeDemais());
            return;
          }
          partes.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(partes).toString('utf8')));
        req.on('error', reject);
      });
    } catch (err) {
      if (err instanceof CorpoGrandeDemais) {
        res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' });
        res.end(JSON.stringify({ error: 'payload_too_large', limite: CORPO_MAX_BYTES }));
        return;
      }
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad_request', message: err.message }));
      return;
    }

    let payload = {};
    if (bodyRaw.trim()) {
      try {
        payload = JSON.parse(bodyRaw);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_json', message: 'Corpo da requisição não é um JSON válido' }));
        return;
      }
    }

    // 4. Identifica o provedor da rota: /webhook/:provedor ou query ?provedor=
    const segments = pathname.split('/').filter(Boolean);
    let rotaProvedor = null;
    if (segments.length >= 2 && segments[0] === 'webhook') {
      rotaProvedor = segments[1];
    } else if (parsedUrl.searchParams.get('provedor')) {
      rotaProvedor = parsedUrl.searchParams.get('provedor');
    }

    // 5. Filtro de grupo ANTES de normalizar (que já baixa mídia): grupo fora do
    //    GRUPOS.md não é gravado nem chega ao LLM. Encaminhamento manual é o dono → passa.
    let chat;
    try {
      chat = identificarChat(payload, rotaProvedor || 'auto');
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad_request', message: err.message }));
      return;
    }
    if (chat.provedor !== 'encaminhamento-manual' && chat.grupo && !(await grupoAutorizado(chat.grupoJid))) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ignorada: true, motivo: 'grupo_nao_autorizado' }));
      return;
    }

    try {
      const mensagem = await normalizar(payload, rotaProvedor || 'auto', { midiaDir });

      // 6. Deduplicação por id
      if (seenIds.has(mensagem.id)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, duplicada: true, id: mensagem.id }));
        return;
      }

      // Novo ID: registra no conjunto
      seenIds.add(mensagem.id);

      // 7. Grava em mensagens.jsonl
      const dir = path.dirname(mensagensPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      await fs.promises.appendFile(mensagensPath, JSON.stringify(mensagem) + '\n', 'utf8');

      // Se houver store fornecido, salva também no store
      if (store) {
        if (typeof store.gravarMensagem === 'function') {
          await store.gravarMensagem(mensagem);
        } else if (typeof store.salvarMensagem === 'function') {
          await store.salvarMensagem(mensagem);
        }
      }

      // 8. Responde 200 rápido antes do processamento pesado
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id: mensagem.id }));

      // 9. Execução assíncrona do enriquecimento e motor em segundo plano
      setImmediate(async () => {
        try {
          let msgProcessar = mensagem;
          if (typeof enriquecer === 'function') {
            const enr = await enriquecer(msgProcessar);
            if (enr) msgProcessar = enr;
          }
          if (typeof processar === 'function') {
            await processar(msgProcessar);
          }
          if (typeof onPipelineComplete === 'function') {
            onPipelineComplete(null, msgProcessar);
          }
        } catch (err) {
          console.error('[ingestao/webhook] Erro no pipeline assíncrono:', err);
          if (typeof onPipelineComplete === 'function') {
            onPipelineComplete(err, null);
          }
        }
      });
    } catch (err) {
      if (err?.code === 'CHATID_INVALIDO') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'chatid_invalido', message: err.message }));
        return;
      }
      console.error('[ingestao/webhook] Erro ao normalizar/gravar:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal_error', message: err.message }));
    }
  };
}
