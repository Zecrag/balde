/**
 * motor-despejo.test.mjs — GB-36: roteamento do grupo despejo para empresa · projeto
 * (menção explícita + contexto fixo, administrativo, cliente desconhecido, pessoal,
 * nome parecido). LLM mockado.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { criarMensagem } from '../lib/tipos.mjs';
import { criarStore } from '../lib/store.mjs';
import { processar } from '../lib/motor/index.mjs';
import { rotearDespejo, detectarMencao, empresasConhecidas, FIXO_MENSAGENS } from '../lib/motor/despejo.mjs';

const DESPEJO = '120363000000000099@g.us';
const CLIENTES = [{ empresa: 'Alice', projeto: 'Balde', grupos: [DESPEJO], tipoTicket: 'despejo' }];
const PROJETOS = [
  { empresa: 'Alice', projeto: 'Balde', tipo: 'despejo' },
  { empresa: 'Acme', projeto: 'Site', tipo: 'interno', ganho: 3000 },
  { empresa: 'Acme', projeto: 'Ads', tipo: 'cliente', ganho: 3000 },
  { empresa: 'Delta', projeto: 'Projeto Ads', tipo: 'cliente' },
  { empresa: 'EmpresaX', projeto: 'MKT Exemplo Alice', tipo: 'cliente' },
];
const EMPRESAS = empresasConhecidas(PROJETOS);

function novoStore() {
  const dir = mkdtempSync(join(tmpdir(), 'balde-despejo-'));
  mkdirSync(join(dir, 'dados', 'contextos'), { recursive: true });
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(join(dir, 'config', 'clientes.json'), JSON.stringify(CLIENTES));
  return { dir, store: criarStore(dir) };
}

let seq = 0;
const T0 = Date.UTC(2026, 9, 7, 12, 0);
const msg = (texto, minutos) => {
  seq++;
  return criarMensagem({ id: `d-${seq}`, chatId: DESPEJO, chatNome: DESPEJO, autor: 'Alice', texto, origem: 'grupo',
    ts: new Date(T0 + (minutos ?? seq) * 60_000).toISOString() });
};

/** LLM que sempre cria uma tarefa com o título dado pela mensagem; guarda os prompts. */
function llmEco() {
  const prompts = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const c = body.messages.at(-1).content;
    const prompt = typeof c === 'string' ? c : c[0].text;
    prompts.push(prompt);
    const ultima = prompt.split('ÚLTIMA MENSAGEM (analise esta):\n')[1] ?? '';
    const titulo = `Fazer ${ultima.split(': ').slice(1).join(': ').slice(0, 40)}`;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({
      tarefas: [{ titulo, estado: 'pronta' }], atualizacoes: [] }) } }] }) };
  };
  return { opcoes: { llm: { env: { OPENAI_API_KEY: 'k', BALDE_LLM: 'openai' }, fetch, retryMs: 0 }, projetos: PROJETOS }, prompts };
}

describe('GB-36 — detectarMencao', () => {
  it('menção explícita a cliente conhecido, com projeto citado', () => {
    assert.deepEqual(detectarMencao('material do site da Acme', EMPRESAS), { empresa: 'Acme', projeto: 'Site' });
    assert.deepEqual(detectarMencao('anúncios da acme pra subir', EMPRESAS), { empresa: 'Acme', projeto: 'Ads' });
    assert.equal(detectarMencao('#acme', EMPRESAS).empresa, 'Acme');
    assert.deepEqual(detectarMencao('é da Exemplo', EMPRESAS), { empresa: 'Exemplo', projeto: 'Administrativo' });
  });

  it('nome parecido casa por similaridade (Delte → Delta, Exmplo → Exemplo)', () => {
    assert.equal(detectarMencao('material do site da Delte', EMPRESAS).empresa, 'Delta');
    assert.equal(detectarMencao('isso é da Exmplo', EMPRESAS).empresa, 'Exemplo');
  });

  it('cliente desconhecido nunca vira empresa: só clienteSugerido', () => {
    assert.deepEqual(detectarMencao('cliente: Nova Loja', EMPRESAS), { clienteSugerido: 'Nova Loja' });
    assert.deepEqual(detectarMencao('revisar site da Fulano Silva, urgente', EMPRESAS), { clienteSugerido: 'Fulano Silva' });
  });

  it('token solto, sigla ou nome curto não é cliente ("5OX", "Kç", "BUILDA")', () => {
    assert.equal(detectarMencao('#5OX', EMPRESAS), null);
    assert.equal(detectarMencao('#Kç pra ver', EMPRESAS), null);
    assert.equal(detectarMencao('cliente: Kç', EMPRESAS), null);
    assert.equal(detectarMencao('CNPJ BUILDA', EMPRESAS), null);
    assert.equal(detectarMencao('material do site da Xptqz', EMPRESAS), null);
    for (const t of ['#5OX', 'cliente: Kç', 'material do site da Fulano']) {
      const { destino } = rotearDespejo({ texto: t, ts: new Date(T0).toISOString() }, null, PROJETOS);
      assert.ok(['Alice · Pessoal', 'Exemplo · Administrativo'].includes(`${destino.empresa} · ${destino.projeto}`), t);
    }
  });

  it('sem pista não inventa cliente ("dados" não é Delta, "é da semana" não é cliente)', () => {
    assert.equal(detectarMencao('manda os dados da planilha', EMPRESAS), null);
    assert.equal(detectarMencao('isso é da semana passada', EMPRESAS), null);
    assert.equal(detectarMencao('comprar ração do cachorro', EMPRESAS), null);
  });
});

describe('GB-36 — rotearDespejo', () => {
  const m = (texto, minutos) => ({ texto, ts: new Date(T0 + minutos * 60_000).toISOString() });

  it('administrativo → Exemplo · Administrativo; sem pista → Alice · Pessoal', () => {
    assert.deepEqual(
      [rotearDespejo(m('emitir boleto e nota fiscal', 0), null, PROJETOS).destino].map(d => `${d.empresa} · ${d.projeto}`),
      ['Exemplo · Administrativo']);
    const p = rotearDespejo(m('comprar ração do cachorro', 0), null, PROJETOS);
    assert.equal(`${p.destino.empresa} · ${p.destino.projeto}`, 'Alice · Pessoal');
    assert.equal(p.fixo, null);
  });

  it('menção vira contexto fixo por 30 min / 10 mensagens, até nova menção', () => {
    let { destino, fixo } = rotearDespejo(m('material do site da Acme', 0), null, PROJETOS);
    assert.equal(destino.empresa, 'Acme');
    assert.equal(destino.receitaMensal, 3000);

    ({ destino, fixo } = rotearDespejo(m('ajustar o rodapé', 5), fixo, PROJETOS));
    assert.equal(`${destino.empresa} · ${destino.projeto}`, 'Acme · Site');
    assert.equal(destino.motivo, 'contexto');

    // Passou de 30 min → perde o contexto
    const tarde = rotearDespejo(m('ajustar o menu', 31), fixo, PROJETOS);
    assert.equal(tarde.destino.empresa, 'Alice');

    // Nova menção troca o contexto
    const outra = rotearDespejo(m('anúncios da Delta', 6), fixo, PROJETOS);
    assert.equal(outra.destino.empresa, 'Delta');
    assert.equal(rotearDespejo(m('trocar logo', 7), outra.fixo, PROJETOS).destino.empresa, 'Delta');

    // Menção a cliente sem cadastro encerra o contexto e não cria empresa
    const nova = rotearDespejo(m('cliente: Nova Loja', 8), outra.fixo, PROJETOS);
    assert.equal(`${nova.destino.empresa} · ${nova.destino.projeto}`, 'Alice · Pessoal');
    assert.equal(nova.destino.clienteSugerido, 'Nova Loja');
    assert.equal(nova.fixo, null);
  });

  it('contexto fixo acaba depois de 10 mensagens', () => {
    let { fixo } = rotearDespejo(m('#acme', 0), null, PROJETOS);
    for (let i = 1; i <= FIXO_MENSAGENS; i++) {
      const r = rotearDespejo(m(`item ${i}`, i), fixo, PROJETOS);
      assert.equal(r.destino.empresa, 'Acme', `mensagem ${i}`);
      fixo = r.fixo;
    }
    assert.equal(rotearDespejo(m('item 11', 11), fixo, PROJETOS).destino.empresa, 'Alice');
  });
});

describe('GB-36 — motor no grupo despejo', () => {
  let ctx;
  beforeEach(() => { ctx = novoStore(); });
  afterEach(() => rmSync(ctx.dir, { recursive: true, force: true }));

  it('tarefas do despejo vão para o cliente citado, o administrativo ou o pessoal — nunca Alice · Balde', async () => {
    const { opcoes, prompts } = llmEco();
    await processar(msg('material do site da Acme: trocar fotos', 0), ctx.store, opcoes);
    await processar(msg('e ajustar o rodapé', 2), ctx.store, opcoes);
    await processar(msg('revisar contrato da Arutech', 40), ctx.store, opcoes);
    await processar(msg('emitir nota fiscal de outubro', 120), ctx.store, opcoes);
    await processar(msg('comprar ração do cachorro', 200), ctx.store, opcoes);

    const destinos = ctx.store.lerTarefas().map(t => `${t.empresa} · ${t.projeto}${t.clienteSugerido ? ` [${t.clienteSugerido}]` : ''}`);
    assert.deepEqual(destinos, [
      'Acme · Site',
      'Acme · Site',
      'Alice · Pessoal [Arutech]',
      'Exemplo · Administrativo',
      'Alice · Pessoal',
    ]);
    const arutech = ctx.store.lerTarefas()[2];
    assert.equal(arutech.sugerirCriar, undefined);
    assert.match(`${arutech.titulo} ${arutech.descricao}`, /Arutech/);
    assert.match(prompts[0], /Empresa: Acme\nProjeto: Site/);
    assert.ok(ctx.store.lerTarefas().every(t => t.empresa !== 'Alice' || t.projeto !== 'Balde'));
  });
});

describe('GB-36 — reprocessar --grupo/--refazer', () => {
  let ctx;
  beforeEach(() => { ctx = novoStore(); });
  afterEach(() => rmSync(ctx.dir, { recursive: true, force: true }));

  it('filtra o grupo pelo projeto resolvido e refaz as tarefas no destino certo', async () => {
    const { filtrarGrupo, limparParaRefazer, reprocessar } = await import('../bin/reprocessar.mjs');
    const { resolverEmpresaProjeto } = await import('../lib/motor/resolver.mjs');
    const { acumularContexto } = await import('../lib/motor/contexto.mjs');
    const despejo = [msg('material do site da Acme: trocar fotos', 0), msg('emitir nota fiscal', 60)];
    const outro = criarMensagem({ id: 'x-1', chatId: 'outro@g.us', chatNome: 'Outro', texto: 'oi' });
    const filtradas = filtrarGrupo([...despejo, outro], 'balde', m => resolverEmpresaProjeto(m, CLIENTES));
    assert.deepEqual(filtradas.map(m => m.id), despejo.map(m => m.id));

    // Estado antigo: as duas tarefas presas em Alice · Balde
    ctx.store.salvarTarefas(despejo.map((m, i) => ({ id: `t${i}`, titulo: `T${i}`, estado: 'pronta', chatId: DESPEJO,
      empresa: 'Alice', projeto: 'Balde', fontes: [m.id] })).concat([{ id: 'manual', titulo: 'Manual', chatId: DESPEJO, fontes: [] }]));
    assert.equal(limparParaRefazer(ctx.store, filtradas).length, 2);
    assert.deepEqual(ctx.store.lerTarefas().map(t => t.id), ['manual'], 'tarefa sem fonte (manual) fica');

    const { opcoes } = llmEco();
    await reprocessar({ store: ctx.store, mensagens: filtradas, enriquecer: async m => m, acumular: acumularContexto,
      processar: (m, store) => processar(m, store, opcoes) });
    const destinos = ctx.store.lerTarefas().filter(t => t.id !== 'manual').map(t => `${t.empresa} · ${t.projeto}`);
    assert.deepEqual(destinos, ['Acme · Site', 'Exemplo · Administrativo']);
  });
});

describe('GB-36 — texto ilegível não vira pista', () => {
  it('PDF extraído como binário cru é ignorado; #tag precisa ser palavra', () => {
    const lixo = 'stream x\u0000\u0001#kç×ße\u0015 obj #5OX¸Ä endobj '.repeat(40);
    const r = rotearDespejo({ texto: lixo, ts: new Date(T0).toISOString() }, null, PROJETOS);
    assert.equal(`${r.destino.empresa} · ${r.destino.projeto}`, 'Alice · Pessoal');
    assert.equal(detectarMencao('preço R$10 #5OX', EMPRESAS), null);
    assert.equal(detectarMencao('anota isso #acme.', EMPRESAS).empresa, 'Acme');
  });
});

describe('GB-36 — formas reais de citar', () => {
  it('"Material Site Acme abaixo" e nome do arquivo "Boleto_Arutech_….pdf"', () => {
    assert.deepEqual(detectarMencao('Material Site Acme abaixo', EMPRESAS), { empresa: 'Acme', projeto: 'Site' });
    const pdf = { texto: '\u0000\u0001lixo', ts: new Date(T0).toISOString(),
      raw: { data: { message: { documentMessage: { fileName: 'Boleto_Fulano_consultoria.pdf' } } } } };
    const r = rotearDespejo(pdf, null, PROJETOS).destino;
    assert.equal(`${r.empresa} · ${r.projeto}`, 'Exemplo · Administrativo');
    assert.equal(r.clienteSugerido, 'Fulano');
    assert.equal(detectarMencao('Site Novo pronto', EMPRESAS), null);
  });
});

describe('GB-36b — corrigir-dados reclassifica empresa desconhecida', () => {
  it('"5OX"/"Kç"/cliente citado vão para projeto conhecido; nome plausível vira clienteSugerido', async () => {
    const { reclassificarDesconhecidas } = await import('../bin/corrigir-dados.mjs');
    const { tarefas, trocas } = reclassificarDesconhecidas([
      { id: '1', titulo: 'Reenviar boleto corrigido', descricao: '', empresa: 'Kç', projeto: 'Geral', sugerirCriar: true },
      { id: '2', titulo: 'Revisar material do site da Acme', descricao: '', empresa: '5OX', projeto: 'Geral', sugerirCriar: true },
      { id: '3', titulo: 'Atualizar razão social', descricao: '', empresa: 'Arutech', projeto: 'Geral', sugerirCriar: true },
      { id: '4', titulo: 'Subir anúncios', empresa: 'Delta', projeto: 'Projeto Ads' },
    ], PROJETOS);
    assert.equal(trocas.length, 3);
    const d = tarefas.map(t => `${t.empresa} · ${t.projeto}${t.clienteSugerido ? ` [${t.clienteSugerido}]` : ''}`);
    assert.deepEqual(d, ['Exemplo · Administrativo', 'Acme · Site', 'Exemplo · Administrativo [Arutech]', 'Delta · Projeto Ads']);
    assert.ok(tarefas.every(t => t.sugerirCriar === undefined));
  });
});
