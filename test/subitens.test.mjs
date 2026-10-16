import { test } from 'node:test';
import assert from 'node:assert/strict';
import { converterComplementos, candidatasComplemento, juntarSubitens } from '../lib/motor/subitens.mjs';
import { aplicarExtracao } from '../lib/motor/index.mjs';
const info = { empresa: 'Cliente ficticio', projeto: 'Catalogo' };
const pai = () => ({ ...info, id: 'pai', chatId: 'chat', titulo: 'Atualizar catálogo de produtos', estado: 'pronta', fontes: ['original'], subitens: [{ texto: 'Conferir versão', feito: true }] });
const filha = () => ({ ...info, id: 'filha', titulo: 'Lembrar de formatar catálogo de produtos em negrito', estado: 'pronta', fontes: ['detalhe'] });
test('conversão preserva pai, checks e fontes; original vira histórico ligado', () => {
  const antes = [pai(), filha()];
  const resultado = converterComplementos(antes, [{ id: 'filha', principalId: 'pai' }]);
  assert.equal(resultado[0].subitens.length, 2);
  assert.equal(resultado[0].subitens[0].feito, true);
  assert.deepEqual(resultado[0].fontes, ['original', 'detalhe']);
  assert.equal(resultado[1].convertidaPara, 'pai');
  assert.equal(resultado[1].estado, 'descartada');
  assert.equal(antes[1].estado, 'pronta');
  assert.deepEqual(converterComplementos(resultado, [{ id: 'filha', principalId: 'pai' }]), resultado);
});
test('conversão explícita preserva conclusão e recusa outro cliente/ciclos', () => {
  const r = converterComplementos([{ ...pai(), estado: 'feita' }, { ...filha(), estado: 'feita' }], [{ id: 'filha', principalId: 'pai' }]);
  assert.equal(r[0].estado, 'feita');
  assert.equal(r[0].subitens[1].feito, true);
  assert.throws(() => converterComplementos([pai(), { ...filha(), empresa: 'Outro' }], [{ id: 'filha', principalId: 'pai' }]));
  assert.throws(() => converterComplementos([pai(), filha()], [{ id: 'filha', principalId: 'pai' }, { id: 'pai', principalId: 'filha' }]));
});
test('candidatas exigem orientação e pai único no mesmo cliente/projeto', () => {
  assert.deepEqual(candidatasComplemento([pai(), filha()]), [{ id: 'filha', principalId: 'pai' }]);
  assert.equal(candidatasComplemento([pai(), { ...filha(), empresa: 'Outro' }]).length, 0);
  assert.equal(candidatasComplemento([pai(), { ...pai(), id: 'outro' }, filha()]).length, 0);
  assert.equal(candidatasComplemento([pai(), { ...filha(), titulo: 'Criar formulário para catálogo de produtos', descricao: 'Lembrando: usar os dados do catálogo de produtos' }]).length, 0);
});
test('check marcado sobrevive a repetição do modelo', () => {
  assert.deepEqual(juntarSubitens([{ texto: 'Conferir versão', feito: true }], [{ texto: 'conferir versão', feito: false }]), [{ texto: 'Conferir versão', feito: true }]);
});
test('pós-processamento transforma nova orientação em checklist sem trocar estado', () => {
  const tarefas = [pai()];
  const store = { lerTarefas: () => tarefas, upsertTarefa: t => { tarefas[0] = t; } };
  const mensagem = { id: 'm', chatId: 'chat', texto: 'Lembrando: formatar catálogo de produtos em negrito' };
  const r = aplicarExtracao({ store, info, mensagem, contexto: { mensagens: [mensagem] }, novasExtraidas: [filha()], atualizacoes: [] });
  assert.equal(r.novas.length, 0);
  assert.equal(tarefas[0].subitens.length, 2);
  assert.ok(tarefas[0].fontes.includes('detalhe'));
  assert.equal(tarefas[0].estado, 'pronta');
});
