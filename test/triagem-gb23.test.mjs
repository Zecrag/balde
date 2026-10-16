import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aplicarExtracao } from '../lib/motor/index.mjs';
import { candidatasLimpeza, pagamentoConfirmado } from '../lib/motor/triagem.mjs';
const info = { empresa: 'Cliente ficticio', projeto: 'Teste' };
function executar(texto, extraidas, existentes = [], atualizacoes = []) {
  const mensagem = { id: 'm1', chatId: 'teste', texto, ts: '2026-01-01T12:00:00Z' };
  const tarefas = existentes.map(t => ({ ...info, estado: 'pronta', chatId: 'teste', ...t }));
  const store = { lerTarefas: () => tarefas, upsertTarefa: t => { const i = tarefas.findIndex(x => x.id === t.id); if (i < 0) tarefas.push(t); else tarefas[i] = t; }, lerContexto: () => ({ mensagens: [], tarefasAbertas: [] }), salvarContexto() {} };
  return { ...aplicarExtracao({ store, mensagem, info, contexto: { mensagens: [mensagem] }, novasExtraidas: extraidas, atualizacoes }), tarefas };
}
test('saudação e aceite com conflito de agenda não criam trabalho', () => {
  for (const texto of ['Boa noite', 'Obrigado!', 'Combinado!', 'Pode ser. Tenho outra reunião mais tarde.']) {
    assert.equal(executar(texto, [{ titulo: 'Confirmar agenda', fontes: ['m1'] }]).novas.length, 0);
  }
});
test('saudação seguida de pedido real preserva tarefa', () => {
  assert.equal(executar('Boa noite, envie o contrato revisado', [{ titulo: 'Enviar contrato revisado' }]).novas.length, 1);
});
test('comprovante conclui cobrança e elimina recebimento artificial', () => {
  const r = executar('Segue o comprovante de pagamento', [{ titulo: 'Confirmar recebimento do documento' }], [{ id: 't1', titulo: 'Cobrar mensalidade' }]);
  assert.equal(r.novas.length, 0);
  assert.equal(r.tarefas[0].estado, 'feita');
});
test('não conclui pagamento futuro, negado, ambíguo ou mídia não lida', () => {
  for (const texto of ['Ainda não paguei', 'Vou enviar o comprovante', '[📎 não lido: pdf]', 'Pagamento agendado']) assert.equal(pagamentoConfirmado({ texto }), false);
  const r = executar('Paguei', [], [{ id: 't1', titulo: 'Cobrar janeiro' }, { id: 't2', titulo: 'Cobrar fevereiro' }]);
  assert.ok(r.tarefas.every(t => t.estado === 'pronta'));
});
test('deduplica sinônimos entre chats do cliente/projeto e dentro da extração', () => {
  const a = { titulo: 'Mandar contrato revisado' };
  assert.equal(executar('Preciso do contrato revisado', [a], [{ id: 't1', titulo: 'Enviar contrato revisado', chatId: 'outro' }]).novas.length, 0);
  assert.equal(executar('Preciso do contrato revisado', [a, { ...a }]).novas.length, 1);
});
test('preserva cliente, projeto e pedido diferentes', () => {
  for (const diferente of [{ empresa: 'Outra empresa' }, { projeto: 'Outro projeto', chatId: 'outro' }, { titulo: 'Revisar contrato revisado' }]) {
    const r = executar('Envie o contrato revisado', [{ titulo: 'Enviar contrato revisado' }], [{ id: 't1', titulo: 'Enviar contrato revisado', ...diferente }]);
    assert.equal(r.novas.length, 1);
  }
});
test('limpeza é pura e retorna candidatos sem conteúdo pessoal', () => {
  const tarefas = [{ ...info, id: '1', titulo: 'Enviar contrato revisado', estado: 'pronta' }, { ...info, id: '2', titulo: 'Mandar contrato revisado', estado: 'pronta' }, { ...info, id: '3', titulo: 'Cumprimentar contato', estado: 'pronta' }, { ...info, id: '4', titulo: 'Cumprimentar contato', estado: 'feita' }];
  const antes = JSON.stringify(tarefas);
  assert.deepEqual(candidatasLimpeza(tarefas).map(t => t.id), ['2', '3']);
  assert.equal(JSON.stringify(tarefas), antes);
});
