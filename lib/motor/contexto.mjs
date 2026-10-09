/**
 * contexto.mjs — Acumula contexto por chat (janela deslizante).
 *
 * Mantém as últimas N mensagens e os IDs de tarefas abertas
 * para aquele chatId, persistindo em dados/contextos/<chatId>.json.
 */

import { criarContexto } from '../tipos.mjs';

/** Tamanho máximo da janela de mensagens por chat */
const JANELA_MAXIMA = 50;

/**
 * Acumula uma mensagem no contexto do chat.
 *
 * @param {import('../store.mjs').Store} store
 * @param {import('../tipos.mjs').Mensagem} mensagem
 * @returns {import('../tipos.mjs').ContextoChat}
 */
export function acumularContexto(store, mensagem) {
  const existente = store.lerContexto(mensagem.chatId);

  const contexto = existente
    ? { ...existente }
    : criarContexto({ chatId: mensagem.chatId });

  // Adiciona a mensagem à janela
  contexto.mensagens = [...contexto.mensagens, mensagem].slice(-JANELA_MAXIMA);
  contexto.atualizadoEm = new Date().toISOString();

  store.salvarContexto(contexto);
  return contexto;
}

/**
 * Registra uma tarefa aberta no contexto do chat.
 */
export function registrarTarefaNoContexto(store, chatId, tarefaId) {
  const contexto = store.lerContexto(chatId);
  if (!contexto) return;

  if (!contexto.tarefasAbertas.includes(tarefaId)) {
    contexto.tarefasAbertas = [...contexto.tarefasAbertas, tarefaId];
    contexto.atualizadoEm = new Date().toISOString();
    store.salvarContexto(contexto);
  }
}

/**
 * Remove uma tarefa do contexto do chat (quando concluída).
 */
export function removerTarefaDoContexto(store, chatId, tarefaId) {
  const contexto = store.lerContexto(chatId);
  if (!contexto) return;

  contexto.tarefasAbertas = contexto.tarefasAbertas.filter(id => id !== tarefaId);
  contexto.atualizadoEm = new Date().toISOString();
  store.salvarContexto(contexto);
}
