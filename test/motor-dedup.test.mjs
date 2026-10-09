/**
 * motor-dedup.test.mjs — GB-23b: complemento não duplica tarefa (LLM e heurística,
 * inclusive com mensagens processadas em paralelo) e empresa/projeto por nome do grupo.
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
import { jaccard, acharSimilar } from '../lib/motor/similaridade.mjs';

const CLIENTES = [
  { empresa: 'Acme Corp', projeto: 'Site', grupos: ['Site - Acme'], receitaMensal: 15000, pesoUrgencia: 1.5 },
  { empresa: 'Varejo Brasil', projeto: 'Loja', grupos: ['Loja Varejo'], receitaMensal: 9000, pesoUrgencia: 1.2 },
];

const CHAT = '120363011111111111@g.us';
const PEDIDO = 'Olá Alice, precisamos atualizar o banner da home para a promoção até sexta-feira, mas ainda não fechamos os textos finais nem a imagem.';
const COMPLEMENTO = 'Alice, definimos os textos do banner: "Black Friday Antecipada - 40% OFF". O link é /black-friday. Pode publicar!';

function novoStore() {
  const dir = mkdtempSync(join(tmpdir(), 'balde-dedup-'));
  mkdirSync(join(dir, 'dados', 'contextos'), { recursive: true });
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(join(dir, 'config', 'clientes.json'), JSON.stringify(CLIENTES));
  return { dir, store: criarStore(dir) };
}

let seq = 0;
function msg(texto) {
  seq++;
  return criarMensagem({
    id: `m-${seq}`, chatId: CHAT, chatNome: 'Alfa Tech - Site', autor: 'Carlos Gestor', texto,
    ts: new Date(Date.UTC(2026, 9, 7, 12, seq)).toISOString(),
  });
}

/**
 * fetch OpenAI mockado. `responder(prompt)` devolve o payload; `atrasoMs` simula a latência real.
 */
function openaiMock(responder, atrasoMs = 0) {
  const prompts = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const prompt = body.messages.at(-1).content[0].text;
    prompts.push(prompt);
    const payload = responder(prompt, prompts.length);
    if (atrasoMs) await new Promise(r => setTimeout(r, atrasoMs));
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }) };
  };
  return { opcoes: { llm: { env: { OPENAI_API_KEY: 'k', BALDE_LLM: 'openai' }, fetch, retryMs: 0 } }, prompts };
}

/** Como o gpt real fez: ignora a tarefa aberta e cria outra com título parecido. */
const LLM_QUE_DUPLICA = (_prompt, n) => n === 1
  ? { tarefas: [{ titulo: 'Atualizar banner da home para a promoção', descricao: PEDIDO, estado: 'aguardando_info',
      faltando: ['textos finais', 'imagem'], prazo: 'sexta-feira', tipo: 'desenvolvimento', etapa: 'producao',
      proximoPasso: 'Pedir textos finais e imagem no grupo' }], atualizacoes: [] }
  : { tarefas: [{ titulo: 'Atualizar banner da home para promoção Black Friday', descricao: COMPLEMENTO, estado: 'pronta',
      faltando: [], prazo: null, tipo: 'desenvolvimento', etapa: 'entrega', proximoPasso: 'Publicar o banner com o link /black-friday' }],
    atualizacoes: [] };

describe('GB-23b — complemento atualiza a tarefa aberta (sem duplicar)', () => {
  let ctx;
  beforeEach(() => { ctx = novoStore(); });
  afterEach(() => rmSync(ctx.dir, { recursive: true, force: true }));

  it('LLM: prompt leva as tarefas abertas com id e o motor aplica atualizacoes[{id}]', async () => {
    let idAberta;
    const { opcoes, prompts } = openaiMock((prompt, n) => {
      if (n === 1) return LLM_QUE_DUPLICA(prompt, 1);
      idAberta = prompt.match(/"id": "([^"]+)"/)?.[1];
      return { tarefas: [], atualizacoes: [{ id: idAberta, estado: 'pronta', faltando: [], etapa: 'entrega',
        proximoPasso: 'Publicar o banner com o link /black-friday', descricao: COMPLEMENTO }] };
    });
    await processar(msg(PEDIDO), ctx.store, opcoes);
    const r2 = await processar(msg(COMPLEMENTO), ctx.store, opcoes);

    assert.ok(idAberta, 'o prompt da 2ª mensagem precisa trazer o id da tarefa aberta');
    assert.match(prompts[1], /Atualizar banner da home/);
    assert.match(prompts[1], /ATUALIZAÇÃO|atualizacoes/);
    assert.equal(r2.novas.length, 0);
    assert.equal(r2.atualizadas[0].id, idAberta);
    const tarefas = ctx.store.lerTarefas();
    assert.equal(tarefas.length, 1);
    assert.equal(tarefas[0].estado, ESTADOS.PRONTA);
    assert.equal(tarefas[0].proximoPasso, 'Publicar o banner com o link /black-friday');
  });

  it('LLM devolve tarefa nova parecida → rede de segurança faz merge (caso real Alfa Tech)', async () => {
    const { opcoes } = openaiMock(LLM_QUE_DUPLICA);
    const r1 = await processar(msg(PEDIDO), ctx.store, opcoes);
    const r2 = await processar(msg(COMPLEMENTO), ctx.store, opcoes);

    assert.equal(r1.novas.length, 1);
    assert.equal(r2.novas.length, 0, 'complemento não pode virar 2ª tarefa');
    assert.equal(r2.atualizadas.length, 1);
    const [t] = ctx.store.lerTarefas();
    assert.equal(ctx.store.lerTarefas().length, 1);
    assert.equal(t.titulo, 'Atualizar banner da home para a promoção');
    assert.equal(t.estado, ESTADOS.PRONTA);
    assert.deepEqual(t.faltando, []);
    assert.equal(t.etapa, 'entrega');
    assert.equal(t.prazo, 'sexta-feira', 'prazo null do complemento não apaga o prazo');
    assert.match(t.descricao, /\[Atualização\].*Black Friday/s);
    assert.equal(t.fontes.length, 2);
  });

  it('mensagens em paralelo (webhook dispara o motor sem esperar) e LLM lento → 1 tarefa só', async () => {
    let idVisto = null;
    const { opcoes } = openaiMock((prompt, n) => {
      if (n === 2) idVisto = prompt.match(/"id": "([^"]+)"/)?.[1] ?? null;
      return LLM_QUE_DUPLICA(prompt, n);
    }, 40);
    await Promise.all([
      processar(msg(PEDIDO), ctx.store, opcoes),
      processar(msg(COMPLEMENTO), ctx.store, opcoes),
    ]);
    assert.ok(idVisto, 'a 2ª chamada ao LLM só sai depois da 1ª tarefa existir');
    assert.equal(ctx.store.lerTarefas().length, 1);
  });

  it('heurística: pedido + reformulação do mesmo pedido → merge, não duplica', async () => {
    const semLLM = { llm: { env: {} } };
    const r1 = await processar(msg('Precisamos atualizar o banner da home para a promoção'), ctx.store, semLLM);
    const r2 = await processar(msg('Pode atualizar o banner da home da promoção Black Friday até sexta?'), ctx.store, semLLM);
    assert.equal(r1.novas.length, 1);
    assert.equal(r2.novas.length, 0);
    assert.equal(r2.atualizadas[0].id, r1.novas[0].id);
    assert.equal(ctx.store.lerTarefas().length, 1);
  });

  it('assuntos diferentes no mesmo chat continuam virando tarefas separadas', async () => {
    const semLLM = { llm: { env: {} } };
    await processar(msg('Precisamos atualizar o banner da home'), ctx.store, semLLM);
    await processar(msg('Preciso corrigir o formulário de contato que não envia e-mail'), ctx.store, semLLM);
    assert.equal(ctx.store.lerTarefas().length, 2);
  });
});

describe('GB-23b — similaridade', () => {
  it('Jaccard dos títulos do caso real ≥ 0,5; assuntos diferentes < 0,5', () => {
    assert.ok(jaccard('Atualizar banner da home para a promoção', 'Atualizar banner da home para promoção Black Friday') >= 0.5);
    assert.ok(jaccard('Atualizar banner da home', 'Corrigir formulário de contato') < 0.5);
    assert.equal(acharSimilar({ titulo: 'x' }, []), null);
  });
});

describe('GB-23b — empresa/projeto pelo nome do grupo fora da config', () => {
  const m = (chatNome) => criarMensagem({ chatId: 'novo@g.us', chatNome, texto: 'oi' });

  it('"Empresa - Projeto" desconhecido → separa pelo hífen', () => {
    const r = resolverEmpresaProjeto(m('Alfa Tech - Site'), CLIENTES);
    assert.equal(r.empresa, 'Alfa Tech');
    assert.equal(r.projeto, 'Site');
  });

  it('"Projeto - Empresa" com empresa conhecida → inverte e herda receita/peso', () => {
    const r = resolverEmpresaProjeto(m('Catálogo – Varejo Brasil'), CLIENTES);
    assert.equal(r.empresa, 'Varejo Brasil');
    assert.equal(r.projeto, 'Catálogo');
    assert.equal(r.receitaMensal, 9000);
    assert.equal(r.pesoUrgencia, 1.2);
  });

  it('"Empresa conhecida - Projeto novo" → empresa da config', () => {
    const r = resolverEmpresaProjeto(m('Acme Corp - App'), CLIENTES);
    assert.equal(r.empresa, 'Acme Corp');
    assert.equal(r.projeto, 'App');
  });

  it('nome sem o padrão continua "?"', () => {
    const r = resolverEmpresaProjeto(m('Grupo Random'), CLIENTES);
    assert.equal(r.empresa, '?');
    assert.equal(r.projeto, '?');
  });

  it('processar() usa o fallback: tarefa nasce com Alfa Tech / Site', async () => {
    const ctx = novoStore();
    try {
      const r = await processar(msg(PEDIDO), ctx.store, { llm: { env: {} } });
      assert.equal(r.novas[0].empresa, 'Alfa Tech');
      assert.equal(r.novas[0].projeto, 'Site');
    } finally {
      rmSync(ctx.dir, { recursive: true, force: true });
    }
  });
});
