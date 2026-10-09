/**
 * @file store.test.mjs — GB-24 A2: chatId nunca escapa de dados/contextos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { criarStore, chatIdValido } from '../lib/store.mjs';

test('chatIdValido aceita jids e ids internos, rejeita traversal', () => {
  for (const ok of ['120363000000000000@g.us', '5511999999999@s.whatsapp.net', 'manual', 'acme-site-001', 'a.b_c+d']) {
    assert.equal(chatIdValido(ok), true, ok);
  }
  for (const ruim of ['../../X', '..', 'a/b', 'a\\b', '', 'a b', 'x..y', null, undefined, 42]) {
    assert.equal(chatIdValido(ruim), false, String(ruim));
  }
});

test('salvarContexto com chatId ../ lança e não escreve fora de dados/', () => {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'balde-store-'));
  const antes = process.env.BALDE_DADOS;
  delete process.env.BALDE_DADOS;
  try {
    const store = criarStore(raiz);
    assert.throws(() => store.salvarContexto({ chatId: '../../X', mensagens: [] }), /chatId inválido/);
    assert.throws(() => store.salvarContexto({ chatId: '../fora', mensagens: [] }), /chatId inválido/);
    assert.equal(fs.existsSync(path.join(raiz, 'X.json')), false);
    assert.equal(fs.existsSync(path.join(raiz, 'dados', 'fora.json')), false);
    assert.equal(store.lerContexto('../../X'), null);

    store.salvarContexto({ chatId: '120363000000000000@g.us', mensagens: [] });
    assert.deepEqual(store.lerContexto('120363000000000000@g.us'), { chatId: '120363000000000000@g.us', mensagens: [] });
    assert.ok(fs.existsSync(path.join(raiz, 'dados', 'contextos', '120363000000000000@g.us.json')));
  } finally {
    if (antes !== undefined) process.env.BALDE_DADOS = antes;
    fs.rmSync(raiz, { recursive: true, force: true });
  }
});
