/**
 * @file painel-util.test.mjs — GB-41/GB-45: máscaras do painel e leitura do uso da IA (GET /api/uso mockado).
 * Roda com: node --test test/painel-util.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resumoUso } from '../lib/leitura.mjs';
import {
  mascaraData, dataCurta, dataValida, mascaraMoeda, moedaDoArquivo,
  intervalo, normalizarUso, normalizarLeitura, preencherDias, fmtUSD, resultadoDosGrupos,
} from '../painel/util.js';

describe('máscara de data dd/mm/aa', () => {
  it('só números, barras automáticas, no máximo 8 caracteres', () => {
    assert.equal(mascaraData('3'), '3');
    assert.equal(mascaraData('311'), '31/1');
    assert.equal(mascaraData('3112'), '31/12');
    assert.equal(mascaraData('31122'), '31/12/2');
    assert.equal(mascaraData('311226999'), '31/12/26');
    assert.equal(mascaraData('31/ab12-26'), '31/12/26');
    assert.equal(mascaraData('31/12/2026'), '31/12/26', 'colar com ano de 4 dígitos vira aa');
  });
  it('dataCurta normaliza o formato antigo do arquivo; dataValida recusa dia que não existe', () => {
    assert.equal(dataCurta('1/9/2026'), '01/09/26');
    assert.equal(dataCurta('11/09/26'), '11/09/26');
    assert.equal(dataValida(''), true);
    assert.equal(dataValida('29/02/28'), true);
    assert.equal(dataValida('29/02/27'), false);
    assert.equal(dataValida('31/12'), false);
  });
});

describe('máscara de moeda BR', () => {
  it('dígitos são centavos', () => {
    assert.equal(mascaraMoeda(''), '');
    assert.equal(mascaraMoeda('5'), '0,05');
    assert.equal(mascaraMoeda('768000'), '7.680,00');
    assert.equal(mascaraMoeda('R$ 1.234,56'), '1.234,56');
    assert.equal(mascaraMoeda('000'), '');
  });
  it('valor do arquivo vira 0.000,00', () => {
    assert.equal(moedaDoArquivo('7.680,00'), '7.680,00');
    assert.equal(moedaDoArquivo('6000'), '6.000,00');
    assert.equal(moedaDoArquivo(''), '');
  });
});

describe('uso da IA (aba Custos)', () => {
  const agora = new Date(2026, 9, 8, 15, 0);   // 08/10/2026
  it('intervalo: hoje, 7 dias e mês', () => {
    assert.deepEqual(intervalo('hoje', agora), { desde: '2026-10-08', ate: '2026-10-08' });
    assert.deepEqual(intervalo('7d', agora), { desde: '2026-10-02', ate: '2026-10-08' });
    assert.deepEqual(intervalo('mes', agora), { desde: '2026-10-01', ate: '2026-10-08' });
  });

  it('calcula total, por dia e última leitura quando a API só manda as leituras', () => {
    const u = normalizarUso({ leituras: [
      { ts: new Date(2026, 9, 7, 9).toISOString(), custoUSD: 0.01, entrada: 900, saida: 100, mensagensNovas: 4, audios: 1 },
      { ts: new Date(2026, 9, 8, 9).toISOString(), usd: 0.03, tokens: 3000, mensagens: 6, audios: 0, limite: 'teto diário perto' },
    ] });
    assert.deepEqual(u.total, { usd: 0.04, tokens: 4000, chamadas: null, segundosAudio: 0, mensagens: 10, audios: 1 });
    assert.deepEqual(u.porDia.map(d => [d.dia, d.tokens]), [['2026-10-07', 1000], ['2026-10-08', 3000]]);
    assert.equal(u.ultima.usd, 0.03);
    assert.equal(u.leituras[0].aviso, 'teto diário perto');
  });

  it('usa total/porProjeto/porDia/ultima prontos e ordena o ranking por US$', () => {
    const u = normalizarUso({
      total: { usd: 1, tokens: 10, mensagens: 4, audios: 2 },
      leituras: [],
      porProjeto: [{ empresa: 'A', projeto: 'x', usd: 0.2, tokens: 5, mensagens: 0 }, { empresa: 'B', projeto: 'y', usd: 0.8, tokens: 5, mensagens: 4 }],
      porDia: [{ dia: '2026-10-08', usd: 1, tokens: 10 }],
      ultima: { ts: '2026-10-08T12:00:00Z', custoUSD: 0.5 },
    });
    assert.equal(u.total.usd, 1);
    assert.deepEqual(u.porProjeto.map(p => [p.empresa, p.porMensagem]), [['B', 0.2], ['A', null]]);
    assert.equal(u.ultima.usd, 0.5);
  });

  it('resultado do POST /api/ler e eixo de dias com zeros', () => {
    assert.deepEqual(normalizarLeitura({ mensagensNovas: 3, custoUSD: 0.002, aviso: 'limite diário atingido' }),
      { mensagens: 3, usd: 0.002, aviso: 'limite diário atingido' });
    assert.deepEqual(normalizarLeitura({ leitura: { mensagens: 1, usd: 0.1 } }), { mensagens: 1, usd: 0.1, aviso: null });
    const dias = preencherDias([{ dia: '2026-10-03', usd: 1, tokens: 1 }], '2026-10-02', '2026-10-04');
    assert.deepEqual(dias.map(d => d.usd), [0, 1, 0]);
    assert.equal(fmtUSD(1.5), 'US$ 1,50');
    assert.equal(fmtUSD(0.0021), 'US$ 0,0021');
  });

  it('entende o formato real de resumoUso (mapas porLeitura/porEmpresaProjeto/porDia) e o resultado de lerAgora', () => {
    const dir = mkdtempSync(join(tmpdir(), 'balde-uso-'));
    try {
      writeFileSync(join(dir, 'leituras.jsonl'), [
        { leituraId: 'L1', inicio: '2026-10-07T12:00:00.000Z', grupos: [{}, {}] },
        { leituraId: 'L2', inicio: '2026-10-08T12:00:00.000Z', grupos: [{}] },
      ].map(x => JSON.stringify(x)).join('\n') + '\n');
      writeFileSync(join(dir, 'uso-llm.jsonl'), [
        { ts: '2026-10-07T12:00:01.000Z', leituraId: 'L1', empresa: 'Alfa', projeto: 'Site', tokensIn: 900, tokensOut: 100, custoUSD: 0.01 },
        { ts: '2026-10-08T12:00:01.000Z', leituraId: 'L2', empresa: 'Beta', projeto: 'App · v2', tipo: 'transcricao', segundosAudio: 90, custoUSD: 0.03 },
        { ts: '2026-10-08T13:00:00.000Z', empresa: 'Beta', projeto: 'App · v2', tokensIn: 10, tokensOut: 0, custoUSD: 0.001 },
      ].map(x => JSON.stringify(x)).join('\n') + '\n');
      const u = normalizarUso(resumoUso({ dadosDir: dir, desde: '2026-10-01', ate: '2026-10-08' }));
      assert.equal(u.total.usd, 0.041);
      assert.equal(u.total.tokens, 1010);
      assert.equal(u.total.chamadas, 3);
      assert.equal(u.total.mensagens, 0, 'GB-46: resumoUso informa mensagens (0 quando os grupos não têm novas)');
      assert.deepEqual(u.leituras.map(l => [l.id, l.usd]), [['L2', 0.03], ['L1', 0.01]], 'fora-de-leitura não vira leitura');
      assert.deepEqual(u.porProjeto.map(p => [p.empresa, p.projeto, p.usd]), [['Beta', 'App · v2', 0.031], ['Alfa', 'Site', 0.01]]);
      assert.equal(u.porProjeto[0].segundosAudio, 90);
      assert.equal(u.porDia.length, 2);
      assert.equal(u.ultima.id, 'L2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    assert.deepEqual(normalizarLeitura({ leituraId: 'L3', custoUSD: 0.004, chamadas: 2, bloqueadoPorTeto: true,
      avisos: ['Limite do dia atingido (US$ 0.50)'], grupos: [{ novas: 3, audios: 1 }, { novas: 2, audios: 0 }] }),
    { mensagens: 5, usd: 0.004, aviso: 'Limite do dia atingido (US$ 0.50)' });
  });
});

describe('GB-46 — resultadoDosGrupos ("Ler este grupo")', () => {
  it('filtra pelos jids pedidos e soma mensagens, áudios e custo', () => {
    const dados = { custoUSD: 0.01, grupos: [
      { jid: 'a@g.us', mensagens: 3, novas: 3, audios: 1, custoUSD: 0.002, tarefasNovas: 1, atualizadas: 1 },
      { jid: 'b@g.us', novas: 9, custoUSD: 0.008 },
    ] };
    assert.deepEqual(resultadoDosGrupos(dados, ['a@g.us']), { mensagens: 3, audios: 1, usd: 0.002, tarefas: 2, aviso: null });
  });

  it('avisa grupo ausente, primeira leitura, limite e pendentes', () => {
    assert.match(resultadoDosGrupos({ grupos: [] }, ['x@g.us']).aviso, /não está na leitura/);
    assert.match(resultadoDosGrupos({ grupos: [{ jid: 'a', iniciado: true }] }, ['a']).aviso, /primeira leitura/);
    const r = resultadoDosGrupos({ grupos: [{ jid: 'a', novas: 2, bloqueado: true, pendentes: 2 }] }, ['a']);
    assert.match(r.aviso, /limite do dia/);
    assert.match(r.aviso, /2 pendentes/);
  });

  it('normalizarUso mostra mensagens e áudios por projeto vindos do resumoUso', () => {
    const u = normalizarUso({ total: { custoUSD: 0, mensagens: 5, audios: 1 }, porLeitura: {},
      porEmpresaProjeto: { 'Acme · Site': { custoUSD: 0.001, chamadas: 1, tokensIn: 10, tokensOut: 1, mensagens: 5, audios: 1 } } });
    assert.equal(u.total.mensagens, 5);
    assert.deepEqual([u.porProjeto[0].mensagens, u.porProjeto[0].audios], [5, 1]);
    assert.equal(u.porProjeto[0].porMensagem, 0.001 / 5);
  });
});
