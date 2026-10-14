import test from 'node:test';
import assert from 'node:assert/strict';
import { calcularAlertas } from '../lib/alertas.mjs';
import { montarTexto } from '../lib/avisos-texto.mjs';

test('GB-63: panorama distinto do urgente, estados e três mais antigas sem prazo', () => {
  const hoje = '2026-10-14';
  const base = { empresa: 'Acme', projeto: 'Site', estado: 'pronta' };
  const tarefas = [
    ...[1, 2, 3, 4].map(n => ({ ...base, titulo: `Sem data ${n}`, criadaEm: `2026-10-0${n}T12:00:00Z` })),
    { ...base, titulo: 'Entregue', estado: 'feita', atualizadaEm: hoje },
    { ...base, titulo: 'Atrasada detalhada', prazo: '2026-10-13', estado: 'precisa_decisao' },
    { ...base, titulo: 'Esperando', prazo: hoje, estado: 'aguardando_info' },
    { ...base, titulo: 'Em andamento', prazo: '2026-10-17', estado: 'em_execucao' },
    { ...base, titulo: 'Ignorar', estado: 'descartada' },
    { ...base, titulo: 'Arquivo', arquivado: true },
  ];
  const projetos = [{ ...base, fim: '2026-10-17' }, { empresa: 'Beta', projeto: 'Fora', fim: '2026-10-18' }];
  const alertas = calcularAlertas({ tarefas, projetos, hoje });
  const resumo = montarTexto('resumo', alertas, { hoje });
  const urgente = montarTexto('urgente', alertas, { hoje });
  assert.notEqual(resumo, urgente);
  assert.ok(resumo.startsWith('📋 *Resumo do dia · 14/10*'));
  assert.ok(urgente.startsWith('⚡ *Prazos que pedem atenção · 14/10*'));
  assert.match(resumo, /✅ Concluídas hoje: 1\n• Entregue/);
  assert.match(resumo, /📊 Abertas 7 · Decidir 1 · Falta info 1 · Pra fazer 5/);
  assert.match(resumo, /⏳ Sem prazo: 4 abertas/);
  assert.match(resumo, /Sem data 1 · Acme — há 13 d/);
  assert.ok(resumo.indexOf('Sem data 1') < resumo.indexOf('Sem data 2'));
  assert.match(resumo, /Sem data 3/);
  assert.doesNotMatch(resumo, /Sem data 4|Atrasada detalhada|Ignorar|Arquivo|Fora/);
  assert.match(resumo, /🔴 1 atrasada \(Acme\)/);
  assert.match(resumo, /17\/10 \(faltam 3 d\)/);
  assert.match(urgente, /Atrasada detalhada/);
  assert.doesNotMatch(urgente, /Sem data|Concluídas|Abertas|Fim dos projetos/);
});

test('GB-63: resumo vazio explicita zeros e não inventa idade ausente', () => {
  const hoje = '2026-10-14';
  const vazio = montarTexto('resumo', calcularAlertas({ hoje }), { hoje });
  assert.match(vazio, /Nada concluído hoje/);
  assert.match(vazio, /Abertas 0/);
  assert.match(vazio, /Sem prazo: 0 abertas/);
  const alertas = calcularAlertas({ hoje, tarefas: [{ empresa: 'Balde', titulo: 'Sem criação', estado: 'pronta' }] });
  assert.match(montarTexto('resumo', alertas), /idade indisponível/);
  assert.match(montarTexto('resumo', alertas), /No Balde para organizar: 1/);
});
