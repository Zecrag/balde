/**
 * motor-cliente-aprovacao.test.mjs — Tarefas que dependem do cliente (aguardando_info +
 * responsavel 'cliente'), pedidos de aprovação (precisa_decisao) e conclusão na
 * própria conversa (feita). LLM mockado (OpenAI).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { criarMensagem, ESTADOS } from '../lib/tipos.mjs';
import { criarStore } from '../lib/store.mjs';
import { processar } from '../lib/motor/index.mjs';
import { normalizarResponsavel } from '../lib/motor/extrator.mjs';

const CLIENTES = [{ empresa: 'Acme Corp', projeto: 'Site', grupos: ['acme-site@g.us'], receitaMensal: 5000 }];

function novoStore() {
  const dir = mkdtempSync(join(tmpdir(), 'balde-cliente-'));
  mkdirSync(join(dir, 'dados', 'contextos'), { recursive: true });
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(join(dir, 'config', 'clientes.json'), JSON.stringify(CLIENTES));
  return { dir, store: criarStore(dir) };
}

const msg = (texto, extra = {}) =>
  criarMensagem({ chatId: 'acme-site@g.us', chatNome: 'Site - Acme', autor: 'Cliente', texto, ...extra });

function llm(...payloads) {
  const chamadas = [];
  const fetch = async (url, init) => {
    chamadas.push(JSON.parse(init.body));
    const p = payloads.shift();
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(p) } }] }) };
  };
  return { opcoes: { llm: { env: { OPENAI_API_KEY: 'k' }, fetch, retryMs: 0 } }, chamadas };
}

describe('dependência do cliente, aprovação e conclusão', () => {
  let ctx;
  beforeEach(() => { ctx = novoStore(); });
  afterEach(() => rmSync(ctx.dir, { recursive: true, force: true }));

  it('o prompt pede responsavel, dependência do cliente, aprovação e conclusão', async () => {
    const { opcoes, chamadas } = llm({ tarefas: [], atualizacoes: [] });
    await processar(msg('bom dia'), ctx.store, opcoes);
    const system = chamadas[0].messages[0].content;
    const texto = typeof system === 'string' ? system : JSON.stringify(system);
    assert.match(texto, /"responsavel"/);
    assert.match(texto, /DEPENDÊNCIA DO CLIENTE/);
    assert.match(texto, /APROVAÇÃO/);
    assert.match(texto, /CONCLUSÃO/);
  });

  it('dependência do cliente vira aguardando_info com responsavel cliente e o que falta entregar', async () => {
    const { opcoes } = llm(
      { tarefas: [{ titulo: 'Atualizar anúncios com as fotos novas', estado: 'aguardando_info', responsavel: 'cliente',
        faltando: ['fotos novas dos produtos'], etapa: 'producao', tipo: 'geral' }], atualizacoes: [] },
      // Cliente manda as fotos → sai de aguardando_info e a bola volta pra mim (LLM não diz o responsável)
      { tarefas: [], atualizacoes: [] },
    );
    const { novas } = await processar(msg('assim que vocês mandarem as fotos novas eu atualizo os anúncios'), ctx.store, opcoes);
    assert.equal(novas.length, 1);
    assert.equal(novas[0].estado, ESTADOS.AGUARDANDO_INFO);
    assert.equal(novas[0].responsavel, 'cliente');
    assert.deepEqual(novas[0].faltando, ['fotos novas dos produtos']);

    const id = novas[0].id;
    opcoes.llm.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({
      tarefas: [], atualizacoes: [{ id, faltando: [] }] }) } }] }) });
    const { atualizadas } = await processar(msg('segue as fotos'), ctx.store, opcoes);
    assert.equal(atualizadas[0].estado, ESTADOS.PRONTA);
    assert.equal(atualizadas[0].responsavel, 'eu');
  });

  it('aguardando_info sem responsavel do LLM é do cliente; responsavel inválido é ignorado', async () => {
    const { opcoes } = llm({ tarefas: [{ titulo: 'Configurar domínio do site', estado: 'aguardando_info', responsavel: 'fulano',
      faltando: ['acesso ao registro.br'], etapa: 'suporte', tipo: 'hospedagem' }], atualizacoes: [] });
    const { novas } = await processar(msg('preciso do acesso ao registro.br pra configurar o domínio'), ctx.store, opcoes);
    assert.equal(novas[0].responsavel, 'cliente');
  });

  it('pedido de aprovação vira precisa_decisao com responsavel cliente; "aprovado" conclui', async () => {
    const { opcoes } = llm({ tarefas: [{ titulo: 'Aprovar layout da home do site', estado: 'precisa_decisao', responsavel: 'cliente',
      faltando: ['aprovação do layout da home'], etapa: 'aprovacao', tipo: 'desenvolvimento' }], atualizacoes: [] });
    const { novas } = await processar(msg('subi o layout da home, consegue aprovar?', { autor: 'Eu' }), ctx.store, opcoes);
    assert.equal(novas[0].estado, ESTADOS.PRECISA_DECISAO);
    assert.equal(novas[0].responsavel, 'cliente');
    assert.equal(novas[0].etapa, 'aprovacao');

    const id = novas[0].id;
    opcoes.llm.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({
      tarefas: [], atualizacoes: [{ id, estado: 'feita', faltando: [] }] }) } }] }) });
    const { atualizadas } = await processar(msg('aprovado!'), ctx.store, opcoes);
    assert.equal(atualizadas[0].estado, ESTADOS.FEITA);
    assert.equal(ctx.store.lerTarefas().find(t => t.id === id).estado, ESTADOS.FEITA);
  });

  it('tarefa resolvida na conversa ("subiu") sai como feita e deixa de ser aberta', async () => {
    const { opcoes } = llm({ tarefas: [{ titulo: 'Publicar landing page nova', estado: 'pronta', etapa: 'entrega', tipo: 'desenvolvimento' }], atualizacoes: [] });
    const { novas } = await processar(msg('pode publicar a landing nova?'), ctx.store, opcoes);
    const id = novas[0].id;
    opcoes.llm.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({
      tarefas: [], atualizacoes: [{ id, estado: 'feita' }] }) } }] }) });
    await processar(msg('subiu, já está no ar', { autor: 'Eu' }), ctx.store, opcoes);
    assert.equal(ctx.store.lerTarefas().find(t => t.id === id).estado, ESTADOS.FEITA);
  });

  it('tarefa nasce na data da mensagem (backfill de histórico)', async () => {
    const { opcoes } = llm({ tarefas: [{ titulo: 'Revisar textos do site', estado: 'pronta' }], atualizacoes: [] });
    const ts = '2026-09-10T14:00:00.000Z';
    const { novas } = await processar(msg('revisa os textos do site por favor', { ts }), ctx.store, opcoes);
    assert.equal(novas[0].criadaEm, ts);
  });

  it('heurística: aguardando_info é do cliente', async () => {
    const { novas } = await processar(msg('preciso de informações: qual o CNPJ novo?'), ctx.store, { llm: { env: {} } });
    assert.equal(novas[0].estado, ESTADOS.AGUARDANDO_INFO);
    assert.equal(novas[0].responsavel, 'cliente');
  });

  it('normalizarResponsavel: só grava quando muda', () => {
    const a = { estado: 'aguardando_info' };
    normalizarResponsavel(a, { responsavel: 'cliente' });
    assert.equal('responsavel' in a, false);
    const b = { estado: 'em_execucao' };
    normalizarResponsavel(b, { responsavel: 'cliente', estado: 'aguardando_info' });
    assert.equal(b.responsavel, 'eu');
    const c = { estado: 'precisa_decisao', responsavel: 'eu' };
    normalizarResponsavel(c, { responsavel: 'ia' });
    assert.equal(c.responsavel, 'eu');
  });
});
