/**
 * index.mjs — Função principal `processar(mensagem)`.
 *
 * Orquestra o fluxo completo:
 *   1. Resolve empresa/projeto
 *   2. Acumula contexto
 *   3. Extrai tarefas (LLM via lib/llm.mjs ou heurística) com etapa e próximo passo
 *   4. Calcula urgência
 *   5. Decide estado
 *   6. Upsert sem duplicar (extraída parecida com tarefa aberta do chat → merge)
 *
 * Mensagens do mesmo chat são processadas em fila: o webhook dispara o motor em
 * paralelo e, com LLM (segundos por chamada), o complemento chegava antes da
 * tarefa do pedido existir — virava duplicata.
 */

import { criarTarefa, ESTADOS } from '../tipos.mjs';
import { resolverEmpresaProjeto } from './resolver.mjs';
import { acumularContexto, registrarTarefaNoContexto } from './contexto.mjs';
import { extrairTarefas, extrairLinks } from './extrator.mjs';
import { calcularUrgencia } from './urgencia.mjs';
import { acharSimilar, mesmaIntencao } from './similaridade.mjs';
import { rotearDespejo } from './despejo.mjs';
import { calcularPrazoISO } from './datas.mjs';
import * as config from '../config.mjs';

/** Quantas mensagens anteriores do chat contam como "contíguas" para fundir intenção. */
const JANELA_CONTIGUA = 4;

/** chatId → promessa da última mensagem enfileirada naquele chat. */
const filas = new Map();

const ehAberta = t => t.estado !== ESTADOS.FEITA && t.estado !== ESTADOS.DESCARTADA;

/**
 * Processa uma mensagem de WhatsApp e retorna as tarefas criadas/atualizadas.
 *
 * @param {import('../tipos.mjs').Mensagem} mensagem
 * @param {import('../store.mjs')} store — instância do store (criarStore)
 * @param {{ llm?: import('../llm.mjs').OpcoesLLM, projetos?: Array }} [opcoes] — injeção de env/fetch do LLM
 *   e dos projetos conhecidos para o roteamento do despejo (testes)
 * @returns {Promise<{ novas: Array, atualizadas: Array }>}
 */
export function processar(mensagem, store, opcoes = {}) {
  const chave = mensagem.chatId;
  const anterior = filas.get(chave) ?? Promise.resolve();
  const atual = anterior.catch(() => {}).then(() => processarAgora(mensagem, store, opcoes));
  filas.set(chave, atual);
  atual.finally(() => { if (filas.get(chave) === atual) filas.delete(chave); }).catch(() => {});
  return atual;
}

async function processarAgora(mensagem, store, opcoes) {
  // 1. Resolve empresa/projeto pelo chatId/chatNome/texto (+ tipo do grupo e origem)
  const clientes = store.lerClientes();
  const info = { ...resolverEmpresaProjeto(mensagem, clientes), origem: mensagem.origem };

  // 2. Acumula contexto (janela deslizante por chat)
  const contexto = acumularContexto(store, mensagem);

  // 2b. Grupo despejo: a tarefa vai para o cliente/projeto de que trata, não para o grupo
  if (/despejo/i.test(info.tipoGrupo ?? '')) {
    const { destino, fixo } = rotearDespejo(mensagem, contexto.roteamento ?? null, opcoes.projetos ?? projetosConhecidos(store));
    Object.assign(info, { empresa: destino.empresa, projeto: destino.projeto, receitaMensal: destino.receitaMensal, pesoUrgencia: 1 });
    if (destino.clienteSugerido) info.clienteSugerido = destino.clienteSugerido;
    contexto.roteamento = fixo;
    store.salvarContexto(contexto);
  }

  // 3. Busca tarefas existentes deste chat (exclui terminais)
  const todasTarefas = store.lerTarefas();
  const tarefasDoChat = todasTarefas.filter(t => t.chatId === mensagem.chatId && ehAberta(t));

  // 4. Extrai novas tarefas / atualizações
  const { tarefas: novasExtraidas, atualizacoes } = await extrairTarefas(
    contexto,
    info,
    tarefasDoChat,
    opcoes.llm,
  );

  return aplicarExtracao({ store, mensagem, info, contexto, novasExtraidas, atualizacoes });
}

/**
 * Passos 5–7 do motor: funde extraídas parecidas com tarefas abertas do chat, aplica
 * as atualizações e cria as novas. Usado por processar() e pela leitura em lote
 * (lib/leitura.mjs), que extrai várias mensagens numa chamada só.
 *
 * @param {Object} p
 * @param {Object} p.store
 * @param {Object} p.mensagem — a mensagem de origem (chatId; ts vira criadaEm)
 * @param {{ empresa: string, projeto: string, receitaMensal?: number, pesoUrgencia?: number, clienteSugerido?: string }} p.info
 * @param {{ mensagens: Object[] }} p.contexto — janela do chat (tarefas contíguas)
 * @param {Object[]} p.novasExtraidas
 * @param {Object[]} p.atualizacoes
 * @returns {{ novas: Object[], atualizadas: Object[] }}
 */
export function aplicarExtracao({ store, mensagem, info, contexto, novasExtraidas, atualizacoes }) {
  // 5. Extraída parecida com tarefa aberta do chat → vira atualização (rede de segurança)
  const paraCriar = [];
  const abertas = () => store.lerTarefas().filter(t => t.chatId === mensagem.chatId && ehAberta(t));
  const recentes = new Set(contexto.mensagens.slice(-1 - JANELA_CONTIGUA, -1).map(m => m.id).filter(Boolean));
  for (const extraida of novasExtraidas) {
    const lista = abertas();
    const similar = acharSimilar(extraida, lista) ?? acharContigua(extraida, lista, recentes);
    if (similar) atualizacoes.push(mesclar(similar, extraida));
    else paraCriar.push(extraida);
  }

  // 6. Aplica atualizações em tarefas existentes (sempre sobre o estado atual do store)
  const atualizadas = new Map();
  for (const atualiz of atualizacoes) {
    const tarefaExistente = store.lerTarefas().find(t => t.id === atualiz.id);
    if (!tarefaExistente) continue;

    const tarefaAtualizada = {
      ...tarefaExistente,
      ...atualiz,
      atualizadaEm: new Date().toISOString(),
    };

    // Recalcula urgência se o estado mudou
    tarefaAtualizada.urgencia = calcularUrgencia({
      receitaMensal: info.receitaMensal,
      pesoUrgencia:  info.pesoUrgencia,
      prazo:         tarefaAtualizada.prazo,
      tipo:          tarefaAtualizada.tipo,
      cobrancas:     tarefaAtualizada.cobrancas,
    });

    store.upsertTarefa(tarefaAtualizada);
    atualizadas.set(tarefaAtualizada.id, tarefaAtualizada);
  }

  // 7. Cria novas tarefas com urgência calculada
  const novas = [];
  for (const extraida of paraCriar) {
    const dataMsg = mensagem?.ts ? new Date(mensagem.ts) : new Date();
    const prazo = calcularPrazoISO(extraida.prazo, dataMsg);
    const urgencia = calcularUrgencia({
      receitaMensal: info.receitaMensal,
      pesoUrgencia:  info.pesoUrgencia,
      prazo,
      tipo:          extraida.tipo,
    });

    // Cliente citado sem cadastro: o nome fica visível na tarefa
    if (info.clienteSugerido) {
      if (!normTexto(extraida.titulo).includes(normTexto(info.clienteSugerido))) {
        extraida.titulo = `[${info.clienteSugerido}] ${extraida.titulo}`;
      }
      if (!normTexto(extraida.descricao ?? '').includes(normTexto(info.clienteSugerido))) {
        extraida.descricao = `${extraida.descricao ?? ''}\n[Cliente citado: ${info.clienteSugerido}]`.trim();
      }
    }

    const links = Array.isArray(extraida.links) && extraida.links.length
      ? extraida.links
      : extrairLinks(mensagem.texto || mensagem.transcricao);
    const nota = extraida.nota
      ?? (mensagem.tipo === 'audio' ? mensagem.transcricao?.slice(0, 200) : (mensagem.tipo === 'imagem' ? mensagem.descricaoImagem?.slice(0, 200) : null))
      ?? null;

    const tarefa = {
      ...criarTarefa({
        ...extraida,
        prazo,
        links,
        nota,
        // Tarefa nova sempre tem dono: o cliente quando a bola está com ele, senão eu
        responsavel:  extraida.responsavel ?? (extraida.estado === ESTADOS.AGUARDANDO_INFO ? 'cliente' : 'eu'),
        urgencia,
        empresa:      info.empresa,
        projeto:      info.projeto,
        chatId:       mensagem.chatId,
        // Backfill de histórico: a tarefa nasce na data do pedido, não na do processamento
        ...(criadaEmDe(mensagem) ? { criadaEm: criadaEmDe(mensagem) } : {}),
      }),
      // criarTarefa só conhece os campos base; etapa/próximo passo vêm do extrator
      etapa:        extraida.etapa ?? null,
      proximoPasso: extraida.proximoPasso ?? null,
      // Despejo citou cliente que não existe: só a sugestão — empresa nova nunca é criada
      ...(info.clienteSugerido ? { clienteSugerido: info.clienteSugerido } : {}),
    };

    store.upsertTarefa(tarefa);
    registrarTarefaNoContexto(store, mensagem.chatId, tarefa.id);
    novas.push(tarefa);
  }

  return { novas, atualizadas: [...atualizadas.values()] };
}

/**
 * Tarefa aberta nascida de uma das últimas mensagens do chat com a mesma intenção
 * (ex.: "Avaliar impulsionar os vídeos" logo seguida de "Programar impulsionamento
 * dos vídeos"). Só olha tarefas contíguas: longe no tempo, vale o merge conservador.
 */
function acharContigua(extraida, abertas, recentes) {
  if (recentes.size === 0) return null;
  return abertas.find(t => (t.fontes ?? t.mensagensRef ?? []).some(f => recentes.has(f))
    && (!extraida.empresa || !t.empresa || normTexto(t.empresa) === normTexto(extraida.empresa))
    && (normTexto(t.clienteSugerido || '') === normTexto(extraida.clienteSugerido || ''))
    && mesmaIntencao(extraida, t)) ?? null;
}

/**
 * Projetos conhecidos: GRUPOS.md (inclusive internos, sem grupo) + clientes.json.
 * @returns {{ empresa: string, projeto: string, tipo?: string, ganho?: number }[]}
 */
export function projetosConhecidos(store) {
  let doMd = [];
  try { doMd = config.listarProjetos?.() ?? []; } catch (err) { console.warn(`[balde] GRUPOS.md ilegível: ${err.message}`); }
  const doJson = store.lerClientes().flatMap(c => Array.isArray(c.projetos)
    ? c.projetos.map(p => ({ empresa: c.empresa, projeto: p.nome, tipo: c.tipoTicket ?? c.tipo, ganho: c.receitaMensal }))
    : [{ empresa: c.empresa, projeto: c.projeto, tipo: c.tipoTicket ?? c.tipo, ganho: c.receitaMensal }]);
  return [...doMd, ...doJson];
}

/** ts da mensagem (ISO) quando é passado — nunca no futuro. */
function criadaEmDe(mensagem) {
  const ms = Date.parse(mensagem?.ts ?? '');
  return Number.isFinite(ms) && ms < Date.now() ? new Date(ms).toISOString() : null;
}

const normTexto = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

/**
 * Atualização que funde uma tarefa extraída numa tarefa aberta parecida.
 * Mantém o título da existente; o resto reflete a mensagem mais recente.
 */
function mesclar(existente, extraida) {
  const atualiz = { id: existente.id };

  const descNova = (extraida.descricao || '').trim();
  if (descNova && !normTexto(existente.descricao).includes(normTexto(descNova))) {
    atualiz.descricao = `${existente.descricao ?? ''}\n[Atualização] ${descNova}`.trim();
  }
  for (const campo of ['estado', 'faltando', 'etapa', 'proximoPasso', 'responsavel']) {
    if (extraida[campo] !== undefined && extraida[campo] !== null) atualiz[campo] = extraida[campo];
  }
  if (extraida.prazo) atualiz.prazo = extraida.prazo;
  if (Array.isArray(extraida.links) && extraida.links.length) {
    atualiz.links = [...new Set([...(existente.links || []), ...extraida.links])];
  }
  if (extraida.nota) {
    atualiz.nota = existente.nota ? `${existente.nota}\n${extraida.nota}` : extraida.nota;
  }
  if (extraida.tipo && extraida.tipo !== 'geral' && (!existente.tipo || existente.tipo === 'geral')) {
    atualiz.tipo = extraida.tipo;
  }

  const fontes = existente.fontes || existente.mensagensRef || [];
  const novasFontes = (extraida.mensagensRef || extraida.fontes || []).filter(f => f && !fontes.includes(f));
  atualiz.fontes = [...fontes, ...novasFontes];
  return atualiz;
}
