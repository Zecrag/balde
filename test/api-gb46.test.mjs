/**
 * @file api-gb46.test.mjs — GB-46 na API: cliente sem grupo pelo PUT /api/projetos,
 * nomes dos grupos com cache em disco (Evolution lenta) e jids do projeto em GET /api/tarefas.
 * Roda com: node --test test/api-gb46.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { criarApi } from '../lib/api.mjs';
import { CABECALHO_TABELA } from '../lib/config.mjs';

const J1 = '120363000000000001@g.us';
const J2 = '120363000000000002@g.us';
const GRUPOS = `# Grupos\n\n${CABECALHO_TABELA}
|---|---|---|---|---|---|---|---|
| Acme | Site | ${J1} | 1.000,00 | | | cliente | ativo |
| Beta | Ads | ${J2} | | | | cliente | ativo |
`;

function req(server, method, path, corpo) {
  return new Promise((resolve, reject) => {
    const payload = corpo === undefined ? '' : JSON.stringify(corpo);
    const r = http.request({
      hostname: '127.0.0.1', port: server.address().port, method, path,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }));
    });
    r.on('error', reject);
    r.end(payload);
  });
}

async function subir(opts) {
  const server = http.createServer(criarApi(opts));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return server;
}
const fechar = s => new Promise(r => s.close(r));
const esperar = ms => new Promise(r => setTimeout(r, ms));
const store = { async listarTarefas() { return []; }, async atualizarTarefa(id, c) { return { id, ...c }; } };

describe('GB-46 — API', () => {
  let tmp, md, cache;
  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'balde-api-gb46-'));
    md = join(tmp, 'GRUPOS.md');
    cache = join(tmp, 'config', 'nomes-grupos.json');
  });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it('PUT /api/projetos aceita cliente novo sem grupo', async () => {
    writeFileSync(md, GRUPOS);
    const server = await subir({ store, gruposMdPath: md, nomesCachePath: null, listarGruposEvolution: async () => [] });
    try {
      const { body: atual } = await req(server, 'GET', '/api/projetos');
      const linhas = [...atual.linhas.map(({ jid, grupoNome, ...l }) => l),
        { empresa: 'Nova', projeto: 'Geral', link: '', ganho: '300,00', inicio: '', fim: '', tipo: 'cliente', status: 'ativo' }];
      const r = await req(server, 'PUT', '/api/projetos', { linhas, versao: atual.versao });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.ok(readFileSync(md, 'utf8').includes('| Nova | Geral | | 300,00 | | | cliente | ativo |'));
      const nova = r.body.linhas.find(l => l.empresa === 'Nova');
      assert.equal(nova.jid, null);
    } finally { await fechar(server); }
  });

  it('nome do grupo vem do cache em disco na hora, mesmo com a Evolution lenta', async () => {
    writeFileSync(md, GRUPOS);
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(tmp, 'config'), { recursive: true });
    writeFileSync(cache, JSON.stringify({ [J1]: 'Grupo Acme (cache)' }));
    let lenta;
    const server = await subir({
      store, gruposMdPath: md, nomesCachePath: cache,
      listarGruposEvolution: () => new Promise(r => { lenta = r; }),
    });
    try {
      const t0 = Date.now();
      const { body } = await req(server, 'GET', '/api/projetos');
      assert.equal(body.linhas[0].grupoNome, 'Grupo Acme (cache)');
      assert.equal(body.nomesPendentes, true, 'J2 ainda sem nome');
      assert.ok(Date.now() - t0 < 2500);
      // Evolution responde: cache em disco ganha o nome novo e o GET seguinte já traz os dois
      lenta([{ jid: J1, nome: 'Grupo Acme' }, { jid: J2, nome: 'Grupo Beta' }]);
      await esperar(50);
      const { body: depois } = await req(server, 'GET', '/api/projetos');
      assert.deepEqual(depois.linhas.map(l => l.grupoNome), ['Grupo Acme', 'Grupo Beta']);
      assert.equal(depois.nomesPendentes, false);
      assert.deepEqual(JSON.parse(readFileSync(cache, 'utf8')), { [J1]: 'Grupo Acme', [J2]: 'Grupo Beta' });
    } finally { await fechar(server); }
  });

  it('com todos os nomes no cache, não espera a Evolution nem marca pendente', async () => {
    writeFileSync(md, GRUPOS);
    writeFileSync(cache, JSON.stringify({ [J1]: 'A', [J2]: 'B' }));
    const server = await subir({ store, gruposMdPath: md, nomesCachePath: cache, listarGruposEvolution: () => new Promise(() => {}) });
    try {
      const t0 = Date.now();
      const { body } = await req(server, 'GET', '/api/projetos');
      assert.ok(Date.now() - t0 < 1000);
      assert.equal(body.nomesPendentes, false);
      assert.deepEqual(body.linhas.map(l => l.grupoNome), ['A', 'B']);
    } finally { await fechar(server); }
  });

  it('busca de grupos também atualiza o cache de nomes', async () => {
    writeFileSync(md, GRUPOS);
    rmSync(cache, { force: true });
    const server = await subir({ store, gruposMdPath: md, nomesCachePath: cache, listarGruposEvolution: async () => [{ jid: '9@g.us', nome: 'Grupo Nove' }] });
    try {
      const r = await req(server, 'GET', '/api/grupos/buscar?q=nove');
      assert.equal(r.status, 200);
      await esperar(50);
      assert.ok(existsSync(cache));
      assert.equal(JSON.parse(readFileSync(cache, 'utf8'))['9@g.us'], 'Grupo Nove');
    } finally { await fechar(server); }
  });

  it('GET /api/tarefas traz os jids de cada projeto (botão "Ler este grupo")', async () => {
    writeFileSync(md, GRUPOS);
    const server = await subir({
      store, gruposMdPath: md, nomesCachePath: null,
      lerClientes: () => [
        { empresa: 'Acme', projeto: 'Site', grupos: [J1], receitaMensal: 1000 },
        { empresa: 'Nova', projeto: 'Geral', grupos: [], receitaMensal: 0 },
      ],
    });
    try {
      const { body } = await req(server, 'GET', '/api/tarefas');
      const proj = Object.fromEntries(body.empresas.flatMap(e => e.projetos.map(p => [`${e.empresa}·${p.projeto}`, p.grupos])));
      assert.deepEqual(proj['Acme·Site'], [J1]);
      assert.deepEqual(proj['Nova·Geral'], []);
    } finally { await fechar(server); }
  });
});
