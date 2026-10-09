/**
 * @file api-seguranca.test.mjs — GB-25: a API do Balde não aceita ordens de outros sites.
 * Roda com: node --test test/api-seguranca.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { criarApi, hostLoopback } from '../lib/api.mjs';

function criarStoreMock() {
  const db = new Map([['t1', { id: 't1', titulo: 'Tarefa', estado: 'pronta' }]]);
  return {
    async listarTarefas() { return [...db.values()]; },
    async atualizarTarefa(id, campos) {
      const t = { ...(db.get(id) ?? { id }), ...campos, id };
      db.set(id, t);
      return t;
    },
    async listarMensagens() { return []; },
    async gravarDistribuicao() {},
    _db: db,
  };
}

/** Request cru: headers exatamente como passados (Host incluso). */
function req(server, { method = 'GET', path = '/', headers = {}, corpo } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: '127.0.0.1', port: server.address().port, method, path, headers }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let body;
        try { body = JSON.parse(data); } catch { body = data; }
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    r.on('error', reject);
    if (corpo !== undefined) r.write(corpo);
    r.end();
  });
}

async function subir(opts) {
  const tmp = mkdtempSync(join(tmpdir(), 'balde-seg-'));
  writeFileSync(join(tmp, 'DESTINOS.md'), '| n8n | webhook | https://n8n.exemplo/x |\n');
  const abertos = [];
  const store = criarStoreMock();
  const server = http.createServer(criarApi({
    store,
    lerClientes: () => [],
    gruposMdPath: join(tmp, 'GRUPOS.md'),
    abrirArquivo: p => abertos.push(p),
    destinosPath: join(tmp, 'DESTINOS.md'),
    ...opts,
  }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, store, abertos, tmp, porta: server.address().port };
}

const JSON_CT = { 'Content-Type': 'application/json' };

describe('API — proteção contra outros sites (loopback)', () => {
  let ctx;
  before(async () => { ctx = await subir({ host: '127.0.0.1' }); });
  after(async () => {
    await new Promise(r => ctx.server.close(r));
    rmSync(ctx.tmp, { recursive: true, force: true });
  });

  it('PATCH com Origin de outro site → 403 e nada muda', async () => {
    const r = await req(ctx.server, {
      method: 'PATCH', path: '/api/tarefas/t1',
      headers: { ...JSON_CT, Origin: 'http://evil.com' }, corpo: JSON.stringify({ estado: 'feita' }),
    });
    assert.equal(r.status, 403);
    assert.equal(ctx.store._db.get('t1').estado, 'pronta');
  });

  it('POST distribuir e config/abrir com Origin de outro site → 403', async () => {
    for (const path of ['/api/tarefas/t1/distribuir', '/api/config/abrir']) {
      const r = await req(ctx.server, {
        method: 'POST', path, headers: { ...JSON_CT, Origin: 'http://evil.com' }, corpo: '{"nome":"n8n"}',
      });
      assert.equal(r.status, 403, path);
    }
    assert.deepEqual(ctx.abertos, []);
  });

  it('escrita sem Content-Type JSON (form simples cross-site) → 403', async () => {
    const r = await req(ctx.server, {
      method: 'POST', path: '/api/config/abrir',
      headers: { 'Content-Type': 'text/plain' }, corpo: '{}',
    });
    assert.equal(r.status, 403);
    assert.deepEqual(ctx.abertos, []);
  });

  it('Host estranho (DNS rebinding) → 403, inclusive em GET e no painel', async () => {
    for (const path of ['/api/tarefas', '/']) {
      const r = await req(ctx.server, { path, headers: { Host: 'evil.com' } });
      assert.equal(r.status, 403, path);
    }
    const r = await req(ctx.server, { path: '/api/tarefas', headers: { Host: `evil.com:${ctx.porta}` } });
    assert.equal(r.status, 403);
  });

  it('nenhuma resposta libera CORS (sem Access-Control-Allow-Origin)', async () => {
    const respostas = [
      await req(ctx.server, { path: '/api/tarefas' }),
      await req(ctx.server, { method: 'OPTIONS', path: '/api/tarefas/t1', headers: { Origin: 'http://evil.com' } }),
      await req(ctx.server, { method: 'PATCH', path: '/api/tarefas/t1', headers: JSON_CT, corpo: '{}' }),
    ];
    for (const r of respostas) assert.equal(r.headers['access-control-allow-origin'], undefined);
  });

  it('painel same-origin funciona: GET, PATCH e POST com Origin do próprio painel', async () => {
    for (const host of [`127.0.0.1:${ctx.porta}`, `localhost:${ctx.porta}`]) {
      const origem = { ...JSON_CT, Host: host, Origin: `http://${host}` };
      assert.equal((await req(ctx.server, { path: '/', headers: { Host: host } })).status, 200);
      assert.equal((await req(ctx.server, { path: '/api/tarefas', headers: { Host: host } })).status, 200);
      const p = await req(ctx.server, { method: 'PATCH', path: '/api/tarefas/t1', headers: origem, corpo: '{"responsavel":"eu"}' });
      assert.equal(p.status, 200);
      assert.equal(p.body.tarefa.responsavel, 'eu');
      const a = await req(ctx.server, { method: 'POST', path: '/api/config/abrir', headers: origem, corpo: '{}' });
      assert.equal(a.status, 200);
    }
  });

  it('corpo maior que 1 MB → 413', async () => {
    const grande = JSON.stringify({ descricao: 'x'.repeat(1024 * 1024 + 10) });
    const r = await req(ctx.server, { method: 'PATCH', path: '/api/tarefas/t1', headers: JSON_CT, corpo: grande });
    assert.equal(r.status, 413);
    assert.notEqual(ctx.store._db.get('t1').descricao?.length, 1024 * 1024 + 10);
  });

  it('corpo > 1 MB sem Content-Length (chunked) → 413', async () => {
    const r = await new Promise((resolve, reject) => {
      const rq = http.request({ hostname: '127.0.0.1', port: ctx.porta, method: 'PATCH', path: '/api/tarefas/t1',
        headers: { ...JSON_CT, 'Transfer-Encoding': 'chunked' } }, res => { res.resume(); resolve(res.statusCode); });
      rq.on('error', reject);
      for (let i = 0; i < 20; i++) rq.write('x'.repeat(100 * 1024));
      rq.end();
    });
    assert.equal(r, 413);
  });

  it('estático não sai da pasta do painel', async () => {
    for (const path of ['/painel/..%2f..%2fpackage.json', '/painel/%2e%2e/server.mjs', '/..%2fserver.mjs']) {
      const r = await req(ctx.server, { path });
      assert.equal(r.status, 404, path);
    }
  });
});

describe('API — fora de loopback exige X-Balde-Token', () => {
  let ctx;
  before(async () => { ctx = await subir({ host: '0.0.0.0', token: 'segredo-123' }); });
  after(async () => {
    await new Promise(r => ctx.server.close(r));
    rmSync(ctx.tmp, { recursive: true, force: true });
  });

  it('sem token ou token errado → 401; token certo → 200', async () => {
    assert.equal((await req(ctx.server, { path: '/api/tarefas' })).status, 401);
    assert.equal((await req(ctx.server, { path: '/api/tarefas', headers: { 'X-Balde-Token': 'errado' } })).status, 401);
    assert.equal((await req(ctx.server, { path: '/api/tarefas', headers: { 'X-Balde-Token': 'segredo-123' } })).status, 200);
  });

  it('Origin estranha continua recusada mesmo com token', async () => {
    const r = await req(ctx.server, {
      method: 'PATCH', path: '/api/tarefas/t1',
      headers: { ...JSON_CT, 'X-Balde-Token': 'segredo-123', Origin: 'http://evil.com' }, corpo: '{}',
    });
    assert.equal(r.status, 403);
  });

  it('hostLoopback reconhece loopback', () => {
    for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]']) assert.equal(hostLoopback(h), true, h);
    for (const h of ['0.0.0.0', '::', '192.168.0.10']) assert.equal(hostLoopback(h), false, h);
  });
});
