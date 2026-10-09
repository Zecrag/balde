/**
 * @file leitura.mjs — Leitura MANUAL dos grupos (GB-44): gastar o mínimo.
 *
 * Nada roda sozinho: sem polling, WebSocket nem catch-up automático (só com
 * BALDE_LEITURA=auto no server.mjs). O dono aperta "Ler agora" (POST /api/ler)
 * ou roda `node bin/ler.mjs`, e cada leitura:
 *   1. para cada grupo do GRUPOS.md (config/grupos.json), pagina /chat/findMessages
 *      da Evolution só até o cursor do grupo — mensagem com timestamp ≤ cursor
 *      nunca é relida; grupo sem cursor começa AGORA (nada do passado);
 *   2. grava as novas em dados/mensagens.jsonl e avança o cursor;
 *   3. áudio novo (BALDE_LER_AUDIO, ligado): cache por hash, whisper local se existir,
 *      senão BALDE_TRANSCRICAO_MODELO (padrão gpt-4o-mini-transcribe), corte em
 *      BALDE_AUDIO_MAX_SEG (300 s). Imagem e PDF desligados por padrão
 *      (BALDE_LER_IMAGEM=1 / BALDE_LER_PDF=1 ligam): a mensagem leva "📎 não lido";
 *   4. UMA chamada de LLM por grupo com o lote das mensagens novas (texto truncado em
 *      800 chars, no máximo BALDE_LER_LOTE_MAX=80 por lote — o resto fica pendente
 *      para a próxima leitura), contexto = só id + título das tarefas abertas do
 *      projeto (máx. 30), resposta JSON compacta com max_completion_tokens
 *      BALDE_LER_MAX_TOKENS (600). Grupo sem novidade = 0 chamadas. LLM desligado
 *      (BALDE_LLM=off) ou resposta inválida → heurística local, sem custo;
 *   5. teto BALDE_LLM_LIMITE_DIA_USD (0.50): ao atingir, grava as mensagens SEM
 *      chamar o LLM, guarda-as como pendentes do grupo e avisa.
 *
 * Arquivos (em BALDE_DADOS ou balde/dados):
 *   leitura.json    { ultimaLeitura, grupos: { "<jid>": { ultimaLeitura, cursor: { ts, ids }, pendentes: [Mensagem enxuta] } } }
 *                   cursor.ts em segundos (messageTimestamp); ids = já lidas naquele segundo.
 *   leituras.jsonl  uma linha por leitura: { leituraId, inicio, fim, chamadas, custoUSD,
 *                   bloqueadoPorTeto, grupos: [{ jid, empresa, projeto, novas, chamadas, audios, custoUSD, ... }] }
 *   uso-llm.jsonl   uma linha por chamada paga: { ts, leituraId, empresa, projeto, grupoJid,
 *                   tipo: 'extracao'|'transcricao', modelo, tokensIn, tokensOut, segundosAudio, custoUSD }
 *                   (gravada por lib/llm.mjs e lib/midia/audio.mjs; preço = tabela configurável
 *                   PRECOS_PADRAO / BALDE_LLM_PRECOS / PRECOS_TRANSCRICAO_MIN).
 *
 * Quanto custou: resumoUso({ desde, ate }) → { total, porLeitura, porEmpresaProjeto, porDia }
 * (GET /api/uso?desde=AAAA-MM-DD&ate=AAAA-MM-DD, ou `node bin/ler.mjs --uso`). total, porLeitura e
 * porEmpresaProjeto trazem também mensagens e áudios (contados de leituras.jsonl: grupos[].mensagens|novas, audios).
 *
 * Modelo escolhido (GB-46): dados/config-llm.json { modeloExtracao, modeloTranscricao, limiteDiaUSD },
 * gravado pelo painel (GET/PUT /api/config/llm) e lido no começo de cada leitura — vale por cima
 * do .env sem reiniciar. Nunca devolve chaves; só diz se há key para cada provedor.
 *
 * Testes nunca tocam o dados/ real: sob `node --test` é obrigatório passar dadosDir
 * ou BALDE_DADOS.
 */

import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  chamarLLM, configLLM, llmDisponivel, gastoHojeUSD, limiteDiaUSD, precoModelo, precoTranscricaoMin, MODELOS_PADRAO,
  MODELOS_EXTRACAO, MODELOS_TRANSCRICAO, ARQUIVO_CONFIG_LLM, lerConfigEscolhida, aplicarConfigEscolhida, temKey,
} from './llm.mjs';
import { transcreverAudioLeitura, lerAudioLigado, whisperLocal, MODELO_TRANSCRICAO_PADRAO } from './midia/audio.mjs';
import { tsSegundos, depoisDoCursor, avancarCursor } from './ingestao/evolution-cursor.mjs';
import { carregarGruposAutorizados } from './ingestao/autorizacao.mjs';
import { ESTADOS } from './tipos.mjs';
import { aplicarExtracao, processar, projetosConhecidos } from './motor/index.mjs';
import { acumularContexto } from './motor/contexto.mjs';
import { resolverEmpresaProjeto } from './motor/resolver.mjs';
import { rotearDespejo, empresasConhecidas, acharEmpresa, escolherProjeto } from './motor/despejo.mjs';
import { sanearRespostaLLM, ehDespejo, extrairLinks, extrairTarefas } from './motor/extrator.mjs';
import { ETAPAS } from './motor/etapas.mjs';
import { calcularPrazoISO } from './motor/datas.mjs';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export const TEXTO_MAX = 800;
export const DESCRICAO_MAX = 200;
export const TAREFAS_CONTEXTO_MAX = 30;
export const MAX_TOKENS_PADRAO = 600;
export const LOTE_MAX_PADRAO = 80;
const PAGINA = 50;
const MAX_PAGINAS = 20;
export const MARCA_NAO_LIDO = '📎 não lido';

const numeroEnv = (env, nome, padrao) => {
  const n = Number(env[nome]);
  return Number.isFinite(n) && n > 0 ? n : padrao;
};
const ligado = (v, padrao) => (v == null || String(v).trim() === '' ? padrao
  : !['0', 'false', 'off', 'nao', 'não'].includes(String(v).trim().toLowerCase()));
const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// ─── Caminhos e estado ──────────────────────────────────────────

/** dados/ da leitura; sob node --test exige dadosDir ou BALDE_DADOS explícitos. */
export function caminhoDados(opcoes = {}, env = process.env) {
  if (opcoes.dadosDir) return opcoes.dadosDir;
  if (env.BALDE_DADOS) return env.BALDE_DADOS;
  if (env.NODE_TEST_CONTEXT) throw new Error('leitura em teste sem dadosDir/BALDE_DADOS — recusado para não tocar dados reais');
  return path.join(RAIZ, 'dados');
}

export function lerEstado(arquivo) {
  try {
    const e = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
    if (e && typeof e === 'object' && !Array.isArray(e)) return { ultimaLeitura: e.ultimaLeitura ?? null, grupos: e.grupos ?? {} };
  } catch { /* primeiro uso */ }
  return { ultimaLeitura: null, grupos: {} };
}

/** Gravação atômica: queda no meio não corrompe o cursor. */
export function gravarEstado(arquivo, estado) {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const tmp = `${arquivo}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(estado, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, arquivo);
}

function lerJsonl(arquivo) {
  if (!arquivo || !fs.existsSync(arquivo)) return [];
  const saida = [];
  for (const linha of fs.readFileSync(arquivo, 'utf8').split('\n')) {
    if (!linha.trim()) continue;
    try { saida.push(JSON.parse(linha)); } catch { /* linha quebrada */ }
  }
  return saida;
}

const anexar = (arquivo, obj) => {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  fs.appendFileSync(arquivo, JSON.stringify(obj) + '\n', 'utf8');
};

/** Pendente guarda só o que o lote usa (o raw da Evolution fica no mensagens.jsonl). */
const enxuta = m => Object.fromEntries(Object.entries({
  id: m.id, chatId: m.chatId, chatNome: m.chatNome, origem: m.origem, autor: m.autor, ts: m.ts, tipo: m.tipo,
  texto: m.texto, transcricao: m.transcricao, midiaPath: m.midiaPath,
}).filter(([, v]) => v !== undefined));

// ─── Coleta na Evolution ────────────────────────────────────────

/** /chat/findMessages da Evolution (mais recentes primeiro), só leitura. */
export function buscarPaginaEvolution(env = process.env, fetchFn = globalThis.fetch) {
  const url = String(env.BALDE_EVOLUTION_URL ?? '').replace(/\/+$/, '');
  const key = env.BALDE_EVOLUTION_KEY;
  const inst = env.BALDE_EVOLUTION_INSTANCIA;
  if (!url || !key || !inst) return null;
  return async (jid, page) => {
    const res = await fetchFn(`${url}/chat/findMessages/${inst}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: key },
      body: JSON.stringify({ where: { key: { remoteJid: jid } }, page, offset: PAGINA }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`findMessages HTTP ${res.status}`);
    const data = await res.json();
    return { records: data?.messages?.records || [], pages: Number(data?.messages?.pages) || 1 };
  };
}

/**
 * Registros do grupo depois do cursor, do mais antigo ao mais novo. Para de paginar
 * na primeira página que alcança o cursor.
 */
export async function coletarNovas(buscarPagina, jid, cursor) {
  const porId = new Map();
  for (let page = 1; page <= MAX_PAGINAS; page++) {
    const { records, pages } = await buscarPagina(jid, page);
    let alcancou = false;
    for (const r of records) {
      const ts = tsSegundos(r.messageTimestamp);
      const id = r.key?.id;
      if (ts === null || !id || r.key?.remoteJid !== jid) continue;
      // Cursor sem ids (início da leitura manual): só o que veio depois daquele segundo
      const nova = cursor?.ids?.length ? depoisDoCursor(cursor, ts, id) : !cursor || ts > cursor.ts;
      if (nova) { if (!porId.has(id)) porId.set(id, { r, ts, id }); }
      else alcancou = true;
    }
    if (alcancou || records.length === 0 || page >= pages) break;
  }
  return [...porId.values()].sort((a, b) => a.ts - b.ts);
}

// ─── Mídia barata ───────────────────────────────────────────────

/**
 * Prepara a mensagem para o lote. Áudio: transcrição barata. Imagem/PDF: desligados
 * por padrão (só a legenda + "📎 não lido"). Nunca chama LLM de imagem por padrão.
 * @returns {Promise<{ msg: Object, custoUSD: number, audio: boolean }>}
 */
export async function prepararMidia(m, { env, transcrever, uso, usoPath, fetch: fetchFn }) {
  if (m.tipo === 'audio') {
    if (!lerAudioLigado(env)) return { msg: { ...m, texto: `${m.texto || ''} [🎤 áudio não lido]`.trim() }, custoUSD: 0, audio: false };
    const r = await transcrever(m, { env, usoPath, uso, ...(fetchFn ? { fetch: fetchFn } : {}) });
    if (r?.transcricao) {
      const texto = r.cortado ? `${r.transcricao} [áudio cortado]` : r.transcricao;
      return { msg: { ...m, transcricao: texto, texto }, custoUSD: r.custoUSD ?? 0, audio: true };
    }
    return { msg: { ...m, texto: `${m.texto || ''} [🎤 áudio sem transcrição${r?.motivo ? `: ${r.motivo}` : ''}]`.trim(), pendenteMidia: true }, custoUSD: r?.custoUSD ?? 0, audio: true };
  }
  const desligado = (m.tipo === 'imagem' && !ligado(env.BALDE_LER_IMAGEM, false))
    || (m.tipo === 'pdf' && !ligado(env.BALDE_LER_PDF, false));
  if (desligado) return { msg: { ...m, texto: `${m.texto || ''} [${MARCA_NAO_LIDO}: ${m.tipo}]`.trim() }, custoUSD: 0, audio: false };
  if (m.tipo === 'imagem' || m.tipo === 'pdf') {
    // Ligado pelo dono: enriquecedor normal (imagem cobra uma chamada de visão)
    const { enriquecer } = await import('./midia/enriquecedor.mjs');
    return { msg: (await enriquecer(m)) ?? m, custoUSD: 0, audio: false };
  }
  return { msg: m, custoUSD: 0, audio: false };
}

// ─── Extração em lote ───────────────────────────────────────────

const TIPOS = ['hospedagem', 'boleto', 'desenvolvimento', 'operacional', 'administrativo', 'pessoal', 'geral'];
const ESTADOS_OK = [ESTADOS.AGUARDANDO_INFO, ESTADOS.PRONTA, ESTADOS.PRECISA_DECISAO, ESTADOS.EM_EXECUCAO, ESTADOS.FEITA];

/** Curto e estável (o provedor reaproveita o prefixo em cache). */
export const SYSTEM_LOTE = `Você extrai micro-tarefas de mensagens de WhatsApp de uma agência. Responda só JSON compacto, sem espaços extras:
{"n":[{"m":["id"],"t":"","nt":"","d":"","e":"","r":"","f":[],"p":null,"tp":"","et":""}],"a":[{"id":"","m":["id"],"e":"","f":[],"p":null,"d":"","c":false}]}
n=tarefa nova: cada pedido distinto vira uma tarefa em n; um item por pedido; não juntar (mesmo áudio com múltiplos pedidos = tarefas separadas). m=só ids das mensagens que embasam a tarefa (nunca mensagens de controle como Cliente X/Concluir X). t=ação concreta no infinitivo+objeto, até 70 chars. nt=resumo claro em 1 a 2 frases do QUE fazer (nunca o início da transcrição). d=detalhes até 200 chars. a=atualização: só quando a mensagem complementa uma tarefa aberta listada (responde o que faltava, muda prazo, entrega o pedido, aprova, conclui ou cobra → c:true). Pedido diferente = nova; na dúvida, nova. Conversa sem pedido = nada. Entrega para revisão = nova "Revisar ...".
e=${ESTADOS_OK.join('|')}. r=eu|cliente (quem destrava). f=o que falta do cliente. p=prazo como dito ou null. tp=${TIPOS.join('|')}. et=${Object.keys(ETAPAS).join('|')}. Omita campos vazios.`;

const linhaMensagem = m => {
  const texto = String(m.texto || m.transcricao || '').replace(/\s+/g, ' ').trim().slice(0, TEXTO_MAX);
  return `[${m.id}] ${String(m.autor || '?').slice(0, 40)}: ${texto}`;
};

/** Mensagem que vale mandar ao LLM: tem texto além das marcas de mídia não lida. */
const temConteudo = m => Boolean(String(m.texto || m.transcricao || '').replace(/\[(📎|🎤)[^\]]*\]/gu, '').trim());

export function montarPromptLote({ info, nomeGrupo, despejo, abertas, mensagens }) {
  return [
    `Empresa: ${info.empresa ?? '?'} · Projeto: ${info.projeto ?? '?'} · Grupo: ${nomeGrupo}${despejo ? ' (DESPEJO: qualquer anotação vale)' : ''}`,
    `Tarefas abertas (id|título):`,
    ...(abertas.length ? abertas.map(t => `${t.id}|${String(t.titulo ?? '').slice(0, 90)}`) : ['(nenhuma)']),
    `Mensagens novas:`,
    ...mensagens.map(linhaMensagem),
  ].join('\n');
}

/** Tarefas abertas do projeto (despejo: do chat), mais recentes primeiro, no máximo 30. */
export function abertasDoProjeto(tarefas, { chatId, empresa, projeto, despejo }) {
  const abertas = tarefas.filter(t => t.estado !== ESTADOS.FEITA && t.estado !== ESTADOS.DESCARTADA
    && (despejo ? t.chatId === chatId : (norm(t.empresa) === norm(empresa) && norm(t.projeto) === norm(projeto)) || t.chatId === chatId));
  return abertas
    .sort((a, b) => String(b.atualizadaEm ?? b.criadaEm ?? '').localeCompare(String(a.atualizadaEm ?? a.criadaEm ?? '')))
    .slice(0, TAREFAS_CONTEXTO_MAX);
}

const curta = s => (typeof s === 'string' && s.trim() ? s.trim().slice(0, DESCRICAO_MAX) : undefined);

/** Item compacto do LLM → formato longo do extrator. */
export function expandirItem(c, ehAtualizacao) {
  const nota = c.nt || c.nota || undefined;
  const longo = {
    titulo: ehAtualizacao ? undefined : c.t,
    descricao: curta(c.d || c.nt),
    nota: typeof nota === 'string' && nota.trim() ? nota.trim() : (curta(c.d) || undefined),
    fontes: Array.isArray(c.m) ? c.m : undefined,
    mensagensRef: Array.isArray(c.m) ? c.m : undefined,
    estado: c.e,
    responsavel: c.r,
    faltando: c.f,
    prazo: c.p,
    tipo: c.tp,
    etapa: c.et,
    ...(ehAtualizacao ? { id: c.id, cobranca: c.c === true } : {}),
  };
  for (const k of Object.keys(longo)) if (longo[k] === undefined) delete longo[k];
  return longo;
}

// ─── Modo bloco (GB-49 / GB-53) ─────────────────────────────────

export const CONFIG_BLOCO_PADRAO = Object.freeze({
  ativo: true,
  abrir: 'Cliente',
  fechar: 'Concluir',
});

export const ARQUIVO_CONFIG_BLOCO = 'config-bloco.json';

export function escaparRegex(str) {
  return String(str ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 1 a 20 letras (unicode), sem números, espaços ou símbolos injetáveis. */
export const PALAVRA_BLOCO_RE = /^\p{L}{1,20}$/u;

export function validarPalavraBloco(val) {
  return typeof val === 'string' && PALAVRA_BLOCO_RE.test(val.trim());
}

/**
 * Lê dados/config-bloco.json ou retorna o padrão { ativo: true, abrir: "Cliente", fechar: "Concluir" }.
 * @param {string|null} dadosDir
 * @returns {{ ativo: boolean, abrir: string, fechar: string }}
 */
export function lerConfigBloco(dadosDir) {
  if (!dadosDir) return { ...CONFIG_BLOCO_PADRAO };
  try {
    const raw = fs.readFileSync(path.join(dadosDir, ARQUIVO_CONFIG_BLOCO), 'utf8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      return {
        ativo: typeof obj.ativo === 'boolean' ? obj.ativo : CONFIG_BLOCO_PADRAO.ativo,
        abrir: typeof obj.abrir === 'string' && validarPalavraBloco(obj.abrir) ? obj.abrir.trim() : CONFIG_BLOCO_PADRAO.abrir,
        fechar: typeof obj.fechar === 'string' && validarPalavraBloco(obj.fechar) ? obj.fechar.trim() : CONFIG_BLOCO_PADRAO.fechar,
      };
    }
  } catch { /* arquivo não existe ou corrompido */ }
  return { ...CONFIG_BLOCO_PADRAO };
}

/**
 * Grava dados/config-bloco.json atomicamente.
 * Valida ativo (booleano) e palavras (1 a 20 letras).
 * @param {{ dadosDir: string, corpo: any }} param
 * @returns {{ erro?: string, config?: { ativo: boolean, abrir: string, fechar: string } }}
 */
export function gravarConfigBloco({ dadosDir, corpo }) {
  if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) {
    return { erro: 'Corpo deve ser um objeto' };
  }
  const atual = lerConfigBloco(dadosDir);
  const nova = { ...atual };

  if ('ativo' in corpo) {
    if (typeof corpo.ativo !== 'boolean') {
      return { erro: 'ativo deve ser booleano' };
    }
    nova.ativo = corpo.ativo;
  }

  if ('abrir' in corpo) {
    if (!validarPalavraBloco(corpo.abrir)) {
      return { erro: 'Palavra de abertura deve conter entre 1 e 20 letras' };
    }
    nova.abrir = String(corpo.abrir).trim();
  }

  if ('fechar' in corpo) {
    if (!validarPalavraBloco(corpo.fechar)) {
      return { erro: 'Palavra de fechamento deve conter entre 1 e 20 letras' };
    }
    nova.fechar = String(corpo.fechar).trim();
  }

  const arquivo = path.join(dadosDir, ARQUIVO_CONFIG_BLOCO);
  gravarEstado(arquivo, {
    ativo: nova.ativo,
    abrir: nova.abrir,
    fechar: nova.fechar,
    atualizadoEm: new Date().toISOString(),
  });
  return { config: { ativo: nova.ativo, abrir: nova.abrir, fechar: nova.fechar } };
}

/**
 * Lista blocos abertos em leitura.json: { grupo, cliente, mensagens, desde }.
 * @param {string} dadosDir
 * @returns {Array<{ grupo: string, cliente: string, mensagens: number, desde: string|null }>}
 */
export function listarBlocosPendentes(dadosDir) {
  const estado = lerEstado(path.join(dadosDir, 'leitura.json'));
  const lista = [];
  for (const [jid, eg] of Object.entries(estado.grupos || {})) {
    if (eg?.bloco && eg.bloco.cliente) {
      const msgs = Array.isArray(eg.bloco.mensagens) ? eg.bloco.mensagens : [];
      let desde = eg.bloco.desde ?? null;
      if (!desde && msgs[0]?.ts) {
        desde = typeof msgs[0].ts === 'number'
          ? new Date(msgs[0].ts < 1e11 ? msgs[0].ts * 1000 : msgs[0].ts).toISOString()
          : String(msgs[0].ts);
      }
      if (!desde && eg.ultimaLeitura) {
        desde = eg.ultimaLeitura;
      }
      lista.push({
        grupo: eg.bloco.grupo || msgs[0]?.chatNome || jid,
        cliente: eg.bloco.cliente,
        mensagens: msgs.length,
        desde,
      });
    }
  }
  return lista;
}

export function acharAberturaBloco(texto, configOuPalavra) {
  if (!texto || typeof texto !== 'string') return null;
  if (configOuPalavra && typeof configOuPalavra === 'object' && configOuPalavra.ativo === false) {
    return null;
  }
  const palavra = typeof configOuPalavra === 'object' && configOuPalavra !== null
    ? (configOuPalavra.abrir ?? 'Cliente')
    : (typeof configOuPalavra === 'string' && configOuPalavra ? configOuPalavra : 'Cliente');
  const esc = escaparRegex(palavra);
  const m = texto.match(new RegExp(`^(?:[\\s\\n\\r]*${esc}\\s+([^\\n\\r:]+))`, 'i'));
  return m ? m[1].trim() : null;
}

export function acharFechamentoBloco(texto, configOuPalavra) {
  if (!texto || typeof texto !== 'string') return null;
  if (configOuPalavra && typeof configOuPalavra === 'object' && configOuPalavra.ativo === false) {
    return null;
  }
  const palavra = typeof configOuPalavra === 'object' && configOuPalavra !== null
    ? (configOuPalavra.fechar ?? 'Concluir')
    : (typeof configOuPalavra === 'string' && configOuPalavra ? configOuPalavra : 'Concluir');
  const esc = escaparRegex(palavra);
  const m = texto.match(new RegExp(`^(?:[\\s\\n\\r]*${esc}\\s+([^\\n\\r:]+))`, 'i'));
  return m ? m[1].trim() : null;
}

const resumoMsg = m => {
  const t = String(m.texto || m.transcricao || m.descricaoImagem || '').replace(/\s+/g, ' ').trim();
  return t.slice(0, 100) || '(sem texto)';
};

// ─── Leitura ────────────────────────────────────────────────────

let leituraAtual = null;

/** true enquanto uma leitura roda. */
export const leituraEmAndamento = () => leituraAtual !== null;

/**
 * Lê agora os grupos (todos do GRUPOS.md ou os filtrados), uma vez só por mensagem.
 * Duas chamadas ao mesmo tempo compartilham a mesma leitura.
 *
 * @param {Object} [opcoes]
 * @param {string[]} [opcoes.grupos] — jids ou termos (empresa/projeto); vazio = todos
 * @param {NodeJS.ProcessEnv} [opcoes.env]
 * @param {string} [opcoes.dadosDir]
 * @param {Object} [opcoes.store] — criarStore(); padrão sobre balde/
 * @param {Array} [opcoes.gruposConfig] — config/grupos.json já lido (testes)
 * @param {(jid: string, page: number) => Promise<{records: Object[], pages: number}>} [opcoes.buscarPagina]
 * @param {(r: Object) => Promise<Object>} [opcoes.normalizar] — registro cru → Mensagem (baixa a mídia)
 * @param {typeof transcreverAudioLeitura} [opcoes.transcrever]
 * @param {typeof fetch} [opcoes.fetch] — LLM e transcrição (testes)
 * @param {number} [opcoes.agoraMs]
 * @param {(linha: string) => void} [opcoes.log]
 */
export function lerAgora(opcoes = {}) {
  if (!leituraAtual) {
    leituraAtual = executarLeitura(opcoes).finally(() => { leituraAtual = null; });
  }
  return leituraAtual;
}

async function executarLeitura(opcoes) {
  const envBase = opcoes.env ?? process.env;
  const log = opcoes.log ?? (l => console.log(l));
  const dadosDir = caminhoDados(opcoes, envBase);
  // Modelo/teto escolhidos no painel valem por cima do .env, lidos a cada leitura
  const env = aplicarConfigEscolhida(envBase, lerConfigEscolhida(dadosDir));
  const configBloco = opcoes.configBloco ?? lerConfigBloco(dadosDir);
  const estadoPath = path.join(dadosDir, 'leitura.json');
  const usoPath = path.join(dadosDir, 'uso-llm.jsonl');
  const mensagensPath = path.join(dadosDir, 'mensagens.jsonl');
  const agoraMs = opcoes.agoraMs ?? Date.now();
  const inicio = new Date(agoraMs).toISOString();
  const leituraId = `L${inicio.replace(/\D/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;

  const store = opcoes.store ?? (await import('./store.mjs')).criarStore(RAIZ);
  const buscarPagina = opcoes.buscarPagina ?? buscarPaginaEvolution(env);
  const normalizar = opcoes.normalizar ?? (async r => {
    const { normalizar: n } = await import('./ingestao/normalizar.mjs');
    return n({ data: r }, 'evolution', { midiaDir: path.join(dadosDir, 'midia') });
  });
  const transcrever = opcoes.transcrever ?? transcreverAudioLeitura;
  const llmLigado = llmDisponivel(env);

  let grupos = opcoes.gruposConfig ?? await carregarGruposAutorizados();
  if (opcoes.grupos?.length) {
    const alvos = opcoes.grupos.map(norm).filter(Boolean);
    grupos = grupos.filter(g => alvos.some(a => g.jid === a || norm(`${g.empresa} ${g.projeto}`).includes(a) || norm(g.jid).includes(a)));
  }

  const estado = lerEstado(estadoPath);
  const resumo = { leituraId, inicio, fim: null, chamadas: 0, custoUSD: 0, bloqueadoPorTeto: false, avisos: [], grupos: [] };
  if (!buscarPagina) resumo.avisos.push('Evolution não configurada (BALDE_EVOLUTION_URL/KEY/INSTANCIA)');

  const vistas = new Set(lerJsonl(mensagensPath).map(m => m?.id).filter(Boolean));
  const limite = limiteDiaUSD(env);
  const tetoAtingido = () => gastoHojeUSD(usoPath, new Date(agoraMs)) >= limite;

  for (const g of grupos) {
    const r = { jid: g.jid, empresa: g.empresa ?? '?', projeto: g.projeto ?? '?', novas: 0, mensagens: 0, enviadas: 0, chamadas: 0, audios: 0, custoUSD: 0, tarefasNovas: 0, atualizadas: 0, pendentes: 0 };
    resumo.grupos.push(r);
    const eg = estado.grupos[g.jid] ?? (estado.grupos[g.jid] = {});

    // Grupo novo na leitura manual: começa agora, nada do passado
    if (!eg.cursor) {
      eg.cursor = { ts: Math.floor(agoraMs / 1000), ids: [] };
      eg.ultimaLeitura = inicio;
      r.iniciado = true;
      continue;
    }
    if (!buscarPagina) continue;

    let coletadas;
    try {
      coletadas = await coletarNovas(buscarPagina, g.jid, eg.cursor);
    } catch (err) {
      r.erro = err.message;
      log(`[leitura] ${r.empresa} · ${r.projeto}: falha ao listar (${err.message})`);
      continue;
    }

    // Normaliza e avança o cursor — nunca relê
    const novas = [];
    for (const x of coletadas) {
      try {
        const m = await normalizar(x.r);
        if (m?.id && m.chatId === g.jid && !vistas.has(m.id)) {
          vistas.add(m.id);
          novas.push(m);
        }
      } catch (err) {
        log(`[leitura] ${r.empresa} · ${r.projeto}: mensagem ${x.id} ilegível (${err.message})`);
      }
      eg.cursor = cursorDepois(eg.cursor, x.ts, x.id);
    }
    eg.ultimaLeitura = inicio;
    gravarEstado(estadoPath, estado);
    r.novas = r.mensagens = novas.length;

    const uso = { leituraId, empresa: r.empresa, projeto: r.projeto, grupoJid: g.jid };

    // Mídia barata (só das novas) e gravação em mensagens.jsonl com enriquecimento
    const prontas = [];
    for (const m of novas) {
      let msgPronta = m;
      try {
        const p = await prepararMidia(m, { env, transcrever, uso, usoPath, fetch: opcoes.fetch });
        if (p.audio) r.audios++;
        r.custoUSD += p.custoUSD;
        msgPronta = p.msg;
      } catch (err) {
        log(`[leitura] falha ao preparar mídia da mensagem ${m.id}: ${err.message}`);
      }
      anexar(mensagensPath, msgPronta);
      prontas.push(msgPronta);
    }

    const logMensagens = [];
    // Modo bloco só no grupo de despejo (do dono): num grupo de cliente, qualquer participante
    // poderia rotear tarefas para outro cliente, e "Cliente reclamou…" travaria a leitura.
    const permiteBloco = configBloco.ativo && /despejo/i.test(g.tipo ?? '');
    let blocoAtivo = permiteBloco && eg.bloco ? { cliente: eg.bloco.cliente, mensagens: [...(eg.bloco.mensagens || [])], desde: eg.bloco.desde } : null;
    const blocosConcluidos = [];
    const mensagensNormais = [];

    const fecharRegexSozinho = new RegExp(`^\\s*${escaparRegex(configBloco.fechar)}\\s*$`, 'i');

    for (const m of prontas) {
      if (blocoAtivo) {
        blocoAtivo.mensagens.push(m);
        const fecha = acharFechamentoBloco(m.texto, configBloco) || (fecharRegexSozinho.test(m.texto) ? blocoAtivo.cliente : null);
        if (fecha && norm(fecha) === norm(blocoAtivo.cliente)) {
          blocosConcluidos.push(blocoAtivo);
          blocoAtivo = null;
        }
      } else {
        const abre = permiteBloco ? acharAberturaBloco(m.texto, configBloco) : null;
        if (abre) {
          blocoAtivo = { cliente: abre, mensagens: [m], desde: m.ts ? (typeof m.ts === 'number' ? new Date(m.ts * 1000).toISOString() : String(m.ts)) : inicio };
          const fecha = acharFechamentoBloco(m.texto, configBloco);
          if (fecha && norm(fecha) === norm(abre)) {
            blocosConcluidos.push(blocoAtivo);
            blocoAtivo = null;
          }
        } else {
          mensagensNormais.push(m);
        }
      }
    }

    if (blocoAtivo) {
      eg.bloco = {
        grupo: g.chatNome || g.projeto || g.empresa || g.jid,
        cliente: blocoAtivo.cliente,
        mensagens: blocoAtivo.mensagens.map(enxuta),
        desde: eg.bloco?.desde || blocoAtivo.desde || (blocoAtivo.mensagens[0]?.ts ? (typeof blocoAtivo.mensagens[0].ts === 'number' ? new Date(blocoAtivo.mensagens[0].ts * 1000).toISOString() : String(blocoAtivo.mensagens[0].ts)) : inicio),
      };
      for (const m of prontas) {
        if (blocoAtivo.mensagens.some(x => x.id === m.id)) {
          logMensagens.push({
            id: m.id,
            resumo: resumoMsg(m),
            destino: 'descartada',
            motivo: `bloco pendente: aguardando ${configBloco.fechar} ${blocoAtivo.cliente}`,
          });
        }
      }
    } else {
      delete eg.bloco;
    }

    for (const b of blocosConcluidos) {
      const empresas = empresasConhecidas(projetosConhecidos(store));
      const conhecida = acharEmpresa(b.cliente, empresas);
      let alvoEmpresa, alvoProjeto, clienteSugerido;
      if (conhecida) {
        alvoEmpresa = conhecida.empresa;
        alvoProjeto = escolherProjeto(conhecida, '');
      } else {
        const balde = projetosConhecidos(store).find(p => norm(p.empresa) === 'balde')
          ?? projetosConhecidos(store).find(p => /despejo/i.test(p.tipo ?? ''))
          ?? { empresa: 'Balde', projeto: 'Balde' };
        alvoEmpresa = balde.empresa || 'Balde';
        alvoProjeto = balde.projeto || 'Balde';
        clienteSugerido = b.cliente;
      }

      const resBloco = await extrairGrupoBloco({
        g,
        mensagens: b.mensagens,
        alvo: { empresa: alvoEmpresa, projeto: alvoProjeto, clienteSugerido },
        store, env, llmLigado, uso, usoPath, fetch: opcoes.fetch, log,
        configBloco,
      });

      r.chamadas += resBloco.chamadas;
      r.custoUSD += resBloco.custoUSD;
      r.tarefasNovas += resBloco.novas;
      r.atualizadas += resBloco.atualizadas;
      if (resBloco.heuristica) r.heuristica = true;

      for (const m of b.mensagens) {
        const tarefa = resBloco.tarefasCriadas?.find(t => (t.fontes || t.mensagensRef || []).includes(m.id))
          ?? resBloco.tarefasCriadas?.[0];
        logMensagens.push({
          id: m.id,
          resumo: resumoMsg(m),
          destino: { empresa: alvoEmpresa, projeto: alvoProjeto },
          motivo: 'bloco concluído',
          ...(tarefa?.id ? { tarefaId: tarefa.id } : {})
        });
      }
    }

    const fila = [...(eg.pendentes ?? []), ...mensagensNormais].filter(temConteudo);
    if (!fila.length) {
      eg.pendentes = [];
    } else {
      const loteMax = numeroEnv(env, 'BALDE_LER_LOTE_MAX', LOTE_MAX_PADRAO);
      const lote = fila.slice(0, loteMax);
      const sobra = fila.slice(loteMax);

      if (llmLigado && tetoAtingido()) {
        resumo.bloqueadoPorTeto = true;
        eg.pendentes = fila.map(enxuta);
        r.pendentes = fila.length;
        r.bloqueado = true;
      } else {
        const res = await extrairGrupo({ g, lote, store, env, llmLigado, uso, usoPath, fetch: opcoes.fetch, log, configBloco });
        r.chamadas += res.chamadas;
        r.custoUSD += res.custoUSD;
        r.enviadas = res.chamadas ? lote.length : 0;
        r.tarefasNovas += res.novas;
        r.atualizadas += res.atualizadas;
        if (res.heuristica) r.heuristica = true;
        eg.pendentes = sobra.map(enxuta);
        r.pendentes = sobra.length;

        for (const m of lote) {
          const tarefa = res.tarefasCriadas?.find(t => (t.fontes || t.mensagensRef || []).includes(m.id));
          if (tarefa) {
            logMensagens.push({
              id: m.id,
              resumo: resumoMsg(m),
              destino: { empresa: tarefa.empresa, projeto: tarefa.projeto },
              motivo: 'tarefa criada',
              tarefaId: tarefa.id,
            });
          } else {
            const links = extrairLinks(m.texto || m.transcricao);
            logMensagens.push({
              id: m.id,
              resumo: resumoMsg(m),
              destino: 'descartada',
              motivo: links.length ? 'material associado' : 'sem pedido',
            });
          }
        }
      }
    }

    gravarEstado(estadoPath, estado);

    if (logMensagens.length > 0) {
      anexar(path.join(dadosDir, 'leituras-log.jsonl'), {
        em: inicio,
        grupo: g.chatNome || g.projeto || g.empresa || g.jid,
        mensagens: logMensagens,
      });
    }
  }

  if (resumo.bloqueadoPorTeto) {
    resumo.avisos.push(`Limite do dia atingido (US$ ${limite.toFixed(2)}): mensagens gravadas sem chamar o LLM; ficam pendentes para a próxima leitura.`);
  }
  resumo.chamadas = resumo.grupos.reduce((s, g) => s + g.chamadas, 0);
  resumo.custoUSD = Number(resumo.grupos.reduce((s, g) => s + g.custoUSD, 0).toFixed(6));
  for (const g of resumo.grupos) g.custoUSD = Number(g.custoUSD.toFixed(6));
  resumo.fim = new Date().toISOString();
  estado.ultimaLeitura = inicio;
  gravarEstado(estadoPath, estado);
  anexar(path.join(dadosDir, 'leituras.jsonl'), resumo);
  for (const a of resumo.avisos) log(`[leitura] AVISO: ${a}`);
  return resumo;
}

/** Cursor depois de (ts, id) — nunca recua. */
function cursorDepois(cursor, ts, id) {
  const c = { _: cursor ? { ts: cursor.ts, ids: [...(cursor.ids ?? [])] } : undefined };
  avancarCursor(c, '_', ts, id);
  return c._;
}

/**
 * Uma chamada de LLM para o lote do grupo; heurística local se o LLM estiver
 * desligado ou falhar.
 */
async function extrairGrupo({ g, lote, store, env, llmLigado, uso, usoPath, fetch: fetchFn, log, configBloco }) {
  const cfgBloco = configBloco ?? CONFIG_BLOCO_PADRAO;
  const saida = { chamadas: 0, custoUSD: 0, novas: 0, atualizadas: 0, heuristica: false, tarefasCriadas: [] };
  const clientes = store.lerClientes();
  const base = resolverEmpresaProjeto(lote[0], clientes);
  const info0 = { ...base, empresa: base.empresa && base.empresa !== '?' ? base.empresa : g.empresa, projeto: base.projeto && base.projeto !== '?' ? base.projeto : g.projeto, origem: lote[0].origem };
  const despejo = /despejo/i.test(info0.tipoGrupo ?? g.tipo ?? '');

  const heuristica = async () => {
    saida.heuristica = true;
    const semLLM = { ...env, BALDE_LLM: 'off' };
    for (const m of lote) {
      const res = await processar(m, store, { llm: { env: semLLM } });
      saida.novas += res?.novas?.length ?? 0;
      saida.atualizadas += res?.atualizadas?.length ?? 0;
      if (res?.novas) saida.tarefasCriadas.push(...res.novas);
    }
    return saida;
  };
  if (!llmLigado) return heuristica();

  const abertas = abertasDoProjeto(store.lerTarefas(), { chatId: g.jid, empresa: info0.empresa, projeto: info0.projeto, despejo });
  const resposta = await chamarLLM({
    system: SYSTEM_LOTE,
    prompt: montarPromptLote({ info: info0, nomeGrupo: lote[0].chatNome || g.jid, despejo, abertas, mensagens: lote }),
    json: true,
    maxTokens: numeroEnv(env, 'BALDE_LER_MAX_TOKENS', MAX_TOKENS_PADRAO),
  }, { env, usoPath, uso: { ...uso, tipo: 'extracao' }, ...(fetchFn ? { fetch: fetchFn } : {}) }).catch(err => {
    log(`[leitura] LLM falhou: ${err.message}`);
    return null;
  });
  if (resposta) {
    saida.chamadas = 1;
    saida.custoUSD = resposta.uso?.custoUSD ?? 0;
  }
  const json = resposta?.json;
  if (!json || typeof json !== 'object') {
    log(`[leitura] ${g.empresa} · ${g.projeto}: LLM sem JSON válido — heurística local`);
    return heuristica();
  }

  // Janela de contexto e roteamento do despejo, mensagem a mensagem (sem custo)
  const porId = new Map(lote.map(m => [m.id, m]));
  const infoDe = new Map();
  for (const m of lote) {
    const contexto = acumularContexto(store, m);
    if (despejo) {
      const { destino, fixo } = rotearDespejo(m, contexto.roteamento ?? null, projetosConhecidos(store));
      infoDe.set(m.id, { ...info0, empresa: destino.empresa, projeto: destino.projeto, receitaMensal: destino.receitaMensal, pesoUrgencia: 1,
        ...(destino.clienteSugerido ? { clienteSugerido: destino.clienteSugerido } : {}) });
      contexto.roteamento = fixo;
      store.salvarContexto(contexto);
    } else {
      infoDe.set(m.id, info0);
    }
  }

  const origemDe = item => {
    const ids = Array.isArray(item?.m) ? item.m : [];
    const comEmpresa = ids.map(id => porId.get(id)).filter(Boolean).find(m => {
      const info = infoDe.get(m.id);
      return info?.empresa && !['?', 'pessoal'].includes(norm(info.empresa));
    });
    if (comEmpresa) return comEmpresa;
    const comTexto = ids.map(id => porId.get(id)).filter(Boolean).reverse().find(m => {
      const links = extrairLinks(m.texto || m.transcricao);
      const semLinks = (m.texto || '').replace(/https?:\/\/[^\s<>"')]+|www\.[^\s<>"')]+/gi, '').trim();
      return Boolean(semLinks || !links.length);
    });
    return comTexto ?? porId.get(ids.find(id => porId.has(id))) ?? lote[lote.length - 1];
  };

  const aplicar = (item, ehAtualizacao) => {
    const idsOriginais = Array.isArray(item?.m) ? item.m : [];
    const idsLimpos = idsOriginais.filter(id => {
      const m = porId.get(id);
      if (!m) return false;
      const isAbre = acharAberturaBloco(m.texto, cfgBloco) && !m.texto.split('\n')[1]?.trim();
      const isFecha = (acharFechamentoBloco(m.texto, cfgBloco) || /^\s*concluir\s*$/i.test(m.texto)) && !m.texto.split('\n')[1]?.trim();
      return !isAbre && !isFecha;
    });
    const msg = origemDe(item);
    const ids = idsLimpos.length ? idsLimpos : [msg.id];
    const bruto = expandirItem(item, ehAtualizacao);
    bruto.fontes = ids;
    bruto.mensagensRef = ids;
    const todosLinks = [];
    for (const id of ids) {
      const m = porId.get(id);
      if (m) todosLinks.push(...extrairLinks(m.texto || m.transcricao));
    }
    if (todosLinks.length) {
      bruto.links = [...new Set([...(bruto.links || []), ...todosLinks])];
    }
    const tarefasExistentes = store.lerTarefas().filter(t => abertas.some(a => a.id === t.id));
    const { tarefas, atualizacoes } = sanearRespostaLLM(ehAtualizacao ? { atualizacoes: [bruto] } : { tarefas: [bruto] }, msg, tarefasExistentes);
    for (const t of tarefas) if (t.descricao) t.descricao = t.descricao.slice(0, DESCRICAO_MAX);
    const contexto = store.lerContexto(msg.chatId) ?? { mensagens: [] };
    const res = aplicarExtracao({ store, mensagem: msg, info: infoDe.get(msg.id) ?? info0, contexto, novasExtraidas: tarefas, atualizacoes });
    saida.novas += res.novas.length;
    saida.atualizadas += res.atualizadas.length;
    saida.tarefasCriadas.push(...res.novas);
  };
  for (const item of Array.isArray(json.a) ? json.a : []) if (item && typeof item === 'object') aplicar(item, true);
  for (const item of Array.isArray(json.n) ? json.n : []) if (item && typeof item === 'object') aplicar(item, false);
  return saida;
}

async function extrairGrupoBloco({ g, mensagens, alvo, store, env, llmLigado, uso, usoPath, fetch: fetchFn, log, configBloco }) {
  const saida = { chamadas: 0, custoUSD: 0, novas: 0, atualizadas: 0, heuristica: false, tarefasCriadas: [] };
  const lote = mensagens.filter(temConteudo);
  if (!lote.length) return saida;

  const info0 = {
    empresa: alvo.empresa,
    projeto: alvo.projeto,
    origem: lote[0].origem,
    ...(alvo.clienteSugerido ? { clienteSugerido: alvo.clienteSugerido } : {}),
  };

  const fecharRegexSozinho = new RegExp(`^\\s*${escaparRegex(configBloco?.fechar ?? 'Concluir')}\\s*$`, 'i');

  const heuristica = async () => {
    saida.heuristica = true;
    const semLLM = { ...env, BALDE_LLM: 'off' };
    for (const m of lote) {
      const isAbre = acharAberturaBloco(m.texto, configBloco) && !m.texto.split('\n')[1]?.trim();
      const isFecha = (acharFechamentoBloco(m.texto, configBloco) || fecharRegexSozinho.test(m.texto)) && !m.texto.split('\n')[1]?.trim();
      if (isAbre || isFecha) continue;
      const res = await processar(m, store, { llm: { env: semLLM } });
      if (res?.novas?.length) {
        for (const t of res.novas) {
          const updates = {};
          if (t.empresa !== alvo.empresa || t.projeto !== alvo.projeto) {
            updates.empresa = alvo.empresa;
            updates.projeto = alvo.projeto;
          }
          if (alvo.clienteSugerido && !t.titulo.includes(`[${alvo.clienteSugerido}]`)) {
            updates.titulo = `[${alvo.clienteSugerido}] ${t.titulo}`;
          }
          if (Object.keys(updates).length) {
            const atualizada = store.upsertTarefa({ ...t, ...updates });
            saida.tarefasCriadas.push(atualizada);
          } else {
            saida.tarefasCriadas.push(t);
          }
        }
        saida.novas += res.novas.length;
      }
      saida.atualizadas += res?.atualizadas?.length ?? 0;
    }
    return saida;
  };

  if (!llmLigado) return heuristica();

  const abertas = abertasDoProjeto(store.lerTarefas(), {
    chatId: g.jid,
    empresa: alvo.empresa,
    projeto: alvo.projeto,
    despejo: false,
  });

  const msgsPrompt = lote.filter(m => {
    const isAbre = acharAberturaBloco(m.texto, configBloco) && !m.texto.split('\n')[1]?.trim();
    const isFecha = (acharFechamentoBloco(m.texto, configBloco) || fecharRegexSozinho.test(m.texto)) && !m.texto.split('\n')[1]?.trim();
    return !isAbre && !isFecha;
  });

  if (!msgsPrompt.length) return saida;

  const prompt = montarPromptLote({
    info: info0,
    nomeGrupo: lote[0].chatNome || g.jid,
    despejo: false,
    abertas,
    mensagens: msgsPrompt,
  });

  const resposta = await chamarLLM({
    system: SYSTEM_LOTE,
    prompt,
    json: true,
    maxTokens: numeroEnv(env, 'BALDE_LER_MAX_TOKENS', MAX_TOKENS_PADRAO),
  }, { env, usoPath, uso: { ...uso, tipo: 'extracao' }, ...(fetchFn ? { fetch: fetchFn } : {}) }).catch(err => {
    log(`[leitura] LLM do bloco falhou: ${err.message}`);
    return null;
  });

  if (resposta) {
    saida.chamadas = 1;
    saida.custoUSD = resposta.uso?.custoUSD ?? 0;
  }
  const json = resposta?.json;
  if (!json || typeof json !== 'object') {
    log(`[leitura] Bloco ${alvo.empresa}: LLM sem JSON válido — heurística local`);
    return heuristica();
  }

  const msgsControle = new Set(
    lote.filter(m => {
      const isAbre = acharAberturaBloco(m.texto, configBloco) && !m.texto.split('\n')[1]?.trim();
      const isFecha = (acharFechamentoBloco(m.texto, configBloco) || fecharRegexSozinho.test(m.texto)) && !m.texto.split('\n')[1]?.trim();
      return isAbre || isFecha;
    }).map(m => m.id)
  );

  const porId = new Map(lote.map(m => [m.id, m]));
  const origemDe = item => {
    const ids = Array.isArray(item?.m) ? item.m : [];
    const idValido = ids.find(id => porId.has(id) && !msgsControle.has(id));
    return porId.get(idValido) ?? msgsPrompt[msgsPrompt.length - 1];
  };

  const aplicar = (item, ehAtualizacao) => {
    const idsOriginais = Array.isArray(item?.m) ? item.m : [];
    const idsLimpos = idsOriginais.filter(id => porId.has(id) && !msgsControle.has(id));
    const msg = origemDe(item);
    const ids = idsLimpos.length ? idsLimpos : (msgsControle.has(msg.id) ? [msgsPrompt[0]?.id].filter(Boolean) : [msg.id]);
    const bruto = expandirItem(item, ehAtualizacao);
    bruto.fontes = ids;
    bruto.mensagensRef = ids;
    const todosLinks = [];
    for (const id of ids) {
      const m = porId.get(id);
      if (m) todosLinks.push(...extrairLinks(m.texto || m.transcricao));
    }
    if (todosLinks.length) {
      bruto.links = [...new Set([...(bruto.links || []), ...todosLinks])];
    }
    const tarefasExistentes = store.lerTarefas().filter(t => abertas.some(a => a.id === t.id));
    const { tarefas, atualizacoes } = sanearRespostaLLM(ehAtualizacao ? { atualizacoes: [bruto] } : { tarefas: [bruto] }, msg, tarefasExistentes);
    for (const t of tarefas) if (t.descricao) t.descricao = t.descricao.slice(0, DESCRICAO_MAX);
    const contexto = store.lerContexto(msg.chatId) ?? { mensagens: [] };
    const res = aplicarExtracao({ store, mensagem: msg, info: info0, contexto, novasExtraidas: tarefas, atualizacoes });
    saida.novas += res.novas.length;
    saida.atualizadas += res.atualizadas.length;
    saida.tarefasCriadas.push(...res.novas);
  };

  for (const item of Array.isArray(json.a) ? json.a : []) if (item && typeof item === 'object') aplicar(item, true);
  for (const item of Array.isArray(json.n) ? json.n : []) if (item && typeof item === 'object') aplicar(item, false);

  return saida;
}

// ─── Estimativa e resumo de custo ───────────────────────────────

/** Tokens típicos de uma chamada de lote (prompt fixo + ~60 tokens por mensagem). */
export const TOKENS_LOTE = Object.freeze({ fixo: 450, porMensagem: 60, porTarefa: 15, saida: 250 });

/**
 * Estimativa de custo pela tabela de preços configurável (PRECOS_PADRAO / BALDE_LLM_PRECOS
 * e PRECOS_TRANSCRICAO_MIN / BALDE_TRANSCRICAO_PRECO_MIN).
 * @param {{ chamadas?: number, mensagens?: number, tarefas?: number, minutosAudio?: number,
 *           tokensInPorChamada?: number, tokensOutPorChamada?: number, modelo?: string, modeloTranscricao?: string, audioLocal?: boolean }} p
 */
export function estimarCusto(p = {}, env = process.env) {
  const modelo = p.modelo ?? configLLM(env)?.modelo ?? env.BALDE_LLM_MODELO ?? MODELOS_PADRAO.openai;
  const chamadas = p.chamadas ?? 0;
  const tokensIn = p.tokensInPorChamada != null ? p.tokensInPorChamada * chamadas
    : chamadas * TOKENS_LOTE.fixo + (p.mensagens ?? 0) * TOKENS_LOTE.porMensagem + chamadas * (p.tarefas ?? 0) * TOKENS_LOTE.porTarefa;
  const tokensOut = (p.tokensOutPorChamada ?? TOKENS_LOTE.saida) * chamadas;
  const preco = precoModelo(modelo, env);
  const llmUSD = (tokensIn * preco.entrada + tokensOut * preco.saida) / 1e6;
  const modeloTranscricao = p.modeloTranscricao ?? env.BALDE_TRANSCRICAO_MODELO ?? MODELO_TRANSCRICAO_PADRAO;
  const audioUSD = p.audioLocal ? 0 : (p.minutosAudio ?? 0) * precoTranscricaoMin(modeloTranscricao, env);
  return { modelo, tokensIn, tokensOut, llmUSD, modeloTranscricao, audioUSD, totalUSD: llmUSD + audioUSD, precoConhecido: preco.conhecido };
}

const dataDe = v => {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.getTime();
  const s = String(v);
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00` : s);
  return Number.isFinite(ms) ? ms : null;
};
const diaLocal = ms => {
  const d = new Date(ms);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
};
const vazio = () => ({ custoUSD: 0, chamadas: 0, tokensIn: 0, tokensOut: 0, segundosAudio: 0, mensagens: 0, audios: 0 });
/** Mensagens e áudios de um grupo numa leitura (leituras antigas só têm `novas`). */
const contarGrupo = (acc, g) => {
  acc.mensagens += Number(g?.mensagens ?? g?.novas) || 0;
  acc.audios += Number(g?.audios) || 0;
};
const somar = (acc, l) => {
  acc.custoUSD += Number(l.custoUSD) || 0;
  acc.chamadas += 1;
  acc.tokensIn += Number(l.tokensIn ?? l.entrada) || 0;
  acc.tokensOut += Number(l.tokensOut ?? l.saida) || 0;
  acc.segundosAudio += Number(l.segundosAudio ?? l.segundos) || 0;
};
const arredondar = o => { o.custoUSD = Number(o.custoUSD.toFixed(6)); return o; };

/**
 * Quanto custou, de uso-llm.jsonl (e leituras.jsonl para as leituras sem custo).
 * `ate` em AAAA-MM-DD inclui o dia inteiro.
 * @param {{ desde?: string|Date, ate?: string|Date, dadosDir?: string, env?: object }} [p]
 * @returns {{ total: Object, porLeitura: Object, porEmpresaProjeto: Object, porDia: Object }}
 */
export function resumoUso(p = {}) {
  const env = p.env ?? process.env;
  const dadosDir = caminhoDados(p, env);
  const desde = dataDe(p.desde);
  let ate = dataDe(p.ate);
  if (ate !== null && /^\d{4}-\d{2}-\d{2}$/.test(String(p.ate))) ate += 86_400_000 - 1;
  const dentro = ms => Number.isFinite(ms) && (desde === null || ms >= desde) && (ate === null || ms <= ate);

  const total = vazio();
  const porLeitura = {};
  const porEmpresaProjeto = {};
  const porDia = {};
  for (const l of lerJsonl(path.join(dadosDir, 'leituras.jsonl'))) {
    const ms = Date.parse(l?.inicio ?? '');
    if (!l?.leituraId || !dentro(ms)) continue;
    const leitura = porLeitura[l.leituraId] = { ...vazio(), inicio: l.inicio, grupos: l.grupos?.length ?? 0 };
    for (const g of Array.isArray(l.grupos) ? l.grupos : []) {
      contarGrupo(leitura, g);
      contarGrupo(total, g);
      if (Number(g?.mensagens ?? g?.novas) || Number(g?.audios)) contarGrupo(porEmpresaProjeto[`${g.empresa ?? '?'} · ${g.projeto ?? '?'}`] ??= vazio(), g);
    }
  }
  for (const l of lerJsonl(path.join(dadosDir, 'uso-llm.jsonl'))) {
    const ms = Date.parse(l?.ts ?? '');
    if (!dentro(ms)) continue;
    somar(total, l);
    const idL = l.leituraId ?? 'fora-de-leitura';
    somar(porLeitura[idL] ??= vazio(), l);
    somar(porEmpresaProjeto[`${l.empresa ?? '?'} · ${l.projeto ?? '?'}`] ??= vazio(), l);
    somar(porDia[diaLocal(ms)] ??= vazio(), l);
  }
  for (const o of [total, ...Object.values(porLeitura), ...Object.values(porEmpresaProjeto), ...Object.values(porDia)]) arredondar(o);
  return { total, porLeitura, porEmpresaProjeto, porDia };
}

// ─── Modelo escolhido: dados/config-llm.json (GB-46) ────────────

/** Leitura típica para a estimativa do seletor quando ainda não há histórico. */
export const LEITURA_TIPICA_PADRAO = Object.freeze({ chamadas: 3, mensagens: 30, tarefas: 10, minutosAudio: 2, base: 'padrão' });

/**
 * Média das últimas leituras com mensagem nova (até 20): grupos com novidade = chamadas,
 * mensagens e minutos de áudio. Sem histórico → LEITURA_TIPICA_PADRAO.
 */
export function leituraTipica(dadosDir) {
  const leituras = lerJsonl(path.join(dadosDir, 'leituras.jsonl'))
    .filter(l => Array.isArray(l?.grupos) && l.grupos.some(g => Number(g?.mensagens ?? g?.novas) > 0))
    .slice(-20);
  if (!leituras.length) return { ...LEITURA_TIPICA_PADRAO };
  const ids = new Set(leituras.map(l => l.leituraId));
  let segundos = 0;
  for (const u of lerJsonl(path.join(dadosDir, 'uso-llm.jsonl'))) if (ids.has(u?.leituraId)) segundos += Number(u.segundosAudio) || 0;
  const media = f => leituras.reduce((s, l) => s + f(l), 0) / leituras.length;
  return {
    chamadas: Math.max(1, Math.round(media(l => l.grupos.filter(g => Number(g?.mensagens ?? g?.novas) > 0).length))),
    mensagens: Math.max(1, Math.round(media(l => l.grupos.reduce((s, g) => s + (Number(g?.mensagens ?? g?.novas) || 0), 0)))),
    tarefas: LEITURA_TIPICA_PADRAO.tarefas,
    minutosAudio: Number((segundos / 60 / leituras.length).toFixed(1)),
    base: `média de ${leituras.length} leitura${leituras.length === 1 ? '' : 's'}`,
  };
}

/**
 * Estado do seletor: escolha gravada, valor efetivo, opções com preço e estimativa por leitura típica.
 * Nunca inclui chaves — só se há key para o provedor.
 * @param {{ dadosDir: string, env?: object, whisper?: () => string|null }} p
 */
export function estadoConfigLLM({ dadosDir, env = process.env, whisper = () => whisperLocal() }) {
  const escolhido = lerConfigEscolhida(dadosDir);
  const efetivoEnv = aplicarConfigEscolhida(env, escolhido);
  const tipica = leituraTipica(dadosDir);
  const cfg = configLLM(efetivoEnv);
  const local = whisper();
  const extracao = MODELOS_EXTRACAO.map(m => {
    const tabela = env.BALDE_LLM_PRECOS ? { BALDE_LLM_PRECOS: env.BALDE_LLM_PRECOS } : {};   // tabela do .env vale; preço avulso é só do modelo do .env
    const preco = precoModelo(m.id, tabela);
    const disponivel = temKey(m.provedor, env);
    return {
      id: m.id, provedor: m.provedor, entradaPor1M: preco.entrada, saidaPor1M: preco.saida,
      disponivel, ...(disponivel ? {} : { motivo: `sem ${m.provedor === 'gemini' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY'} no .env` }),
      estimativaLeituraUSD: Number(estimarCusto({ ...tipica, minutosAudio: 0, modelo: m.id }, tabela).llmUSD.toFixed(6)),
    };
  });
  const transcricao = MODELOS_TRANSCRICAO.map(id => {
    const porMin = id === 'local' ? 0 : precoTranscricaoMin(id, {});
    const disponivel = id === 'local' ? Boolean(local) : temKey('openai', env);
    return {
      id, porMinutoUSD: porMin, disponivel,
      ...(disponivel ? {} : { motivo: id === 'local' ? 'whisper local não instalado' : 'sem OPENAI_API_KEY no .env' }),
      estimativaLeituraUSD: Number((tipica.minutosAudio * porMin).toFixed(6)),
    };
  });
  const modeloTranscricaoEfetivo = escolhido.modeloTranscricao
    ?? (local && !['openai', 'groq'].includes(String(env.BALDE_TRANSCRICAO ?? '').toLowerCase()) ? 'local'
      : env.BALDE_TRANSCRICAO_MODELO?.trim() || MODELO_TRANSCRICAO_PADRAO);
  return {
    arquivo: path.join(dadosDir, ARQUIVO_CONFIG_LLM),
    escolhido,
    efetivo: {
      llmLigado: Boolean(cfg),
      modeloExtracao: cfg?.modelo ?? efetivoEnv.BALDE_LLM_MODELO?.trim() ?? MODELOS_PADRAO.openai,
      modeloTranscricao: modeloTranscricaoEfetivo,
      limiteDiaUSD: limiteDiaUSD(efetivoEnv),
      gastoHojeUSD: Number(gastoHojeUSD(path.join(dadosDir, 'uso-llm.jsonl')).toFixed(6)),
    },
    leituraTipica: tipica,
    opcoes: { extracao, transcricao },
  };
}

/**
 * Valida e grava a escolha (atômico). Campo ausente mantém o gravado; null volta ao .env.
 * @returns {{ erro?: string, config?: object }}
 */
export function gravarConfigLLM({ dadosDir, corpo, env = process.env, whisper = () => whisperLocal() }) {
  if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) return { erro: 'Corpo deve ser um objeto' };
  const atual = lerConfigEscolhida(dadosDir);
  const nova = { ...atual };
  if ('modeloExtracao' in corpo) {
    if (corpo.modeloExtracao === null) delete nova.modeloExtracao;
    else {
      const m = MODELOS_EXTRACAO.find(x => x.id === corpo.modeloExtracao);
      if (!m) return { erro: `modeloExtracao deve ser um de: ${MODELOS_EXTRACAO.map(x => x.id).join(', ')}` };
      if (!temKey(m.provedor, env)) return { erro: `${m.id} precisa de chave ${m.provedor} no .env` };
      nova.modeloExtracao = m.id;
    }
  }
  if ('modeloTranscricao' in corpo) {
    if (corpo.modeloTranscricao === null) delete nova.modeloTranscricao;
    else {
      if (!MODELOS_TRANSCRICAO.includes(corpo.modeloTranscricao)) return { erro: `modeloTranscricao deve ser um de: ${MODELOS_TRANSCRICAO.join(', ')}` };
      if (corpo.modeloTranscricao === 'local' && !whisper()) return { erro: 'whisper local não está instalado' };
      if (corpo.modeloTranscricao !== 'local' && !temKey('openai', env)) return { erro: 'transcrição pela API precisa de OPENAI_API_KEY no .env' };
      nova.modeloTranscricao = corpo.modeloTranscricao;
    }
  }
  if ('limiteDiaUSD' in corpo) {
    if (corpo.limiteDiaUSD === null) delete nova.limiteDiaUSD;
    else {
      const n = typeof corpo.limiteDiaUSD === 'number' ? corpo.limiteDiaUSD : Number(String(corpo.limiteDiaUSD).replace(',', '.'));
      if (!Number.isFinite(n) || n < 0 || n > 50) return { erro: 'limiteDiaUSD deve ser um número entre 0 e 50' };
      nova.limiteDiaUSD = Number(n.toFixed(2));
    }
  }
  const arquivo = path.join(dadosDir, ARQUIVO_CONFIG_LLM);
  gravarEstado(arquivo, { ...nova, atualizadoEm: new Date().toISOString() });
  return { config: nova };
}

// ─── Rotas HTTP: POST /api/ler, GET /api/ler, GET /api/uso, GET|PUT /api/config/llm ──

/** 127.x, ::1 e localhost são loopback (mesma regra de lib/api.mjs). */
function hostLoopback(host) {
  const h = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

function tokenConfere(recebido, esperado) {
  if (!esperado || typeof recebido !== 'string') return false;
  const a = Buffer.from(recebido), b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Cópia das proteções de lib/api.mjs: Host (anti DNS rebinding), token fora de loopback, Content-Type e Origin na escrita. */
function recusar(req, { loopback, token }) {
  const porta = req.socket?.localPort;
  const host = String(req.headers.host ?? '').toLowerCase();
  const hostsLocais = [`127.0.0.1:${porta}`, `localhost:${porta}`];
  if (loopback && !hostsLocais.includes(host)) return [403, 'Host não permitido'];
  if (!loopback && !tokenConfere(req.headers['x-balde-token'], token)) return [401, 'X-Balde-Token ausente ou inválido'];
  if (req.method === 'POST' || req.method === 'PUT') {
    const tipo = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (tipo !== 'application/json') return [403, 'Content-Type deve ser application/json'];
    const origin = req.headers.origin;
    const origensOk = hostsLocais.map(h => `http://${h}`);
    if (!loopback && host) origensOk.push(`http://${host}`);
    if (origin !== undefined && !origensOk.includes(String(origin).toLowerCase())) return [403, 'Origin não permitida'];
  }
  return null;
}

function responder(res, status, dados) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(dados));
}

async function lerCorpo(req, max = 16_384) {
  let tam = 0;
  const partes = [];
  for await (const c of req) {
    tam += c.length;
    if (tam > max) throw Object.assign(new Error('Corpo grande demais'), { status: 413 });
    partes.push(c);
  }
  const texto = Buffer.concat(partes).toString('utf8').trim();
  if (!texto) return {};
  try { return JSON.parse(texto); } catch { throw Object.assign(new Error('JSON inválido'), { status: 400 }); }
}

export const ROTAS_LEITURA = Object.freeze([
  '/api/ler',
  '/api/uso',
  '/api/config/llm',
  '/api/leituras/log',
  '/api/config/bloco',
  '/api/blocos/pendentes',
]);

/**
 * Lê as últimas entradas do log de leituras.
 * @param {string} dadosDir
 * @param {number} [limite=50]
 * @returns {Array}
 */
export function lerLogLeituras(dadosDir, limite = 50) {
  const arquivo = path.join(dadosDir, 'leituras-log.jsonl');
  const linhas = lerJsonl(arquivo);
  return linhas.slice(-limite).reverse();
}

/**
 * Handler de /api/ler e /api/uso. Devolve false quando o caminho não é dele.
 * @param {{ host?: string, token?: string, lerAgora?: typeof lerAgora, resumoUso?: typeof resumoUso, opcoes?: Object, whisper?: () => string|null }} [p]
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<boolean>}
 */
export function criarRotaLeitura({
  host = process.env.BALDE_HOST ?? '127.0.0.1',
  token = process.env.BALDE_WEBHOOK_TOKEN,
  lerAgora: ler = lerAgora,
  resumoUso: resumo = resumoUso,
  opcoes = {},
  whisper,
} = {}) {
  const protecao = { loopback: hostLoopback(host), token };
  // env da leitura (testes injetam) e detector do whisper local para o seletor de modelo
  const configExtra = { ...(opcoes.env ? { env: opcoes.env } : {}), ...(whisper ? { whisper } : {}) };
  return async function rotaLeitura(req, res) {
    let url;
    try { url = new URL(req.url || '/', 'http://localhost'); } catch { return false; }
    if (!ROTAS_LEITURA.includes(url.pathname)) return false;

    const recusa = recusar(req, protecao);
    if (recusa) { responder(res, recusa[0], { erro: recusa[1] }); return true; }

    try {
      if (url.pathname === '/api/ler' && req.method === 'POST') {
        const corpo = await lerCorpo(req);
        const grupos = Array.isArray(corpo?.grupos) ? corpo.grupos.filter(g => typeof g === 'string' && g.length <= 200).slice(0, 50) : undefined;
        responder(res, 200, await ler({ ...opcoes, ...(grupos?.length ? { grupos } : {}) }));
      } else if (url.pathname === '/api/ler' && req.method === 'GET') {
        const estado = lerEstado(path.join(caminhoDados(opcoes), 'leitura.json'));
        responder(res, 200, { emAndamento: leituraEmAndamento(), ultimaLeitura: estado.ultimaLeitura,
          grupos: Object.fromEntries(Object.entries(estado.grupos).map(([jid, g]) => [jid, { ultimaLeitura: g.ultimaLeitura ?? null, pendentes: g.pendentes?.length ?? 0 }])) });
      } else if (url.pathname === '/api/leituras/log' && req.method === 'GET') {
        const limite = Number(url.searchParams.get('limite')) || 50;
        responder(res, 200, lerLogLeituras(caminhoDados(opcoes), limite));
      } else if (url.pathname === '/api/uso' && req.method === 'GET') {
        responder(res, 200, resumo({ ...opcoes, desde: url.searchParams.get('desde') ?? undefined, ate: url.searchParams.get('ate') ?? undefined }));
      } else if (url.pathname === '/api/config/llm' && req.method === 'GET') {
        responder(res, 200, estadoConfigLLM({ dadosDir: caminhoDados(opcoes), ...configExtra }));
      } else if (url.pathname === '/api/config/llm' && req.method === 'PUT') {
        const dadosDir = caminhoDados(opcoes);
        const r = gravarConfigLLM({ dadosDir, corpo: await lerCorpo(req), ...configExtra });
        if (r.erro) responder(res, 400, { erro: r.erro });
        else responder(res, 200, estadoConfigLLM({ dadosDir, ...configExtra }));
      } else if (url.pathname === '/api/config/bloco' && req.method === 'GET') {
        responder(res, 200, lerConfigBloco(caminhoDados(opcoes)));
      } else if (url.pathname === '/api/config/bloco' && req.method === 'PUT') {
        const dadosDir = caminhoDados(opcoes);
        const r = gravarConfigBloco({ dadosDir, corpo: await lerCorpo(req) });
        if (r.erro) responder(res, 400, { erro: r.erro });
        else responder(res, 200, lerConfigBloco(dadosDir));
      } else if (url.pathname === '/api/blocos/pendentes' && req.method === 'GET') {
        responder(res, 200, listarBlocosPendentes(caminhoDados(opcoes)));
      } else {
        res.setHeader('Allow',
          url.pathname === '/api/ler' ? 'GET, POST' :
          (url.pathname === '/api/config/llm' || url.pathname === '/api/config/bloco') ? 'GET, PUT' :
          'GET'
        );
        responder(res, 405, { erro: 'Método não permitido' });
      }
    } catch (err) {
      responder(res, err.status ?? 500, { erro: err.status ? err.message : 'Falha na leitura' });
      if (!err.status) console.error('[leitura] erro:', err.message);
    }
    return true;
  };
}
