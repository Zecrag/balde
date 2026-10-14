/**
 * @file avisos.mjs — Módulo de configuração, envio e agendamento de avisos no WhatsApp.
 *
 * Regras do dono:
 * - Avisos enviados SOMENTE para os números configurados (DDI + DDD + número, 10-15 dígitos).
 * - NUNCA para grupos (rejeita explicitamente qualquer destino com @g.us ou fora da lista).
 * - Sem custo de LLM (textos determinísticos locais montados por lib/avisos-texto.mjs).
 * - Agendador com fuso America/Sao_Paulo, checa a cada minuto, no máximo um disparo por horário por dia.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { calcularAlertas } from './alertas.mjs';
import { montarTexto } from './avisos-texto.mjs';
import { parseGruposMd } from './config.mjs';

export const CONFIG_AVISOS_PADRAO = Object.freeze({
  ativo: false,
  numeros: [],
  janelaDias: 3,
  horarios: [
    {
      id: '1',
      hora: '18:00',
      tipo: 'resumo',
      ativo: true,
    },
  ],
});

export const FUSO_HORARIO = 'America/Sao_Paulo';

/**
 * Retorna o caminho do arquivo de configuração de avisos.
 * @param {string} dadosDir
 * @returns {string}
 */
export function caminhoConfigAvisos(dadosDir) {
  return join(dadosDir, 'config-avisos.json');
}

/**
 * Retorna o caminho do arquivo de estado do agendador.
 * @param {string} dadosDir
 * @returns {string}
 */
export function caminhoEstadoAvisos(dadosDir) {
  return join(dadosDir, 'avisos-estado.json');
}

/**
 * Retorna o caminho do log de avisos enviados.
 * @param {string} dadosDir
 * @returns {string}
 */
export function caminhoLogAvisos(dadosDir) {
  return join(dadosDir, 'avisos.jsonl');
}

/**
 * Retorna data (YYYY-MM-DD) no fuso America/Sao_Paulo.
 * @param {Date|string|number} [data=new Date()]
 * @returns {string}
 */
export function dataAtualSaoPaulo(data = new Date()) {
  const d = data instanceof Date ? data : new Date(data);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO_HORARIO,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(d);
}

/**
 * Retorna horário (HH:MM) no fuso America/Sao_Paulo.
 * @param {Date|string|number} [data=new Date()]
 * @returns {string}
 */
export function horaAtualSaoPaulo(data = new Date()) {
  const d = data instanceof Date ? data : new Date(data);
  const formatter = new Intl.DateTimeFormat('pt-BR', {
    timeZone: FUSO_HORARIO,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const partes = Object.fromEntries(formatter.formatToParts(d).map(p => [p.type, p.value]));
  return `${partes.hour}:${partes.minute}`;
}

/**
 * Mascara número de telefone: preserva primeiros 4 e últimos 4 dígitos.
 * Ex: 5511999998888 -> 5511*****8888
 * @param {string} num
 * @returns {string}
 */
export function mascararNumero(num) {
  const s = String(num ?? '').replace(/\D/g, '');
  if (s.length < 8) return '***';
  const ini = 4;
  const fim = 4;
  const meio = '*'.repeat(Math.max(3, s.length - ini - fim));
  return `${s.slice(0, ini)}${meio}${s.slice(-fim)}`;
}

/**
 * Lê dados/config-avisos.json ou devolve o padrão.
 * @param {string} dadosDir
 * @returns {{ ativo: boolean, numeros: string[], janelaDias: number, horarios: Array<{ id: string, hora: string, tipo: string, ativo: boolean }> }}
 */
export function lerConfigAvisos(dadosDir) {
  const arquivo = caminhoConfigAvisos(dadosDir);
  try {
    if (existsSync(arquivo)) {
      const raw = JSON.parse(readFileSync(arquivo, 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        return {
          ativo: raw.ativo === true,
          numeros: Array.isArray(raw.numeros)
            ? raw.numeros.map(n => String(n)).filter(n => /^\d{10,15}$/.test(n))
            : [],
          janelaDias: Number.isInteger(raw.janelaDias) && raw.janelaDias >= 0 && raw.janelaDias <= 30
            ? raw.janelaDias
            : 3,
          horarios: Array.isArray(raw.horarios)
            ? raw.horarios.map((h, i) => ({
                id: String(h?.id || i + 1),
                hora: String(h?.hora ?? '18:00'),
                tipo: h?.tipo === 'urgente' ? 'urgente' : 'resumo',
                ativo: h?.ativo !== false,
              }))
            : structuredClone(CONFIG_AVISOS_PADRAO.horarios),
        };
      }
    }
  } catch {}
  return structuredClone(CONFIG_AVISOS_PADRAO);
}

/**
 * Valida o corpo para gravação da configuração de avisos.
 * @param {any} corpo
 * @returns {{ erro?: string, config?: Object }}
 */
export function validarConfigAvisos(corpo) {
  if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) {
    return { erro: 'Corpo deve ser um objeto JSON' };
  }

  const resultado = {};

  if ('ativo' in corpo) {
    if (typeof corpo.ativo !== 'boolean') {
      return { erro: 'ativo deve ser booleano' };
    }
    resultado.ativo = corpo.ativo;
  }

  if ('janelaDias' in corpo) {
    const j = corpo.janelaDias;
    if (!Number.isInteger(j) || j < 0 || j > 30) {
      return { erro: 'janelaDias deve ser um inteiro entre 0 e 30' };
    }
    resultado.janelaDias = j;
  }

  if ('numeros' in corpo) {
    if (!Array.isArray(corpo.numeros)) {
      return { erro: 'numeros deve ser uma lista de telefones' };
    }
    const numerosLimpos = [];
    for (const num of corpo.numeros) {
      const s = String(num ?? '');
      if (!/^\d{10,15}$/.test(s)) {
        return { erro: `Número inválido: "${s}". Deve conter apenas dígitos (10 a 15, com DDI)` };
      }
      if (s.includes('@g.us')) {
        return { erro: 'Grupos (@g.us) não são permitidos' };
      }
      numerosLimpos.push(s);
    }
    resultado.numeros = [...new Set(numerosLimpos)];
  }

  if ('horarios' in corpo) {
    if (!Array.isArray(corpo.horarios)) {
      return { erro: 'horarios deve ser uma lista' };
    }
    const horariosLimpos = [];
    for (let i = 0; i < corpo.horarios.length; i++) {
      const h = corpo.horarios[i];
      if (!h || typeof h !== 'object') {
        return { erro: `Horário na posição ${i} deve ser um objeto` };
      }
      const hora = String(h.hora ?? '');
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(hora)) {
        return { erro: `Horário inválido: "${hora}". Formato esperado: HH:MM (00:00 a 23:59)` };
      }
      const tipo = String(h.tipo ?? '');
      if (!['resumo', 'urgente'].includes(tipo)) {
        return { erro: `Tipo inválido no horário "${hora}". Deve ser "resumo" ou "urgente"` };
      }
      if ('ativo' in h && typeof h.ativo !== 'boolean') {
        return { erro: `ativo no horário "${hora}" deve ser booleano` };
      }
      horariosLimpos.push({
        id: String(h.id || randomUUID()),
        hora,
        tipo,
        ativo: h.ativo !== false,
      });
    }
    resultado.horarios = horariosLimpos;
  }

  return { config: resultado };
}

/**
 * Grava dados/config-avisos.json atomicamente.
 * @param {{ dadosDir: string, corpo: any }} param
 * @returns {{ erro?: string, config?: Object }}
 */
export function gravarConfigAvisos({ dadosDir, corpo }) {
  const validacao = validarConfigAvisos(corpo);
  if (validacao.erro) return { erro: validacao.erro };

  const atual = lerConfigAvisos(dadosDir);
  const nova = {
    ativo: validacao.config.ativo !== undefined ? validacao.config.ativo : atual.ativo,
    numeros: validacao.config.numeros !== undefined ? validacao.config.numeros : atual.numeros,
    janelaDias: validacao.config.janelaDias !== undefined ? validacao.config.janelaDias : atual.janelaDias,
    horarios: validacao.config.horarios !== undefined ? validacao.config.horarios : atual.horarios,
  };

  mkdirSync(dadosDir, { recursive: true });
  const arquivo = caminhoConfigAvisos(dadosDir);
  const tmp = `${arquivo}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(nova, null, 2) + '\n', 'utf8');
  renameSync(tmp, arquivo);

  return { config: nova };
}

/**
 * Lê o log de avisos de dados/avisos.jsonl.
 * @param {string} dadosDir
 * @param {number} [limite=50]
 * @returns {Array<Object>}
 */
export function lerLogAvisos(dadosDir, limite = 50) {
  const arquivo = caminhoLogAvisos(dadosDir);
  if (!existsSync(arquivo)) return [];
  const linhas = [];
  try {
    for (const l of readFileSync(arquivo, 'utf8').split('\n')) {
      const trimmed = l.trim();
      if (!trimmed) continue;
      try { linhas.push(JSON.parse(trimmed)); } catch {}
    }
  } catch {}
  return linhas.slice(-limite).reverse();
}

/**
 * Grava uma entrada no log dados/avisos.jsonl.
 * @param {string} dadosDir
 * @param {Object} entrada
 */
export function gravarLogAvisos(dadosDir, entrada) {
  mkdirSync(dadosDir, { recursive: true });
  const arquivo = caminhoLogAvisos(dadosDir);
  const linha = JSON.stringify({
    em: new Date().toISOString(),
    ...entrada,
  }) + '\n';
  appendFileSync(arquivo, linha, 'utf8');
}

/**
 * Lê dados/avisos-estado.json.
 * @param {string} dadosDir
 * @returns {{ ultimoEnvio: Record<string, string> }}
 */
export function lerEstadoAvisos(dadosDir) {
  const arquivo = caminhoEstadoAvisos(dadosDir);
  try {
    if (existsSync(arquivo)) {
      const raw = JSON.parse(readFileSync(arquivo, 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        return {
          ultimoEnvio: raw.ultimoEnvio && typeof raw.ultimoEnvio === 'object' ? raw.ultimoEnvio : {},
          reservas: raw.reservas ?? {},
        };
      }
    }
  } catch {}
  return { ultimoEnvio: {}, reservas: {} };
}

/**
 * Grava dados/avisos-estado.json atomicamente.
 * @param {string} dadosDir
 * @param {Object} estado
 */
export function gravarEstadoAvisos(dadosDir, estado) {
  mkdirSync(dadosDir, { recursive: true });
  const arquivo = caminhoEstadoAvisos(dadosDir);
  const tmp = `${arquivo}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(estado, null, 2) + '\n', 'utf8');
  renameSync(tmp, arquivo);
}

export const TETO_ENVIOS_DIA = 10;

/** Minutos de atraso aceitos para um horário cujo tick exato foi perdido. */
export const TOLERANCIA_MINUTOS = 5;

function minutosDoDia(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

/**
 * Conta quantos envios bem-sucedidos foram feitos hoje no fuso America/Sao_Paulo.
 * @param {string} dadosDir
 * @param {Date|string|number} [hoje=new Date()]
 * @returns {number}
 */
export function contarEnviosHoje(dadosDir, hoje = new Date()) {
  const diaHoje = dataAtualSaoPaulo(hoje);
  const arquivo = caminhoLogAvisos(dadosDir);
  if (!existsSync(arquivo)) return 0;
  let contagem = 0;
  try {
    for (const l of readFileSync(arquivo, 'utf8').split('\n')) {
      const trimmed = l.trim();
      if (!trimmed) continue;
      try {
        const item = JSON.parse(trimmed);
        if (item.ok && item.em) {
          const diaItem = dataAtualSaoPaulo(item.em);
          if (diaItem === diaHoje) {
            contagem++;
          }
        }
      } catch {}
    }
  } catch {}
  return contagem;
}

/**
 * Envia uma mensagem via Evolution API para um número individual.
 * Regras duras:
 * - NUNCA envia para grupos (@g.us).
 * - Rejeita qualquer destino com caracteres que não sejam dígitos.
 * - Rejeita números fora da lista de números permitidos.
 * - Valida formato numérico (10-15 dígitos).
 *
 * @param {{
 *   numero: string,
 *   texto: string,
 *   numerosPermitidos: string[],
 *   env?: Record<string, string>,
 *   fetch?: typeof fetch
 * }} param
 * @returns {Promise<Object>}
 */
export async function enviarMensagemEvolution({
  numero,
  texto,
  numerosPermitidos = [],
  env = process.env,
  fetch = globalThis.fetch,
}) {
  const numLimpo = String(numero ?? '');

  // 1. Rejeita qualquer grupo (@g.us)
  if (numLimpo.includes('@g.us') || /@g\.us/i.test(numLimpo)) {
    throw new Error('Envio para grupos (@g.us) é terminantemente proibido.');
  }

  // 2. Rejeita qualquer destino com caracteres que não sejam dígitos
  if (/\D/.test(numLimpo)) {
    throw new Error(`Destino "${mascararNumero(numLimpo)}" contém caracteres que não são dígitos. Apenas dígitos são permitidos.`);
  }

  // 3. Valida padrão numérico (10 a 15 dígitos)
  if (!/^\d{10,15}$/.test(numLimpo)) {
    throw new Error(`Número "${mascararNumero(numLimpo)}" inválido. Deve conter 10 a 15 dígitos com DDI.`);
  }

  // 4. TRAVA DURA: só envia para números que estão na lista configurada
  const permitidos = (numerosPermitidos ?? []).map(n => String(n));
  if (!permitidos.includes(numLimpo)) {
    throw new Error(`Número "${mascararNumero(numLimpo)}" não está na lista de números autorizados pelo dono.`);
  }

  const url = String(env.BALDE_EVOLUTION_URL ?? '').replace(/\/+$/, '');
  const key = env.BALDE_EVOLUTION_KEY;
  const inst = env.BALDE_EVOLUTION_INSTANCIA;
  if (!url || !key || !inst) {
    throw new Error('Evolution não configurada (BALDE_EVOLUTION_URL/KEY/INSTANCIA)');
  }

  const endpoint = `${url}/message/sendText/${encodeURIComponent(inst)}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    // Redirect levaria o header apikey para outro host: recusa em vez de seguir.
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: {
      apikey: key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      number: numLimpo,
      text: texto,
    }),
  });

  if (!res.ok) {
    throw new Error(`Evolution respondeu HTTP ${res.status}`);
  }

  return res.json().catch(() => ({ ok: true }));
}

/**
 * Carrega projetos e tarefas para montar alertas.
 * @param {{ store: any, gruposMdPath?: string, lerClientes?: Function }} param
 * @returns {Promise<{ tarefas: Array<any>, projetos: Array<any> }>}
 */
export async function carregarDadosAlertas({ store, gruposMdPath, lerClientes }) {
  const tarefas = typeof store?.lerTarefas === 'function'
    ? await store.lerTarefas()
    : (typeof store?.listarTarefas === 'function' ? await store.listarTarefas() : []);

  let projetos = [];
  if (gruposMdPath && existsSync(gruposMdPath)) {
    try {
      const conteudo = readFileSync(gruposMdPath, 'utf8');
      projetos = parseGruposMd(conteudo).linhas ?? [];
    } catch {}
  }
  if (!projetos.length && typeof lerClientes === 'function') {
    projetos = await lerClientes() || [];
  }

  return { tarefas, projetos };
}

/**
 * Gera a prévia do texto de alertas para visualização sem envio.
 * @param {{
 *   tipo?: 'resumo'|'urgente',
 *   dadosDir: string,
 *   store: any,
 *   gruposMdPath?: string,
 *   lerClientes?: Function,
 *   hoje?: Date
 * }} param
 * @returns {Promise<{ ok: boolean, tipo: string, texto: string, alertas: Object }>}
 */
export async function obterPreviaAvisos({
  tipo = 'resumo',
  dadosDir,
  store,
  gruposMdPath,
  lerClientes,
  hoje = new Date(),
}) {
  if (!['resumo', 'urgente'].includes(tipo)) {
    throw Object.assign(new Error('tipo deve ser resumo ou urgente'), { status: 400 });
  }

  const config = lerConfigAvisos(dadosDir);
  const { tarefas, projetos } = await carregarDadosAlertas({ store, gruposMdPath, lerClientes });
  const alertas = calcularAlertas({
    tarefas,
    projetos,
    janelaDias: config.janelaDias,
    hoje,
  });

  const texto = montarTexto(tipo, alertas, { hoje });
  return { ok: true, tipo, texto, alertas };
}

/**
 * Envia avisos de WhatsApp para todos os números configurados.
 * Registra cada envio (sucesso ou falha) em dados/avisos.jsonl.
 *
 * @param {{
 *   tipo?: 'resumo'|'urgente',
 *   dadosDir: string,
 *   store: any,
 *   gruposMdPath?: string,
 *   lerClientes?: Function,
 *   env?: Record<string, string>,
 *   fetch?: typeof fetch,
 *   hoje?: Date
 * }} param
 * @returns {Promise<{ ok: boolean, tipo: string, texto: string, enviados: number, resultados: Array<any> }>}
 */
export async function dispararAvisos({
  tipo = 'resumo',
  dadosDir,
  store,
  gruposMdPath,
  lerClientes,
  env = process.env,
  fetch = globalThis.fetch,
  hoje = new Date(),
}) {
  if (!['resumo', 'urgente'].includes(tipo)) {
    throw Object.assign(new Error('tipo deve ser resumo ou urgente'), { status: 400 });
  }

  const config = lerConfigAvisos(dadosDir);
  if (!config.numeros?.length) {
    throw Object.assign(new Error('Nenhum número de WhatsApp configurado para receber avisos'), { status: 400 });
  }

  const dia = dataAtualSaoPaulo(hoje);
  const usados = () => Math.max(contarEnviosHoje(dadosDir, hoje), lerEstadoAvisos(dadosDir).reservas[dia] ?? 0);
  const enviosHoje = usados();
  if (enviosHoje >= TETO_ENVIOS_DIA) {
    throw Object.assign(
      new Error(`Teto diário de envios atingido (máximo ${TETO_ENVIOS_DIA} por dia; ${enviosHoje} realizados hoje)`),
      { status: 429 }
    );
  }

  const { tarefas, projetos } = await carregarDadosAlertas({ store, gruposMdPath, lerClientes });
  const alertas = calcularAlertas({
    tarefas,
    projetos,
    janelaDias: config.janelaDias,
    hoje,
  });

  const texto = montarTexto(tipo, alertas, { hoje });
  const resultados = [];

  for (const num of config.numeros) {
    if (usados() >= TETO_ENVIOS_DIA) {
      const err = new Error(`Teto diário de ${TETO_ENVIOS_DIA} envios atingido`);
      const numMascarado = mascararNumero(num);
      gravarLogAvisos(dadosDir, {
        em: new Date(hoje).toISOString(),
        tipo,
        numero: numMascarado,
        ok: false,
        erro: err.message,
      });
      resultados.push({ numero: numMascarado, ok: false, erro: err.message });
      break;
    }
    // Reserva síncrona e persistida antes de qualquer await: cobre concorrência e restart.
    const estado = lerEstadoAvisos(dadosDir);
    estado.reservas = { [dia]: usados() + 1 };
    gravarEstadoAvisos(dadosDir, estado);
    const numMascarado = mascararNumero(num);
    try {
      await enviarMensagemEvolution({
        numero: num,
        texto,
        numerosPermitidos: config.numeros,
        env,
        fetch,
      });
      gravarLogAvisos(dadosDir, {
        em: new Date(hoje).toISOString(),
        tipo,
        numero: numMascarado,
        ok: true,
      });
      resultados.push({ numero: numMascarado, ok: true });
    } catch (err) {
      gravarLogAvisos(dadosDir, {
        em: new Date(hoje).toISOString(),
        tipo,
        numero: numMascarado,
        ok: false,
        erro: 'Falha no envio pela Evolution',
      });
      resultados.push({ numero: numMascarado, ok: false, erro: 'Falha no envio pela Evolution' });
    }
  }

  return {
    ok: resultados.every(r => r.ok),
    tipo,
    texto,
    enviados: resultados.filter(r => r.ok).length,
    resultados,
  };
}

/**
 * Inicia o agendador de avisos periódicos no servidor.
 * Checa a cada minuto se algum horário configurado deve disparar.
 *
 * @param {{
 *   dadosDir: string,
 *   store: any,
 *   gruposMdPath?: string,
 *   lerClientes?: Function,
 *   env?: Record<string, string>,
 *   fetch?: typeof fetch,
 *   intervaloMs?: number
 * }} param
 * @returns {{ parar: () => void, tick: (agora?: Date) => Promise<{ disparados: number, erros: Array<any> }> }}
 */
export function iniciarAgendadorAvisos({
  dadosDir,
  store,
  gruposMdPath,
  lerClientes,
  env = process.env,
  fetch = globalThis.fetch,
  intervaloMs = 60_000,
}) {
  let timer = null;
  let emExecucao = false;

  async function tick(agora = new Date()) {
    if (emExecucao) return { disparados: 0, erros: [] };
    emExecucao = true;
    const erros = [];
    let disparados = 0;

    try {
      const config = lerConfigAvisos(dadosDir);
      if (!config.ativo || !config.numeros?.length || !config.horarios?.length) {
        return { disparados: 0, erros: [] };
      }

      const horaAtual = horaAtualSaoPaulo(agora);
      const dataAtual = dataAtualSaoPaulo(agora);
      const estado = lerEstadoAvisos(dadosDir);
      const ultimoEnvio = estado.ultimoEnvio || {};

      for (const h of config.horarios) {
        if (!h.ativo) continue;
        // Tolera tick atrasado (event loop ocupado pulou o minuto), mas não dispara horas depois de um restart.
        const atraso = minutosDoDia(horaAtual) - minutosDoDia(h.hora);
        if (!(atraso >= 0 && atraso <= TOLERANCIA_MINUTOS)) continue;
        // Não duplica se já disparou hoje para este horário. A chave por hora+tipo cobre
        // o mesmo horário salvo de novo no painel com outro id.
        const chaveHora = `${h.hora}|${h.tipo}`;
        if (ultimoEnvio[h.id] === dataAtual || ultimoEnvio[chaveHora] === dataAtual) continue;

        try {
          // Marca antes do envio: após queda não repete um disparo incerto.
          ultimoEnvio[h.id] = dataAtual;
          ultimoEnvio[chaveHora] = dataAtual;
          gravarEstadoAvisos(dadosDir, { ...lerEstadoAvisos(dadosDir), ultimoEnvio });
          await dispararAvisos({
            tipo: h.tipo,
            dadosDir,
            store,
            gruposMdPath,
            lerClientes,
            env,
            fetch,
            hoje: agora,
          });
          disparados++;
        } catch (err) {
          erros.push({ horario: h, erro: err.message });
        }
      }
    } catch (err) {
      erros.push({ erro: err.message });
    } finally {
      emExecucao = false;
    }

    return { disparados, erros };
  }

  timer = setInterval(() => {
    tick().catch(err => console.error('[Balde] Erro no agendador de avisos:', err));
  }, intervaloMs);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  return {
    parar() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    tick,
  };
}
