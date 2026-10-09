/**
 * motor-merge-conservador.test.mjs — GB-30: pedidos diferentes no mesmo grupo viram
 * tarefas separadas; só funde quando a mensagem complementa a mesma tarefa.
 * Caso real: grupo Loja Exemplo (promessa, legendas, plataforma do link).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { criarMensagem, ESTADOS } from '../lib/tipos.mjs';
import { criarStore } from '../lib/store.mjs';
import { processar } from '../lib/motor/index.mjs';
import { acharSimilar, mesmaTarefa } from '../lib/motor/similaridade.mjs';

const CHAT = '120363000000000030@g.us';
const CLIENTES = [{ empresa: 'Loja Exemplo', projeto: 'Ads', grupos: [CHAT], receitaMensal: 3000, pesoUrgencia: 1 }];

function novoStore() {
  const dir = mkdtempSync(join(tmpdir(), 'balde-gb30-'));
  mkdirSync(join(dir, 'dados', 'contextos'), { recursive: true });
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(join(dir, 'config', 'clientes.json'), JSON.stringify(CLIENTES));
  return { dir, store: criarStore(dir) };
}

let seq = 0;
function msg(texto, autor = 'Cliente') {
  seq++;
  return criarMensagem({
    id: `gb30-${seq}`, chatId: CHAT, chatNome: 'Loja Exemplo - Ads', autor, texto,
    ts: new Date(Date.UTC(2026, 9, 6, 19, seq)).toISOString(),
  });
}

/** fetch OpenAI mockado: a n-ésima chamada devolve `respostas[n-1](prompt)`. */
function openaiMock(respostas) {
  const prompts = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const prompt = body.messages.at(-1).content[0].text;
    prompts.push({ prompt, system: body.messages[0].content });
    const payload = respostas[prompts.length - 1](prompt);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }) };
  };
  return { opcoes: { llm: { env: { OPENAI_API_KEY: 'k', BALDE_LLM: 'openai' }, fetch, retryMs: 0 } }, prompts };
}

const nova = (titulo, descricao, extra = {}) => ({
  tarefas: [{ titulo, descricao, estado: 'pronta', faltando: [], prazo: null, tipo: 'geral', etapa: 'producao',
    proximoPasso: 'Executar e avisar no grupo', ...extra }],
  atualizacoes: [],
});

// Descrições com o mesmo contexto ("campanha de Ads da Loja Exemplo"), como o LLM real escreve.
const PROMESSA = nova('Definir promessa clara e forte para anúncios', 'Criar uma promessa para a campanha de Ads da Loja Exemplo.');
const LEGENDAS = nova('Adicionar legendas ao vídeo dos anúncios', 'Vídeo da campanha de Ads da Loja Exemplo sem legenda.');
const PLATAFORMA = nova('Confirmar plataforma do link de pagamento', 'Confirmar em qual plataforma a Loja Exemplo fez o link de pagamento da campanha de Ads.',
  { estado: 'aguardando_info', faltando: ['plataforma do link de pagamento'] });

describe('GB-30 — merge conservador no motor (LLM mockado)', () => {
  let ctx;
  beforeEach(() => { ctx = novoStore(); });
  afterEach(() => rmSync(ctx.dir, { recursive: true, force: true }));

  it('3 pedidos diferentes no mesmo grupo → 3 tarefas', async () => {
    const { opcoes, prompts } = openaiMock([() => PROMESSA, () => LEGENDAS, () => PLATAFORMA]);
    await processar(msg('Sei que preciso de uma promessa clara e forte'), ctx.store, opcoes);
    await processar(msg('Aqui está o vídeo que gravei está sem legenda sem nada'), ctx.store, opcoes);
    await processar(msg('Boa, você fez link de pagamento em qual?', 'Alice Appi'), ctx.store, opcoes);

    const titulos = ctx.store.lerTarefas().map(t => t.titulo).sort();
    assert.deepEqual(titulos, [
      'Adicionar legendas ao vídeo dos anúncios',
      'Confirmar plataforma do link de pagamento',
      'Definir promessa clara e forte para anúncios',
    ]);
    for (const t of ctx.store.lerTarefas()) assert.doesNotMatch(t.descricao, /\[Atualização\]/);

    assert.match(prompts[0].system, /Pedido DIFERENTE no mesmo grupo = tarefa NOVA/);
    assert.match(prompts[0].system, /Na dúvida entre atualizar e criar, CRIE/);
    assert.match(prompts[2].prompt, /Pedido diferente, mesmo do mesmo projeto, vai em "tarefas"/);
  });

  it('complemento real atualiza: resposta via atualizacoes[id] e via título quase igual', async () => {
    let idPlataforma;
    const { opcoes } = openaiMock([
      () => PROMESSA,
      () => PLATAFORMA,
      prompt => {
        idPlataforma = JSON.parse(prompt.match(/Tarefas abertas[^\n]*\n([\s\S]*?\n\])/)[1])
          .find(t => t.titulo.startsWith('Confirmar')).id;
        return { tarefas: [], atualizacoes: [{ id: idPlataforma, faltando: [], estado: 'pronta', descricao: 'Cliente respondeu: Kiwify.' }] };
      },
      // LLM ignora a tarefa aberta e "cria" a mesma com outras palavras → rede funde
      () => nova('Confirmar plataforma usada no link de pagamento', 'Plataforma confirmada: Kiwify, link de pagamento.'),
    ]);
    await processar(msg('Sei que preciso de uma promessa clara e forte'), ctx.store, opcoes);
    await processar(msg('Boa, você fez link de pagamento em qual?', 'Alice Appi'), ctx.store, opcoes);
    const r3 = await processar(msg('Kiwify'), ctx.store, opcoes);
    const r4 = await processar(msg('A plataforma do link é a Kiwify mesmo'), ctx.store, opcoes);

    assert.equal(r3.novas.length, 0);
    assert.equal(r3.atualizadas[0].id, idPlataforma);
    assert.equal(r4.novas.length, 0, 'complemento com título quase igual não vira 2ª tarefa');
    assert.equal(r4.atualizadas[0].id, idPlataforma);

    const tarefas = ctx.store.lerTarefas();
    assert.equal(tarefas.length, 2);
    const plataforma = tarefas.find(t => t.id === idPlataforma);
    assert.equal(plataforma.estado, ESTADOS.PRONTA);
    assert.deepEqual(plataforma.faltando, []);
    assert.match(plataforma.descricao, /\[Atualização\].*Kiwify/s);
    assert.equal(plataforma.fontes.length, 3);
    assert.doesNotMatch(tarefas.find(t => t.id !== idPlataforma).descricao, /Kiwify/);
  });
});

describe('GB-30 — similaridade exige mesmo verbo e mesmo objeto', () => {
  const aberta = (titulo, descricao = 'Campanha de Ads da Loja Exemplo') =>
    ({ id: titulo, titulo, descricao, empresa: 'Loja Exemplo', projeto: 'Ads' });

  it('mesmo projeto/palavras em comum, pedidos diferentes → não funde', () => {
    const abertas = [aberta('Definir promessa clara e forte para anúncios')];
    assert.equal(acharSimilar({ titulo: 'Adicionar legendas ao vídeo dos anúncios', descricao: 'Campanha de Ads da Loja Exemplo' }, abertas), null);
    assert.equal(acharSimilar({ titulo: 'Criar anúncios novos de vídeo' }, abertas), null, 'mesmo verbo, objeto diferente');
    assert.equal(mesmaTarefa({ titulo: 'Revisar anúncios Loja Exemplo Ads' }, aberta('Publicar anúncios Loja Exemplo Ads')), false,
      'empresa/projeto no título não contam como objeto em comum');
  });

  it('mesmo verbo (ou sinônimo) e mesmo objeto → funde', () => {
    assert.ok(mesmaTarefa({ titulo: 'Criar promessa clara e forte para anúncios' }, aberta('Definir promessa clara e forte para anúncios')));
    assert.ok(mesmaTarefa({ titulo: 'Atualizar o banner da home da promoção Black Friday até sexta' }, aberta('Atualizar o banner da home para a promoção')));
    assert.ok(mesmaTarefa({ titulo: 'Confirmar plataforma do link de pagamento' }, aberta('confirmar plataforma do link de pagamento')));
  });
});
