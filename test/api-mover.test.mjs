/**
 * @file api-mover.test.mjs — GB-32: mover tarefa para outra empresa·projeto pelo PATCH.
 * Roda com: node --test test/api-mover.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { criarApi } from '../lib/api.mjs';

const GRUPOS = `| Empresa | Projeto | Link do grupo | Ganho R$/mês | Início | Fim | Tipo |
|---|---|---|---|---|---|---|
| Acme | Site | 120363000000000001@g.us | 1.000,00 | | | cliente |
| Acme | App | 120363000000000002@g.us | | | | cliente |
| Beta | API | 120363000000000003@g.us | | | | cliente |
`;

function criarStoreMock() {
  const db = new Map();
  return {
    async listarTarefas() { return [...db.values()]; },
    async atualizarTarefa(id, campos) {
      const agora = new Date().toISOString();
      const atualizada = { ...(db.get(id) ?? { id, criadaEm: agora }), ...campos, id, atualizadaEm: agora };
      db.set(id, atualizada);
      return atualizada;
    },
    _db: db,
  };
}

function patch(server, id, corpo, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(corpo);
    const r = http.request({
      hostname: '127.0.0.1', port: server.address().port, method: 'PATCH', path: `/api/tarefas/${id}`,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
    }, res => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
    });
    r.on('error', reject);
    r.end(payload);
  });
}

describe('PATCH /api/tarefas/:id — mover (GB-32)', () => {
  let server, store, tmp;
  const fontes = [{ mensagemId: 'm1', chatId: 'chat-acme' }];

  before(async () => {
    store = criarStoreMock();
    tmp = mkdtempSync(join(tmpdir(), 'balde-mover-'));
    writeFileSync(join(tmp, 'GRUPOS.md'), GRUPOS);
    server = http.createServer(criarApi({
      store, lerClientes: () => [], gruposMdPath: join(tmp, 'GRUPOS.md'),
      destinosPath: join(tmp, 'DESTINOS.md'), listarGruposEvolution: async () => [],
    }));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
  });

  after(async () => {
    await new Promise(r => server.close(r));
    rmSync(tmp, { recursive: true, force: true });
  });

  const nova = id => store.atualizarTarefa(id, { empresa: 'Acme', projeto: 'Site', titulo: 'x', estado: 'pronta', fontes, chatId: 'chat-acme' });

  it('par válido → move, grava movidaDe e mantém fontes', async () => {
    await nova('a1');
    const { status, body } = await patch(server, 'a1', { empresa: 'Beta', projeto: 'API' });
    assert.equal(status, 200);
    assert.equal(body.tarefa.empresa, 'Beta');
    assert.equal(body.tarefa.projeto, 'API');
    assert.equal(body.tarefa.movidaDe.empresa, 'Acme');
    assert.equal(body.tarefa.movidaDe.projeto, 'Site');
    assert.ok(body.tarefa.movidaDe.em);
    assert.deepEqual(body.tarefa.fontes, fontes);
    assert.equal(body.tarefa.chatId, 'chat-acme');
  });

  it('projeto Avulso de empresa do GRUPOS.md → aceito', async () => {
    await nova('a2');
    const { status, body } = await patch(server, 'a2', { empresa: 'Beta', projeto: 'Avulso' });
    assert.equal(status, 200);
    assert.equal(body.tarefa.projeto, 'Avulso');
  });

  it('par que não existe no GRUPOS.md → 400 e nada muda', async () => {
    await nova('a3');
    for (const corpo of [
      { empresa: 'Beta', projeto: 'Site' },       // projeto de outra empresa
      { empresa: 'Zeta', projeto: 'Avulso' },     // empresa fora do GRUPOS.md
      { empresa: 'Acme' },                         // sem projeto
      { empresa: 'Acme', projeto: 42 },
    ]) {
      const { status } = await patch(server, 'a3', corpo);
      assert.equal(status, 400, JSON.stringify(corpo));
    }
    const t = store._db.get('a3');
    assert.equal(t.empresa, 'Acme');
    assert.equal(t.projeto, 'Site');
    assert.equal(t.movidaDe, undefined);
  });

  it('tarefa inexistente → 404 sem criar nada', async () => {
    const { status } = await patch(server, 'nao-existe', { empresa: 'Beta', projeto: 'API' });
    assert.equal(status, 404);
    assert.equal(store._db.has('nao-existe'), false);
  });

  it('mesmo par → 200 sem movidaDe', async () => {
    await nova('a4');
    const { status, body } = await patch(server, 'a4', { empresa: 'Acme', projeto: 'Site', estado: 'em_execucao' });
    assert.equal(status, 200);
    assert.equal(body.tarefa.movidaDe, undefined);
    assert.equal(body.tarefa.estado, 'em_execucao');
  });

  it('Origin de outro site → 403 e não move', async () => {
    await nova('a5');
    const { status } = await patch(server, 'a5', { empresa: 'Beta', projeto: 'API' }, { Origin: 'https://evil.example' });
    assert.equal(status, 403);
    assert.equal(store._db.get('a5').empresa, 'Acme');
  });
});
