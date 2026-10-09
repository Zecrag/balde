/**
 * @file api-arquivar.test.mjs — GB-41: projeto interno (sem grupo), datas dd/mm/aa, ganho total
 * e encerrar/reabrir projeto (PATCH /api/projetos/:chave + arquivados em GET /api/tarefas).
 * Roda com: node --test test/api-arquivar.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { criarApi } from '../lib/api.mjs';

const INSTR = '# Grupos do Balde\n\nInstruções do dono.';
const GRUPOS = `${INSTR}

| Empresa | Projeto | Link do grupo | Ganho R$/mês | Início | Fim | Tipo |
|---|---|---|---|---|---|---|
| Acme | Site | 120363000000000001@g.us | 1.000,00 | 01/01/2026 | 31/12/2026 | cliente |
| Acme | App | 120363000000000002@g.us | 500,00 | | | cliente |
| Beta | API | 120363000000000003@g.us | 9.000,00 | | | cliente |
`;

function criarStoreMock() {
  const db = new Map();
  return {
    async listarTarefas() { return [...db.values()]; },
    async atualizarTarefa(id, campos) {
      const atualizada = { ...(db.get(id) ?? { id }), ...campos, id };
      db.set(id, atualizada);
      return atualizada;
    },
    _db: db,
  };
}

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

const chave = (e, p) => `/api/projetos/${encodeURIComponent(`${e}\t${p}`)}`;

describe('GB-41 — projetos arquivados e internos na API', () => {
  let server, store, tmp, md;

  before(async () => {
    store = criarStoreMock();
    tmp = mkdtempSync(join(tmpdir(), 'balde-arquivar-'));
    md = join(tmp, 'GRUPOS.md');
    writeFileSync(md, GRUPOS);
    // clientes.json simula o que o watcher gera (só projetos ativos).
    const clientes = () => [
      { empresa: 'Acme', projeto: 'Site', receitaMensal: 1000, inicio: '2026-01-01', fim: '2026-12-31' },
      { empresa: 'Acme', projeto: 'App', receitaMensal: 500 },
      { empresa: 'Beta', projeto: 'API', receitaMensal: 9000 },
    ].filter(c => !readFileSync(md, 'utf8').includes(`| ${c.empresa} | ${c.projeto} |`) || !new RegExp(`\\| ${c.empresa} \\| ${c.projeto} \\|.*\\| arquivado \\|`).test(readFileSync(md, 'utf8')));
    server = http.createServer(criarApi({
      store, lerClientes: clientes, gruposMdPath: md,
      destinosPath: join(tmp, 'DESTINOS.md'), listarGruposEvolution: async () => [],
    }));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    for (const [id, empresa, projeto, estado] of [
      ['a1', 'Acme', 'Site', 'pronta'], ['a2', 'Acme', 'App', 'pronta'], ['a3', 'Acme', 'App', 'descartada'],
      ['b1', 'Beta', 'API', 'pronta'], ['b2', 'Beta', 'API', 'feita'],
    ]) await store.atualizarTarefa(id, { titulo: id, empresa, projeto, estado, urgencia: 50 });
  });

  after(async () => {
    await new Promise(r => server.close(r));
    rmSync(tmp, { recursive: true, force: true });
  });

  it('GET /api/tarefas sem arquivados: todos em empresas, arquivados vazio', async () => {
    const { status, body } = await req(server, 'GET', '/api/tarefas');
    assert.equal(status, 200);
    assert.deepEqual(body.empresas.map(e => e.empresa), ['Beta', 'Acme']);
    assert.deepEqual(body.arquivados, []);
    assert.ok(body.tarefas.every(t => t.arquivado === false));
  });

  it('PATCH arquiva: só muda a coluna Status, mantém instruções e passa a tabela ao formato novo', async () => {
    const { status, body } = await req(server, 'PATCH', chave('Acme', 'App'), { status: 'arquivado' });
    assert.equal(status, 200);
    const texto = readFileSync(md, 'utf8');
    assert.ok(texto.startsWith(INSTR));
    assert.match(texto, /\| Ganho total \(R\$\) \|.*\| Status \|/);
    assert.ok(texto.includes('| Acme | App | 120363000000000002@g.us | 500,00 | | | cliente | arquivado |'));
    assert.ok(texto.includes('| Acme | Site | 120363000000000001@g.us | 1.000,00 | 01/01/2026 | 31/12/2026 | cliente | ativo |'),
      'as outras linhas vão como estavam, só ganham a coluna Status');
    assert.equal(body.linhas.find(l => l.projeto === 'App').status, 'arquivado');
  });

  it('GET /api/tarefas: projeto arquivado sai de empresas e vai para arquivados com as tarefas', async () => {
    const { body } = await req(server, 'GET', '/api/tarefas');
    const acme = body.empresas.find(e => e.empresa === 'Acme');
    assert.deepEqual(acme.projetos.map(p => p.projeto), ['Site']);
    assert.equal(acme.ganhoTotal, 1000, 'arquivado não conta no total');
    assert.deepEqual(body.arquivados, [{ empresa: 'Acme', projetos: [{ projeto: 'App', ganho: 500, inicio: null, fim: null, tipo: 'cliente', tarefas: 1 }] }]);
    assert.equal(body.tarefas.find(t => t.id === 'a2').arquivado, true);
    assert.equal(body.tarefas.find(t => t.id === 'a1').arquivado, false);
  });

  it('empresa com todos os projetos arquivados some de empresas', async () => {
    await req(server, 'PATCH', chave('Beta', 'API'), { status: 'arquivado' });
    const { body } = await req(server, 'GET', '/api/tarefas');
    assert.deepEqual(body.empresas.map(e => e.empresa), ['Acme']);
    assert.deepEqual(body.arquivados.map(e => e.empresa), ['Acme', 'Beta']);
  });

  it('não move tarefa para projeto arquivado', async () => {
    const { status, body } = await req(server, 'PATCH', '/api/tarefas/a1', { empresa: 'Beta', projeto: 'API' });
    assert.equal(status, 400);
    assert.match(body.erro, /arquivado/);
  });

  it('Reabrir (status ativo) devolve o projeto', async () => {
    const { status } = await req(server, 'PATCH', chave('Beta', 'API'), { status: 'ativo' });
    assert.equal(status, 200);
    assert.ok(readFileSync(md, 'utf8').includes('| Beta | API | 120363000000000003@g.us | 9.000,00 | | | cliente | ativo |'));
    const { body } = await req(server, 'GET', '/api/tarefas');
    assert.deepEqual(body.empresas.map(e => e.empresa), ['Beta', 'Acme']);
    assert.deepEqual(body.arquivados.map(e => e.empresa), ['Acme']);
  });

  it('PATCH recusa status inválido, chave sem tab, projeto inexistente e versão velha', async () => {
    const antes = readFileSync(md, 'utf8');
    assert.equal((await req(server, 'PATCH', chave('Acme', 'Site'), { status: 'apagado' })).status, 400);
    assert.equal((await req(server, 'PATCH', '/api/projetos/Acme', { status: 'arquivado' })).status, 400);
    assert.equal((await req(server, 'PATCH', chave('Gama', 'X'), { status: 'arquivado' })).status, 404);
    assert.equal((await req(server, 'PATCH', chave('Acme', 'Site'), { status: 'arquivado', versao: '0000000000000000' })).status, 409);
    assert.equal(readFileSync(md, 'utf8'), antes);
  });

  it('PUT aceita projeto interno sem grupo, datas dd/mm/aa e grava ganho total', async () => {
    const { body: atual } = await req(server, 'GET', '/api/projetos');
    const linhas = atual.linhas.map(({ empresa, projeto, link, ganho, inicio, fim, tipo, status }) => ({ empresa, projeto, link, ganho, inicio, fim, tipo, status }));
    linhas.push({ empresa: 'Gama', projeto: 'Interno', link: '', ganho: '1.234,56', inicio: '05/02/26', fim: '', tipo: 'interno', status: '' });
    const { status, body } = await req(server, 'PUT', '/api/projetos', { linhas, versao: atual.versao });
    assert.equal(status, 200, JSON.stringify(body));
    const texto = readFileSync(md, 'utf8');
    assert.ok(texto.includes('| Gama | Interno | | 1.234,56 | 05/02/26 | | interno | ativo |'));
    assert.ok(texto.includes('| Acme | Site | 120363000000000001@g.us | 1.000,00 | 01/01/26 | 31/12/26 | cliente | ativo |'), 'dd/mm/aaaa vira dd/mm/aa ao salvar');
    assert.deepEqual(body.avisos, []);
  });

  it('PUT recusa interno com grupo e data fora do formato', async () => {
    const { status, body } = await req(server, 'PUT', '/api/projetos', { linhas: [
      { empresa: 'Gama', projeto: 'X', link: '120363000000000009@g.us', ganho: '', inicio: '31/02/26', fim: '', tipo: 'interno' },
    ] });
    assert.equal(status, 400);
    assert.deepEqual(body.erros.map(e => e.campo), ['link', 'inicio']);
  });
});
