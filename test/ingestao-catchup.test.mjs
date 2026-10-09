import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Catch-up paginado da Evolution: nada aqui fala com a Evolution real (fetch mockado)
const GRUPO_A = '120363000000000001@g.us';
const GRUPO_B = '120363000000000002@g.us';
const AGORA = Date.UTC(2026, 9, 7, 12, 0, 0);
const AGORA_S = AGORA / 1000;
const HORA = 3600;

let tmp, configDir, cursorPath, mensagensPath, fetchOriginal;
let historico; // todas as mensagens "no servidor"
let chamadas;

function msg(jid, id, ts, texto = id) {
  return {
    key: { id, remoteJid: jid, fromMe: false, participant: '5511999999999@s.whatsapp.net' },
    pushName: 'Fulano',
    message: { conversation: texto },
    messageType: 'conversation',
    messageTimestamp: ts,
  };
}

/** Imita /chat/findMessages desta Evolution: where.key.remoteJid, page/offset, mais recentes primeiro. */
function fetchMock(url, init) {
  assert.match(String(url), /\/chat\/findMessages\/Inst$/);
  const corpo = JSON.parse(init.body);
  chamadas.push(corpo);
  const jid = corpo.where?.key?.remoteJid;
  const todas = historico.filter((m) => m.key.remoteJid === jid).sort((a, b) => b.messageTimestamp - a.messageTimestamp);
  const offset = corpo.offset || 50;
  const page = corpo.page || 1;
  const records = todas.slice((page - 1) * offset, page * offset);
  const resposta = { messages: { total: todas.length, pages: Math.ceil(todas.length / offset), currentPage: page, records } };
  return Promise.resolve(new Response(JSON.stringify(resposta), { status: 200, headers: { 'Content-Type': 'application/json' } }));
}

let n = 0;
async function carregarModulo() {
  // Query string nova = instância nova do módulo (ids vistos zerados, como num reinício)
  return import(`../lib/ingestao/evolution.mjs?reinicio=${++n}`);
}

function opcoes(processadas) {
  return { cursorPath, mensagensPath, processar: async (m) => { processadas.push(m); } };
}

const sincronizar = (mod, processadas) =>
  mod.sincronizarEvolution({ url: 'http://evolution.teste', key: 'k', inst: 'Inst', opcoes: opcoes(processadas), agora: AGORA });

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'balde-catchup-'));
  configDir = path.join(tmp, 'config');
  fs.mkdirSync(configDir);
  process.env.BALDE_CONFIG = configDir;
  fetchOriginal = globalThis.fetch;
  globalThis.fetch = fetchMock;
});

after(() => {
  globalThis.fetch = fetchOriginal;
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach((t) => {
  const dir = fs.mkdtempSync(path.join(tmp, 'caso-'));
  cursorPath = path.join(dir, 'evolution-cursor.json');
  mensagensPath = path.join(dir, 'mensagens.jsonl');
  fs.writeFileSync(path.join(configDir, 'grupos.json'), JSON.stringify([{ jid: GRUPO_A }]));
  fs.writeFileSync(path.join(configDir, 'clientes.json'), '[]');
  historico = [];
  chamadas = [];
  delete process.env.BALDE_CATCHUP_TETO;
  delete process.env.BALDE_CATCHUP_DIAS;
});

test('Catch-up: 3 páginas após downtime → todas processadas em ordem e o cursor avança', async () => {
  const cursorTs = AGORA_S - 10 * HORA;
  fs.writeFileSync(cursorPath, JSON.stringify({ [GRUPO_A]: { ts: cursorTs, ids: ['velha-0'] } }));
  historico.push(msg(GRUPO_A, 'velha-0', cursorTs), msg(GRUPO_A, 'velha-1', cursorTs - 60));
  // 130 mensagens depois do cursor = 3 páginas de 50
  for (let i = 1; i <= 130; i++) historico.push(msg(GRUPO_A, `dt-${i}`, cursorTs + i * 60));
  historico.push(msg(GRUPO_B, 'outro-grupo', cursorTs + 30)); // grupo não autorizado

  const mod = await carregarModulo();
  const processadas = [];
  const r = await sincronizar(mod, processadas);

  assert.equal(r.processadas, 130);
  assert.deepEqual(processadas.map((m) => m.id), Array.from({ length: 130 }, (_, i) => `dt-${i + 1}`));
  assert.deepEqual(chamadas.map((c) => c.page), [1, 2, 3]);
  assert.ok(chamadas.every((c) => c.where.key.remoteJid === GRUPO_A));
  const cursor = JSON.parse(fs.readFileSync(cursorPath, 'utf8'));
  assert.deepEqual(cursor[GRUPO_A], { ts: cursorTs + 130 * 60, ids: ['dt-130'] });
  assert.equal(fs.readFileSync(mensagensPath, 'utf8').trim().split('\n').length, 130);
});

test('Catch-up: grupo novo sem cursor ignora mensagens com mais de BALDE_CATCHUP_DIAS (padrão 15)', async () => {
  const DIA = 24 * HORA;
  historico.push(
    msg(GRUPO_A, 'antiga-20d', AGORA_S - 20 * DIA),
    msg(GRUPO_A, 'antiga-15d1h', AGORA_S - 15 * DIA - HORA),
    msg(GRUPO_A, 'recente-14d', AGORA_S - 14 * DIA),
    msg(GRUPO_A, 'recente-1h', AGORA_S - HORA),
  );
  const mod = await carregarModulo();
  const processadas = [];
  await sincronizar(mod, processadas);
  assert.deepEqual(processadas.map((m) => m.id), ['recente-14d', 'recente-1h']);

  // Grupo novo e silencioso também ganha cursor (o piso), para um downtime longo não abrir buraco
  fs.writeFileSync(path.join(configDir, 'grupos.json'), JSON.stringify([{ jid: GRUPO_A }, { jid: GRUPO_B }]));
  await sincronizar(mod, []);
  const cursor = JSON.parse(fs.readFileSync(cursorPath, 'utf8'));
  assert.equal(cursor[GRUPO_B].ts, AGORA_S - 15 * DIA);
});

test('Catch-up: BALDE_CATCHUP_DIAS=2 encurta a janela do grupo novo', async () => {
  process.env.BALDE_CATCHUP_DIAS = '2';
  historico.push(msg(GRUPO_A, 'antiga-49h', AGORA_S - 49 * HORA), msg(GRUPO_A, 'recente-47h', AGORA_S - 47 * HORA));
  const mod = await carregarModulo();
  const processadas = [];
  await sincronizar(mod, processadas);
  assert.deepEqual(processadas.map((m) => m.id), ['recente-47h']);
});

test('Catch-up: reinício não reprocessa nada (nem a mensagem no mesmo segundo do cursor)', async () => {
  const base = AGORA_S - 5 * HORA;
  historico.push(msg(GRUPO_A, 'm1', base), msg(GRUPO_A, 'm2', base + 10), msg(GRUPO_A, 'm3', base + 10));

  const primeira = [];
  await sincronizar(await carregarModulo(), primeira);
  assert.deepEqual(primeira.map((m) => m.id), ['m1', 'm2', 'm3']);

  // Reinício: módulo novo (ids vistos em memória zerados), só o cursor em disco
  const segunda = [];
  const r = await sincronizar(await carregarModulo(), segunda);
  assert.equal(r.processadas, 0);
  assert.deepEqual(segunda, []);

  // Chega uma nova no mesmo segundo do cursor → só ela entra
  historico.push(msg(GRUPO_A, 'm4', base + 10));
  const terceira = [];
  await sincronizar(await carregarModulo(), terceira);
  assert.deepEqual(terceira.map((m) => m.id), ['m4']);
});

test('Catch-up: teto por ciclo processa as mais antigas, registra no log e termina no ciclo seguinte', async (t) => {
  process.env.BALDE_CATCHUP_TETO = '40';
  const cursorTs = AGORA_S - 20 * HORA;
  fs.writeFileSync(cursorPath, JSON.stringify({ [GRUPO_A]: { ts: cursorTs, ids: [] } }));
  for (let i = 1; i <= 70; i++) historico.push(msg(GRUPO_A, `t-${i}`, cursorTs + i));
  const avisos = [];
  t.mock.method(console, 'warn', (...a) => avisos.push(a.join(' ')));

  const mod = await carregarModulo();
  const ciclo1 = [];
  const r1 = await sincronizar(mod, ciclo1);
  assert.deepEqual(r1.pendentes, [GRUPO_A]);
  assert.deepEqual(ciclo1.map((m) => m.id), Array.from({ length: 40 }, (_, i) => `t-${i + 1}`));
  assert.ok(avisos.some((a) => a.includes('teto de 40')));

  const ciclo2 = [];
  const r2 = await sincronizar(mod, ciclo2);
  assert.deepEqual(r2.pendentes, []);
  assert.deepEqual(ciclo2.map((m) => m.id), Array.from({ length: 30 }, (_, i) => `t-${i + 41}`));
});

test('Catch-up: falha da API não avança o cursor do grupo', async (t) => {
  const cursorTs = AGORA_S - HORA;
  fs.writeFileSync(cursorPath, JSON.stringify({ [GRUPO_A]: { ts: cursorTs, ids: [] } }));
  historico.push(msg(GRUPO_A, 'f-1', cursorTs + 5));
  t.mock.method(console, 'error', () => {});
  globalThis.fetch = () => Promise.resolve(new Response('erro', { status: 500 }));
  try {
    const processadas = [];
    const r = await sincronizar(await carregarModulo(), processadas);
    assert.deepEqual(r.pendentes, [GRUPO_A]);
    assert.deepEqual(processadas, []);
    assert.equal(JSON.parse(fs.readFileSync(cursorPath, 'utf8'))[GRUPO_A].ts, cursorTs);
  } finally {
    globalThis.fetch = fetchMock;
  }
});
