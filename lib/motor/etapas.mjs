/**
 * etapas.mjs — Etapa do fluxo de trabalho em que uma tarefa está.
 *
 * Slug sem acento (estável para filtros/automações) → rótulo para exibição.
 */

export const ETAPAS = Object.freeze({
  briefing:       'Briefing',
  producao:       'Produção',
  aprovacao:      'Aprovação',
  ajustes:        'Ajustes',
  entrega:        'Entrega',
  financeiro:     'Financeiro',
  suporte:        'Suporte',
  administrativo: 'Administrativo',
  pessoal:        'Pessoal',
});

export const ETAPA_PADRAO = 'producao';

/**
 * Normaliza o que veio do LLM/usuário para um slug conhecido.
 * Aceita rótulo com acento ("Produção") ou slug ("producao").
 * @param {unknown} valor
 * @returns {string} slug válido (ETAPA_PADRAO quando não reconhece)
 */
export function normalizarEtapa(valor) {
  if (typeof valor !== 'string') return ETAPA_PADRAO;
  const slug = valor.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  return Object.hasOwn(ETAPAS, slug) ? slug : ETAPA_PADRAO;
}
