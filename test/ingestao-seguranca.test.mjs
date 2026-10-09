/**
 * @file ingestao-seguranca.test.mjs — GB-24: filtro de grupo no webhook (A1), chatId
 * com path traversal (A2), download de mídia restrito (M3), teto do corpo (M4) e
 * token só por header com comparação em tempo constante (B1).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { criarHandlerWebhook, normalizar } from '../lib/ingestao/index.mjs';
import { salvarMidia } from '../lib/ingestao/midia.mjs';
import { hostMidiaPermitido, MIDIA_TETO_BYTES } from '../lib/ingestao/midia.mjs';
import { grupoAutorizado } from '../lib/ingestao/autorizacao.mjs';

const GRUPO_OK = '120363000000000001@g.us';
const GRUPO_CLIENTE = '120363000000000002@g.us';
const GRUPO_INTRUSO = '120363000000000099@g.us';
const TOKEN = 'token-seguranca';

const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'balde-seg-'));
const CONFIG_DIR = path.join(RAIZ, 'config');
fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.writeFileSync(path.join(CONFIG_DIR, 'grupos.json'), JSON.stringify([{ jid: GRUPO_OK }]));
fs.writeFileSync(path.join(CONFIG_DIR, 'clientes.json'), JSON.stringify([{ empresa: 'X', projeto: 'Y', grupos: [GRUPO_CLIENTE] }]));
process.env.BALDE_CONFIG = CONFIG_DIR;

test.after(() => fs.rmSync(RAIZ, { recursive: true, force: true }));

function evolution(remoteJid, extra = {}) {
  return {
    event: 'messages.upsert',
    instance: 'teste',
    data: {
      key: { id: `SEG-${Math.random().toString(36).slice(2)}`, remoteJid, fromMe: false },
      pushName: 'Alguém',
      message: { conversation: 'faz o banner novo' },
      messageTimestamp: 1700000000,
      ...extra,
    },
  };
}

async function subir(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

function criarWebhook(dir) {
  const chamadas = { enriquecer: 0, processar: 0 };
  const handler = criarHandlerWebhook({
    token: TOKEN,
    mensagensPath: path.join(dir, 'mensagens.jsonl'),
    midiaDir: path.join(dir, 'midia'),
    enriquecer: async (m) => { chamadas.enriquecer++; return m; },
    processar: async () => { chamadas.processar++; },
  });
  return { handler, chamadas };
}

function post(base, body, headers = { 'x-webhook-token': TOKEN }, rota = '/webhook/evolution') {
  return fetch(`${base}${rota}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── A1 ──────────────────────────────────────────────────────────

test('A1: grupoAutorizado lê grupos.json e clientes.json do BALDE_CONFIG', async () => {
  assert.equal(await grupoAutorizado(GRUPO_OK), true);
  assert.equal(await grupoAutorizado(GRUPO_CLIENTE), true);
  assert.equal(await grupoAutorizado(GRUPO_INTRUSO), false);
  assert.equal(await grupoAutorizado(''), false);
});

test('A1: webhook ignora grupo não autorizado — nada gravado, mídia não baixada, sem enriquecer/processar', async () => {
  const dir = fs.mkdtempSync(path.join(RAIZ, 'a1-'));
  // servidor de mídia: não pode receber nenhuma requisição
  let hitsMidia = 0;
  const midiaSrv = http.createServer((req, res) => { hitsMidia++; res.end('x'); });
  await new Promise((r) => midiaSrv.listen(0, '127.0.0.1', r));
  const evoAntes = process.env.BALDE_EVOLUTION_URL;
  process.env.BALDE_EVOLUTION_URL = `http://127.0.0.1:${midiaSrv.address().port}`;

  const { handler, chamadas } = criarWebhook(dir);
  const { server, base } = await subir(handler);
  try {
    const payload = evolution(GRUPO_INTRUSO, {
      messageType: 'audioMessage',
      message: { audioMessage: { url: `${process.env.BALDE_EVOLUTION_URL}/a.ogg`, mimetype: 'audio/ogg' } },
    });
    const res = await post(base, payload);
    assert.equal(res.status, 200);
    const corpo = await res.json();
    assert.equal(corpo.ignorada, true);

    // mesmo encaminhada, se veio de grupo não autorizado continua ignorada
    const fwd = evolution(GRUPO_INTRUSO, { isForwarded: true });
    assert.equal((await (await post(base, fwd)).json()).ignorada, true);

    await esperar(50);
    assert.equal(fs.existsSync(path.join(dir, 'mensagens.jsonl')), false, 'nada gravado');
    assert.equal(fs.existsSync(path.join(dir, 'midia')), false, 'nenhuma mídia salva');
    assert.equal(hitsMidia, 0, 'mídia não foi baixada');
    assert.deepEqual(chamadas, { enriquecer: 0, processar: 0 });
  } finally {
    server.close();
    midiaSrv.close();
    if (evoAntes === undefined) delete process.env.BALDE_EVOLUTION_URL;
    else process.env.BALDE_EVOLUTION_URL = evoAntes;
  }
});

test('A1: grupo autorizado (grupos.json ou clientes.json) e encaminhamento manual passam', async () => {
  const dir = fs.mkdtempSync(path.join(RAIZ, 'a1ok-'));
  const { handler, chamadas } = criarWebhook(dir);
  const { server, base } = await subir(handler);
  try {
    assert.equal((await (await post(base, evolution(GRUPO_OK))).json()).ok, true);
    assert.equal((await (await post(base, evolution(GRUPO_CLIENTE))).json()).ok, true);
    const manual = { texto: 'pagar boleto', de: 'Alice', origem: 'encaminhada' };
    const r = await (await post(base, manual, undefined, '/webhook/manual')).json();
    assert.equal(r.ok, true);
    assert.notEqual(r.ignorada, true);
    await esperar(50);
    const linhas = fs.readFileSync(path.join(dir, 'mensagens.jsonl'), 'utf8').trim().split('\n');
    assert.equal(linhas.length, 3);
    assert.deepEqual(chamadas, { enriquecer: 3, processar: 3 });
  } finally {
    server.close();
  }
});

// ─── A2 ──────────────────────────────────────────────────────────

test('A2: normalizar rejeita chatId com path traversal', async () => {
  for (const chatId of ['../../X', '../dados/tarefas', 'a/b', 'x\\..\\y', '..']) {
    await assert.rejects(
      normalizar({ texto: 'oi', de: 'eu', chatId }, 'manual'),
      (err) => err.code === 'CHATID_INVALIDO',
      `deveria rejeitar ${chatId}`,
    );
  }
  await assert.rejects(normalizar(evolution('../../X@g.us'), 'evolution'), { code: 'CHATID_INVALIDO' });
  const ok = await normalizar({ texto: 'oi', de: 'eu', chatId: '5511999999999@s.whatsapp.net' }, 'manual');
  assert.equal(ok.chatId, '5511999999999@s.whatsapp.net');
});

test('A2: webhook responde 400 para chatId inválido e não grava', async () => {
  const dir = fs.mkdtempSync(path.join(RAIZ, 'a2-'));
  const { handler, chamadas } = criarWebhook(dir);
  const { server, base } = await subir(handler);
  try {
    const res = await post(base, { texto: 'oi', de: 'eu', chatId: '../../X' }, undefined, '/webhook/manual');
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'chatid_invalido');
    await esperar(30);
    assert.equal(fs.existsSync(path.join(dir, 'mensagens.jsonl')), false);
    assert.deepEqual(chamadas, { enriquecer: 0, processar: 0 });
  } finally {
    server.close();
  }
});

// ─── M3 ──────────────────────────────────────────────────────────

test('M3: allowlist de host de mídia', () => {
  const antes = process.env.BALDE_EVOLUTION_URL;
  process.env.BALDE_EVOLUTION_URL = 'https://evo.exemplo.com:8443';
  try {
    assert.equal(hostMidiaPermitido('https://mmg.whatsapp.net/v/t62/abc.enc'), true);
    assert.equal(hostMidiaPermitido('https://media-gru1-1.cdn.whatsapp.net/x'), true);
    assert.equal(hostMidiaPermitido('https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1'), true);
    assert.equal(hostMidiaPermitido('https://evo.exemplo.com:8443/media/a.ogg'), true);
    assert.equal(hostMidiaPermitido('https://evo.exemplo.com/media/a.ogg'), false, 'porta diferente');
    assert.equal(hostMidiaPermitido('http://127.0.0.1:8080/x'), false);
    assert.equal(hostMidiaPermitido('http://169.254.169.254/latest/meta-data'), false);
    assert.equal(hostMidiaPermitido('https://whatsapp.net.atacante.com/x'), false);
    assert.equal(hostMidiaPermitido('https://evilwhatsapp.net/x'), false);
    assert.equal(hostMidiaPermitido('file:///etc/passwd'), false);
  } finally {
    if (antes === undefined) delete process.env.BALDE_EVOLUTION_URL;
    else process.env.BALDE_EVOLUTION_URL = antes;
  }
});

test('M3: salvarMidia não busca host fora da allowlist, não segue redirect e respeita o teto', async () => {
  const dir = fs.mkdtempSync(path.join(RAIZ, 'm3-'));
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === '/ok.ogg') return res.end(Buffer.from('OggS-dados'));
    if (req.url === '/redir') { res.writeHead(302, { Location: '/ok.ogg' }); return res.end(); }
    if (req.url === '/grande-declarado') {
      res.writeHead(200, { 'Content-Length': String(MIDIA_TETO_BYTES + 1) });
      return res.end();
    }
    if (req.url === '/grande-stream') {
      res.writeHead(200, { 'Transfer-Encoding': 'chunked' });
      const bloco = Buffer.alloc(1024 * 1024, 1);
      let enviados = 0;
      const enviar = () => {
        while (enviados <= 26) {
          enviados++;
          if (!res.write(bloco)) return res.once('drain', enviar);
        }
        res.end();
      };
      res.on('error', () => {});
      return enviar();
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const origem = `http://127.0.0.1:${srv.address().port}`;
  const antes = process.env.BALDE_EVOLUTION_URL;
  try {
    // fora da allowlist: nenhuma requisição sai
    delete process.env.BALDE_EVOLUTION_URL;
    assert.equal(await salvarMidia({ id: 'm1', url: `${origem}/ok.ogg`, mimetype: 'audio/ogg', midiaDir: dir }), null);
    assert.equal(hits.length, 0);

    // host da Evolution: baixa
    process.env.BALDE_EVOLUTION_URL = origem;
    const salvo = await salvarMidia({ id: 'm2', url: `${origem}/ok.ogg`, mimetype: 'audio/ogg', midiaDir: dir });
    assert.ok(salvo && fs.readFileSync(salvo, 'utf8') === 'OggS-dados');

    // redirect: erro, nada salvo
    assert.equal(await salvarMidia({ id: 'm3', url: `${origem}/redir`, mimetype: 'audio/ogg', midiaDir: dir }), null);
    assert.ok(!hits.includes('/ok.ogg') || hits.filter((h) => h === '/ok.ogg').length === 1, 'redirect não seguido');

    // acima do teto (declarado e em stream): descartado
    assert.equal(await salvarMidia({ id: 'm4', url: `${origem}/grande-declarado`, midiaDir: dir }), null);
    assert.equal(await salvarMidia({ id: 'm5', url: `${origem}/grande-stream`, midiaDir: dir }), null);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['m2.ogg']);
  } finally {
    srv.closeAllConnections?.();
    srv.close();
    if (antes === undefined) delete process.env.BALDE_EVOLUTION_URL;
    else process.env.BALDE_EVOLUTION_URL = antes;
  }
});

// ─── M4 ──────────────────────────────────────────────────────────

test('M4: corpo acima de 5 MB → 413 e nada gravado', async () => {
  const dir = fs.mkdtempSync(path.join(RAIZ, 'm4-'));
  const { handler, chamadas } = criarWebhook(dir);
  const { server, base } = await subir(handler);
  try {
    const enviar = (headers, partes) => new Promise((resolve, reject) => {
      const req = http.request(`${base}/webhook/manual`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-webhook-token': TOKEN, ...headers },
      }, (r) => {
        let txt = '';
        r.on('data', (c) => { txt += c; });
        r.on('end', () => resolve({ status: r.statusCode, txt }));
      });
      req.on('error', (e) => (e.code === 'ECONNRESET' || e.code === 'EPIPE' ? resolve({ status: 'reset' }) : reject(e)));
      for (const p of partes) req.write(p);
      req.end();
    });
    const bloco = 'x'.repeat(1024 * 1024);
    const seis = Array.from({ length: 6 }, () => bloco);

    // com Content-Length declarado acima do teto
    const declarado = await enviar({ 'Content-Length': String(6 * 1024 * 1024) }, seis);
    assert.equal(declarado.status, 413);
    assert.equal(JSON.parse(declarado.txt).error, 'payload_too_large');

    // sem Content-Length (chunked) o corte acontece durante a leitura
    const { status } = await enviar({ 'Transfer-Encoding': 'chunked' }, seis);
    assert.ok(status === 413 || status === 'reset', `esperava 413, veio ${status}`);

    await esperar(30);
    assert.equal(fs.existsSync(path.join(dir, 'mensagens.jsonl')), false);
    assert.deepEqual(chamadas, { enriquecer: 0, processar: 0 });
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

// ─── B1 ──────────────────────────────────────────────────────────

test('B1: token só por header — ?token= e ?api_key= na URL não autenticam', async () => {
  const dir = fs.mkdtempSync(path.join(RAIZ, 'b1-'));
  const { handler } = criarWebhook(dir);
  const { server, base } = await subir(handler);
  try {
    const corpo = JSON.stringify(evolution(GRUPO_OK));
    for (const qs of [`?token=${TOKEN}`, `?api_key=${TOKEN}`]) {
      const res = await fetch(`${base}/webhook/evolution${qs}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: corpo });
      assert.equal(res.status, 401, `URL ${qs} não deve autenticar`);
    }
    // token de tamanho diferente não lança (timingSafeEqual sobre hash)
    assert.equal((await post(base, evolution(GRUPO_OK), { 'x-webhook-token': 'x' })).status, 401);
    assert.equal((await post(base, evolution(GRUPO_OK), { authorization: `Bearer ${TOKEN}` })).status, 200);
    assert.equal((await post(base, evolution(GRUPO_OK), { apikey: TOKEN })).status, 200);
  } finally {
    server.close();
  }
});
