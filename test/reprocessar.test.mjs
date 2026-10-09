/**
 * reprocessar.test.mjs — GB-28: bin/reprocessar.mjs roda o motor de novo sem duplicar
 * tarefas e recupera a mídia que ficou criptografada no disco.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { criarMensagem } from '../lib/tipos.mjs';
import { criarStore } from '../lib/store.mjs';
import { processar } from '../lib/motor/index.mjs';
import { acumularContexto } from '../lib/motor/contexto.mjs';
import { reprocessar, lerMensagens, parseDuracao, midiaLegivel } from '../bin/reprocessar.mjs';

const CHAT = '120363022222222222@g.us';
const SEM_LLM = { llm: { env: { BALDE_LLM: 'off' } } };
const processarSemLLM = (m, store) => processar(m, store, SEM_LLM);
const JPEG = Buffer.from('ffd8ffe000104a464946000101000001', 'hex');
const ENC = Buffer.from('4e23368c15d4d8266b87a134022d961d', 'hex');

describe('bin/reprocessar.mjs', () => {
  let dir;
  let store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'balde-reproc-'));
    mkdirSync(join(dir, 'dados', 'contextos'), { recursive: true });
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(join(dir, 'config', 'clientes.json'), JSON.stringify([
      { empresa: 'Acme', projeto: 'Site', grupos: ['Acme - Site'], receitaMensal: 5000, pesoUrgencia: 1 },
    ]));
    store = criarStore(dir);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const msg = (n, texto, extra = {}) => criarMensagem({
    id: `r-${n}`, chatId: CHAT, chatNome: 'Acme - Site', autor: 'Cliente', texto,
    ts: new Date(Date.UTC(2026, 9, 8, 12, n)).toISOString(), ...extra,
  });

  const mensagens = () => [
    msg(1, 'Precisamos trocar o banner da home até sexta, urgente.'),
    msg(2, 'Também corrigir o formulário de contato que não envia e-mail.'),
  ];

  it('rodar duas vezes não duplica tarefas nem a janela de contexto', async () => {
    const deps = { store, enriquecer: async m => m, processar: processarSemLLM, acumular: acumularContexto };
    const r1 = await reprocessar({ ...deps, mensagens: mensagens() });
    const tarefas1 = store.lerTarefas();
    assert.ok(tarefas1.length >= 1, 'primeira rodada cria tarefas');
    assert.equal(r1.novas, tarefas1.length);

    const r2 = await reprocessar({ ...deps, mensagens: mensagens() });
    assert.equal(store.lerTarefas().length, tarefas1.length, 'segunda rodada não cria nada');
    assert.equal(r2.novas, 0);

    const ids = store.lerContexto(CHAT).mensagens.map(m => m.id);
    assert.deepEqual(ids, ['r-1', 'r-2'], 'cada mensagem uma vez, em ordem');
  });

  it('--desde corta mensagens antigas', async () => {
    let chamadas = 0;
    const r = await reprocessar({
      store, mensagens: mensagens(), enriquecer: async m => m, acumular: acumularContexto,
      processar: async () => { chamadas++; return { novas: [], atualizadas: [] }; },
      desdeMs: Date.UTC(2026, 9, 8, 12, 2),
    });
    assert.equal(r.mensagens, 1);
    assert.equal(chamadas, 1);
  });

  it('imagem criptografada no disco é baixada de novo pela Evolution antes de enriquecer', async () => {
    const arq = join(dir, 'dados', 'img.jpg');
    writeFileSync(arq, ENC);
    const pedidos = [];
    let vistoNoEnriquecer;
    const r = await reprocessar({
      store, acumular: acumularContexto, processar: processarSemLLM,
      mensagens: [msg(3, '', { tipo: 'imagem', midiaPath: arq })],
      baixarMidia: async id => { pedidos.push(id); return JPEG; },
      enriquecer: async m => { vistoNoEnriquecer = readFileSync(m.midiaPath); return m; },
    });
    assert.deepEqual(pedidos, ['r-3']);
    assert.equal(r.midiaRecuperada, 1);
    assert.deepEqual(vistoNoEnriquecer, JPEG);
  });

  it('lerMensagens: uma vez por id, ordem por ts, ignora linha quebrada', () => {
    const arq = join(dir, 'm.jsonl');
    const [a, b] = mensagens();
    writeFileSync(arq, [JSON.stringify(b), '{quebrada', JSON.stringify(a), JSON.stringify(b)].join('\n'));
    assert.deepEqual(lerMensagens(arq).map(m => m.id), ['r-1', 'r-2']);
  });

  it('parseDuracao e midiaLegivel', () => {
    assert.equal(parseDuracao('2d'), 2 * 86_400_000);
    assert.equal(parseDuracao('12h'), 12 * 3_600_000);
    assert.equal(parseDuracao('x'), null);
    assert.equal(midiaLegivel(JPEG, 'imagem'), true);
    assert.equal(midiaLegivel(ENC, 'imagem'), false);
    assert.equal(midiaLegivel(Buffer.from('%PDF-1.7'), 'pdf'), true);
  });
});
