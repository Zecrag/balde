/**
 * leitura-gb46.test.mjs — GB-46: modelo escolhido no painel (dados/config-llm.json),
 * ler UM grupo, contagem de mensagens/áudios por projeto e rota GET/PUT /api/config/llm.
 * Tudo com mocks: nenhuma chamada real, nada em dados/ real.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';

const RAIZ_TESTE = mkdtempSync(join(tmpdir(), 'balde-leitura-gb46-'));
process.env.BALDE_DADOS = join(RAIZ_TESTE, 'dados');
process.env.BALDE_CONFIG = join(RAIZ_TESTE, 'config');

const { lerAgora, resumoUso, criarRotaLeitura, estadoConfigLLM } = await import('../lib/leitura.mjs');
const { aplicarConfigEscolhida, lerConfigEscolhida, configLLM } = await import('../lib/llm.mjs');
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

const reg = (jid, id, seg, texto) => ({ key: { id, remoteJid: jid }, messageTimestamp: T0 + seg, pushName: 'Cliente', texto, tipo: 'texto' });
const evolution = porGrupo => {
  const pedidas = [];
  return {
    pedidas,
    buscarPagina: async (jid, page) => {
      pedidas.push(jid);
      const todos = [...(porGrupo[jid] ?? [])].sort((a, b) => b.messageTimestamp - a.messageTimestamp);
      return { records: todos.slice((page - 1) * 50, page * 50), pages: 1 };
    },
  };
};
const normalizar = async r => ({
  id: r.key.id, chatId: r.key.remoteJid, chatNome: r.key.remoteJid, origem: 'grupo', autor: r.pushName,
  ts: new Date(r.messageTimestamp * 1000).toISOString(), tipo: r.tipo, texto: r.texto,
});
const llm = () => {
  const chamadas = [];
  return {
    chamadas,
    fetch: async (url, init) => {
      chamadas.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"n":[],"a":[]}' } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } }) };
    },
  };
};
const ENV = { OPENAI_API_KEY: 'sk-teste', BALDE_LLM_MODELO: 'gpt-4.1-nano' };
const opcoes = (ev, l, extra = {}) => ({
  env: ENV, dadosDir: dados, store, gruposConfig: GRUPOS, buscarPagina: ev.buscarPagina, normalizar,
  fetch: l.fetch, log: () => {}, agoraMs: T0 * 1000, ...extra,
});
const escolher = cfg => writeFileSync(join(dados, 'config-llm.json'), JSON.stringify(cfg));

describe('aplicarConfigEscolhida', () => {
  it('troca modelo e provedor; BALDE_LLM=off continua desligado', () => {
    const e = aplicarConfigEscolhida({ OPENAI_API_KEY: 'k', GEMINI_API_KEY: 'g' }, { modeloExtracao: 'gemini-2.5-flash-lite' });
    assert.equal(configLLM(e).provedor, 'gemini');
    assert.equal(configLLM(e).modelo, 'gemini-2.5-flash-lite');
    assert.equal(configLLM(aplicarConfigEscolhida({ OPENAI_API_KEY: 'k', BALDE_LLM: 'off' }, { modeloExtracao: 'gpt-4o-mini' })), null);
  });

  it('gpt-5-nano liga raciocínio mínimo; outros modelos tiram o reasoning_effort', () => {
    assert.equal(configLLM(aplicarConfigEscolhida({ OPENAI_API_KEY: 'k' }, { modeloExtracao: 'gpt-5-nano' })).raciocinio, 'minimal');
    assert.equal(configLLM(aplicarConfigEscolhida({ OPENAI_API_KEY: 'k', BALDE_LLM_RACIOCINIO: 'low' }, { modeloExtracao: 'gpt-4.1-mini' })).raciocinio, undefined);
  });

  it('transcrição e teto: API força openai; local volta ao whisper; não muda o env original', () => {
    const env = { BALDE_TRANSCRICAO: 'openai' };
    const api = aplicarConfigEscolhida(env, { modeloTranscricao: 'whisper-1', limiteDiaUSD: 0.2 });
    assert.equal(api.BALDE_TRANSCRICAO_MODELO, 'whisper-1');
    assert.equal(api.BALDE_TRANSCRICAO, 'openai');
    assert.equal(api.BALDE_LLM_LIMITE_DIA_USD, '0.2');
    assert.equal(aplicarConfigEscolhida(env, { modeloTranscricao: 'local' }).BALDE_TRANSCRICAO, undefined);
    assert.deepEqual(env, { BALDE_TRANSCRICAO: 'openai' });
  });

  it('lerConfigEscolhida ignora campos inválidos e arquivo quebrado', () => {
    escolher({ modeloExtracao: 'gpt-9-turbo', modeloTranscricao: 'whisper-1', limiteDiaUSD: -1 });
    assert.deepEqual(lerConfigEscolhida(dados), { modeloTranscricao: 'whisper-1' });
    writeFileSync(join(dados, 'config-llm.json'), '{quebrado');
    assert.deepEqual(lerConfigEscolhida(dados), {});
  });
});

describe('leitura com o modelo escolhido', () => {
  it('usa o modelo do config-llm.json (sem reiniciar) e registra mensagens por grupo', async () => {
    const ev = evolution({ [G1]: [reg(G1, 'a', 10, 'Pode trocar o banner?'), reg(G1, 'b', 11, 'e o rodapé')] });
    const l = llm();
    await lerAgora(opcoes(ev, l));                 // primeira leitura só fixa o cursor
    escolher({ modeloExtracao: 'gpt-4o-mini' });
    const r = await lerAgora(opcoes(ev, l, { agoraMs: (T0 + 60) * 1000 }));
    assert.equal(l.chamadas.length, 1);
    assert.equal(l.chamadas[0].body.model, 'gpt-4o-mini');
    const g1 = r.grupos.find(g => g.jid === G1);
    assert.equal(g1.mensagens, 2);
    const uso = readFileSync(join(dados, 'uso-llm.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(uso[0].modelo, 'gpt-4o-mini');
  });

  it('teto do dia escolhido no painel bloqueia a chamada', async () => {
    const ev = evolution({ [G1]: [reg(G1, 'a', 10, 'Pode trocar o banner?')] });
    const l = llm();
    await lerAgora(opcoes(ev, l));
    escolher({ limiteDiaUSD: 0 });
    const r = await lerAgora(opcoes(ev, l, { agoraMs: (T0 + 60) * 1000 }));
    assert.equal(l.chamadas.length, 0);
    assert.equal(r.bloqueadoPorTeto, true);
  });

  it('ler UM grupo: só o jid pedido vai à Evolution', async () => {
    const ev = evolution({});
    const l = llm();
    await lerAgora(opcoes(ev, l));
    ev.pedidas.length = 0;
    const r = await lerAgora(opcoes(ev, l, { grupos: [G2], agoraMs: (T0 + 60) * 1000 }));
    assert.deepEqual(r.grupos.map(g => g.jid), [G2]);
    assert.deepEqual([...new Set(ev.pedidas)], [G2]);
  });
});

describe('resumoUso — mensagens e áudios por projeto', () => {
  it('conta de leituras.jsonl (campo novo mensagens ou antigo novas), inclusive projeto sem custo', () => {
    writeFileSync(join(dados, 'leituras.jsonl'), [
      { leituraId: 'L1', inicio: '2026-10-08T15:00:00.000Z', grupos: [
        { jid: G1, empresa: 'Acme', projeto: 'Site', novas: 4, audios: 1 },
        { jid: G2, empresa: 'Beta', projeto: 'Ads', mensagens: 2, novas: 2, audios: 0 },
      ] },
      { leituraId: 'L2', inicio: '2026-10-09T15:00:00.000Z', grupos: [{ jid: G1, empresa: 'Acme', projeto: 'Site', mensagens: 3, audios: 2 }] },
      { leituraId: 'L3', inicio: '2026-10-09T16:00:00.000Z', grupos: [{ jid: G1, empresa: 'Acme', projeto: 'Site', novas: 0, iniciado: true }] },
    ].map(x => JSON.stringify(x)).join('\n') + '\n');
    writeFileSync(join(dados, 'uso-llm.jsonl'), JSON.stringify({ ts: '2026-10-08T15:00:01.000Z', leituraId: 'L1', empresa: 'Acme', projeto: 'Site', tokensIn: 100, tokensOut: 10, custoUSD: 0.001 }) + '\n');
    const r = resumoUso({ dadosDir: dados });
    assert.equal(r.total.mensagens, 9);
    assert.equal(r.total.audios, 3);
    assert.equal(r.porLeitura.L1.mensagens, 6);
    assert.deepEqual([r.porEmpresaProjeto['Acme · Site'].mensagens, r.porEmpresaProjeto['Acme · Site'].audios], [7, 3]);
    assert.equal(r.porEmpresaProjeto['Beta · Ads'].mensagens, 2);
    assert.equal(r.porEmpresaProjeto['Beta · Ads'].custoUSD, 0);
    const so9 = resumoUso({ dadosDir: dados, desde: '2026-10-09', ate: '2026-10-09' });
    assert.equal(so9.porEmpresaProjeto['Acme · Site'].mensagens, 3);
    assert.equal(so9.porEmpresaProjeto['Beta · Ads'], undefined);
  });
});

describe('GET/PUT /api/config/llm', () => {
  let srv; let base;
  const ENV_ROTA = { OPENAI_API_KEY: 'sk-SEGREDO-123', BALDE_LLM_MODELO: 'gpt-4.1-nano' };
  beforeEach(async () => {
    const rota = criarRotaLeitura({ host: '127.0.0.1', opcoes: { dadosDir: dados, env: ENV_ROTA }, whisper: () => null });
    srv = http.createServer(async (req, res) => { if (!(await rota(req, res))) { res.writeHead(404); res.end(); } });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${srv.address().port}`;
  });
  afterEach(() => new Promise(r => srv.close(r)));
  const put = (corpo, headers = { 'content-type': 'application/json' }) =>
    fetch(`${base}/api/config/llm`, { method: 'PUT', headers, body: JSON.stringify(corpo) });

  it('GET lista modelos com preço e estimativa, diz o que está indisponível e nunca expõe a chave', async () => {
    const r = await fetch(`${base}/api/config/llm`);
    const texto = await r.text();
    assert.equal(r.status, 200);
    assert.ok(!texto.includes('SEGREDO'), 'chave não pode sair na resposta');
    const d = JSON.parse(texto);
    assert.equal(d.efetivo.modeloExtracao, 'gpt-4.1-nano');
    assert.equal(d.efetivo.limiteDiaUSD, 0.5);
    const nano = d.opcoes.extracao.find(m => m.id === 'gpt-4.1-nano');
    assert.deepEqual([nano.entradaPor1M, nano.saidaPor1M, nano.disponivel], [0.1, 0.4, true]);
    assert.ok(nano.estimativaLeituraUSD > 0);
    const mini = d.opcoes.extracao.find(m => m.id === 'gpt-4.1-mini');
    assert.ok(mini.estimativaLeituraUSD > nano.estimativaLeituraUSD);
    assert.equal(d.opcoes.extracao.find(m => m.id === 'gemini-2.5-flash-lite').disponivel, false);
    assert.equal(d.opcoes.transcricao.find(m => m.id === 'local').disponivel, false);
    assert.equal(d.opcoes.transcricao.find(m => m.id === 'gpt-4o-mini-transcribe').porMinutoUSD, 0.003);
  });

  it('PUT grava em dados/config-llm.json e o GET seguinte mostra o efetivo', async () => {
    const r = await put({ modeloExtracao: 'gpt-5-nano', modeloTranscricao: 'whisper-1', limiteDiaUSD: '0,30' });
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(d.efetivo.modeloExtracao, 'gpt-5-nano');
    assert.equal(d.efetivo.modeloTranscricao, 'whisper-1');
    assert.equal(d.efetivo.limiteDiaUSD, 0.3);
    const arq = JSON.parse(readFileSync(join(dados, 'config-llm.json'), 'utf8'));
    assert.equal(arq.modeloExtracao, 'gpt-5-nano');
    // null volta ao .env, campo ausente mantém
    await put({ modeloExtracao: null });
    assert.deepEqual(lerConfigEscolhida(dados), { modeloTranscricao: 'whisper-1', limiteDiaUSD: 0.3 });
  });

  it('PUT recusa modelo desconhecido, provedor sem chave, whisper ausente e teto absurdo', async () => {
    assert.equal((await put({ modeloExtracao: 'gpt-9' })).status, 400);
    assert.match((await (await put({ modeloExtracao: 'gemini-2.5-flash-lite' })).json()).erro, /chave gemini/);
    assert.equal((await put({ modeloTranscricao: 'local' })).status, 400);
    assert.equal((await put({ limiteDiaUSD: 999 })).status, 400);
    assert.equal(existsSync(join(dados, 'config-llm.json')), false);
  });

  it('PUT exige application/json e Origin do próprio painel', async () => {
    assert.equal((await put({ limiteDiaUSD: 1 }, { 'content-type': 'text/plain' })).status, 403);
    assert.equal((await put({ limiteDiaUSD: 1 }, { 'content-type': 'application/json', origin: 'http://mal.com' })).status, 403);
    assert.equal(existsSync(join(dados, 'config-llm.json')), false);
  });

  it('estadoConfigLLM usa a média das leituras como leitura típica', () => {
    writeFileSync(join(dados, 'leituras.jsonl'), JSON.stringify({ leituraId: 'L1', inicio: '2026-10-08T15:00:00.000Z',
      grupos: [{ empresa: 'A', projeto: 'B', mensagens: 12 }, { empresa: 'C', projeto: 'D', novas: 8 }, { empresa: 'E', projeto: 'F', novas: 0 }] }) + '\n');
    const e = estadoConfigLLM({ dadosDir: dados, env: ENV_ROTA, whisper: () => null });
    assert.equal(e.leituraTipica.chamadas, 2);
    assert.equal(e.leituraTipica.mensagens, 20);
  });
});
