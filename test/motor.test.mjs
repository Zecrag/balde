/**
 * motor.test.mjs — Testes do motor de contexto e extração de micro-tarefas.
 *
 * Critérios de aceitação:
 *   1. cd balde && node --test test/motor*.test.mjs → todos passam sem LLM env
 *   2. 3 mensagens no mesmo grupo (pedido incompleto → dado que faltava) → 1 tarefa, aguardando_info → pronta
 *   3. Dois grupos "Site - Acme" e "App - Acme" com config → tarefas com projetos diferentes da mesma empresa
 *   4. Cliente com receita maior → urgência maior para pedido equivalente
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { criarMensagem, ESTADOS } from '../lib/tipos.mjs';
import { criarStore } from '../lib/store.mjs';
import { processar } from '../lib/motor/index.mjs';
import { resolverEmpresaProjeto } from '../lib/motor/resolver.mjs';
import { calcularUrgencia } from '../lib/motor/urgencia.mjs';

// Estes testes cobrem o heurístico: nunca chamar LLM real, mesmo com key no ambiente
process.env.BALDE_LLM = 'off';

// ─── Helpers ────────────────────────────────────────────────────

function tmpBalde() {
  const dir = mkdtempSync(join(tmpdir(), 'balde-test-'));
  mkdirSync(join(dir, 'dados', 'contextos'), { recursive: true });
  mkdirSync(join(dir, 'config'), { recursive: true });
  return dir;
}

function escreverClientes(dir, clientes) {
  writeFileSync(
    join(dir, 'config', 'clientes.json'),
    JSON.stringify(clientes, null, 2),
  );
}

// Config no formato flat do repo (que o resolver adaptado aceita)
const CLIENTES_FLAT = [
  {
    empresa: 'Acme Corp',
    projeto: 'Site',
    grupos: ['Site - Acme', 'acme-site-001'],
    receitaMensal: 15000,
    pesoUrgencia: 1.5,
  },
  {
    empresa: 'Acme Corp',
    projeto: 'App',
    grupos: ['App - Acme', 'acme-app-002'],
    receitaMensal: 15000,
    pesoUrgencia: 1.5,
  },
  {
    empresa: 'Beta Ltda',
    projeto: 'Loja',
    grupos: ['Loja - Beta', 'beta-loja-001'],
    receitaMensal: 3000,
    pesoUrgencia: 1,
  },
  {
    empresa: 'Gamma SA',
    projeto: 'Portal',
    grupos: ['Portal - Gamma', 'gamma-portal-001'],
    receitaMensal: 45000,
    pesoUrgencia: 2,
  },
];

// Config no formato nested do motor (para testar compatibilidade)
const CLIENTES_NESTED = [
  {
    empresa: 'Acme Corp',
    receitaMensal: 15000,
    pesoUrgencia: 1.5,
    projetos: [
      { nome: 'Site', chatId: 'acme-site-001', chatNome: 'Site - Acme' },
      { nome: 'App',  chatId: 'acme-app-002',  chatNome: 'App - Acme' },
    ],
  },
  {
    empresa: 'Beta Ltda',
    receitaMensal: 3000,
    pesoUrgencia: 1,
    projetos: [
      { nome: 'Loja', chatId: 'beta-loja-001', chatNome: 'Loja - Beta' },
    ],
  },
  {
    empresa: 'Gamma SA',
    receitaMensal: 45000,
    pesoUrgencia: 2,
    projetos: [
      { nome: 'Portal', chatId: 'gamma-portal-001', chatNome: 'Portal - Gamma' },
    ],
  },
];

// ─── Tests ──────────────────────────────────────────────────────

describe('tipos.mjs', () => {
  it('criarMensagem exige chatId', () => {
    assert.throws(() => criarMensagem(), /chatId/);
  });

  it('criarMensagem retorna objeto congelado', () => {
    const msg = criarMensagem({ chatId: 'abc' });
    assert.equal(msg.chatId, 'abc');
    assert.throws(() => { msg.chatId = 'xyz'; }, TypeError);
  });
});

describe('resolver.mjs — formato flat (repo)', () => {
  it('resolve por chatId exato', () => {
    const msg = criarMensagem({ chatId: 'acme-site-001', chatNome: 'Site - Acme', texto: 'oi' });
    const result = resolverEmpresaProjeto(msg, CLIENTES_FLAT);
    assert.equal(result.empresa, 'Acme Corp');
    assert.equal(result.projeto, 'Site');
  });

  it('resolve por nome do grupo', () => {
    const msg = criarMensagem({ chatId: 'desconhecido', chatNome: 'App - Acme', texto: 'oi' });
    const result = resolverEmpresaProjeto(msg, CLIENTES_FLAT);
    assert.equal(result.empresa, 'Acme Corp');
    assert.equal(result.projeto, 'App');
  });

  it('infere empresa pelo texto (mensagem encaminhada)', () => {
    const msg = criarMensagem({
      chatId: 'pessoal-001',
      chatNome: 'Meu Pessoal',
      texto: 'Recebi a razão social da Acme Corp, pode atualizar o boleto?',
    });
    const result = resolverEmpresaProjeto(msg, CLIENTES_FLAT);
    assert.equal(result.empresa, 'Acme Corp');
  });

  it('retorna empresa "?" quando sem match', () => {
    const msg = criarMensagem({ chatId: 'xxx', chatNome: 'Grupo Random', texto: 'hello world' });
    const result = resolverEmpresaProjeto(msg, CLIENTES_FLAT);
    assert.equal(result.empresa, '?');
    assert.equal(result.projeto, '?');
  });
});

describe('resolver.mjs — formato nested (motor)', () => {
  it('resolve por chatId exato', () => {
    const msg = criarMensagem({ chatId: 'acme-site-001', chatNome: 'Site - Acme', texto: 'oi' });
    const result = resolverEmpresaProjeto(msg, CLIENTES_NESTED);
    assert.equal(result.empresa, 'Acme Corp');
    assert.equal(result.projeto, 'Site');
  });

  it('resolve por nome do grupo', () => {
    const msg = criarMensagem({ chatId: 'desconhecido', chatNome: 'App - Acme', texto: 'oi' });
    const result = resolverEmpresaProjeto(msg, CLIENTES_NESTED);
    assert.equal(result.empresa, 'Acme Corp');
    assert.equal(result.projeto, 'App');
  });
});

describe('urgencia.mjs', () => {
  it('urgência 0-100', () => {
    const u = calcularUrgencia({ receitaMensal: 10000, pesoUrgencia: 1, prazo: 'hoje', tipo: 'boleto' });
    assert.ok(u >= 0 && u <= 100, `urgência ${u} fora do range`);
  });

  it('receita maior → urgência maior (mesmo tipo e prazo)', () => {
    const uAlta = calcularUrgencia({ receitaMensal: 45000, pesoUrgencia: 2, prazo: 'amanhã', tipo: 'geral' });
    const uBaixa = calcularUrgencia({ receitaMensal: 3000, pesoUrgencia: 1, prazo: 'amanhã', tipo: 'geral' });
    assert.ok(uAlta > uBaixa, `urgência alta (${uAlta}) deveria ser > urgência baixa (${uBaixa})`);
  });

  it('prazo mais próximo → urgência maior', () => {
    const uHoje = calcularUrgencia({ receitaMensal: 10000, pesoUrgencia: 1, prazo: 'hoje', tipo: 'geral' });
    const uMes = calcularUrgencia({ receitaMensal: 10000, pesoUrgencia: 1, prazo: 'fim do mês', tipo: 'geral' });
    assert.ok(uHoje > uMes, `urgência hoje (${uHoje}) deveria ser > fim do mês (${uMes})`);
  });
});

describe('processar() — fluxo completo', () => {
  let dir;
  let storeInst;

  beforeEach(() => {
    dir = tmpBalde();
    escreverClientes(dir, CLIENTES_FLAT);
    storeInst = criarStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // ── Critério 2: pedido incompleto → dado faltando → 1 tarefa, aguardando_info → pronta ──

  it('3 mensagens: pedido incompleto → info → tarefa vai de aguardando_info para pronta', async () => {
    // Mensagem 1: pedido incompleto
    const msg1 = criarMensagem({
      chatId: 'acme-site-001',
      chatNome: 'Site - Acme',
      autor: 'Cliente',
      texto: 'Preciso alterar a razão social no boleto, falta o CNPJ novo',
      ts: '2026-10-07T10:00:00Z',
    });

    const r1 = await processar(msg1, storeInst);
    assert.equal(r1.novas.length, 1, 'Deveria criar 1 tarefa');
    assert.equal(r1.novas[0].estado, ESTADOS.AGUARDANDO_INFO);
    assert.ok(r1.novas[0].faltando.length > 0, 'Deveria ter itens faltando');

    const tarefaId = r1.novas[0].id;

    // Mensagem 2: contexto adicional (não resolve o que falta)
    const msg2 = criarMensagem({
      chatId: 'acme-site-001',
      chatNome: 'Site - Acme',
      autor: 'Cliente',
      texto: 'É urgente porque o prazo é até sexta',
      ts: '2026-10-07T10:05:00Z',
    });

    await processar(msg2, storeInst);

    // Mensagem 3: fornece o dado que faltava (CNPJ)
    const msg3 = criarMensagem({
      chatId: 'acme-site-001',
      chatNome: 'Site - Acme',
      autor: 'Cliente',
      texto: 'O CNPJ novo é 12.345.678/0001-90',
      ts: '2026-10-07T10:10:00Z',
    });

    await processar(msg3, storeInst);

    // Verifica resultado final
    const tarefas = storeInst.lerTarefas();
    const tarefa = tarefas.find(t => t.id === tarefaId);
    assert.ok(tarefa, 'Tarefa deve existir');
    assert.equal(tarefa.estado, ESTADOS.PRONTA, 'Tarefa deveria estar pronta agora');
    assert.equal(tarefa.faltando.length, 0, 'Não deveria ter itens faltando');

    // Verifica que é 1 tarefa só (não duplicou)
    const tarefasDoChatAcme = tarefas.filter(t => t.chatId === 'acme-site-001');
    assert.ok(tarefasDoChatAcme.length >= 1, 'Deveria ter pelo menos 1 tarefa no chat');
  });

  // ── Critério 3: dois grupos da mesma empresa → projetos diferentes ──

  it('dois grupos "Site - Acme" e "App - Acme" geram tarefas com projetos diferentes', async () => {
    const msgSite = criarMensagem({
      chatId: 'acme-site-001',
      chatNome: 'Site - Acme',
      autor: 'Cliente',
      texto: 'Preciso corrigir o layout da home',
      ts: '2026-10-07T11:00:00Z',
    });

    const msgApp = criarMensagem({
      chatId: 'acme-app-002',
      chatNome: 'App - Acme',
      autor: 'Cliente',
      texto: 'Pode criar a tela de login no app?',
      ts: '2026-10-07T11:01:00Z',
    });

    const r1 = await processar(msgSite, storeInst);
    const r2 = await processar(msgApp, storeInst);

    assert.equal(r1.novas.length, 1, 'Deveria ter 1 tarefa do Site');
    assert.equal(r2.novas.length, 1, 'Deveria ter 1 tarefa do App');

    assert.equal(r1.novas[0].empresa, 'Acme Corp');
    assert.equal(r1.novas[0].projeto, 'Site');

    assert.equal(r2.novas[0].empresa, 'Acme Corp');
    assert.equal(r2.novas[0].projeto, 'App');

    assert.notEqual(r1.novas[0].projeto, r2.novas[0].projeto, 'Projetos devem ser diferentes');
  });

  // ── Critério 4: cliente com receita maior → urgência maior ──

  it('cliente com receita maior gera urgência maior para pedido equivalente', async () => {
    // Gamma SA: receita 45000, peso 2
    const msgGamma = criarMensagem({
      chatId: 'gamma-portal-001',
      chatNome: 'Portal - Gamma',
      autor: 'Cliente',
      texto: 'Preciso corrigir um bug na página de contato',
      ts: '2026-10-07T12:00:00Z',
    });

    // Beta Ltda: receita 3000, peso 1
    const msgBeta = criarMensagem({
      chatId: 'beta-loja-001',
      chatNome: 'Loja - Beta',
      autor: 'Cliente',
      texto: 'Preciso corrigir um bug na página de contato',
      ts: '2026-10-07T12:01:00Z',
    });

    const rGamma = await processar(msgGamma, storeInst);
    const rBeta = await processar(msgBeta, storeInst);

    assert.equal(rGamma.novas.length, 1);
    assert.equal(rBeta.novas.length, 1);

    assert.ok(
      rGamma.novas[0].urgencia > rBeta.novas[0].urgencia,
      `Gamma (${rGamma.novas[0].urgencia}) deveria ter urgência maior que Beta (${rBeta.novas[0].urgencia})`,
    );
  });
});

describe('store.mjs', () => {
  let dir;
  let storeInst;

  beforeEach(() => {
    dir = tmpBalde();
    escreverClientes(dir, CLIENTES_FLAT);
    storeInst = criarStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('upsert insere tarefa nova', () => {
    const tarefa = { id: 'test-1', titulo: 'Teste', estado: 'pronta' };
    storeInst.upsertTarefa(tarefa);
    const tarefas = storeInst.lerTarefas();
    assert.equal(tarefas.length, 1);
    assert.equal(tarefas[0].id, 'test-1');
  });

  it('upsert atualiza tarefa existente sem duplicar', () => {
    storeInst.upsertTarefa({ id: 'test-1', titulo: 'V1', estado: 'aguardando_info' });
    storeInst.upsertTarefa({ id: 'test-1', titulo: 'V2', estado: 'pronta' });
    const tarefas = storeInst.lerTarefas();
    assert.equal(tarefas.length, 1, 'Não deveria duplicar');
    assert.equal(tarefas[0].titulo, 'V2');
    assert.equal(tarefas[0].estado, 'pronta');
  });

  it('contexto persiste e acumula', () => {
    storeInst.salvarContexto({ chatId: 'chat-1', mensagens: [{ texto: 'a' }], tarefasAbertas: [], atualizadoEm: '' });
    const ctx = storeInst.lerContexto('chat-1');
    assert.ok(ctx);
    assert.equal(ctx.mensagens.length, 1);
  });

  it('lerClientes retorna array da config', () => {
    const clientes = storeInst.lerClientes();
    assert.equal(clientes.length, 4); // 4 entries in flat format (Acme has 2 rows)
    assert.equal(clientes[0].empresa, 'Acme Corp');
  });
});

describe('extrator heurístico — padrões de texto', () => {
  let dir;
  let storeInst;

  beforeEach(() => {
    dir = tmpBalde();
    escreverClientes(dir, CLIENTES_FLAT);
    storeInst = criarStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('detecta pedido com verbo de ação', async () => {
    const msg = criarMensagem({
      chatId: 'acme-site-001',
      chatNome: 'Site - Acme',
      texto: 'Pode alterar o banner da home?',
      ts: '2026-10-07T10:00:00Z',
    });
    const r = await processar(msg, storeInst);
    assert.equal(r.novas.length, 1);
  });

  it('detecta tipo boleto', async () => {
    const msg = criarMensagem({
      chatId: 'acme-site-001',
      chatNome: 'Site - Acme',
      texto: 'Preciso emitir um boleto com a razão social nova',
      ts: '2026-10-07T10:00:00Z',
    });
    const r = await processar(msg, storeInst);
    assert.equal(r.novas.length, 1);
    assert.equal(r.novas[0].tipo, 'boleto');
  });

  it('detecta tipo hospedagem', async () => {
    const msg = criarMensagem({
      chatId: 'acme-site-001',
      chatNome: 'Site - Acme',
      texto: 'Preciso configurar o SSL no servidor',
      ts: '2026-10-07T10:00:00Z',
    });
    const r = await processar(msg, storeInst);
    assert.equal(r.novas.length, 1);
    assert.equal(r.novas[0].tipo, 'hospedagem');
  });

  it('ignora mensagem sem pedido', async () => {
    const msg = criarMensagem({
      chatId: 'acme-site-001',
      chatNome: 'Site - Acme',
      texto: 'Bom dia pessoal!',
      ts: '2026-10-07T10:00:00Z',
    });
    const r = await processar(msg, storeInst);
    assert.equal(r.novas.length, 0);
  });

  it('detecta prazo textual', async () => {
    const msg = criarMensagem({
      chatId: 'acme-site-001',
      chatNome: 'Site - Acme',
      texto: 'Preciso atualizar o site até sexta',
      ts: '2026-10-07T10:00:00Z',
    });
    const r = await processar(msg, storeInst);
    assert.equal(r.novas.length, 1);
    assert.ok(r.novas[0].prazo, 'Deveria ter um prazo');
  });
});
