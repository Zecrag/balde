import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// Grupos das fixtures autorizados num config isolado (o webhook descarta grupo fora do GRUPOS.md)
const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'balde-ingestao-config-'));
fs.writeFileSync(path.join(CONFIG_DIR, 'grupos.json'), JSON.stringify([
  { jid: '120363025348923456@g.us' },
  { jid: '120363098765432100@g.us' },
]));
process.env.BALDE_CONFIG = CONFIG_DIR;

import { normalizar, criarHandlerWebhook, detectarProvedor } from '../lib/ingestao/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, 'fixtures/whatsapp');
const TEST_TMP_DIR = path.resolve(__dirname, 'tmp');

function lerFixture(nome) {
  const filePath = path.join(FIXTURES_DIR, nome);
  const conteudo = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(conteudo);
}

// Limpa pasta temporária antes e depois dos testes
test.beforeEach(() => {
  if (fs.existsSync(TEST_TMP_DIR)) {
    fs.rmSync(TEST_TMP_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_TMP_DIR, { recursive: true });
});

test.after(() => {
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
  if (fs.existsSync(TEST_TMP_DIR)) {
    fs.rmSync(TEST_TMP_DIR, { recursive: true, force: true });
  }
});

test('Normalização: Evolution API — mensagem de texto', async () => {
  const fixture = lerFixture('evolution-texto.json');
  assert.equal(detectarProvedor(fixture), 'evolution');

  const msg = await normalizar(fixture, 'evolution', {
    midiaDir: path.join(TEST_TMP_DIR, 'midia'),
  });

  assert.equal(msg.id, 'EVO_MSG_TXT_101');
  assert.equal(msg.chatNome, 'Projeto Alfa - Empresa X');
  assert.equal(msg.tipo, 'texto');
  assert.equal(msg.origem, 'grupo');
  assert.equal(msg.autor, 'Roberto Silva');
  assert.match(msg.texto, /Precisamos ajustar o prazo/);
  assert.ok(msg.ts);
});

test('Normalização: Evolution API — mensagem de áudio', async () => {
  const fixture = lerFixture('evolution-audio.json');
  assert.equal(detectarProvedor(fixture), 'evolution');

  const midiaDir = path.join(TEST_TMP_DIR, 'midia');
  const msg = await normalizar(fixture, 'evolution', { midiaDir });

  assert.equal(msg.id, 'EVO_MSG_AUD_102');
  assert.equal(msg.chatNome, 'Projeto Alfa - Empresa X');
  assert.equal(msg.tipo, 'audio');
  assert.equal(msg.origem, 'grupo');
  assert.equal(msg.autor, 'Ana Paula');
  assert.ok(msg.midiaPath, 'Deve possuir midiaPath preenchido');
  assert.ok(fs.existsSync(msg.midiaPath), 'Arquivo de mídia deve existir no disco');
});

test('Normalização: Evolution API — mensagem de PDF', async () => {
  const fixture = lerFixture('evolution-pdf.json');
  assert.equal(detectarProvedor(fixture), 'evolution');

  const midiaDir = path.join(TEST_TMP_DIR, 'midia');
  const msg = await normalizar(fixture, 'evolution', { midiaDir });

  assert.equal(msg.id, 'EVO_MSG_DOC_103');
  assert.equal(msg.chatNome, 'Projeto Alfa - Empresa X');
  assert.equal(msg.tipo, 'pdf');
  assert.equal(msg.origem, 'grupo');
  assert.equal(msg.autor, 'Carlos Financeiro');
  assert.match(msg.texto, /Segue o contrato assinado/);
  assert.ok(msg.midiaPath, 'Deve possuir midiaPath');
  assert.ok(fs.existsSync(msg.midiaPath), 'Arquivo PDF deve existir no disco');
});

test('Normalização: WhatsApp Cloud API — mensagem de texto', async () => {
  const fixture = lerFixture('cloud-api-texto.json');
  assert.equal(detectarProvedor(fixture), 'cloud-api');

  const msg = await normalizar(fixture, 'cloud-api', {
    midiaDir: path.join(TEST_TMP_DIR, 'midia'),
  });

  assert.equal(msg.id, 'wamid.HBgLNTUxMTk5ODg4ODgxMTFRM0I2RDQzMjE=');
  assert.equal(msg.chatNome, 'Maria Oliveira');
  assert.equal(msg.tipo, 'texto');
  assert.equal(msg.origem, 'pessoal');
  assert.equal(msg.autor, 'Maria Oliveira');
  assert.match(msg.texto, /Favor emitir a nota fiscal/);
});

test('Normalização: WhatsApp Cloud API — mensagem de áudio', async () => {
  const fixture = lerFixture('cloud-api-audio.json');
  assert.equal(detectarProvedor(fixture), 'cloud-api');

  const midiaDir = path.join(TEST_TMP_DIR, 'midia');
  const msg = await normalizar(fixture, 'cloud-api', { midiaDir });

  assert.equal(msg.id, 'wamid.HBgLNTUxMTk5ODg4ODgxMTFRM0I2RDQzMjI=');
  assert.equal(msg.chatNome, 'Maria Oliveira');
  assert.equal(msg.tipo, 'audio');
  assert.equal(msg.origem, 'pessoal');
  assert.equal(msg.autor, 'Maria Oliveira');
  assert.ok(msg.midiaPath, 'Deve possuir midiaPath');
  assert.ok(fs.existsSync(msg.midiaPath), 'Áudio gravado deve existir');
});

test('Normalização: Baileys JSON', async () => {
  const fixture = lerFixture('baileys.json');
  assert.equal(detectarProvedor(fixture), 'baileys');

  const msg = await normalizar(fixture, 'baileys', {
    midiaDir: path.join(TEST_TMP_DIR, 'midia'),
  });

  assert.equal(msg.id, 'BAILEYS_MSG_201');
  assert.equal(msg.chatNome, 'Comunidade Clientes VIP');
  assert.equal(msg.tipo, 'texto');
  assert.equal(msg.origem, 'grupo');
  assert.equal(msg.autor, 'Lucas Gestor');
  assert.match(msg.texto, /link da reunião/);
});

test('Normalização: Encaminhamento manual ({texto, de, chatNome?})', async () => {
  const fixture = lerFixture('encaminhamento-manual.json');
  assert.equal(detectarProvedor(fixture), 'encaminhamento-manual');

  const msg = await normalizar(fixture, 'encaminhamento-manual', {
    midiaDir: path.join(TEST_TMP_DIR, 'midia'),
  });

  assert.ok(msg.id.startsWith('manual-'));
  assert.equal(msg.chatNome, 'Encaminhado Pessoal');
  assert.equal(msg.tipo, 'texto');
  assert.equal(msg.origem, 'encaminhada');
  assert.equal(msg.autor, 'Alice');
  assert.match(msg.texto, /razão social da empresa/);
});

test('Handler Webhook: Validação de token e erro 401 sem token válido', async () => {
  const token = 'secreto_balde_123';
  const mensagensPath = path.join(TEST_TMP_DIR, 'mensagens.jsonl');

  const handler = criarHandlerWebhook({
    token,
    mensagensPath,
  });

  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    // 1. POST sem token → deve retornar 401
    const resSemToken = await fetch(`http://localhost:${port}/webhook/evolution`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lerFixture('evolution-texto.json')),
    });
    assert.equal(resSemToken.status, 401, 'Request sem token deve retornar 401');

    // 2. POST com token errado → deve retornar 401
    const resTokenErrado = await fetch(`http://localhost:${port}/webhook/evolution`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-token': 'token_errado',
      },
      body: JSON.stringify(lerFixture('evolution-texto.json')),
    });
    assert.equal(resTokenErrado.status, 401, 'Request com token errado deve retornar 401');

    // 3. POST com token correto no header x-webhook-token → deve retornar 200
    const resValido = await fetch(`http://localhost:${port}/webhook/evolution`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-token': token,
      },
      body: JSON.stringify(lerFixture('evolution-texto.json')),
    });
    assert.equal(resValido.status, 200, 'Request com token correto deve retornar 200');
  } finally {
    server.close();
  }
});

test('Handler Webhook: Verify challenge da WhatsApp Cloud API (GET)', async () => {
  const token = 'meu_token_meta_xyz';
  const handler = criarHandlerWebhook({ token });

  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    // 1. GET challenge com verify_token válido → 200 com texto do challenge
    const challengeCorreto = '1158201444';
    const resValido = await fetch(
      `http://localhost:${port}/webhook/cloud-api?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=${challengeCorreto}`
    );
    assert.equal(resValido.status, 200);
    const bodyValido = await resValido.text();
    assert.equal(bodyValido, challengeCorreto);

    // 2. GET challenge com verify_token inválido → 401
    const resInvalido = await fetch(
      `http://localhost:${port}/webhook/cloud-api?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=${challengeCorreto}`
    );
    assert.equal(resInvalido.status, 401);
  } finally {
    server.close();
  }
});

test('Handler Webhook: Falha fechado (503) quando token não está configurado', async () => {
  const envToken = process.env.BALDE_WEBHOOK_TOKEN;
  const envInseguro = process.env.BALDE_WEBHOOK_INSEGURO;
  delete process.env.BALDE_WEBHOOK_TOKEN;
  delete process.env.BALDE_WEBHOOK_INSEGURO;

  const mensagensPath = path.join(TEST_TMP_DIR, 'mensagens.jsonl');
  const handler = criarHandlerWebhook({ mensagensPath }); // sem token configurado

  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    // 1. POST deve falhar fechado com 503
    const resPost = await fetch(`http://localhost:${port}/webhook/evolution`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lerFixture('evolution-texto.json')),
    });
    assert.equal(resPost.status, 503);
    const corpoPost = await resPost.json();
    assert.equal(corpoPost.error, 'webhook_token_not_configured');

    // 2. GET verify-challenge também deve falhar fechado com 503
    const resGet = await fetch(
      `http://localhost:${port}/webhook/cloud-api?hub.mode=subscribe&hub.challenge=999&hub.verify_token=qualquer`
    );
    assert.equal(resGet.status, 503);
    const corpoGet = await resGet.json();
    assert.equal(corpoGet.error, 'webhook_token_not_configured');
  } finally {
    server.close();
    if (envToken !== undefined) process.env.BALDE_WEBHOOK_TOKEN = envToken;
    if (envInseguro !== undefined) process.env.BALDE_WEBHOOK_INSEGURO = envInseguro;
  }
});

test('Handler Webhook: Modo inseguro em dev local com BALDE_WEBHOOK_INSEGURO=1', async () => {
  const envToken = process.env.BALDE_WEBHOOK_TOKEN;
  const envInseguro = process.env.BALDE_WEBHOOK_INSEGURO;
  delete process.env.BALDE_WEBHOOK_TOKEN;
  process.env.BALDE_WEBHOOK_INSEGURO = '1';

  const mensagensPath = path.join(TEST_TMP_DIR, 'mensagens.jsonl');
  const handler = criarHandlerWebhook({ mensagensPath }); // sem token, mas BALDE_WEBHOOK_INSEGURO=1

  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const resPost = await fetch(`http://localhost:${port}/webhook/evolution`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lerFixture('evolution-texto.json')),
    });
    // Não deve retornar 503 nem 401 no modo inseguro
    assert.equal(resPost.status, 200);
    const corpo = await resPost.json();
    assert.equal(corpo.ok, true);
  } finally {
    server.close();
    if (envToken !== undefined) process.env.BALDE_WEBHOOK_TOKEN = envToken;
    else delete process.env.BALDE_WEBHOOK_TOKEN;
    if (envInseguro !== undefined) process.env.BALDE_WEBHOOK_INSEGURO = envInseguro;
    else delete process.env.BALDE_WEBHOOK_INSEGURO;
  }
});

test('Handler Webhook: Deduplicação por id — mesmo payload enviado 2x resulta em 1 linha só em mensagens.jsonl', async () => {
  const token = 'token_teste';
  const mensagensPath = path.join(TEST_TMP_DIR, 'mensagens.jsonl');
  const midiaDir = path.join(TEST_TMP_DIR, 'midia');

  let enriquecerChamado = 0;
  let processarChamado = 0;

  const handler = criarHandlerWebhook({
    token,
    mensagensPath,
    midiaDir,
    enriquecer: async (msg) => {
      enriquecerChamado++;
      return msg;
    },
    processar: async (msg) => {
      processarChamado++;
    },
  });

  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const payload = lerFixture('evolution-texto.json');

    // Primeiro envio
    const res1 = await fetch(`http://localhost:${port}/webhook/evolution`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-token': token,
      },
      body: JSON.stringify(payload),
    });
    assert.equal(res1.status, 200);
    const corpo1 = await res1.json();
    assert.equal(corpo1.ok, true);
    assert.equal(corpo1.id, 'EVO_MSG_TXT_101');

    // Segundo envio com o MESMO payload
    const res2 = await fetch(`http://localhost:${port}/webhook/evolution`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-token': token,
      },
      body: JSON.stringify(payload),
    });
    assert.equal(res2.status, 200);
    const corpo2 = await res2.json();
    assert.equal(corpo2.ok, true);
    assert.equal(corpo2.duplicada, true);

    // Aguarda microtasks/setImmediate do pipeline assíncrono
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verifica que existe apenas UMA linha em mensagens.jsonl
    assert.ok(fs.existsSync(mensagensPath), 'mensagens.jsonl deve existir');
    const conteudo = fs.readFileSync(mensagensPath, 'utf8');
    const linhas = conteudo.trim().split('\n').filter(Boolean);
    assert.equal(linhas.length, 1, 'Deve conter apenas 1 linha em mensagens.jsonl');

    const gravada = JSON.parse(linhas[0]);
    assert.equal(gravada.id, 'EVO_MSG_TXT_101');
    assert.equal(gravada.chatNome, 'Projeto Alfa - Empresa X');

    // Verifica que enriquecer e processar foram chamados só 1 vez
    assert.equal(enriquecerChamado, 1, 'Enriquecer deve ser chamado apenas 1 vez');
    assert.equal(processarChamado, 1, 'Processar deve ser chamado apenas 1 vez');
  } finally {
    server.close();
  }
});

test('Handler Webhook: Resposta 200 rápida e chamada do pipeline enriquecer + processar', async () => {
  const token = 'token_rapido';
  const mensagensPath = path.join(TEST_TMP_DIR, 'mensagens.jsonl');
  let processado = false;

  const handler = criarHandlerWebhook({
    token,
    mensagensPath,
    enriquecer: async (msg) => {
      // Simula enriquecimento
      msg.transcricao = 'Áudio simulado transcrito com sucesso';
      return msg;
    },
    processar: async (msg) => {
      processado = true;
      assert.equal(msg.transcricao, 'Áudio simulado transcrito com sucesso');
    },
  });

  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const payload = lerFixture('cloud-api-texto.json');

    const inicio = Date.now();
    const res = await fetch(`http://localhost:${port}/webhook/cloud-api`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-balde-token': token,
      },
      body: JSON.stringify(payload),
    });
    const duracao = Date.now() - inicio;

    assert.equal(res.status, 200);
    // Deve responder rápido (bem abaixo de 100ms em localhost)
    assert.ok(duracao < 500, `Resposta HTTP deve ser rápida (< 500ms), durou ${duracao}ms`);

    // Aguarda o pipeline assíncrono
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(processado, true, 'Processar deve ter sido executado em segundo plano');
  } finally {
    server.close();
  }
});

// GB-28: o url da Evolution é o CDN do WhatsApp (criptografado) — a mídia vem decifrada pela Evolution
function payloadImagemCriptografada() {
  return {
    event: 'messages.upsert',
    data: {
      key: { remoteJid: '120363025348923456@g.us', fromMe: false, id: 'EVO_IMG_ENC_1', participant: '5511999999999@s.whatsapp.net' },
      pushName: 'Ana Paula',
      messageType: 'imageMessage',
      messageTimestamp: 1760000000,
      message: { imageMessage: {
        url: 'https://mmg.whatsapp.net/o1/v/t24/f2/m234/abc.enc?ccb=11-4',
        mimetype: 'image/jpeg',
        mediaKey: 'AAAA',
        caption: 'olha',
      } },
    },
  };
}

test('GB-28: Evolution imagem criptografada → decifra via getBase64FromMediaMessage', async () => {
  const JPEG = Buffer.from('ffd8ffe000104a464946000101000001', 'hex');
  const chamadas = [];
  const midiaDeps = {
    env: { BALDE_EVOLUTION_URL: 'https://evo.exemplo.test/', BALDE_EVOLUTION_KEY: 'k', BALDE_EVOLUTION_INSTANCIA: 'inst' },
    fetch: async (url, init) => {
      chamadas.push({ url, body: JSON.parse(init.body), apikey: init.headers.apikey });
      return { ok: true, status: 201, json: async () => ({ mimetype: 'image/jpeg', base64: JPEG.toString('base64') }) };
    },
  };
  const midiaDir = path.join(TEST_TMP_DIR, 'midia');
  const msg = await normalizar(payloadImagemCriptografada(), 'evolution', { midiaDir, midiaDeps });

  assert.equal(msg.tipo, 'imagem');
  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0].url, 'https://evo.exemplo.test/chat/getBase64FromMediaMessage/inst');
  assert.deepEqual(chamadas[0].body.message.key, { id: 'EVO_IMG_ENC_1' });
  assert.ok(msg.midiaPath);
  assert.deepEqual(fs.readFileSync(msg.midiaPath), JPEG, 'grava os bytes decifrados, não o .enc do CDN');
});

test('GB-28: Evolution indisponível → não grava o arquivo criptografado do CDN', async () => {
  const urls = [];
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = async (url) => { urls.push(String(url)); return { ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(8) }; };
  try {
    const midiaDeps = { env: {}, fetch: globalThis.fetch };
    const midiaDir = path.join(TEST_TMP_DIR, 'midia');
    const msg = await normalizar(payloadImagemCriptografada(), 'evolution', { midiaDir, midiaDeps });
    assert.equal(msg.tipo, 'imagem');
    assert.equal(msg.midiaPath, undefined);
    assert.ok(!urls.some(u => u.includes('whatsapp.net')), 'não baixa o .enc');
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});
