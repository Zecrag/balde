import test from 'node:test';
import assert from 'node:assert/strict';
import { calcularAlertas } from '../lib/alertas.mjs';
import { montarTexto } from '../lib/avisos-texto.mjs';

const hoje = new Date('2026-10-14T12:00:00Z');
const tarefa = (id, prazo, extra = {}) => ({ id, titulo: `Tarefa ${id}`, empresa: 'Acme', projeto: 'Site', estado: 'pronta', prazo, ...extra });
const calcular = (tarefas = [], projetos = [], extra = {}) => calcularAlertas({ tarefas, projetos, hoje, ...extra });

test('GB-61: fuso e virada de dia preservam prazo sem horário', () => {
  const tarefas = [tarefa('data', '2026-10-14'), tarefa('instante', '2026-10-14T02:59:00Z')];
  const antes = calcular(tarefas, [], { hoje: new Date('2026-10-14T02:59:59Z') });
  assert.deepEqual(antes.venceHoje.map(t => t.id), ['instante']);
  assert.equal(antes.proximas[0].dias, 1);
  const depois = calcular(tarefas, [], { hoje: new Date('2026-10-14T03:00:00Z') });
  assert.deepEqual(depois.venceHoje.map(t => t.id), ['data']);
  assert.equal(depois.atrasadas[0].dias, 1);
  assert.equal(calcular(tarefas, [], { hoje: '2026-10-14T02:59:59Z', fuso: 'UTC' }).venceHoje.length, 2);
});

test('GB-61: conta calendário mesmo em mudança de horário de verão', () => {
  const alertas = calcular([tarefa('dst', '2026-03-08T05:00:00Z')], [], { hoje: '2026-03-09T04:00:00Z', fuso: 'America/New_York' });
  assert.equal(alertas.atrasadas[0].dias, 1);
});

test('GB-61: atraso de 1 dia ganha de hoje nas duas agregações', () => {
  for (const tarefas of [[tarefa('a', '2026-10-13'), tarefa('b', '2026-10-14')], [tarefa('b', '2026-10-14'), tarefa('a', '2026-10-13')]]) {
    const alertas = calcular(tarefas);
    assert.deepEqual(alertas.porEmpresa.Acme.pior, { tipo: 'atrasada', dias: 1 });
    assert.deepEqual(alertas.porProjeto['Acme|Site'].pior, { tipo: 'atrasada', dias: 1 });
  }
});

test('GB-61: janela inclusiva, maior atraso e próxima mais perto', () => {
  const alertas = calcular([tarefa('3', '2026-10-17'), tarefa('4', '2026-10-18'), tarefa('1', '2026-10-15')]);
  assert.deepEqual(alertas.proximas.map(t => t.id), ['1', '3']);
  assert.deepEqual(alertas.porEmpresa.Acme.pior, { tipo: 'proxima', dias: 1 });
  assert.equal(calcular([tarefa('4', '2026-10-18')]).porEmpresa.Acme, undefined);
  assert.equal(calcular([tarefa('1', '2026-10-13'), tarefa('5', '2026-10-09')]).porEmpresa.Acme.pior.dias, 5);
  assert.equal(calcular([tarefa('1', '2026-10-15'), tarefa('0', '2026-10-14')]).porEmpresa.Acme.pior.tipo, 'hoje');
});

test('GB-61: fim de projeto gera atraso e conta somente abertas', () => {
  const projetos = [{ empresa: 'Acme', projeto: 'Site', fim: '2026-10-12' }];
  const alertas = calcular([tarefa('a', null), tarefa('b', null, { estado: 'feita' }), tarefa('c', null, { estado: 'descartada' })], projetos);
  assert.deepEqual(alertas.projetosAtrasados, [{ empresa: 'Acme', projeto: 'Site', fim: '2026-10-12', dias: 2, abertas: 1 }]);
  assert.deepEqual(alertas.porProjeto['Acme|Site'].pior, { tipo: 'atrasada', dias: 2 });
  assert.equal(calcular([], [{ ...projetos[0], fim: '2026-10-14' }]).porEmpresa.Acme.pior.tipo, 'hoje');
});

test('GB-61: projeto arquivado exclui tarefas, conclusão, Balde e índices', () => {
  const projetos = [{ empresa: 'Balde', projeto: 'despejo', fim: '2026-10-01', status: 'arquivado' }];
  const tarefas = [tarefa('a', '2026-10-01', projetos[0]), tarefa('b', null, { ...projetos[0], estado: 'feita', atualizadaEm: hoje.toISOString() })];
  assert.deepEqual(calcular(tarefas, projetos), calcular());
});

test('GB-61: feitas hoje usam atualizadaEm e respeitam fuso e estado', () => {
  const alertas = calcular([
    tarefa('feita', null, { estado: 'feita', atualizadaEm: '2026-10-14T03:00:00Z' }),
    tarefa('ontem', null, { estado: 'feita', atualizadaEm: '2026-10-14T02:59:59Z' }),
    tarefa('descartada', '2026-10-01', { estado: 'descartada', atualizadaEm: hoje }),
    tarefa('explicitamente-ontem', null, { estado: 'feita', concluidaEm: '2026-10-13', atualizadaEm: hoje }),
  ]);
  assert.deepEqual(alertas.feitasHoje.map(t => t.id), ['feita']);
  assert.equal(alertas.atrasadas.length, 0);
});

test('GB-61: Balde conta abertas sem duplicação, inclusive projeto tipo despejo', () => {
  const alertas = calcular([
    tarefa('a', null, { empresa: 'Balde', projeto: 'despejo' }),
    tarefa('b', null, { projeto: 'despejo' }),
    tarefa('c', null, { empresa: 'Balde', estado: 'feita' }),
    tarefa('d', null, { projeto: 'Inbox' }),
  ], [{ empresa: 'Acme', projeto: 'Inbox', tipo: 'despejo' }]);
  assert.equal(alertas.baldeParado, 3);
});

test('GB-61: não modifica entradas e ignora prazos ausentes ou inválidos', () => {
  const tarefas = [tarefa('a', '2026-02-30'), tarefa('b', 'sem prazo'), tarefa('c', null)];
  const original = structuredClone(tarefas);
  tarefas.forEach(Object.freeze);
  const alertas = calcular(Object.freeze(tarefas));
  assert.equal(alertas.atrasadas.length, 0);
  assert.equal(alertas.proximas.length, 0);
  assert.equal(alertas.abertas, 3);
  assert.equal(alertas.semPrazo.length, 3);
  assert.deepEqual(tarefas, original);
  assert.throws(() => calcular([], [], { hoje: 'inválida' }), /data válida/);
});

function exemplo() {
  return calcular([
    tarefa('atrasada', '2026-10-13'), tarefa('hoje', '2026-10-14'), tarefa('próxima', '2026-10-17'),
    tarefa('entregue', null, { estado: 'feita', atualizadaEm: hoje }), tarefa('balde', null, { empresa: 'Balde' }),
  ], [{ empresa: 'Acme', projeto: 'Site', fim: '2026-10-12' }]);
}

test('GB-61: urgente agrupa empresas e traz apenas prazos de tarefas', () => {
  const texto = montarTexto('urgente', exemplo(), { hoje });
  assert.match(texto, /\*Acme\*/);
  assert.equal(texto.match(/\*Acme\*/g).length, 1);
  assert.match(texto, /🔴 Tarefa atrasada.*13\/10/);
  assert.match(texto, /🟠 Tarefa hoje.*14\/10/);
  assert.match(texto, /🟡 Tarefa próxima.*17\/10/);
  assert.doesNotMatch(texto, /Feitas hoje|Projetos atrasados|🪣|entregue/);
});

test('GB-61: resumo inclui concluídas, projetos e Balde', () => {
  const texto = montarTexto('resumo', exemplo(), { hoje });
  assert.match(texto, /\*Resumo do dia · 14\/10\*/);
  assert.match(texto, /✅ Concluídas hoje: 1/);
  assert.match(texto, /Tarefa entregue/);
  assert.match(texto, /Fim dos projetos/);
  assert.match(texto, /12\/10 \(atrasado 2 d\)/);
  assert.match(texto, /🪣 No Balde para organizar: 1/);
});

test('GB-61: listas longas mostram +N e texto vazio é positivo em uma linha', () => {
  const alertas = calcular(Array.from({ length: 8 }, (_, i) => tarefa(String(i), '2026-10-14')));
  for (const tipo of ['resumo', 'urgente']) {
    if (tipo === 'urgente') assert.match(montarTexto(tipo, alertas, { hoje }), /\+3/);
    assert.doesNotMatch(montarTexto(tipo, alertas), /Tarefa 5/);
    assert.match(montarTexto(tipo, calcular(), { hoje }), tipo === 'urgente' ? /Tudo em dia!/ : /Nada concluído hoje/);
  }
  assert.throws(() => montarTexto('outro', alertas), /tipo/);
});
