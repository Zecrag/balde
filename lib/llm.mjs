/**
 * llm.mjs — Cliente único de LLM via fetch (sem dependências).
 *
 * Provedores: anthropic | openai | gemini.
 *   - Escolha explícita por BALDE_LLM, ou detecção pela primeira key presente
 *     (ordem: anthropic → openai → gemini).
 *   - Keys: BALDE_ANTHROPIC_KEY / ANTHROPIC_API_KEY, BALDE_OPENAI_KEY / OPENAI_API_KEY,
 *     BALDE_GEMINI_KEY / GEMINI_API_KEY (BALDE_LLM_KEY vale para o provedor explícito).
 *   - BALDE_LLM=off|nenhum|heuristico desliga o LLM mesmo com key presente.
 *   - Modelo: BALDE_LLM_MODELO sobrescreve o padrão do provedor (padrão = o mais
 *     barato da família: gpt-4.1-nano, gemini-2.5-flash-lite, claude-haiku-5-5).
 *   - BALDE_LLM_RACIOCINIO=minimal|low|none: reasoning_effort para modelos de
 *     raciocínio da OpenAI (gpt-5-nano etc.); sem ele o campo não vai.
 *   - Gasto (GB-44): cada chamada grava tokens e custo estimado em dados/uso-llm.jsonl;
 *     BALDE_LLM_LIMITE_DIA_USD (padrão 0.50) bloqueia novas chamadas no dia.
 *     Preços por 1M tokens em PRECOS_PADRAO, sobrescritos por BALDE_LLM_PRECOS
 *     (JSON {"modelo":{"entrada":x,"saida":y}}) ou BALDE_LLM_PRECO_ENTRADA/_SAIDA
 *     (para o modelo configurado). Confira na página de preços do provedor.
 *   - Timeout por tentativa: BALDE_LLM_TIMEOUT_MS (padrão 30s) + 1 retry em
 *     erro de rede, timeout, 429 ou 5xx.
 *
 *   - Modelo escolhido no painel (GB-46): dados/config-llm.json
 *     { modeloExtracao, modeloTranscricao, limiteDiaUSD } — lido a cada leitura
 *     (lerConfigEscolhida + aplicarConfigEscolhida) e vale por cima do .env, sem reiniciar.
 *
 * Sem key ou após falha definitiva: retorna null — quem chama segue no heurístico.
 * A key nunca é logada nem posta na URL.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MODELOS_PADRAO = Object.freeze({
  anthropic: 'claude-haiku-5-5',
  openai:    'gpt-4.1-nano',
  gemini:    'gemini-2.5-flash-lite',
});

/**
 * USD por 1M tokens (entrada, saída). Valores de referência — conferir na página
 * de preços do provedor e sobrescrever por env quando mudarem.
 */
export const PRECOS_PADRAO = Object.freeze({
  'gpt-4.1-nano':          { entrada: 0.10, saida: 0.40 },
  'gpt-5-nano':            { entrada: 0.05, saida: 0.40 },
  'gpt-4o-mini':           { entrada: 0.15, saida: 0.60 },
  'gpt-4.1-mini':          { entrada: 0.40, saida: 1.60 },
  'gpt-5-mini':            { entrada: 0.25, saida: 2.00 },
  'gemini-2.5-flash-lite': { entrada: 0.10, saida: 0.40 },
  'gemini-2.0-flash-lite': { entrada: 0.075, saida: 0.30 },
  'claude-haiku-5-5':      { entrada: 1.00, saida: 5.00 },
});

/** Modelo fora da tabela: preço conservador (melhor superestimar o teto). */
export const PRECO_DESCONHECIDO = Object.freeze({ entrada: 3.00, saida: 15.00 });

export const LIMITE_DIA_PADRAO_USD = 0.50;

/** USD por minuto de áudio (transcrição). whisper local = 0. Override: BALDE_TRANSCRICAO_PRECO_MIN. */
export const PRECOS_TRANSCRICAO_MIN = Object.freeze({
  'gpt-4o-mini-transcribe': 0.003,
  'gpt-4o-transcribe':      0.006,
  'whisper-1':              0.006,
  'whisper-large-v3-turbo': 0.04 / 60,
  local:                    0,
});

/** Preço por minuto do modelo de transcrição (desconhecido → o do whisper-1, conservador). */
export function precoTranscricaoMin(modelo, env = process.env) {
  const n = Number(env.BALDE_TRANSCRICAO_PRECO_MIN);
  if (env.BALDE_TRANSCRICAO_PRECO_MIN && Number.isFinite(n) && n >= 0) return n;
  return PRECOS_TRANSCRICAO_MIN[modelo] ?? PRECOS_TRANSCRICAO_MIN['whisper-1'];
}

// ─── Modelo escolhido no painel (GB-46) ─────────────────────────

/** Modelos de extração que o painel oferece (o preço vem de PRECOS_PADRAO). */
export const MODELOS_EXTRACAO = Object.freeze([
  { id: 'gpt-4.1-nano', provedor: 'openai' },
  { id: 'gpt-5-nano', provedor: 'openai', raciocinio: 'minimal' },
  { id: 'gpt-4o-mini', provedor: 'openai' },
  { id: 'gpt-4.1-mini', provedor: 'openai' },
  { id: 'gemini-2.5-flash-lite', provedor: 'gemini' },
]);

/** Modelos de transcrição que o painel oferece ('local' = whisper na máquina, grátis). */
export const MODELOS_TRANSCRICAO = Object.freeze(['gpt-4o-mini-transcribe', 'whisper-1', 'local']);

export const ARQUIVO_CONFIG_LLM = 'config-llm.json';

/**
 * dados/config-llm.json → { modeloExtracao?, modeloTranscricao?, limiteDiaUSD? } (só campos válidos).
 * Ausente ou ilegível = {} (vale o .env).
 * @param {string|null} dadosDir
 */
export function lerConfigEscolhida(dadosDir) {
  if (!dadosDir) return {};
  let bruto;
  try { bruto = JSON.parse(readFileSync(join(dadosDir, ARQUIVO_CONFIG_LLM), 'utf8')); } catch { return {}; }
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) return {};
  const cfg = {};
  if (MODELOS_EXTRACAO.some(m => m.id === bruto.modeloExtracao)) cfg.modeloExtracao = bruto.modeloExtracao;
  if (MODELOS_TRANSCRICAO.includes(bruto.modeloTranscricao)) cfg.modeloTranscricao = bruto.modeloTranscricao;
  const n = Number(bruto.limiteDiaUSD);
  if (bruto.limiteDiaUSD !== null && bruto.limiteDiaUSD !== '' && Number.isFinite(n) && n >= 0) cfg.limiteDiaUSD = n;
  return cfg;
}

/**
 * env + escolha do painel → env efetivo da leitura (novo objeto; o original não muda).
 * BALDE_LLM=off continua desligando o LLM: a escolha troca o modelo, nunca liga o que está desligado.
 * @param {NodeJS.ProcessEnv} env
 * @param {{ modeloExtracao?: string, modeloTranscricao?: string, limiteDiaUSD?: number }} cfg
 */
export function aplicarConfigEscolhida(env, cfg = {}) {
  const saida = { ...env };
  const m = MODELOS_EXTRACAO.find(x => x.id === cfg.modeloExtracao);
  if (m) {
    saida.BALDE_LLM_MODELO = m.id;
    if (!DESLIGADO.has(String(env.BALDE_LLM ?? '').trim().toLowerCase())) saida.BALDE_LLM = m.provedor;
    if (m.raciocinio && !env.BALDE_LLM_RACIOCINIO) saida.BALDE_LLM_RACIOCINIO = m.raciocinio;
    if (!/^gpt-5/.test(m.id)) delete saida.BALDE_LLM_RACIOCINIO;   // reasoning_effort só vale para modelos de raciocínio
  }
  if (cfg.modeloTranscricao === 'local') {
    delete saida.BALDE_TRANSCRICAO;               // whisper local quando existir
  } else if (MODELOS_TRANSCRICAO.includes(cfg.modeloTranscricao)) {
    saida.BALDE_TRANSCRICAO = 'openai';           // força a API mesmo com whisper local instalado
    saida.BALDE_TRANSCRICAO_MODELO = cfg.modeloTranscricao;
  }
  if (Number.isFinite(cfg.limiteDiaUSD) && cfg.limiteDiaUSD >= 0) saida.BALDE_LLM_LIMITE_DIA_USD = String(cfg.limiteDiaUSD);
  return saida;
}

/** true quando há key para o provedor (sem expor a key). */
export function temKey(provedor, env = process.env) {
  return Boolean(KEYS[provedor]?.some(n => env[n]?.trim()) || (env.BALDE_LLM?.trim().toLowerCase() === provedor && env.BALDE_LLM_KEY?.trim()));
}

const KEYS = {
  anthropic: ['BALDE_ANTHROPIC_KEY', 'ANTHROPIC_API_KEY'],
  openai:    ['BALDE_OPENAI_KEY', 'OPENAI_API_KEY'],
  gemini:    ['BALDE_GEMINI_KEY', 'GEMINI_API_KEY'],
};

const DESLIGADO = new Set(['off', 'nenhum', 'none', 'heuristico', 'heurístico', '0', 'false']);

const TIMEOUT_PADRAO_MS = 30_000;
const RETRY_PADRAO_MS = 500;

/**
 * @typedef {Object} ConfigLLM
 * @property {'anthropic'|'openai'|'gemini'} provedor
 * @property {string} key
 * @property {string} modelo
 * @property {number} timeoutMs
 */

/**
 * Resolve provedor, key e modelo a partir do ambiente.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {ConfigLLM|null} null quando não há LLM disponível
 */
export function configLLM(env = process.env) {
  const escolhido = (env.BALDE_LLM ?? '').trim().toLowerCase();
  if (DESLIGADO.has(escolhido)) return null;

  const keyDe = (prov) => KEYS[prov].map(n => env[n]).find(v => v && v.trim())?.trim();

  let provedor = null;
  let key = null;

  if (escolhido) {
    if (!KEYS[escolhido]) {
      console.warn(`[balde] BALDE_LLM="${escolhido}" desconhecido — usando heurística`);
      return null;
    }
    provedor = escolhido;
    key = keyDe(escolhido) || env.BALDE_LLM_KEY?.trim() || null;
  } else {
    provedor = Object.keys(KEYS).find(p => keyDe(p)) ?? null;
    key = provedor ? keyDe(provedor) : null;
  }

  if (!provedor || !key) return null;

  const timeoutMs = Number(env.BALDE_LLM_TIMEOUT_MS) > 0 ? Number(env.BALDE_LLM_TIMEOUT_MS) : TIMEOUT_PADRAO_MS;

  const raciocinio = env.BALDE_LLM_RACIOCINIO?.trim().toLowerCase() || null;

  return {
    provedor,
    key,
    modelo: env.BALDE_LLM_MODELO?.trim() || MODELOS_PADRAO[provedor],
    timeoutMs,
    ...(raciocinio && raciocinio !== 'off' ? { raciocinio } : {}),
  };
}

// ─── Preço, uso e teto diário (GB-44) ───────────────────────────

/**
 * Preço por 1M tokens do modelo, respeitando os overrides de env.
 * @returns {{ entrada: number, saida: number, conhecido: boolean }}
 */
export function precoModelo(modelo, env = process.env) {
  let tabela = { ...PRECOS_PADRAO };
  if (env.BALDE_LLM_PRECOS) {
    try { tabela = { ...tabela, ...JSON.parse(env.BALDE_LLM_PRECOS) }; } catch { console.warn('[balde] BALDE_LLM_PRECOS não é JSON válido — ignorado'); }
  }
  const base = tabela[modelo];
  const doEnv = (nome) => { const n = Number(env[nome]); return Number.isFinite(n) && n >= 0 && env[nome] !== '' && env[nome] != null ? n : null; };
  const entrada = doEnv('BALDE_LLM_PRECO_ENTRADA') ?? Number(base?.entrada ?? PRECO_DESCONHECIDO.entrada);
  const saida = doEnv('BALDE_LLM_PRECO_SAIDA') ?? Number(base?.saida ?? PRECO_DESCONHECIDO.saida);
  return { entrada, saida, conhecido: Boolean(base) || doEnv('BALDE_LLM_PRECO_ENTRADA') !== null };
}

/** Custo estimado em USD de uma chamada. */
export function custoEstimado(modelo, entrada, saida, env = process.env) {
  const p = precoModelo(modelo, env);
  return (entrada * p.entrada + saida * p.saida) / 1e6;
}

export function limiteDiaUSD(env = process.env) {
  const n = Number(env.BALDE_LLM_LIMITE_DIA_USD);
  return env.BALDE_LLM_LIMITE_DIA_USD != null && env.BALDE_LLM_LIMITE_DIA_USD !== '' && Number.isFinite(n) && n >= 0 ? n : LIMITE_DIA_PADRAO_USD;
}

/**
 * Onde gravar o uso: opcoes.usoPath, senão dados/uso-llm.jsonl (BALDE_DADOS).
 * Sob `node --test` sem usoPath explícito não grava (testes nunca tocam dados reais).
 */
export function caminhoUso(opcoes = {}, env = process.env) {
  if (opcoes.usoPath !== undefined) return opcoes.usoPath;
  // O env injetado nos testes não carrega NODE_TEST_CONTEXT: olha o do processo também
  if (env.NODE_TEST_CONTEXT || process.env.NODE_TEST_CONTEXT) return null;
  const dados = env.BALDE_DADOS || process.env.BALDE_DADOS || join(dirname(fileURLToPath(import.meta.url)), '..', 'dados');
  return join(dados, 'uso-llm.jsonl');
}

const diaLocal = (d = new Date()) => {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return z.toISOString().slice(0, 10);
};

/** Soma do custo estimado registrado hoje (dia local) em uso-llm.jsonl. */
export function gastoHojeUSD(usoPath, agora = new Date()) {
  if (!usoPath || !existsSync(usoPath)) return 0;
  const hoje = diaLocal(agora);
  let total = 0;
  for (const linha of readFileSync(usoPath, 'utf8').split('\n')) {
    if (!linha.trim()) continue;
    try {
      const r = JSON.parse(linha);
      if (r?.ts && diaLocal(new Date(r.ts)) === hoje) total += Number(r.custoUSD) || 0;
    } catch { /* linha quebrada */ }
  }
  return total;
}

/** Tokens de entrada/saída devolvidos pelo provedor (estimativa por chars/4 se faltar). */
export function extrairUso(provedor, dados, pedido, texto) {
  let entrada, saida;
  if (provedor === 'openai') {
    entrada = dados?.usage?.prompt_tokens; saida = dados?.usage?.completion_tokens;
  } else if (provedor === 'anthropic') {
    const u = dados?.usage ?? {};
    entrada = u.input_tokens != null ? u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : undefined;
    saida = u.output_tokens;
  } else if (provedor === 'gemini') {
    const u = dados?.usageMetadata ?? {};
    entrada = u.promptTokenCount;
    saida = u.candidatesTokenCount != null ? u.candidatesTokenCount + (u.thoughtsTokenCount ?? 0) : undefined;
  }
  const estimado = !(Number.isFinite(entrada) && Number.isFinite(saida));
  if (!Number.isFinite(entrada)) entrada = Math.ceil(((pedido.system ?? '').length + (pedido.prompt ?? '').length) / 4) + 765 * (pedido.imagens?.length ?? 0);
  if (!Number.isFinite(saida)) saida = Math.ceil((texto ?? '').length / 4);
  return { entrada, saida, estimado };
}

export function registrarUso(usoPath, linha) {
  if (!usoPath) return;
  try {
    mkdirSync(dirname(usoPath), { recursive: true });
    appendFileSync(usoPath, JSON.stringify(linha) + '\n', 'utf8');
  } catch (err) {
    console.warn(`[balde] não gravou uso do LLM: ${err.message}`);
  }
}

/** true quando existe um LLM configurado. */
export function llmDisponivel(env = process.env) {
  return configLLM(env) !== null;
}

/**
 * @typedef {Object} Imagem
 * @property {string} base64   — conteúdo sem prefixo data:
 * @property {string} [mime]   — padrão image/jpeg
 */

/**
 * @typedef {Object} PedidoLLM
 * @property {string}   prompt
 * @property {string}   [system]
 * @property {Imagem[]} [imagens]
 * @property {boolean}  [json]       — pede e parseia resposta JSON
 * @property {number}   [maxTokens]  — padrão 2048
 */

/**
 * @typedef {Object} OpcoesLLM
 * @property {NodeJS.ProcessEnv} [env]
 * @property {typeof fetch}      [fetch]
 * @property {number}            [retryMs] — espera antes do retry
 * @property {string|null}       [usoPath] — arquivo de uso (null = não grava nem aplica teto)
 * @property {string}            [rotulo]  — origem da chamada no uso-llm.jsonl
 * @property {Object}            [uso]     — campos extras da linha de uso (leituraId, empresa,
 *   projeto, grupoJid, tipo: 'extracao' | 'transcricao' | 'imagem')
 */

/**
 * Chama o LLM configurado.
 *
 * @param {PedidoLLM} pedido
 * @param {OpcoesLLM} [opcoes]
 * @returns {Promise<{ provedor: string, modelo: string, texto: string, json: any } | null>}
 *   null sem key, em falha definitiva ou quando json=true e a resposta não é JSON.
 */
export async function chamarLLM(pedido, opcoes = {}) {
  const env = opcoes.env ?? process.env;
  const cfg = configLLM(env);
  if (!cfg) return null;

  // Teto diário: vale para qualquer chamador (extrator, imagem, leitura)
  const usoPath = caminhoUso(opcoes, env);
  if (usoPath && gastoHojeUSD(usoPath) >= limiteDiaUSD(env)) {
    console.warn(`[balde] limite do dia atingido (US$ ${limiteDiaUSD(env).toFixed(2)}) — LLM não chamado`);
    return null;
  }

  const fetchFn = opcoes.fetch ?? globalThis.fetch;
  const retryMs = opcoes.retryMs ?? RETRY_PADRAO_MS;
  const { url, init } = montarRequisicao(cfg, pedido);

  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    // Timer próprio (ref) em vez de AbortSignal.timeout: cobre também a leitura do corpo
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new DOMException(`timeout ${cfg.timeoutMs}ms`, 'TimeoutError')), cfg.timeoutMs);
    let resp;
    let dados;
    try {
      resp = await fetchFn(url, { ...init, signal: ctrl.signal });
      if (resp.ok) dados = await resp.json();
    } catch (err) {
      clearTimeout(timer);
      if (resp?.ok) {
        console.warn(`[balde] LLM ${cfg.provedor} devolveu corpo inválido: ${err?.message}`);
        return null;
      }
      console.warn(`[balde] LLM ${cfg.provedor} falhou (tentativa ${tentativa}): ${err?.message}`);
      if (tentativa < 2) { await esperar(retryMs); continue; }
      return null;
    }
    clearTimeout(timer);

    if (!resp.ok) {
      const repetivel = resp.status === 429 || resp.status >= 500;
      console.warn(`[balde] LLM ${cfg.provedor} respondeu HTTP ${resp.status} (tentativa ${tentativa})${await detalheErro(resp)}`);
      if (repetivel && tentativa < 2) { await esperar(retryMs); continue; }
      return null;
    }

    const texto = extrairTexto(cfg.provedor, dados);
    const tokens = extrairUso(cfg.provedor, dados, pedido, texto);
    const uso = { ...tokens, custoUSD: custoEstimado(cfg.modelo, tokens.entrada, tokens.saida, env) };
    registrarUso(usoPath, {
      ts: new Date().toISOString(), ...(opcoes.uso ?? {}), tipo: opcoes.uso?.tipo ?? 'extracao',
      provedor: cfg.provedor, modelo: cfg.modelo, tokensIn: uso.entrada, tokensOut: uso.saida, segundosAudio: 0,
      custoUSD: Number(uso.custoUSD.toFixed(6)),
      ...(uso.estimado ? { estimado: true } : {}), ...(opcoes.rotulo ? { rotulo: opcoes.rotulo } : {}),
    });
    if (!pedido.json) {
      return { provedor: cfg.provedor, modelo: cfg.modelo, texto, json: null, uso };
    }

    const json = parsearJSON(texto);
    if (json === undefined) {
      console.warn(`[balde] LLM ${cfg.provedor} não devolveu JSON válido`);
      return null;
    }
    return { provedor: cfg.provedor, modelo: cfg.modelo, texto, json, uso };
  }
  return null;
}

// ─── Montagem por provedor ──────────────────────────────────────

const INSTRUCAO_JSON = 'Responda APENAS com um objeto JSON válido, sem texto antes ou depois e sem cercas de código.';

/**
 * @param {ConfigLLM} cfg
 * @param {PedidoLLM} pedido
 * @returns {{ url: string, init: RequestInit }}
 */
export function montarRequisicao(cfg, pedido) {
  const imagens = pedido.imagens ?? [];
  const maxTokens = pedido.maxTokens ?? 2048;
  const system = [pedido.system, pedido.json ? INSTRUCAO_JSON : null].filter(Boolean).join('\n\n');
  const headersBase = { 'content-type': 'application/json' };

  switch (cfg.provedor) {
    case 'anthropic': {
      const content = [
        ...imagens.map(img => ({
          type: 'image',
          source: { type: 'base64', media_type: img.mime ?? 'image/jpeg', data: img.base64 },
        })),
        { type: 'text', text: pedido.prompt },
      ];
      const body = {
        model: cfg.modelo,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content }],
      };
      if (system) body.system = system;
      return {
        url: 'https://api.anthropic.com/v1/messages',
        init: {
          method: 'POST',
          headers: { ...headersBase, 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify(body),
        },
      };
    }

    case 'openai': {
      const content = [
        { type: 'text', text: pedido.prompt },
        ...imagens.map(img => ({
          type: 'image_url',
          image_url: { url: `data:${img.mime ?? 'image/jpeg'};base64,${img.base64}` },
        })),
      ];
      const messages = [];
      if (system) messages.push({ role: 'system', content: system });
      messages.push({ role: 'user', content });
      const body = { model: cfg.modelo, messages, max_completion_tokens: maxTokens };
      if (cfg.raciocinio) body.reasoning_effort = cfg.raciocinio;
      if (pedido.json) body.response_format = { type: 'json_object' };
      return {
        url: 'https://api.openai.com/v1/chat/completions',
        init: {
          method: 'POST',
          headers: { ...headersBase, authorization: `Bearer ${cfg.key}` },
          body: JSON.stringify(body),
        },
      };
    }

    case 'gemini': {
      const parts = [
        ...imagens.map(img => ({ inlineData: { mimeType: img.mime ?? 'image/jpeg', data: img.base64 } })),
        { text: pedido.prompt },
      ];
      const body = {
        contents: [{ role: 'user', parts }],
        generationConfig: { maxOutputTokens: maxTokens },
      };
      if (system) body.systemInstruction = { parts: [{ text: system }] };
      if (pedido.json) body.generationConfig.responseMimeType = 'application/json';
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.modelo)}:generateContent`,
        init: {
          method: 'POST',
          headers: { ...headersBase, 'x-goog-api-key': cfg.key },
          body: JSON.stringify(body),
        },
      };
    }

    default:
      throw new Error(`Provedor LLM desconhecido: ${cfg.provedor}`);
  }
}

function extrairTexto(provedor, dados) {
  switch (provedor) {
    case 'anthropic':
      return (dados?.content ?? []).filter(b => b?.type === 'text').map(b => b.text).join('');
    case 'openai':
      return dados?.choices?.[0]?.message?.content ?? '';
    case 'gemini':
      return (dados?.candidates?.[0]?.content?.parts ?? []).map(p => p?.text ?? '').join('');
    default:
      return '';
  }
}

/**
 * Parseia JSON tolerando cercas ``` e texto em volta.
 * @param {string} texto
 * @returns {any} undefined quando não há JSON válido
 */
export function parsearJSON(texto) {
  if (typeof texto !== 'string' || !texto.trim()) return undefined;
  const limpo = texto.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(limpo);
  } catch {
    const ini = limpo.indexOf('{');
    const fim = limpo.lastIndexOf('}');
    if (ini === -1 || fim <= ini) return undefined;
    try {
      return JSON.parse(limpo.slice(ini, fim + 1));
    } catch {
      return undefined;
    }
  }
}

/**
 * Motivo do erro devolvido pelo provedor (code + message), sem headers nem key.
 * Formatos: OpenAI/Anthropic { error: { message, code|type } }, Gemini { error: { message, status } }.
 */
async function detalheErro(resp) {
  try {
    const corpo = await resp.json();
    const erro = corpo?.error;
    if (!erro) return '';
    if (typeof erro === 'string') return `: ${erro.slice(0, 300)}`;
    const codigo = erro.code ?? erro.type ?? erro.status;
    const msg = typeof erro.message === 'string' ? erro.message.slice(0, 300) : '';
    return `: ${[codigo, msg].filter(Boolean).join(' — ')}`;
  } catch {
    return '';
  }
}

function esperar(ms) {
  return ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve();
}
