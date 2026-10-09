#!/usr/bin/env node
/**
 * @file corrigir-dados.mjs — Corrige tarefas gravadas sem dono real (GB-35).
 *
 *   node bin/corrigir-dados.mjs [--simular]
 *
 * Antes do GB-35 a tarefa nova sem responsável do LLM caía no padrão de
 * criarTarefa ('ia'). Aqui: responsavel 'ia' (ou ausente) → 'cliente' se a tarefa
 * está aguardando_info, senão 'eu'. --simular só conta, não grava.
 *
 * GB-36b: tarefa em empresa · projeto que não existe no GRUPOS.md (ex.: "5OX",
 * "Kç", cliente citado no despejo) é reclassificada pelo próprio conteúdo para um
 * projeto conhecido, o administrativo ou o destino sem pista do dono (.env); o nome antigo
 * fica em clienteSugerido quando parece nome de verdade. sugerirCriar sai.
 * Nunca imprime conteúdo de mensagem — só contagens por empresa · projeto.
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ESTADOS } from '../lib/tipos.mjs';
import { criarStore } from '../lib/store.mjs';
import { rotearDespejo, pareceNome, destinosDono } from '../lib/motor/despejo.mjs';
import * as config from '../lib/config.mjs';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const RESPONSAVEIS = new Set(['eu', 'cliente']);

/**
 * @param {Object[]} tarefas
 * @returns {{ tarefas: Object[], trocas: { id: string, empresa: string, projeto: string, de: string|null, para: string }[] }}
 */
export function corrigirResponsaveis(tarefas) {
  const trocas = [];
  const corrigidas = tarefas.map(t => {
    if (RESPONSAVEIS.has(t.responsavel)) return t;
    const para = t.estado === ESTADOS.AGUARDANDO_INFO ? 'cliente' : 'eu';
    trocas.push({ id: t.id, empresa: t.empresa ?? '?', projeto: t.projeto ?? '?', de: t.responsavel ?? null, para });
    return { ...t, responsavel: para };
  });
  return { tarefas: corrigidas, trocas };
}

const chave = (empresa, projeto) => `${empresa ?? '?'}\u0000${projeto ?? '?'}`.toLowerCase();

/**
 * @param {Object[]} tarefas
 * @param {{ empresa: string, projeto: string, tipo?: string }[]} projetos — listarProjetos()
 */
export function reclassificarDesconhecidas(tarefas, projetos) {
  const { administrativo, pessoal } = destinosDono();
  const conhecidas = new Set([...projetos.map(p => chave(p.empresa, p.projeto)),
    chave(administrativo.empresa, administrativo.projeto), chave(pessoal.empresa, pessoal.projeto)]);
  const trocas = [];
  const corrigidas = tarefas.map(t => {
    const { sugerirCriar, ...limpa } = t;
    if (conhecidas.has(chave(t.empresa, t.projeto))) return sugerirCriar === undefined ? t : limpa;
    const texto = `${t.titulo ?? ''}\n${t.descricao ?? ''}`;
    const { destino } = rotearDespejo({ texto, ts: t.criadaEm }, null, projetos);
    const sugerido = destino.clienteSugerido ?? (pareceNome(t.empresa) ? t.empresa : undefined);
    trocas.push({ id: t.id, empresa: t.empresa ?? '?', projeto: t.projeto ?? '?', para: `${destino.empresa} · ${destino.projeto}` });
    return { ...limpa, empresa: destino.empresa, projeto: destino.projeto,
      ...(sugerido && !limpa.clienteSugerido ? { clienteSugerido: sugerido } : {}) };
  });
  return { tarefas: corrigidas, trocas };
}

function main(argv) {
  const simular = argv.includes('--simular');
  const store = criarStore(RAIZ);
  const resp = corrigirResponsaveis(store.lerTarefas());
  const projetos = config.listarProjetos?.() ?? [];
  const recl = reclassificarDesconhecidas(resp.tarefas, projetos);
  const { tarefas } = recl;
  const trocas = resp.trocas;
  if (!simular && (trocas.length || recl.trocas.length || JSON.stringify(tarefas) !== JSON.stringify(resp.tarefas))) {
    store.salvarTarefas(tarefas);
  }
  console.log(`${simular ? '[simulação] ' : ''}${recl.trocas.length} tarefas em empresa/projeto desconhecido ${simular ? 'seriam reclassificadas' : 'reclassificadas'}`);
  const porDestino = new Map();
  for (const t of recl.trocas) {
    const k = `${t.empresa} · ${t.projeto} → ${t.para}`;
    porDestino.set(k, (porDestino.get(k) ?? 0) + 1);
  }
  for (const [k, n] of porDestino) console.log(`  ${k}: ${n}`);

  const porGrupo = new Map();
  for (const t of trocas) {
    const k = `${t.empresa} · ${t.projeto} → ${t.para}`;
    porGrupo.set(k, (porGrupo.get(k) ?? 0) + 1);
  }
  console.log(`${simular ? '[simulação] ' : ''}${trocas.length} de ${tarefas.length} tarefas ${simular ? 'seriam corrigidas' : 'corrigidas'}`);
  for (const [k, n] of porGrupo) console.log(`  ${k}: ${n}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2));
