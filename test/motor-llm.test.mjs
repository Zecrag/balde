/**
 * motor-llm.test.mjs — Motor com LLM (fetch mockado nos 3 provedores), títulos,
 * etapa/proximoPasso no heurístico e grupo despejo.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { criarMensagem, ESTADOS } from '../lib/tipos.mjs';
import { criarStore } from '../lib/store.mjs';
import { processar } from '../lib/motor/index.mjs';
import { montarPromptContexto } from '../lib/motor/extrator.mjs';
import { gerarTitulo, sanearTitulo, encurtarTitulo } from '../lib/motor/titulo.mjs';
import { ETAPAS, normalizarEtapa } from '../lib/motor/etapas.mjs';

const CLIENTES = [
  { empresa: 'Acme Corp', projeto: 'Site', grupos: ['Site - Acme', 'acme-site@g.us'], receitaMensal: 15000, pesoUrgencia: 1.5 },
  { empresa: 'Eu', projeto: 'Despejo', grupos: ['Despejo', 'despejo@g.us'], receitaMensal: 0, tipoTicket: 'despejo' },
];

/** Opções que garantem heurística mesmo se a máquina tiver key no ambiente. */
const SEM_LLM = { llm: { env: {} } };

function novoStore() {
  const dir = mkdtempSync(join(tmpdir(), 'balde-llm-'));
  mkdirSync(join(dir, 'dados', 'contextos'), { recursive: true });
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(join(dir, 'config', 'clientes.json'), JSON.stringify(CLIENTES));
  return { dir, store: criarStore(dir) };
}

function msg(texto, extra = {}) {
  return criarMensagem({ chatId: 'acme-site@g.us', chatNome: 'Site - Acme', autor: 'Cliente', texto, ...extra });
}

/** Resposta crua do provedor contendo `payload` (objeto) como texto JSON. */
const RESPOSTA = {
  anthropic: p => ({ content: [{ type: 'text', text: JSON.stringify(p) }] }),
  openai:    p => ({ choices: [{ message: { content: JSON.stringify(p) } }] }),
  gemini:    p => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(p) }] } }] }),
};
const ENV = {
  anthropic: { ANTHROPIC_API_KEY: 'k' },
  openai:    { OPENAI_API_KEY: 'k' },
  gemini:    { GEMINI_API_KEY: 'k' },
};

function opcoesLLM(provedor, ...payloads) {
  const chamadas = [];
  const fetch = async (url, init) => {
    chamadas.push({ url, body: JSON.parse(init.body) });
    const p = payloads.shift();
    return { ok: true, status: 200, json: async () => RESPOSTA[provedor](p) };
  };
  return { opcoes: { llm: { env: ENV[provedor], fetch, retryMs: 0 } }, chamadas };
}

/** Texto do prompt enviado, independente do provedor. */
function promptEnviado(provedor, body) {
  if (provedor === 'anthropic') return body.messages[0].content.at(-1).text;
  if (provedor === 'openai') return body.messages.at(-1).content[0].text;
  return body.contents[0].parts.at(-1).text;
}

describe('motor com LLM — 3 provedores', () => {
  let ctx;
  beforeEach(() => { ctx = novoStore(); });
  afterEach(() => rmSync(ctx.dir, { recursive: true, force: true }));

  for (const provedor of ['anthropic', 'openai', 'gemini']) {
    it(`${provedor}: cria tarefa com etapa/proximoPasso e depois atualiza a mesma (sem duplicar)`, async () => {
      const { opcoes, chamadas } = opcoesLLM(provedor,
        { tarefas: [{
          titulo: 'Olá! Segue: Trocar banner da home do site institucional da Acme com a nova campanha de outubro',
          descricao: 'Cliente pediu troca do banner', estado: 'aguardando_info', faltando: ['arte final em PNG'],
          prazo: 'sexta', tipo: 'desenvolvimento', etapa: 'Ajustes', proximoPasso: 'Pedir a arte final em PNG no grupo',
        }], atualizacoes: [] },
        null, // preenchido abaixo com o id real
      );

      const r1 = await processar(msg('Bom dia! Precisa trocar o banner da home até sexta'), ctx.store, opcoes);
      assert.equal(r1.novas.length, 1);
      const t = r1.novas[0];
      assert.ok(t.titulo.length <= 70, `título com ${t.titulo.length} chars`);
      assert.doesNotMatch(t.titulo, /^(Olá|Segue)/i);
      assert.match(t.titulo, /^Trocar banner/);
      assert.ok(!/\s(de|da|do|com|a|o)$/i.test(t.titulo), `título termina pendurado: "${t.titulo}"`);
      assert.equal(t.estado, ESTADOS.AGUARDANDO_INFO);
      assert.deepEqual(t.faltando, ['arte final em PNG']);
      assert.equal(t.etapa, 'ajustes');
      assert.equal(t.proximoPasso, 'Pedir a arte final em PNG no grupo');
      assert.equal(t.empresa, 'Acme Corp');

      // Prompt levou contexto: empresa/projeto, tipo do grupo e a mensagem
      const prompt = promptEnviado(provedor, chamadas[0].body);
      assert.match(prompt, /Empresa: Acme Corp/);
      assert.match(prompt, /Projeto: Site/);
      assert.match(prompt, /Tipo do grupo: cliente/);
      assert.match(prompt, /trocar o banner/);

      // 2ª mensagem: LLM devolve atualização da tarefa aberta + uma "nova" com o mesmo título
      const { opcoes: op2, chamadas: ch2 } = opcoesLLM(provedor, {
        tarefas: [{ titulo: t.titulo, descricao: 'repetida', estado: 'pronta' }],
        atualizacoes: [{ id: t.id, estado: 'pronta', faltando: [], proximoPasso: 'Subir o banner novo e mandar print' },
                       { id: 'id-inventado', estado: 'feita' }],
      });
      const r2 = await processar(msg('Segue a arte final em PNG'), ctx.store, op2);
      assert.equal(r2.novas.length, 0, 'mesma tarefa no mesmo chat não pode duplicar');
      assert.equal(r2.atualizadas.length, 1);
      assert.equal(r2.atualizadas[0].id, t.id);
      assert.equal(r2.atualizadas[0].estado, ESTADOS.PRONTA);
      assert.equal(r2.atualizadas[0].proximoPasso, 'Subir o banner novo e mandar print');

      // A tarefa aberta foi junto no contexto da 2ª chamada
      assert.match(promptEnviado(provedor, ch2[0].body), new RegExp(t.id));
      assert.equal(ctx.store.lerTarefas().filter(x => x.chatId === 'acme-site@g.us').length, 1);
    });
  }

  it('mensagem repetida (mesmo conteúdo) atualiza fontes sem chamar o LLM', async () => {
    const texto = 'Preciso alterar o rodapé do site';
    const r1 = await processar(msg(texto), ctx.store, SEM_LLM);
    assert.equal(r1.novas.length, 1);

    const { opcoes, chamadas } = opcoesLLM('openai', { tarefas: [{ titulo: 'Outra' }], atualizacoes: [] });
    const r2 = await processar(msg(texto), ctx.store, opcoes);
    assert.equal(r2.novas.length, 0);
    assert.equal(chamadas.length, 0);
    assert.equal(ctx.store.lerTarefas().length, 1);
  });

  it('LLM falha (HTTP 500 duas vezes) → cai no heurístico com etapa/proximoPasso', async () => {
    let n = 0;
    const opcoes = { llm: { env: ENV.openai, retryMs: 0, fetch: async () => { n++; return { ok: false, status: 500, json: async () => ({}) }; } } };
    const r = await processar(msg('Preciso emitir o boleto com a razão social nova'), ctx.store, opcoes);
    assert.equal(n, 2, '1 tentativa + 1 retry');
    assert.equal(r.novas.length, 1);
    assert.equal(r.novas[0].etapa, 'financeiro');
    assert.ok(r.novas[0].proximoPasso);
  });

  it('imagem com descricaoImagem entra no prompt', async () => {
    const { opcoes, chamadas } = opcoesLLM('anthropic', { tarefas: [], atualizacoes: [] });
    const m = criarMensagem({ chatId: 'acme-site@g.us', chatNome: 'Site - Acme', tipo: 'imagem', texto: '' });
    await processar({ ...m, descricaoImagem: '[comprovante] Pix de R$ 300,00' }, ctx.store, opcoes);
    assert.match(promptEnviado('anthropic', chamadas[0].body), /\(imagem\) \[comprovante\] Pix de R\$ 300,00/);
  });
});

describe('grupo despejo / origem pessoal', () => {
  let ctx;
  beforeEach(() => { ctx = novoStore(); });
  afterEach(() => rmSync(ctx.dir, { recursive: true, force: true }));

  const despejo = (texto, extra = {}) => criarMensagem({ chatId: 'despejo@g.us', chatNome: 'Despejo', texto, ...extra });

  it('heurístico: anotação sem verbo de pedido vira tarefa administrativa/pessoal', async () => {
    const r1 = await processar(despejo('Ligar pro contador sobre o DAS'), ctx.store, SEM_LLM);
    assert.equal(r1.novas.length, 1);
    assert.equal(r1.novas[0].tipo, 'administrativo');
    assert.equal(r1.novas[0].etapa, 'administrativo');

    const r2 = await processar(despejo('Comprar ração do cachorro'), ctx.store, SEM_LLM);
    assert.equal(r2.novas.length, 1);
    assert.equal(r2.novas[0].tipo, 'pessoal');
    assert.equal(r2.novas[0].etapa, 'pessoal');
    assert.equal(r2.novas[0].titulo, 'Comprar ração do cachorro');
  });

  it('heurístico: "ok"/"valeu" no despejo não vira tarefa; grupo de cliente ignora anotação solta', async () => {
    assert.equal((await processar(despejo('valeu!'), ctx.store, SEM_LLM)).novas.length, 0);
    assert.equal((await processar(msg('Comprar ração do cachorro'), ctx.store, SEM_LLM)).novas.length, 0);
  });

  it('origem pessoal conta como despejo', async () => {
    const m = criarMensagem({ chatId: '5511999@s.whatsapp.net', chatNome: 'Eu', origem: 'pessoal', texto: 'Renovar CNH semana que vem' });
    const r = await processar(m, ctx.store, SEM_LLM);
    assert.equal(r.novas.length, 1);
  });

  it('prompt do LLM marca o grupo como DESPEJO', () => {
    const contexto = { chatId: 'despejo@g.us', mensagens: [despejo('Pagar IPVA')], tarefasAbertas: [] };
    const prompt = montarPromptContexto(contexto, { empresa: 'Eu', projeto: 'Despejo', tipoGrupo: 'despejo' }, []);
    assert.match(prompt, /Tipo do grupo: despejo — DESPEJO/);
  });
});

describe('heurístico — etapa e proximoPasso', () => {
  let ctx;
  beforeEach(() => { ctx = novoStore(); });
  afterEach(() => rmSync(ctx.dir, { recursive: true, force: true }));

  const casos = [
    ['Preciso pagar a fatura da hospedagem', 'financeiro'],
    ['Pode corrigir o erro no formulário?', 'ajustes'],
    ['Pode aprovar a arte do post de sexta?', 'aprovacao'],
    ['Preciso subir a versão final no ar', 'entrega'],
    ['Preciso criar a página de contato', 'producao'],
  ];
  for (const [texto, etapa] of casos) {
    it(`"${texto}" → ${etapa}`, async () => {
      const r = await processar(msg(texto), ctx.store, SEM_LLM);
      assert.equal(r.novas.length, 1);
      assert.equal(r.novas[0].etapa, etapa);
      assert.ok(Object.hasOwn(ETAPAS, r.novas[0].etapa));
      assert.ok(r.novas[0].proximoPasso.length > 0);
    });
  }

  it('aguardando_info → próximo passo pede o que falta', async () => {
    const r = await processar(msg('Preciso alterar a razão social no boleto, falta o CNPJ novo'), ctx.store, SEM_LLM);
    assert.equal(r.novas[0].estado, ESTADOS.AGUARDANDO_INFO);
    assert.match(r.novas[0].proximoPasso, /^Pedir no grupo: .*CNPJ novo/);
  });
});

describe('títulos', () => {
  it('≤70 chars, sem cortar palavra e sem preposição pendurada', () => {
    const longo = 'Preciso atualizar a página de serviços com os novos preços de manutenção mensal e o texto revisado pelo jurídico';
    const t = gerarTitulo(longo);
    assert.ok(t.length <= 70, t);
    assert.ok(longo.toLowerCase().includes(t.toLowerCase().replace(/^atualizar/, 'atualizar')), 'só palavras inteiras');
    assert.ok(!/\s(de|da|do|com|e|o|a|pelo)$/i.test(t), t);
    assert.ok(!t.endsWith('...'));
  });

  it('tira saudação, vocativo e "Segue"', () => {
    assert.equal(gerarTitulo('Olá Alice, segue o contrato para revisar'), 'Contrato para revisar');
    assert.equal(gerarTitulo('Bom dia pessoal! Precisamos trocar a logo do rodapé.'), 'Trocar a logo do rodapé');
    assert.equal(gerarTitulo('Alice, pode alterar o banner?'), 'Alterar o banner');
  });

  it('prazo vai no fim sem estourar 70', () => {
    const t = gerarTitulo('Preciso atualizar todos os textos institucionais da página sobre e da página de equipe até sexta', 'sexta');
    assert.ok(t.length <= 70, t);
    assert.match(t, /até sexta$/);
  });

  it('sanearTitulo (vindo do LLM) e encurtarTitulo', () => {
    assert.equal(sanearTitulo('Olá, Segue: Emitir boleto.'), 'Emitir boleto');
    assert.equal(sanearTitulo('', 'Preciso emitir boleto'), 'Emitir boleto');
    assert.equal(encurtarTitulo('a'.repeat(80)).length, 70);
  });

  it('normalizarEtapa aceita rótulo com acento', () => {
    assert.equal(normalizarEtapa('Produção'), 'producao');
    assert.equal(normalizarEtapa('Aprovação'), 'aprovacao');
    assert.equal(normalizarEtapa('qualquer'), 'producao');
  });
});
