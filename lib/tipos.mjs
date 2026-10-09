/**
 * @file tipos.mjs — Tipos compartilhados e fábricas do Balde.
 *
 * JSDoc typedefs para IDE + exports de runtime usados pelo motor.
 */

import { randomUUID } from 'node:crypto';

// ─── Estados possíveis de uma tarefa ────────────────────────────
export const ESTADOS = Object.freeze({
  AGUARDANDO_INFO: 'aguardando_info',
  PRONTA:          'pronta',
  PRECISA_DECISAO: 'precisa_decisao',
  EM_EXECUCAO:     'em_execucao',
  FEITA:           'feita',
  DESCARTADA:      'descartada',
});

// ─── JSDoc typedefs ─────────────────────────────────────────────

/**
 * @typedef {Object} Mensagem
 * @property {string} id
 * @property {string} chatId
 * @property {string} chatNome
 * @property {'grupo'|'pessoal'|'encaminhada'} origem
 * @property {string} autor
 * @property {string} ts  — ISO 8601
 * @property {'texto'|'audio'|'pdf'|'imagem'|'outro'} tipo
 * @property {string} texto
 * @property {string} [midiaPath]
 * @property {string} [transcricao]
 * @property {*} raw
 */

/**
 * @typedef {Object} Tarefa
 * @property {string} id
 * @property {string} empresa
 * @property {string} projeto
 * @property {string} titulo
 * @property {string} descricao
 * @property {'aguardando_info'|'pronta'|'precisa_decisao'|'em_execucao'|'feita'|'descartada'} estado
 * @property {string|null} prazo  — ISO 8601 ou null
 * @property {number} urgencia   — 0-100
 * @property {'eu'|'ia'|string} responsavel
 * @property {string[]} faltando
 * @property {string[]} fontes   — mensagemId[]
 * @property {string[]} [links]  — URLs associadas ao pedido
 * @property {string|null} [nota] — transcrição curta, legenda, descrição de imagem
 * @property {string} chatId
 * @property {string} criadaEm  — ISO 8601
 * @property {string} atualizadaEm — ISO 8601
 * @property {{ tipo: 'automacao'|'agente'|'skill'|'fluxo', alvo: string }} [destino]
 */

/**
 * @typedef {Object} ContextoChat
 * @property {string}     chatId
 * @property {Mensagem[]} mensagens       — últimas N mensagens
 * @property {string[]}   tarefasAbertas  — IDs de tarefas abertas neste chat
 * @property {string}     atualizadoEm
 */

// ─── Fábricas de runtime ────────────────────────────────────────

/**
 * Cria uma Mensagem normalizada.
 * @param {Partial<Mensagem> & { chatId: string }} opts
 * @returns {Readonly<Mensagem>}
 */
export function criarMensagem({
  chatId,
  chatNome = '',
  remetente = '',
  autor,
  texto = '',
  tipo = 'texto',
  timestamp,
  ts,
  origem = 'grupo',
  id,
  midiaPath,
  transcricao,
  raw,
  meta = {},
} = {}) {
  if (!chatId) throw new Error('chatId é obrigatório');
  return Object.freeze({
    id:        id ?? randomUUID(),
    chatId,
    chatNome,
    origem,
    autor:     autor ?? remetente ?? '',
    ts:        ts ?? timestamp ?? new Date().toISOString(),
    tipo,
    texto,
    ...(midiaPath    ? { midiaPath }    : {}),
    ...(transcricao  ? { transcricao }  : {}),
    raw:       raw ?? meta,
  });
}

/**
 * Cria uma Tarefa com valores padrão.
 * @param {Partial<Tarefa>} opts
 * @returns {Tarefa}
 */
export function criarTarefa({
  id = randomUUID(),
  titulo = '',
  descricao = '',
  estado = ESTADOS.PRONTA,
  faltando = [],
  urgencia = 50,
  empresa = '?',
  projeto = '?',
  chatId = '',
  prazo = null,
  tipo = 'geral',
  responsavel = 'ia',
  fontes = [],
  links = [],
  nota = null,
  criadaEm = new Date().toISOString(),
  atualizadaEm,
  atualizadoEm,
  mensagensRef = [],
} = {}) {
  return {
    id,
    titulo,
    descricao,
    estado,
    faltando,
    urgencia,
    empresa,
    projeto,
    chatId,
    prazo,
    tipo,
    responsavel,
    fontes: fontes.length ? fontes : mensagensRef,
    links: Array.isArray(links) ? links : [],
    nota: nota ?? null,
    criadaEm,
    atualizadaEm: atualizadaEm ?? atualizadoEm ?? new Date().toISOString(),
  };
}

/**
 * Cria um ContextoChat com valores padrão.
 * @param {Partial<ContextoChat> & { chatId: string }} opts
 * @returns {ContextoChat}
 */
export function criarContexto({
  chatId,
  mensagens = [],
  tarefasAbertas = [],
  atualizadoEm = new Date().toISOString(),
} = {}) {
  if (!chatId) throw new Error('chatId é obrigatório');
  return { chatId, mensagens, tarefasAbertas, atualizadoEm };
}
