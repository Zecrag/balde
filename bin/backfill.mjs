#!/usr/bin/env node
/**
 * @file backfill.mjs — Puxa da Evolution o histórico que o balde não viu.
 *
 *   node bin/backfill.mjs [--dias 30] [--grupo <termo>] [--teto 3000] [--simular] [--confirmar]
 *
 * Sem --confirmar (GB-44) só mostra o plano e a estimativa de custo e não grava nada:
 * o backfill passa CADA mensagem pelo motor (uma chamada de LLM por mensagem).
 *
 * Para cada grupo do GRUPOS.md (config/grupos.json), pagina /chat/findMessages
 * até N dias atrás e separa as mensagens que ainda não estão em dados/mensagens.jsonl.
 * O histórico que o WhatsApp compartilha quando o número entra no grupo
 * (messageHistoryBundle) é decifrado por lib/ingestao/historico-grupo.mjs e entra junto.
 * Mostra o plano (mensagens, áudios, imagens, PDFs por grupo) e segue:
 *   - normaliza cada uma (a mídia vem decifrada pelo getBase64FromMediaMessage);
 *   - remonta a linha do tempo do grupo (já vistas + novas, em ordem cronológica)
 *     com a janela de contexto zerada, para o motor ler a conversa na ordem real;
 *   - nova → enriquecer (áudio→transcrição, imagem, PDF) → processar(), que aplica
 *     dedup e o merge conservador; já vista → só entra na janela de contexto;
 *   - a nova só é gravada no JSONL depois de processada: se cair no meio, rodar de
 *     novo retoma do que faltou;
 *   - o cursor do grupo avança (nunca recua) para o catch-up não repetir nada.
 *
 * Só leitura na Evolution. Carrega balde/.env sem sobrescrever o ambiente.
 * Nunca imprime conteúdo de mensagem nem segredo — só contagens e títulos de tarefa.
 * Rode com o serviço pausado (kill -STOP) para não disputar tarefas.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { carregarEnv } from './diagnostico.mjs';
import { lerMensagens } from './reprocessar.mjs';
import { tsSegundos, lerCursor, gravarCursor, avancarCursor } from '../lib/ingestao/evolution-cursor.mjs';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_PAGINAS = 400; // por grupo (50 por página = 20 mil mensagens)

/** Tipo de mídia do registro cru da Evolution (para o plano de custo). */
export function tipoMidia(r) {
  const m = r?.message ?? {};
  if (m.audioMessage || r?.messageType === 'audioMessage') return 'audio';
  if (m.imageMessage || r?.messageType === 'imageMessage') return 'imagem';
  const doc = m.documentMessage;
  if (doc && (/pdf/i.test(doc.mimetype ?? '') || /\.pdf$/i.test(doc.fileName ?? ''))) return 'pdf';
  return null;
}

/** Grupos do GRUPOS.md filtrados por termo (empresa, projeto ou jid, sem acento/caixa). */
export function filtrarGrupos(grupos, termo) {
  if (!termo) return grupos;
  const n = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const alvo = n(termo);
  return grupos.filter(g => [g.empresa, g.projeto, g.jid].some(c => n(c).includes(alvo)));
}

/**
 * Registros do grupo na janela [piso, agora], sem repetição, do mais antigo ao mais novo.
 * Anexo de histórico (messageHistoryBundle, ao entrar no grupo) é aberto por `expandir`
 * e as mensagens de dentro entram na janela como as outras.
 * @param {(jid: string, page: number) => Promise<{records: Object[], pages: number}>} buscarPagina
 * @param {(r: Object) => Promise<Object[]>} [expandir]
 */
export async function coletarJanela(buscarPagina, jid, piso, expandir) {
  const porId = new Map();
  const anexos = [];
  for (let page = 1; page <= MAX_PAGINAS; page++) {
    const { records, pages } = await buscarPagina(jid, page);
    let passouDoPiso = false;
    for (const r of records) {
      const ts = tsSegundos(r.messageTimestamp);
      const id = r.key?.id;
      if (ts === null || !id || r.key?.remoteJid !== jid) continue;
      if (r.message?.messageHistoryBundle) anexos.push(r);
      if (ts < piso) { passouDoPiso = true; continue; }
      if (!porId.has(id)) porId.set(id, { r, ts, id });
    }
    if (passouDoPiso || records.length === 0 || page >= pages) break;
  }
  for (const anexo of expandir ? anexos : []) {
    for (const r of await expandir(anexo)) {
      const ts = tsSegundos(r.messageTimestamp);
      const id = r.key?.id;
      if (ts !== null && id && ts >= piso && r.key.remoteJid === jid && !porId.has(id)) porId.set(id, { r, ts, id });
    }
  }
  return [...porId.values()].sort((a, b) => a.ts - b.ts);
}

/**
 * @param {Object} p
 * @param {Array<{jid: string, empresa?: string, projeto?: string}>} p.grupos
 * @param {(jid: string, page: number) => Promise<{records: Object[], pages: number}>} p.buscarPagina
 * @param {(r: Object) => Promise<Object|null>} p.normalizar  — registro cru → Mensagem (baixa a mídia)
 * @param {(r: Object) => Promise<Object[]>} [p.expandir]     — abre anexo de histórico do grupo
 * @param {ReturnType<import('../lib/store.mjs').criarStore>} p.store
 * @param {string} p.mensagensPath
 * @param {string} p.cursorPath
 * @param {(m: Object) => Promise<Object>} p.enriquecer
 * @param {(m: Object, store: Object) => Promise<{novas: Object[], atualizadas: Object[]}>} p.processar
 * @param {(store: Object, m: Object) => void} p.acumular  — só janela de contexto
 * @param {number} [p.dias=30]
 * @param {number} [p.teto=3000]   — máximo de mensagens novas no total (as mais antigas ficam de fora)
 * @param {boolean} [p.simular]    — só o plano, não grava nada
 * @param {number} [p.agoraMs]
 * @param {(linha: string) => void} [p.log]
 */
export async function backfill({
  grupos, buscarPagina, normalizar, expandir, store, mensagensPath, cursorPath,
  enriquecer, processar, acumular, dias = 30, teto = 3000, simular = false,
  agoraMs = Date.now(), log = console.log,
}) {
  const piso = Math.floor(agoraMs / 1000) - Math.round(dias * 86400);
  const existentes = lerMensagens(mensagensPath);
  const vistas = new Set(existentes.map(m => m.id));

  // 1. Plano: o que falta em cada grupo
  const planos = [];
  for (const g of grupos) {
    const nome = `${g.empresa ?? '?'} · ${g.projeto ?? '?'}`;
    let janela;
    try {
      janela = await coletarJanela(buscarPagina, g.jid, piso, expandir);
    } catch (err) {
      log(`[backfill] ${nome}: falha ao listar mensagens (${err.message}) — grupo pulado`);
      planos.push({ g, nome, faltam: [], erro: err.message });
      continue;
    }
    const faltam = janela.filter(x => !vistas.has(x.id));
    planos.push({ g, nome, janela: janela.length, faltam });
  }

  const total = planos.reduce((s, p) => s + p.faltam.length, 0);
  if (total > teto) {
    // Corta as mais antigas de cada grupo, proporcionalmente, até caber no teto
    let sobra = total - teto;
    for (const p of [...planos].sort((a, b) => b.faltam.length - a.faltam.length)) {
      const corte = Math.min(sobra, Math.ceil(p.faltam.length * (total - teto) / total));
      p.cortadas = corte;
      p.faltam = p.faltam.slice(corte);
      sobra -= corte;
      if (sobra <= 0) break;
    }
    log(`[backfill] teto de ${teto} mensagens: ${total - teto} das mais antigas ficam de fora`);
  }

  const contar = lista => lista.reduce((c, x) => { const t = tipoMidia(x.r); if (t) c[t]++; return c; }, { audio: 0, imagem: 0, pdf: 0 });
  log(`[backfill] plano — últimos ${dias} dias, ${grupos.length} grupo(s):`);
  for (const p of planos) {
    const c = contar(p.faltam);
    p.midia = c;
    log(`  ${p.nome}: ${p.faltam.length} nova(s) de ${p.janela ?? 0} na janela · ${c.audio} áudio(s), ${c.imagem} imagem(ns), ${c.pdf} PDF(s)${p.cortadas ? ` · ${p.cortadas} cortada(s) pelo teto` : ''}`);
  }
  const totMidia = contar(planos.flatMap(p => p.faltam));
  log(`[backfill] total: ${planos.reduce((s, p) => s + p.faltam.length, 0)} mensagem(ns), ${totMidia.audio} áudio(s) para transcrever, ${totMidia.imagem} imagem(ns), ${totMidia.pdf} PDF(s)`);

  const resumo = { grupos: [], novas: 0, atualizadas: 0, erros: 0 };
  if (simular) {
    resumo.grupos = planos.map(p => ({ nome: p.nome, mensagens: p.faltam.length, audios: p.midia.audio, imagens: p.midia.imagem, processadas: 0 }));
    return resumo;
  }

  const cursor = await lerCursor(cursorPath);

  // 2. Execução, grupo a grupo, na ordem real da conversa
  for (const p of planos) {
    const r = { nome: p.nome, mensagens: p.faltam.length, audios: p.midia.audio, processadas: 0, novas: 0, atualizadas: 0, erros: 0 };
    resumo.grupos.push(r);
    if (!p.faltam.length) continue;

    const novas = [];
    for (const x of p.faltam) {
      try {
        const m = await normalizar(x.r);
        if (m?.id && m.chatId === p.g.jid) novas.push({ m, ts: x.ts, id: x.id });
      } catch (err) {
        r.erros++;
        log(`[backfill] ${p.nome}: falha ao normalizar ${x.id}: ${err.message}`);
      }
    }
    const idsNovos = new Set(novas.map(n => n.m.id));
    const linha = [
      ...existentes.filter(m => m.chatId === p.g.jid && !idsNovos.has(m.id)).map(m => ({ m, nova: false })),
      ...novas.map(n => ({ m: n.m, nova: true, ts: n.ts, id: n.id })),
    ].sort((a, b) => String(a.m.ts ?? '').localeCompare(String(b.m.ts ?? '')));

    // Janela de contexto do grupo é remontada do zero na ordem certa
    const ctx = store.lerContexto(p.g.jid);
    if (ctx) store.salvarContexto({ ...ctx, mensagens: [] });

    const jaCitadas = () => new Set(store.lerTarefas().flatMap(t => t.fontes ?? t.mensagensRef ?? []));
    let feitas = 0;
    for (const item of linha) {
      let msg = item.m;
      try {
        msg = (await enriquecer(msg)) ?? msg;
        if (!item.nova || jaCitadas().has(msg.id)) {
          acumular(store, msg);
        } else {
          const res = await processar(msg, store);
          r.processadas++;
          r.novas += res?.novas?.length ?? 0;
          r.atualizadas += res?.atualizadas?.length ?? 0;
        }
      } catch (err) {
        r.erros++;
        log(`[backfill] ${p.nome}: ${item.m.id}: ${err.message}`);
      }
      if (item.nova) {
        // Grava depois de processar: se o backfill cair, a próxima rodada retoma daqui
        fs.appendFileSync(mensagensPath, JSON.stringify(item.m) + '\n', 'utf8');
        avancarCursor(cursor, p.g.jid, item.ts, item.id);
        await gravarCursor(cursorPath, cursor);
        feitas++;
        if (feitas % 10 === 0 || feitas === novas.length) {
          log(`[backfill] ${p.nome}: ${feitas}/${novas.length} · ${r.novas} tarefa(s) nova(s), ${r.atualizadas} atualização(ões)`);
        }
      }
    }
    resumo.novas += r.novas;
    resumo.atualizadas += r.atualizadas;
    resumo.erros += r.erros;
  }
  return resumo;
}

function argumento(argv, nome) {
  const i = argv.indexOf(nome);
  return i === -1 ? undefined : argv[i + 1];
}

async function main(argv) {
  const dias = Number(argumento(argv, '--dias') ?? 30);
  const teto = Number(argumento(argv, '--teto') ?? 3000);
  if (!(dias > 0) || !(teto > 0)) {
    console.error('uso: node bin/backfill.mjs [--dias 30] [--grupo <termo>] [--teto 3000] [--simular]');
    process.exit(2);
  }

  const envPath = path.join(RAIZ, '.env');
  if (fs.existsSync(envPath)) carregarEnv(fs.readFileSync(envPath, 'utf8'), process.env);
  const url = String(process.env.BALDE_EVOLUTION_URL ?? '').replace(/\/+$/, '');
  const key = process.env.BALDE_EVOLUTION_KEY;
  const inst = process.env.BALDE_EVOLUTION_INSTANCIA;
  if (!url || !key || !inst) {
    console.error('[backfill] BALDE_EVOLUTION_URL/KEY/INSTANCIA ausentes no .env');
    process.exit(2);
  }

  const { criarStore } = await import('../lib/store.mjs');
  const { processar } = await import('../lib/motor/index.mjs');
  const { acumularContexto } = await import('../lib/motor/contexto.mjs');
  const { enriquecer } = await import('../lib/midia/index.mjs');
  const { normalizar } = await import('../lib/ingestao/normalizar.mjs');
  const { buscarPagina } = await import('../lib/ingestao/evolution.mjs');
  const { carregarGruposAutorizados } = await import('../lib/ingestao/autorizacao.mjs');
  const { expandirHistorico, prepararMidiaHistorico } = await import('../lib/ingestao/historico-grupo.mjs');

  const store = criarStore(RAIZ);
  const dados = process.env.BALDE_DADOS || path.join(RAIZ, 'dados');
  const grupos = filtrarGrupos(await carregarGruposAutorizados(), argumento(argv, '--grupo'));
  if (!grupos.length) {
    console.error('[backfill] nenhum grupo do GRUPOS.md casa com o filtro');
    process.exit(2);
  }

  const confirmado = argv.includes('--confirmar');
  const resumo = await backfill({
    grupos, dias, teto, simular: argv.includes('--simular') || !confirmado, store,
    buscarPagina: (jid, page) => buscarPagina(url, key, inst, jid, page),
    normalizar: async r => normalizar({ data: await prepararMidiaHistorico(r) }, 'evolution', { midiaDir: path.join(dados, 'midia') }),
    expandir: async r => {
      try { return await expandirHistorico(r); } catch (err) { console.warn(`[backfill] histórico do grupo ilegível: ${err.message}`); return []; }
    },
    mensagensPath: path.join(dados, 'mensagens.jsonl'),
    cursorPath: path.join(dados, 'evolution-cursor.json'),
    enriquecer, processar, acumular: acumularContexto,
  });
  if (!confirmado) {
    const { estimarCustoMotor } = await import('./reprocessar.mjs');
    const soma = k => resumo.grupos.reduce((s, g) => s + (g[k] ?? 0), 0);
    estimarCustoMotor({ mensagens: soma('mensagens'), audios: soma('audios'), imagens: soma('imagens') }, '[backfill] estimativa');
    console.log('[backfill] nada foi gravado. Para executar: node bin/backfill.mjs ... --confirmar');
    return;
  }
  console.log(JSON.stringify({ novas: resumo.novas, atualizadas: resumo.atualizadas, erros: resumo.erros }));
  for (const g of resumo.grupos) console.log(`  ${g.nome}: ${g.processadas}/${g.mensagens} processada(s), ${g.audios} áudio(s)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch(err => { console.error(err); process.exit(1); });
}
