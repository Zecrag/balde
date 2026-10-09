/**
 * motor-revisao.test.mjs — GB-35 (revisão GB-33): responsável de tarefa nova,
 * entrega de parceiro para revisão, cobrança de andamento, conclusão por
 * "definido/escolhido" e fusão de tarefas de mensagens contíguas. LLM mockado.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { criarMensagem, ESTADOS } from '../lib/tipos.mjs';
import { criarStore } from '../lib/store.mjs';
import { processar } from '../lib/motor/index.mjs';
import { extrairComHeuristica, normalizarResponsavel } from '../lib/motor/extrator.mjs';
import { mesmaIntencao } from '../lib/motor/similaridade.mjs';
import { calcularUrgencia } from '../lib/motor/urgencia.mjs';

const CLIENTES = [{ empresa: 'Acme Corp', projeto: 'Site', grupos: ['acme-site@g.us'], receitaMensal: 5000 }];

function novoStore() {
  const dir = mkdtempSync(join(tmpdir(), 'balde-revisao-'));
  mkdirSync(join(dir, 'dados', 'contextos'), { recursive: true });
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(join(dir, 'config', 'clientes.json'), JSON.stringify(CLIENTES));
  return { dir, store: criarStore(dir) };
}

let seq = 0;
const msg = texto => {
  seq++;
  return criarMensagem({ id: `r-${seq}`, chatId: 'acme-site@g.us', chatNome: 'Site - Acme', autor: 'Cliente', texto,
    ts: new Date(Date.UTC(2026, 9, 7, 12, seq)).toISOString() });
};

/** respostas: funções (prompt, system) → payload, uma por chamada. */
function llm(respostas) {
  const chamadas = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const prompt = body.messages.at(-1).content;
    const texto = typeof prompt === 'string' ? prompt : prompt[0].text;
    chamadas.push({ prompt: texto, system: body.messages[0].content });
    const payload = respostas[chamadas.length - 1](texto);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }) };
  };
  return { opcoes: { llm: { env: { OPENAI_API_KEY: 'k', BALDE_LLM: 'openai' }, fetch, retryMs: 0 } }, chamadas };
}

const idDe = (prompt, inicio) => JSON.parse(prompt.match(/Tarefas abertas[^\n]*\n([\s\S]*?\n\])/)[1])
  .find(t => t.titulo.startsWith(inicio)).id;

describe('GB-35 — responsável de tarefa nova', () => {
  let ctx;
  beforeEach(() => { ctx = novoStore(); });
  afterEach(() => rmSync(ctx.dir, { recursive: true, force: true }));

  it('LLM sem responsavel: pronta/em_execucao → eu; aguardando_info → cliente; nunca "ia"', async () => {
    const { opcoes } = llm([() => ({ tarefas: [
      { titulo: 'Trocar banner da home', estado: 'pronta' },
      { titulo: 'Subir landing de Natal', estado: 'em_execucao' },
      { titulo: 'Configurar domínio do site', estado: 'aguardando_info', faltando: ['acesso ao registro.br'] },
    ], atualizacoes: [] })]);
    const { novas } = await processar(msg('três pedidos'), ctx.store, opcoes);
    const por = Object.fromEntries(novas.map(t => [t.titulo, t.responsavel]));
    assert.equal(por['Trocar banner da home'], 'eu');
    assert.equal(por['Subir landing de Natal'], 'eu');
    assert.equal(por['Configurar domínio do site'], 'cliente');
    assert.ok(ctx.store.lerTarefas().every(t => t.responsavel !== 'ia'));
  });

  it('normalizarResponsavel: tarefa nova sem dono vira eu; atualização sem estado não ganha dono', () => {
    const nova = { estado: ESTADOS.PRONTA };
    normalizarResponsavel(nova);
    assert.equal(nova.responsavel, 'eu');
    const atualiz = { descricao: 'x' };
    normalizarResponsavel(atualiz, { id: 't1', estado: ESTADOS.PRONTA, responsavel: 'eu' });
    assert.equal(atualiz.responsavel, undefined);
  });

  it('heurística: pedido executável → eu; pedido com pergunta → cliente', () => {
    const ctxChat = texto => ({ chatId: 'c', mensagens: [{ id: 'h1', texto }] });
    const info = { empresa: 'Acme', projeto: 'Site' };
    const [pronta] = extrairComHeuristica(ctxChat('Preciso trocar o banner da home'), info, []).tarefas;
    assert.equal(pronta.estado, ESTADOS.PRONTA);
    assert.equal(pronta.responsavel, 'eu');
    const [aguardando] = extrairComHeuristica(ctxChat('Preciso configurar o domínio, qual o login do registro?'), info, []).tarefas;
    assert.equal(aguardando.estado, ESTADOS.AGUARDANDO_INFO);
    assert.equal(aguardando.responsavel, 'cliente');
  });
});

describe('GB-35 — prompt e atualizações', () => {
  let ctx;
  beforeEach(() => { ctx = novoStore(); });
  afterEach(() => rmSync(ctx.dir, { recursive: true, force: true }));

  it('prompt cobre entrega para revisão, cobrança e "definido/escolhido/aprovado sem alterações"', async () => {
    const { opcoes, chamadas } = llm([() => ({ tarefas: [], atualizacoes: [] })]);
    await processar(msg('bom dia'), ctx.store, opcoes);
    const system = chamadas[0].system;
    assert.match(system, /ENTREGA PARA REVISÃO/);
    assert.match(system, /estamos com o site pronto/);
    assert.match(system, /finalizamos a etapa/);
    assert.match(system, /nunca é conversa vazia/);
    assert.match(system, /COBRANÇA de andamento ou prazo/);
    assert.match(system, /qual o prazo\?/);
    assert.match(system, /tem novidade\?/);
    assert.match(system, /"cobranca": true/);
    assert.match(system, /"definido", "escolhido"/);
    assert.match(system, /aprovado sem alterações/);
  });

  it('entrega do parceiro vira tarefa de revisão minha', async () => {
    const { opcoes } = llm([() => ({ tarefas: [{ titulo: 'Revisar site entregue pelo parceiro', estado: 'pronta',
      etapa: 'aprovacao', tipo: 'desenvolvimento' }], atualizacoes: [] })]);
    const { novas } = await processar(msg('estamos com o site pronto'), ctx.store, opcoes);
    assert.equal(novas.length, 1);
    assert.equal(novas[0].etapa, 'aprovacao');
    assert.equal(novas[0].responsavel, 'eu');
  });

  it('cobrança atualiza a tarefa pendente, registra e sobe a urgência (sem tarefa nova)', async () => {
    const { opcoes } = llm([
      () => ({ tarefas: [{ titulo: 'Trocar banner da home', estado: 'pronta', tipo: 'geral' }], atualizacoes: [] }),
      prompt => ({ tarefas: [], atualizacoes: [{ id: idDe(prompt, 'Trocar banner'), cobranca: true }] }),
      prompt => ({ tarefas: [], atualizacoes: [{ id: idDe(prompt, 'Trocar banner'), cobranca: true, descricao: 'Cliente cobrou de novo' }] }),
    ]);
    const { novas: [banner] } = await processar(msg('troca o banner da home'), ctx.store, opcoes);
    const r2 = await processar(msg('qual o prazo?'), ctx.store, opcoes);
    assert.equal(r2.novas.length, 0);
    const cobrada = r2.atualizadas[0];
    assert.equal(cobrada.id, banner.id);
    assert.equal(cobrada.cobrancas, 1);
    assert.match(cobrada.descricao, /\[Atualização\] Cobrança: qual o prazo\?/);
    assert.ok(cobrada.urgencia > banner.urgencia, `${cobrada.urgencia} > ${banner.urgencia}`);

    const r3 = await processar(msg('tem novidade?'), ctx.store, opcoes);
    assert.equal(r3.atualizadas[0].cobrancas, 2);
    assert.ok(r3.atualizadas[0].urgencia > cobrada.urgencia);
    assert.equal(ctx.store.lerTarefas().length, 1);
  });

  it('urgência: cobranças somam até 3', () => {
    const base = calcularUrgencia({ receitaMensal: 0, tipo: 'geral' });
    assert.equal(calcularUrgencia({ tipo: 'geral', cobrancas: 1 }), base + 10);
    assert.equal(calcularUrgencia({ tipo: 'geral', cobrancas: 9 }), base + 30);
  });

  it('"definido" conclui a decisão pendente', async () => {
    const { opcoes } = llm([
      () => ({ tarefas: [{ titulo: 'Escolher paleta do site', estado: 'precisa_decisao', responsavel: 'cliente',
        faltando: ['escolha da paleta'] }], atualizacoes: [] }),
      prompt => ({ tarefas: [], atualizacoes: [{ id: idDe(prompt, 'Escolher paleta'), estado: 'feita', faltando: [] }] }),
    ]);
    const { novas: [paleta] } = await processar(msg('qual paleta vocês preferem?'), ctx.store, opcoes);
    const r = await processar(msg('definido, vamos com a azul'), ctx.store, opcoes);
    assert.equal(r.novas.length, 0);
    assert.equal(r.atualizadas[0].id, paleta.id);
    assert.equal(r.atualizadas[0].estado, ESTADOS.FEITA);
  });
});

describe('GB-35 — fusão de tarefas de mensagens contíguas', () => {
  let ctx;
  beforeEach(() => { ctx = novoStore(); });
  afterEach(() => rmSync(ctx.dir, { recursive: true, force: true }));

  it('mesmaIntencao: verbo diferente, mesmo objeto (radicais) → mesma; objetos diferentes → não', () => {
    const t = titulo => ({ titulo, empresa: 'Acme Corp', projeto: 'Site' });
    assert.ok(mesmaIntencao(t('Programar impulsionamento dos vídeos'), t('Avaliar viabilidade de impulsionar dois vídeos')));
    assert.equal(mesmaIntencao(t('Adicionar legendas ao vídeo'), t('Criar anúncio do vídeo')), false);
    assert.equal(mesmaIntencao(t('Adicionar legendas ao vídeo dos anúncios'), t('Definir promessa clara e forte para anúncios')), false);
  });

  it('mensagens seguidas com a mesma intenção viram uma tarefa só', async () => {
    const { opcoes } = llm([
      () => ({ tarefas: [{ titulo: 'Avaliar viabilidade de impulsionar dois vídeos', estado: 'pronta' }], atualizacoes: [] }),
      () => ({ tarefas: [{ titulo: 'Programar impulsionamento dos vídeos', estado: 'pronta', prazo: 'sexta' }], atualizacoes: [] }),
    ]);
    const { novas: [avaliar] } = await processar(msg('dá pra impulsionar esses dois vídeos?'), ctx.store, opcoes);
    const r = await processar(msg('se der, programa o impulsionamento pra sexta'), ctx.store, opcoes);
    assert.equal(r.novas.length, 0);
    assert.equal(r.atualizadas[0].id, avaliar.id);
    assert.equal(r.atualizadas[0].prazo, 'sexta');
    assert.equal(r.atualizadas[0].fontes.length, 2);
    assert.equal(ctx.store.lerTarefas().length, 1);
  });

  it('mesma intenção longe no chat (fora da janela contígua) continua separada', async () => {
    const vazio = () => ({ tarefas: [], atualizacoes: [] });
    const { opcoes } = llm([
      () => ({ tarefas: [{ titulo: 'Avaliar viabilidade de impulsionar dois vídeos', estado: 'pronta' }], atualizacoes: [] }),
      vazio, vazio, vazio, vazio, vazio,
      () => ({ tarefas: [{ titulo: 'Programar impulsionamento dos vídeos', estado: 'pronta' }], atualizacoes: [] }),
    ]);
    await processar(msg('dá pra impulsionar esses dois vídeos?'), ctx.store, opcoes);
    for (let i = 0; i < 5; i++) await processar(msg(`conversa ${i}`), ctx.store, opcoes);
    const r = await processar(msg('programa o impulsionamento'), ctx.store, opcoes);
    assert.equal(r.novas.length, 1);
    assert.equal(ctx.store.lerTarefas().length, 2);
  });
});

describe('GB-35 — bin/corrigir-dados', () => {
  it('ia/ausente → eu, ou cliente se aguardando_info; eu/cliente intactos', async () => {
    const { corrigirResponsaveis } = await import('../bin/corrigir-dados.mjs');
    const { tarefas, trocas } = corrigirResponsaveis([
      { id: 'a', estado: 'pronta', responsavel: 'ia' },
      { id: 'b', estado: 'aguardando_info', responsavel: 'ia' },
      { id: 'c', estado: 'em_execucao' },
      { id: 'd', estado: 'pronta', responsavel: 'cliente' },
    ]);
    assert.deepEqual(tarefas.map(t => t.responsavel), ['eu', 'cliente', 'eu', 'cliente']);
    assert.equal(trocas.length, 3);
  });
});
