#!/usr/bin/env node
/**
 * @file ler.mjs — Leitura manual dos grupos, pelo terminal (GB-44).
 *
 *   node bin/ler.mjs [--grupo <termo>]...        lê agora (todos ou os filtrados)
 *   node bin/ler.mjs --uso [--desde AAAA-MM-DD] [--ate AAAA-MM-DD]
 *   node bin/ler.mjs --estimar [--grupos 7] [--mensagens 20] [--audios 3] [--minutos 1]
 *
 * Mesma leitura do botão "Ler agora" (lib/leitura.mjs): só o que passou do cursor,
 * uma chamada de LLM por grupo com novidade, teto diário BALDE_LLM_LIMITE_DIA_USD.
 * Carrega balde/.env sem sobrescrever o ambiente. Nunca imprime conteúdo de
 * mensagem nem segredo — só contagens, custo e avisos.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { carregarEnv } from './diagnostico.mjs';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function argumento(argv, nome) {
  const i = argv.indexOf(nome);
  return i === -1 ? undefined : argv[i + 1];
}
const todos = (argv, nome) => argv.flatMap((a, i) => (a === nome && argv[i + 1] ? [argv[i + 1]] : []));
const usd = n => `US$ ${Number(n).toFixed(4)}`;

/** Texto da estimativa (também usado por backfill/reprocessar). */
export function linhasEstimativa(e, rotulo) {
  return [
    `${rotulo}: ${usd(e.totalUSD)} estimado`,
    `  LLM ${e.modelo}: ~${e.tokensIn} tokens de entrada + ~${e.tokensOut} de saída = ${usd(e.llmUSD)}${e.precoConhecido ? '' : ' (modelo fora da tabela: preço conservador)'}`,
    `  áudio ${e.modeloTranscricao}: ${usd(e.audioUSD)}`,
    '  Preços da tabela configurável (PRECOS_PADRAO / BALDE_LLM_PRECOS em lib/llm.mjs) — confira na página do provedor.',
  ];
}

async function main(argv) {
  const envPath = path.join(RAIZ, '.env');
  if (fs.existsSync(envPath)) carregarEnv(fs.readFileSync(envPath, 'utf8'), process.env);
  const { lerAgora, resumoUso, estimarCusto } = await import('../lib/leitura.mjs');

  if (argv.includes('--uso')) {
    const r = resumoUso({ desde: argumento(argv, '--desde'), ate: argumento(argv, '--ate') });
    console.log(`Total: ${usd(r.total.custoUSD)} em ${r.total.chamadas} chamada(s), ${r.total.segundosAudio}s de áudio`);
    for (const [dia, v] of Object.entries(r.porDia)) console.log(`  ${dia}: ${usd(v.custoUSD)} (${v.chamadas})`);
    console.log('Por empresa · projeto:');
    for (const [k, v] of Object.entries(r.porEmpresaProjeto)) console.log(`  ${k}: ${usd(v.custoUSD)} (${v.chamadas})`);
    console.log('Por leitura:');
    for (const [k, v] of Object.entries(r.porLeitura)) console.log(`  ${k}${v.inicio ? ` ${v.inicio}` : ''}: ${usd(v.custoUSD)} (${v.chamadas})`);
    return;
  }

  if (argv.includes('--estimar')) {
    const grupos = Number(argumento(argv, '--grupos') ?? 7);
    const mensagens = Number(argumento(argv, '--mensagens') ?? 20);
    const minutosAudio = Number(argumento(argv, '--audios') ?? 3) * Number(argumento(argv, '--minutos') ?? 1);
    const e = estimarCusto({ chamadas: grupos, mensagens, tarefas: 20, minutosAudio });
    for (const l of linhasEstimativa(e, `Leitura com ${grupos} grupo(s), ${mensagens} mensagem(ns), ${minutosAudio} min de áudio`)) console.log(l);
    return;
  }

  const r = await lerAgora({ grupos: todos(argv, '--grupo') });
  for (const g of r.grupos) {
    const extra = [g.iniciado && 'começa agora', g.bloqueado && 'teto atingido', g.heuristica && 'heurística', g.erro && `erro: ${g.erro}`].filter(Boolean).join(', ');
    console.log(`  ${g.empresa} · ${g.projeto}: ${g.novas} nova(s), ${g.chamadas} chamada(s), ${g.audios} áudio(s), ${g.tarefasNovas} tarefa(s) nova(s), ${g.atualizadas} atualização(ões), ${g.pendentes} pendente(s), ${usd(g.custoUSD)}${extra ? ` — ${extra}` : ''}`);
  }
  console.log(`Leitura ${r.leituraId}: ${r.chamadas} chamada(s), ${usd(r.custoUSD)}`);
  for (const a of r.avisos) console.log(`AVISO: ${a}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch(err => { console.error(err.message); process.exit(1); });
}
