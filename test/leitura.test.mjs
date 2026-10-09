/**
 * leitura.test.mjs — Leitura manual (GB-44): cursor, uma chamada por grupo,
 * teto diário, mídia barata, registro e resumo de custo, rotas HTTP.
 * Tudo com mocks: nenhuma chamada real, nada em dados/ real.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';

const RAIZ_TESTE = mkdtempSync(join(tmpdir(), 'balde-leitura-'));
process.env.BALDE_DADOS = join(RAIZ_TESTE, 'dados');
process.env.BALDE_CONFIG = join(RAIZ_TESTE, 'config');

const { lerAgora, resumoUso, estimarCusto, criarRotaLeitura, caminhoDados, montarPromptLote, TEXTO_MAX, SYSTEM_LOTE } = await import('../lib/leitura.mjs');
const { criarStore } = await import('../lib/store.mjs');

const G1 = '111@g.us';
const G2 = '222@g.us';
const GRUPOS = [
  { jid: G1, empresa: 'Acme', projeto: 'Site', tipo: 'cliente' },
  { jid: G2, empresa: 'Beta', projeto: 'Ads', tipo: 'cliente' },
];
const T0 = Math.floor(Date.UTC(2026, 9, 8, 12, 0) / 1000);

let dados;
let store;

beforeEach(() => {
  rmSync(RAIZ_TESTE, { recursive: true, force: true });
  dados = process.env.BALDE_DADOS;
  mkdirSync(join(dados, 'contextos'), { recursive: true });
  mkdirSync(process.env.BALDE_CONFIG, { recursive: true });
  writeFileSync(join(process.env.BALDE_CONFIG, 'clientes.json'), JSON.stringify([
    { empresa: 'Acme', projeto: 'Site', grupos: [G1], receitaMensal: 1000 },
    { empresa: 'Beta', projeto: 'Ads', grupos: [G2], receitaMensal: 500 },
  ]));
  store = criarStore(RAIZ_TESTE);
});
afterEach(() => rmSync(RAIZ_TESTE, { recursive: true, force: true }));

/** Registro cru da Evolution. */
const reg = (jid, id, seg, texto, tipo = 'texto') => ({ key: { id, remoteJid: jid }, messageTimestamp: T0 + seg, pushName: 'Cliente', texto, tipo });

/** Evolution falsa: `porGrupo[jid]` = registros; conta páginas pedidas. */
function evolution(porGrupo) {
  const pedidas = [];
  return {
    pedidas,
    buscarPagina: async (jid, page) => {
      pedidas.push({ jid, page });
      const todos = [...(porGrupo[jid] ?? [])].sort((a, b) => b.messageTimestamp - a.messageTimestamp);
      return { records: todos.slice((page - 1) * 50, page * 50), pages: Math.max(1, Math.ceil(todos.length / 50)) };
    },
  };
}

const normalizar = async r => ({
  id: r.key.id, chatId: r.key.remoteJid, chatNome: r.key.remoteJid, origem: 'grupo', autor: r.pushName,
  ts: new Date(r.messageTimestamp * 1000).toISOString(), tipo: r.tipo, texto: r.texto,
  ...(r.tipo !== 'texto' ? { midiaPath: join(dados, 'midia', `${r.key.id}.bin`) } : {}),
});

/** LLM falso (OpenAI): devolve `respostas` em ordem e conta as chamadas. */
function llm(...respostas) {
  const chamadas = [];
  const fetch = async (url, init) => {
    chamadas.push({ url, body: JSON.parse(init.body) });
    const p = respostas.shift() ?? { n: [], a: [] };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(p) } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } }) };
  };
  return { fetch, chamadas };
}

const ENV = { OPENAI_API_KEY: 'sk-teste', BALDE_DADOS: undefined };
const opcoes = (ev, l, extra = {}) => ({
  env: ENV, dadosDir: dados, store, gruposConfig: GRUPOS, buscarPagina: ev.buscarPagina, normalizar,
  fetch: l.fetch, log: () => {}, agoraMs: T0 * 1000, ...extra,
});
const usoLinhas = () => existsSync(join(dados, 'uso-llm.jsonl'))
  ? readFileSync(join(dados, 'uso-llm.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];

/** Primeira leitura só fixa o cursor (grupo começa agora). */
async function iniciar(ev, l) {
  const r = await lerAgora(opcoes(ev, l));
  assert.ok(r.grupos.every(g => g.iniciado));
}

describe('lerAgora — cursor e uma chamada por grupo', () => {
  it('grupo sem cursor começa agora: nada do passado, 0 páginas, 0 chamadas', async () => {
    const ev = evolution({ [G1]: [reg(G1, 'velha', -3600, 'preciso do site novo')] });
    const l = llm();
    const r = await lerAgora(opcoes(ev, l));
    assert.equal(ev.pedidas.length, 0);
    assert.equal(l.chamadas.length, 0);
    assert.equal(r.chamadas, 0);
    const estado = JSON.parse(readFileSync(join(dados, 'leitura.json'), 'utf8'));
    assert.equal(estado.grupos[G1].cursor.ts, T0);
    assert.ok(estado.ultimaLeitura);
  });

  it('sem novidade = 0 chamadas', async () => {
    const ev = evolution({ [G1]: [], [G2]: [] });
    const l = llm();
    await iniciar(ev, l);
    const r = await lerAgora(opcoes(ev, l));
    assert.equal(l.chamadas.length, 0);
    assert.equal(r.chamadas, 0);
    assert.equal(r.custoUSD, 0);
    assert.equal(usoLinhas().length, 0);
  });

  it('10 mensagens num grupo = 1 chamada; contexto só id+título; texto truncado em 800', async () => {
    const msgs = { [G1]: [], [G2]: [] };
    const ev = evolution(msgs);
    const l = llm({ n: [{ m: ['m1'], t: 'Trocar banner da home', d: 'x'.repeat(500), e: 'pronta', r: 'eu', tp: 'desenvolvimento', et: 'ajustes' }] });
    await iniciar(ev, l);
    store.upsertTarefa({ id: 'T-velha', titulo: 'Corrigir formulário', descricao: 'segredo longo da descrição', estado: 'pronta', empresa: 'Acme', projeto: 'Site', chatId: G1 });
    for (let i = 1; i <= 10; i++) msgs[G1].push(reg(G1, `m${i}`, i, i === 1 ? 'preciso trocar o banner ' + 'y'.repeat(2000) : `mensagem ${i}`));

    const r = await lerAgora(opcoes(ev, l));
    assert.equal(l.chamadas.length, 1);
    assert.equal(r.chamadas, 1);
    const g = r.grupos.find(x => x.jid === G1);
    assert.equal(g.novas, 10);
    assert.equal(g.tarefasNovas, 1);

    const { body } = l.chamadas[0];
    assert.equal(body.max_completion_tokens, 600);
    const prompt = body.messages[1].content.map?.(p => p.text).join('') ?? body.messages[1].content;
    assert.match(prompt, /T-velha\|Corrigir formulário/);
    assert.ok(!prompt.includes('segredo longo'), 'descrição da tarefa não vai no contexto');
    const linhaM1 = prompt.split('\n').find(x => x.startsWith('[m1]'));
    assert.ok(linhaM1.length <= TEXTO_MAX + 30, `linha com ${linhaM1.length}`);
    assert.ok(body.messages[0].content.startsWith(SYSTEM_LOTE), "system estável");

    const tarefa = store.lerTarefas().find(t => t.titulo === 'Trocar banner da home');
    assert.ok(tarefa);
    assert.ok(tarefa.descricao.length <= 200);
    assert.deepEqual(tarefa.fontes ?? tarefa.mensagensRef, ['m1']);

    const [uso] = usoLinhas();
    assert.equal(uso.leituraId, r.leituraId);
    assert.equal(uso.tipo, 'extracao');
    assert.equal(uso.grupoJid, G1);
    assert.equal(uso.empresa, 'Acme');
    assert.equal(uso.tokensIn, 1000);
    assert.equal(uso.tokensOut, 100);
    assert.ok(uso.custoUSD > 0);
    const linhas = readFileSync(join(dados, 'leituras.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(linhas.at(-1).leituraId, r.leituraId);
    assert.equal(linhas.at(-1).chamadas, 1);
  });

  it('mensagem ≤ cursor nunca é reenviada', async () => {
    const msgs = { [G1]: [] };
    const ev = evolution(msgs);
    const l = llm({ n: [] }, { n: [] });
    await lerAgora(opcoes(ev, l, { gruposConfig: [GRUPOS[0]] }));
    msgs[G1].push(reg(G1, 'antiga', 0, 'mesmo segundo do início'), reg(G1, 'a1', 5, 'preciso do logo'));
    await lerAgora(opcoes(ev, l, { gruposConfig: [GRUPOS[0]] }));
    assert.equal(l.chamadas.length, 1);
    const primeira = JSON.stringify(l.chamadas[0].body);
    assert.ok(!primeira.includes('[antiga]'), 'ts igual ao cursor inicial não entra');
    assert.ok(primeira.includes('[a1]'));

    msgs[G1].push(reg(G1, 'a2', 9, 'agora o rodapé'));
    await lerAgora(opcoes(ev, l, { gruposConfig: [GRUPOS[0]] }));
    assert.equal(l.chamadas.length, 2);
    const segunda = JSON.stringify(l.chamadas[1].body);
    assert.ok(segunda.includes('[a2]'));
    assert.ok(!segunda.includes('[a1]'), 'a1 já lida');

    await lerAgora(opcoes(ev, l, { gruposConfig: [GRUPOS[0]] }));
    assert.equal(l.chamadas.length, 2, 'sem novidade = sem chamada');
    const ids = readFileSync(join(dados, 'mensagens.jsonl'), 'utf8').trim().split('\n').map(x => JSON.parse(x).id);
    assert.deepEqual(ids, ['a1', 'a2']);
  });

  it('teto do dia bloqueia: grava sem chamar o LLM, avisa e guarda pendentes', async () => {
    const msgs = { [G1]: [] };
    const ev = evolution(msgs);
    const l = llm({ n: [] });
    await lerAgora(opcoes(ev, l, { gruposConfig: [GRUPOS[0]] }));
    writeFileSync(join(dados, 'uso-llm.jsonl'), JSON.stringify({ ts: new Date().toISOString(), tipo: 'extracao', custoUSD: 0.6 }) + '\n');
    msgs[G1].push(reg(G1, 'b1', 3, 'preciso do boleto'));

    const r = await lerAgora(opcoes(ev, l, { gruposConfig: [GRUPOS[0]] }));
    assert.equal(l.chamadas.length, 0);
    assert.equal(r.bloqueadoPorTeto, true);
    assert.match(r.avisos.join(' '), /Limite do dia/);
    assert.equal(r.grupos[0].pendentes, 1);
    assert.ok(readFileSync(join(dados, 'mensagens.jsonl'), 'utf8').includes('"b1"'), 'mensagem gravada');

    // Teto maior: a pendente vai na próxima leitura, sem reler a Evolution
    const r2 = await lerAgora(opcoes(ev, l, { gruposConfig: [GRUPOS[0]], env: { ...ENV, BALDE_LLM_LIMITE_DIA_USD: '5' } }));
    assert.equal(l.chamadas.length, 1);
    assert.ok(JSON.stringify(l.chamadas[0].body).includes('[b1]'));
    assert.equal(r2.grupos[0].pendentes, 0);
  });

  it('imagem (desligada por padrão) não chama LLM; legenda vai marcada "📎 não lido"', async () => {
    const msgs = { [G1]: [] };
    const ev = evolution(msgs);
    const l = llm({ n: [] });
    await lerAgora(opcoes(ev, l, { gruposConfig: [GRUPOS[0]] }));
    msgs[G1].push(reg(G1, 'img1', 2, '', 'imagem'));
    let r = await lerAgora(opcoes(ev, l, { gruposConfig: [GRUPOS[0]] }));
    assert.equal(l.chamadas.length, 0, 'imagem sem legenda: nada a extrair, nenhuma chamada (nem de visão)');
    assert.equal(r.chamadas, 0);

    msgs[G1].push(reg(G1, 'img2', 4, 'ajusta esse layout', 'imagem'));
    r = await lerAgora(opcoes(ev, l, { gruposConfig: [GRUPOS[0]] }));
    assert.equal(l.chamadas.length, 1, 'só a chamada do lote de texto');
    assert.match(JSON.stringify(l.chamadas[0].body), /📎 não lido: imagem/);
    assert.ok(!JSON.stringify(l.chamadas[0].body).includes('image_url'), 'nenhuma imagem enviada');
  });

  it('áudio novo: transcrição barata uma vez, custo na linha da leitura', async () => {
    const msgs = { [G1]: [] };
    const ev = evolution(msgs);
    const l = llm({ n: [] });
    const transcritos = [];
    const transcrever = async (m, o) => {
      transcritos.push(m.id);
      assert.equal(o.uso.grupoJid, G1);
      return { transcricao: 'preciso que mude a cor do botão', custoUSD: 0.003 };
    };
    await lerAgora(opcoes(ev, l, { gruposConfig: [GRUPOS[0]], transcrever }));
    msgs[G1].push(reg(G1, 'au1', 2, '', 'audio'));
    const r = await lerAgora(opcoes(ev, l, { gruposConfig: [GRUPOS[0]], transcrever }));
    await lerAgora(opcoes(ev, l, { gruposConfig: [GRUPOS[0]], transcrever }));
    assert.deepEqual(transcritos, ['au1']);
    assert.equal(r.grupos[0].audios, 1);
    assert.ok(r.custoUSD >= 0.003);
    assert.match(JSON.stringify(l.chamadas[0].body), /mude a cor do botão/);
  });

  it('LLM desligado: heurística local, 0 chamadas pagas', async () => {
    const msgs = { [G1]: [] };
    const ev = evolution(msgs);
    const l = llm();
    const env = { BALDE_LLM: 'off', OPENAI_API_KEY: 'sk' };
    await lerAgora(opcoes(ev, l, { gruposConfig: [GRUPOS[0]], env }));
    msgs[G1].push(reg(G1, 'h1', 2, 'preciso trocar o banner da home'));
    const r = await lerAgora(opcoes(ev, l, { gruposConfig: [GRUPOS[0]], env }));
    assert.equal(l.chamadas.length, 0);
    assert.equal(r.grupos[0].heuristica, true);
    assert.equal(r.grupos[0].tarefasNovas, 1);
  });

  it('em teste sem dadosDir/BALDE_DADOS recusa (nunca dados reais)', () => {
    assert.throws(() => caminhoDados({}, { NODE_TEST_CONTEXT: 'child' }), /recusado/);
  });
});

describe('custo', () => {
  it('resumoUso agrega por leitura, empresa · projeto e dia', () => {
    const linhas = [
      { ts: '2026-10-08T15:00:00.000Z', leituraId: 'L1', empresa: 'Acme', projeto: 'Site', grupoJid: G1, tipo: 'extracao', modelo: 'gpt-4.1-nano', tokensIn: 1000, tokensOut: 100, segundosAudio: 0, custoUSD: 0.00014 },
      { ts: '2026-10-08T15:00:01.000Z', leituraId: 'L1', empresa: 'Acme', projeto: 'Site', grupoJid: G1, tipo: 'transcricao', modelo: 'gpt-4o-mini-transcribe', tokensIn: 0, tokensOut: 0, segundosAudio: 60, custoUSD: 0.003 },
      { ts: '2026-10-09T15:00:00.000Z', leituraId: 'L2', empresa: 'Beta', projeto: 'Ads', tipo: 'extracao', tokensIn: 500, tokensOut: 50, custoUSD: 0.00007 },
    ];
    writeFileSync(join(dados, 'uso-llm.jsonl'), linhas.map(x => JSON.stringify(x)).join('\n') + '\n');
    writeFileSync(join(dados, 'leituras.jsonl'), JSON.stringify({ leituraId: 'L0', inicio: '2026-10-08T14:00:00.000Z', grupos: [] }) + '\n');

    const r = resumoUso({ dadosDir: dados });
    assert.equal(r.total.chamadas, 3);
    assert.equal(r.total.custoUSD, 0.00321);
    assert.equal(r.total.segundosAudio, 60);
    assert.equal(r.porLeitura.L1.chamadas, 2);
    assert.equal(r.porLeitura.L0.custoUSD, 0, 'leitura sem custo aparece');
    assert.equal(r.porEmpresaProjeto['Acme · Site'].custoUSD, 0.00314);
    assert.equal(Object.keys(r.porDia).length, 2);

    const so9 = resumoUso({ dadosDir: dados, desde: '2026-10-09', ate: '2026-10-09' });
    assert.equal(so9.total.chamadas, 1);
    assert.equal(so9.total.custoUSD, 0.00007);
  });

  it('estimarCusto usa a tabela configurável', () => {
    const base = estimarCusto({ chamadas: 7, mensagens: 20, tarefas: 10, minutosAudio: 3 }, { BALDE_LLM_MODELO: 'gpt-4.1-nano', OPENAI_API_KEY: 'k' });
    assert.equal(base.modelo, 'gpt-4.1-nano');
    assert.ok(base.llmUSD > 0 && base.llmUSD < 0.01);
    assert.ok(Math.abs(base.audioUSD - 0.009) < 1e-9);
    const caro = estimarCusto({ chamadas: 7, mensagens: 20 }, { BALDE_LLM_MODELO: 'x', BALDE_LLM_PRECOS: '{"x":{"entrada":10,"saida":10}}', OPENAI_API_KEY: 'k' });
    assert.ok(caro.llmUSD > base.llmUSD * 10);
    assert.equal(estimarCusto({ minutosAudio: 3, audioLocal: true }, {}).audioUSD, 0);
  });

  it('prompt do lote é compacto e estável', () => {
    const p = montarPromptLote({ info: { empresa: 'Acme', projeto: 'Site' }, nomeGrupo: 'G', despejo: false, abertas: [], mensagens: [{ id: 'x', autor: 'A', texto: 'oi' }] });
    assert.match(p, /\(nenhuma\)/);
    assert.ok(SYSTEM_LOTE.length < 1400, `system com ${SYSTEM_LOTE.length} chars`);
  });
});

describe('rotas /api/ler e /api/uso', () => {
  let srv; let base; let lidas;
  beforeEach(async () => {
    lidas = [];
    const rota = criarRotaLeitura({
      host: '127.0.0.1',
      lerAgora: async o => { lidas.push(o); return { leituraId: 'L', chamadas: 0 }; },
      resumoUso: o => ({ total: { custoUSD: 0 }, desde: o.desde }),
      opcoes: { dadosDir: dados },
    });
    srv = http.createServer(async (req, res) => { if (!(await rota(req, res))) { res.writeHead(404); res.end(); } });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${srv.address().port}`;
  });
  afterEach(() => new Promise(r => srv.close(r)));

  it('POST exige application/json; Origin estranha e Host estranho recusados', async () => {
    assert.equal((await fetch(`${base}/api/ler`, { method: 'POST', body: '{}' })).status, 403);
    assert.equal((await fetch(`${base}/api/ler`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://mal.com' }, body: '{}' })).status, 403);
    const hostRuim = await new Promise(res => {
      const req = http.request(`${base}/api/uso`, { headers: { host: 'mal.com' } }, r => { r.resume(); res(r.statusCode); });
      req.end();
    });
    assert.equal(hostRuim, 403);
    assert.equal(lidas.length, 0);
  });

  it('POST /api/ler chama lerAgora com os grupos; GET /api/uso e GET /api/ler respondem', async () => {
    const r = await fetch(`${base}/api/ler`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grupos: ['acme'] }) });
    assert.equal(r.status, 200);
    assert.deepEqual(lidas[0].grupos, ['acme']);
    const u = await (await fetch(`${base}/api/uso?desde=2026-10-01`)).json();
    assert.equal(u.desde, '2026-10-01');
    const e = await (await fetch(`${base}/api/ler`)).json();
    assert.equal(e.emAndamento, false);
    assert.equal((await fetch(`${base}/api/uso`, { method: 'DELETE', headers: { 'content-type': 'application/json' } })).status, 405);
  });
});
