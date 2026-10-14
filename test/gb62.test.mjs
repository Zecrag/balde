/**
 * @file test/gb62.test.mjs
 * Revisão de segurança dos avisos por WhatsApp (GB-62):
 * 1. fetch da Evolution não segue redirect (o header apikey iria para outro host).
 * 2. Erros de destino recusado não carregam o número completo.
 * 3. Agendador: tick atrasado ainda dispara (até TOLERANCIA_MINUTOS), horas depois não;
 *    o mesmo horário salvo de novo com outro id não repete no dia.
 * 4. GET /api/avisos/log limita o tamanho pedido.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';

import {
  enviarMensagemEvolution,
  iniciarAgendadorAvisos,
  gravarConfigAvisos,
  gravarLogAvisos,
  TOLERANCIA_MINUTOS,
} from '../lib/avisos.mjs';
import { criarApi } from '../lib/api.mjs';

const NUMERO = '5511999998888';
const ENV = {
  BALDE_EVOLUTION_URL: 'https://evolution.mock',
  BALDE_EVOLUTION_KEY: 'chave-secreta-mock',
  BALDE_EVOLUTION_INSTANCIA: 'inst-1',
};

describe('GB-62 — envio pela Evolution', () => {
  it('pede ao fetch para recusar redirect', async () => {
    let init;
    await enviarMensagemEvolution({
      numero: NUMERO,
      texto: 'oi',
      numerosPermitidos: [NUMERO],
      env: ENV,
      fetch: async (_url, i) => { init = i; return { ok: true, json: async () => ({}) }; },
    });
    assert.equal(init.redirect, 'error');
  });

  it('erros de destino recusado não expõem o número completo', async () => {
    const casos = [
      { numero: `${NUMERO}@g.us`, permitidos: [NUMERO] },
      { numero: `+${NUMERO}`, permitidos: [NUMERO] },
      { numero: '5511999997777', permitidos: [NUMERO] },
    ];
    for (const c of casos) {
      await assert.rejects(
        () => enviarMensagemEvolution({ numero: c.numero, texto: 'x', numerosPermitidos: c.permitidos, env: ENV, fetch: async () => { throw new Error('não deveria chamar'); } }),
        err => !err.message.includes('999998888') && !err.message.includes('999997777'),
      );
    }
  });
});

describe('GB-62 — agendador', () => {
  let dir;
  let chamadas;
  const store = { lerTarefas: () => [], listarTarefas: async () => [] };
  const fetchMock = async () => { chamadas++; return { ok: true, json: async () => ({}) }; };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gb62-'));
    chamadas = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function config(horarios) {
    gravarConfigAvisos({ dadosDir: dir, corpo: { ativo: true, numeros: [NUMERO], horarios } });
  }

  it('dispara com tick atrasado dentro da tolerância e não horas depois', async () => {
    config([{ id: 'h1', hora: '18:00', tipo: 'resumo', ativo: true }]);
    const ag = iniciarAgendadorAvisos({ dadosDir: dir, store, fetch: fetchMock, env: ENV });
    try {
      // 21:00 em São Paulo: muito tarde, não dispara (restart à noite não manda o resumo das 18h).
      assert.equal((await ag.tick(new Date('2026-10-15T00:00:00Z'))).disparados, 0);
      // 18:00 + tolerância: dispara.
      const atrasado = new Date(Date.parse('2026-10-14T21:00:00Z') + TOLERANCIA_MINUTOS * 60_000);
      assert.equal((await ag.tick(atrasado)).disparados, 1);
      // Minuto seguinte, ainda dentro da janela anterior: não repete.
      assert.equal((await ag.tick(new Date('2026-10-14T21:01:00Z'))).disparados, 0);
      assert.equal(chamadas, 1);
    } finally { ag.parar(); }
  });

  it('o mesmo horário salvo de novo com outro id não repete no dia', async () => {
    config([{ id: 'h1', hora: '18:00', tipo: 'resumo', ativo: true }]);
    const ag = iniciarAgendadorAvisos({ dadosDir: dir, store, fetch: fetchMock, env: ENV });
    try {
      assert.equal((await ag.tick(new Date('2026-10-14T21:00:00Z'))).disparados, 1);
      config([{ id: 'outro-id', hora: '18:00', tipo: 'resumo', ativo: true }]);
      assert.equal((await ag.tick(new Date('2026-10-14T21:02:00Z'))).disparados, 0);
      assert.equal(chamadas, 1);
    } finally { ag.parar(); }
  });
});

describe('GB-62 — GET /api/avisos/log', () => {
  it('limita o tamanho pedido a 500 e ignora valores negativos', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb62-log-'));
    const dados = join(dir, 'dados');
    mkdirSync(dados, { recursive: true });
    for (let i = 0; i < 600; i++) gravarLogAvisos(dados, { tipo: 'resumo', numero: '5511*****8888', ok: true, i });
    const handler = criarApi({
      store: { listarTarefas: async () => [], lerTarefas: () => [] },
      lerClientes: () => [],
      dadosDir: dados,
      gruposMdPath: join(dir, 'GRUPOS.md'),
    });
    const servidor = http.createServer(handler);
    await new Promise(r => servidor.listen(0, '127.0.0.1', r));
    const porta = servidor.address().port;
    const get = async q => (await fetch(`http://127.0.0.1:${porta}/api/avisos/log${q}`)).json();
    try {
      assert.equal((await get('?limite=100000')).length, 500);
      const neg = await get('?limite=-5');
      assert.equal(neg.length, 1);
      assert.equal(neg[0].i, 599);
    } finally {
      await new Promise(r => servidor.close(r));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
