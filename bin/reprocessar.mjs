#!/usr/bin/env node
/**
 * @file reprocessar.mjs — Roda o motor de novo sobre dados/mensagens.jsonl.
 *
 *   node bin/reprocessar.mjs [--desde 2d] [--confirmar]     (Nd | Nh | Nm; sem --desde = tudo)
 *   node bin/reprocessar.mjs --grupo balde [--refazer] [--confirmar]
 *
 * Sem --confirmar (GB-44) só mostra quantas mensagens iriam ao motor e a estimativa
 * de custo (uma chamada de LLM por mensagem, áudio e imagem à parte) — não grava nada.
 *
 * --grupo X: só os chats cujo id, nome ou "empresa projeto" contém X.
 * --refazer: antes, apaga as tarefas desses chats nascidas dessas mensagens (e o
 *   contexto fixo do despejo), para o motor classificar tudo de novo (GB-36).
 *
 * Para mensagens que já entraram mas não viraram tarefa (ex.: LLM devolvendo 400).
 *   - Ordem cronológica (ts), uma vez por id.
 *   - Mídia ilegível no disco (o .enc criptografado do CDN do WhatsApp) é baixada
 *     de novo, decifrada pela Evolution, antes do enriquecimento.
 *   - Dedup: mensagem já citada em `fontes` de alguma tarefa só volta para a janela
 *     de contexto (não é extraída de novo); as demais passam por processar(), cuja
 *     rede de similaridade funde o que for parecido com tarefa aberta.
 *   - A janela de contexto dos chats tocados perde essas mensagens antes de
 *     reprocessar, para não entrarem duas vezes.
 *
 * Carrega balde/.env sem sobrescrever o ambiente. Nunca imprime conteúdo de
 * mensagem nem segredo — só contagens e títulos de tarefa.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { carregarEnv } from './diagnostico.mjs';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const UNIDADES = { d: 86_400_000, h: 3_600_000, m: 60_000 };

/** "2d" | "12h" | "30m" → ms; inválido → null. */
export function parseDuracao(txt) {
  const m = /^(\d+)\s*([dhm])$/i.exec(String(txt ?? '').trim());
  return m ? Number(m[1]) * UNIDADES[m[2].toLowerCase()] : null;
}

/** Bytes iniciais batem com o tipo? (imagem/áudio/pdf baixados criptografados não batem.) */
export function midiaLegivel(buf, tipo) {
  if (!buf || buf.length < 4) return false;
  const ini = buf.subarray(0, 12);
  const latin = ini.toString('latin1');
  if (tipo === 'imagem') {
    return (ini[0] === 0xff && ini[1] === 0xd8 && ini[2] === 0xff)
      || latin.startsWith('\x89PNG') || latin.startsWith('GIF8')
      || (latin.startsWith('RIFF') && latin.slice(8, 12) === 'WEBP');
  }
  if (tipo === 'audio') {
    return latin.startsWith('OggS') || latin.startsWith('ID3') || latin.slice(4, 8) === 'ftyp'
      || latin.startsWith('RIFF') || (ini[0] === 0xff && (ini[1] & 0xe0) === 0xe0);
  }
  if (tipo === 'pdf') return latin.startsWith('%PDF');
  return true;
}

const normTxt = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

/**
 * Mensagens dos chats que casam com `grupo` (id, nome ou empresa/projeto resolvidos).
 * @param {Object[]} mensagens
 * @param {string} grupo
 * @param {(m: Object) => { empresa: string, projeto: string }} resolver
 */
export function filtrarGrupo(mensagens, grupo, resolver) {
  const alvo = normTxt(grupo);
  const casa = new Map();
  return mensagens.filter(m => {
    if (!casa.has(m.chatId)) {
      const r = resolver(m);
      casa.set(m.chatId, [m.chatId, m.chatNome, `${r.empresa} ${r.projeto}`].some(v => normTxt(v).includes(alvo)));
    }
    return casa.get(m.chatId);
  });
}

/**
 * Apaga as tarefas dos chats alvo cujas fontes são todas mensagens alvo, e zera o
 * contexto fixo do despejo desses chats. Devolve as tarefas apagadas.
 */
export function limparParaRefazer(store, mensagens) {
  const ids = new Set(mensagens.map(m => m.id));
  const chats = new Set(mensagens.map(m => m.chatId));
  const apagadas = [];
  const ficam = store.lerTarefas().filter(t => {
    const fontes = t.fontes ?? t.mensagensRef ?? [];
    const refazer = chats.has(t.chatId) && fontes.length > 0 && fontes.every(f => ids.has(f));
    if (refazer) apagadas.push(t);
    return !refazer;
  });
  store.salvarTarefas(ficam);
  for (const chatId of chats) {
    const ctx = store.lerContexto(chatId);
    if (ctx) store.salvarContexto({ ...ctx, roteamento: null, tarefasAbertas: (ctx.tarefasAbertas ?? []).filter(id => !apagadas.some(t => t.id === id)) });
  }
  return apagadas;
}

/** Lê o JSONL, tolera linha quebrada, uma vez por id, em ordem de ts. */
export function lerMensagens(arquivo) {
  if (!fs.existsSync(arquivo)) return [];
  const porId = new Map();
  for (const linha of fs.readFileSync(arquivo, 'utf8').split('\n')) {
    if (!linha.trim()) continue;
    try {
      const m = JSON.parse(linha);
      if (m?.id && m.chatId && !porId.has(m.id)) porId.set(m.id, m);
    } catch { /* linha corrompida */ }
  }
  return [...porId.values()].sort((a, b) => String(a.ts ?? '').localeCompare(String(b.ts ?? '')));
}

/**
 * @param {Object} p
 * @param {ReturnType<import('../lib/store.mjs').criarStore>} p.store
 * @param {Object[]} p.mensagens            — já em ordem
 * @param {(m: Object) => Promise<Object>} p.enriquecer
 * @param {(m: Object, store: Object) => Promise<{novas: Object[], atualizadas: Object[]}>} p.processar
 * @param {(keyId: string) => Promise<Buffer|null>} [p.baixarMidia] — Evolution
 * @param {(m: Object, store: Object) => void} p.acumular — só janela de contexto
 * @param {number} [p.desdeMs]              — corta mensagens com ts anterior
 */
export async function reprocessar({ store, mensagens, enriquecer, processar, baixarMidia, acumular, desdeMs }) {
  const alvo = desdeMs ? mensagens.filter(m => Date.parse(m.ts) >= desdeMs) : mensagens;
  const ids = new Set(alvo.map(m => m.id));
  const resumo = { mensagens: alvo.length, processadas: 0, jaComTarefa: 0, midiaRecuperada: 0, midiaIlegivel: 0, novas: 0, atualizadas: 0, erros: 0 };

  // Janela de contexto sem as mensagens que vão entrar de novo
  for (const chatId of new Set(alvo.map(m => m.chatId))) {
    const ctx = store.lerContexto(chatId);
    if (ctx) store.salvarContexto({ ...ctx, mensagens: (ctx.mensagens ?? []).filter(m => !ids.has(m.id)) });
  }

  const jaCitadas = () => new Set(store.lerTarefas().flatMap(t => t.fontes ?? t.mensagensRef ?? []));

  for (const original of alvo) {
    let msg = original;
    try {
      if (['imagem', 'audio', 'pdf'].includes(msg.tipo) && msg.midiaPath) {
        let buf = null;
        try { buf = fs.readFileSync(msg.midiaPath); } catch { /* sumiu */ }
        if (!midiaLegivel(buf, msg.tipo)) {
          const novo = baixarMidia ? await baixarMidia(msg.id) : null;
          if (novo && midiaLegivel(novo, msg.tipo)) {
            fs.mkdirSync(path.dirname(msg.midiaPath), { recursive: true });
            fs.writeFileSync(msg.midiaPath, novo);
            resumo.midiaRecuperada++;
          } else {
            resumo.midiaIlegivel++;
          }
        }
      }

      msg = (await enriquecer(msg)) ?? msg;
      if (jaCitadas().has(msg.id)) {
        acumular(store, msg);
        resumo.jaComTarefa++;
        continue;
      }

      const r = await processar(msg, store);
      resumo.processadas++;
      resumo.novas += r?.novas?.length ?? 0;
      resumo.atualizadas += r?.atualizadas?.length ?? 0;
    } catch (err) {
      resumo.erros++;
      console.warn(`[reprocessar] ${original.id}: ${err.message}`);
    }
  }
  return resumo;
}

/** Tokens médios de uma chamada do motor por mensagem (janela de 20 mensagens + tarefas do chat). */
export const TOKENS_MOTOR = Object.freeze({ entrada: 1700, saida: 150, imagem: 1100 });

/**
 * Estimativa do motor mensagem a mensagem (backfill e reprocessar), pela tabela de
 * preços configurável de lib/llm.mjs. Imprime e devolve o total em USD.
 */
export async function estimarCustoMotor({ mensagens, audios = 0, imagens = 0, minutosPorAudio = 1 }, rotulo, env = process.env, log = console.log) {
  const { estimarCusto } = await import('../lib/leitura.mjs');
  const { llmDisponivel } = await import('../lib/llm.mjs');
  const llm = llmDisponivel(env);
  const e = estimarCusto({
    chamadas: llm ? mensagens + imagens : 0,
    tokensInPorChamada: Math.round((mensagens * TOKENS_MOTOR.entrada + imagens * TOKENS_MOTOR.imagem) / Math.max(1, mensagens + imagens)),
    tokensOutPorChamada: TOKENS_MOTOR.saida,
    minutosAudio: audios * minutosPorAudio,
  }, env);
  log(`${rotulo}: ${mensagens} mensagem(ns)${llm ? ` → ${mensagens} chamada(s) de LLM` : ' (LLM desligado: heurística, sem custo)'}, ${imagens} imagem(ns), ${audios} áudio(s)`);
  log(`  ≈ US$ ${e.totalUSD.toFixed(4)} (LLM ${e.modelo} US$ ${e.llmUSD.toFixed(4)} + áudio ${e.modeloTranscricao} US$ ${e.audioUSD.toFixed(4)}) — preços da tabela configurável (lib/llm.mjs)`);
  return e.totalUSD;
}

async function main(argv) {
  const i = argv.indexOf('--desde');
  let desdeMs;
  if (i !== -1) {
    const dur = parseDuracao(argv[i + 1]);
    if (!dur) {
      console.error('uso: node bin/reprocessar.mjs [--desde 2d|12h|30m]');
      process.exit(2);
    }
    desdeMs = Date.now() - dur;
  }

  const envPath = path.join(RAIZ, '.env');
  if (fs.existsSync(envPath)) carregarEnv(fs.readFileSync(envPath, 'utf8'), process.env);

  const { criarStore } = await import('../lib/store.mjs');
  const { processar } = await import('../lib/motor/index.mjs');
  const { acumularContexto } = await import('../lib/motor/contexto.mjs');
  const { enriquecer } = await import('../lib/midia/index.mjs');
  const { baixarMidiaEvolution } = await import('../lib/ingestao/midia.mjs');

  const store = criarStore(RAIZ);
  const dados = process.env.BALDE_DADOS || path.join(RAIZ, 'dados');
  let mensagens = lerMensagens(path.join(dados, 'mensagens.jsonl'));

  const g = argv.indexOf('--grupo');
  if (g !== -1) {
    if (!argv[g + 1]) {
      console.error('uso: node bin/reprocessar.mjs --grupo <nome> [--refazer]');
      process.exit(2);
    }
    const { resolverEmpresaProjeto } = await import('../lib/motor/resolver.mjs');
    const clientes = store.lerClientes();
    mensagens = filtrarGrupo(mensagens, argv[g + 1], m => resolverEmpresaProjeto(m, clientes));
  }

  if (!argv.includes('--confirmar')) {
    const alvo = desdeMs ? mensagens.filter(m => Date.parse(m.ts) >= desdeMs) : mensagens;
    const citadas = argv.includes('--refazer') ? new Set() : new Set(store.lerTarefas().flatMap(t => t.fontes ?? t.mensagensRef ?? []));
    const vao = alvo.filter(m => !citadas.has(m.id));
    await estimarCustoMotor({
      mensagens: vao.length,
      audios: vao.filter(m => m.tipo === 'audio').length,
      imagens: vao.filter(m => m.tipo === 'imagem').length,
    }, '[reprocessar] estimativa');
    console.log('[reprocessar] nada foi gravado. Para executar, repita com --confirmar');
    return;
  }

  if (g !== -1) {
    if (argv.includes('--refazer')) {
      const alvo = desdeMs ? mensagens.filter(m => Date.parse(m.ts) >= desdeMs) : mensagens;
      const apagadas = limparParaRefazer(store, alvo);
      console.log(`refazer: ${apagadas.length} tarefas apagadas para reclassificar`);
    }
  }

  const resumo = await reprocessar({
    store, mensagens, enriquecer, processar, desdeMs,
    acumular: acumularContexto,
    baixarMidia: id => baixarMidiaEvolution(id),
  });
  console.log(JSON.stringify(resumo));

  const grupos = new Map();
  for (const t of store.lerTarefas()) {
    const chave = `${t.empresa ?? '?'} · ${t.projeto ?? '?'}`;
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(t.titulo);
  }
  for (const [chave, titulos] of grupos) {
    console.log(`${chave} (${titulos.length})`);
    for (const t of titulos) console.log(`  - ${t}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch(err => { console.error(err); process.exit(1); });
}
