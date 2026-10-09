#!/usr/bin/env node
/**
 * @file grupos.mjs — achar, adicionar e criar grupos do WhatsApp pela Evolution.
 *
 *   node bin/grupos.mjs buscar <termo...>            termos separados por vírgula
 *   node bin/grupos.mjs adicionar <termo|jid> [--empresa X --projeto Y --tipo cliente|despejo --ganho 3000]
 *   node bin/grupos.mjs criar "<Nome>" [--participantes 5511..,5511..] [--descricao ...] [--adicionar ...] --sim
 *
 * buscar e adicionar só leem a Evolution. criar é ação externa: sem --sim só mostra o que faria.
 * Credenciais vêm do balde/.env (BALDE_EVOLUTION_URL/KEY/INSTANCIA) e nunca são impressas.
 */

import { parseArgs } from 'node:util';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { caminhoGruposMd } from '../lib/config.mjs';
import {
  evolutionDoAmbiente, listarGrupos, buscarGrupos, separarTermos, sugerirEmpresaProjeto,
  linhaGruposMd, adicionarAoGruposMd, empresasDoGruposMd, jidsDoGruposMd,
  normalizarParticipantes, corpoCriarGrupo, criarGrupo, linkConvite,
} from '../lib/ingestao/grupos-evolution.mjs';

const USO = `Uso:
  node bin/grupos.mjs buscar <termo>[, <termo>...]
  node bin/grupos.mjs adicionar <termo|jid> [--empresa X] [--projeto Y] [--tipo cliente|despejo] [--ganho 3000]
  node bin/grupos.mjs criar "<Nome>" [--participantes 5511..,5511..] [--descricao ...] [--adicionar] --sim`;

/** Lê balde/.env sem sobrescrever o ambiente (mesma regra do server.mjs, sem subir o motor). */
function carregarEnvLocal(envPath = fileURLToPath(new URL('../.env', import.meta.url))) {
  if (!existsSync(envPath)) return;
  for (const linha of readFileSync(envPath, 'utf8').split('\n')) {
    const t = linha.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const [k, ...v] = t.split('=');
    if (k.trim() && !Object.hasOwn(process.env, k.trim())) process.env[k.trim()] = v.join('=').trim();
  }
}

const OPCOES = {
  empresa: { type: 'string' },
  projeto: { type: 'string' },
  tipo: { type: 'string' },
  ganho: { type: 'string' },
  participantes: { type: 'string' },
  descricao: { type: 'string' },
  adicionar: { type: 'boolean' },
  sim: { type: 'boolean' },
  ajuda: { type: 'boolean', short: 'h' },
};

/** Dados da linha: sugestão do nome do grupo, sobrescrita pelas flags. */
function dadosDaLinha(grupo, flags, empresas, dica) {
  const sug = sugerirEmpresaProjeto(grupo.nome ?? '', empresas, dica);
  return {
    jid: grupo.jid,
    empresa: flags.empresa ?? sug.empresa,
    projeto: flags.projeto ?? sug.projeto,
    tipo: flags.tipo ?? 'cliente',
    ganho: flags.ganho ?? '',
  };
}

async function cmdBuscar(termos, ctx) {
  const { out } = ctx;
  if (!termos.length) throw new Error('informe ao menos um termo');
  const grupos = await listarGrupos(ctx.conexao);
  const { resultados, naoEncontrados } = buscarGrupos(grupos, termos);
  const empresas = await empresasDoGruposMd(ctx.gruposMd);
  const jaTem = await jidsDoGruposMd(ctx.gruposMd);
  for (const { termo, grupos: achados } of resultados) {
    out(`\n# "${termo}" — ${achados.length} grupo(s)`);
    for (const g of achados) {
      out(`  ${g.nome}${g.tamanho ? ` (${g.tamanho} pessoas)` : ''}${jaTem.has(g.jid) ? '  [já no GRUPOS.md]' : ''}`);
      out(`  ${linhaGruposMd(dadosDaLinha(g, {}, empresas, termo))}`);
    }
  }
  for (const termo of naoEncontrados) {
    out(`\n# "${termo}" — não encontrado: o número não está nesse grupo (ou o nome é outro).`);
  }
  return { resultados, naoEncontrados };
}

async function cmdAdicionar(termos, flags, ctx) {
  const { out } = ctx;
  const termo = termos.join(' ').trim();
  if (!termo) throw new Error('informe o termo ou o jid do grupo');
  const grupos = await listarGrupos(ctx.conexao);
  const { resultados } = buscarGrupos(grupos, [termo]);
  const achados = resultados[0]?.grupos ?? [];
  if (!achados.length) throw new Error(`"${termo}" não encontrado: o número não está nesse grupo (ou o nome é outro).`);
  if (achados.length > 1) {
    out(`"${termo}" achou ${achados.length} grupos — refine o termo ou use o jid:`);
    for (const g of achados) out(`  ${g.jid}  ${g.nome}`);
    return { adicionado: false, ambiguo: achados };
  }
  const r = await adicionarAoGruposMd(dadosDaLinha(achados[0], flags, await empresasDoGruposMd(ctx.gruposMd), termo), ctx.gruposMd);
  out(r.adicionado ? `Adicionado ao GRUPOS.md (${achados[0].nome}):` : `Já estava no GRUPOS.md (${achados[0].nome}) — nada mudou:`);
  out(`  ${r.linha}`);
  return r;
}

async function cmdCriar(termos, flags, ctx) {
  const { out } = ctx;
  const nome = termos.join(' ').trim();
  const participantes = normalizarParticipantes(flags.participantes);
  const corpo = corpoCriarGrupo({ nome, participantes, descricao: flags.descricao });
  if (!flags.sim) {
    out('Simulação (nada foi criado). Faria:');
    out(`  POST /group/create/<instância> ${JSON.stringify(corpo)}`);
    out('Rode de novo com --sim para criar de verdade.');
    return { criado: false, corpo };
  }
  const { jid } = await criarGrupo(ctx.conexao, { nome, participantes, descricao: flags.descricao });
  out(`Grupo criado: ${nome}`);
  out(`  jid: ${jid}`);
  const convite = await linkConvite(ctx.conexao, jid).catch(e => { out(`  (sem link de convite: ${e.message})`); return null; });
  if (convite) out(`  convite: ${convite}`);
  const dados = dadosDaLinha({ jid, nome }, flags, await empresasDoGruposMd(ctx.gruposMd));
  if (flags.adicionar) {
    const r = await adicionarAoGruposMd(dados, ctx.gruposMd);
    out(r.adicionado ? 'Adicionado ao GRUPOS.md:' : 'Já estava no GRUPOS.md:');
    out(`  ${r.linha}`);
  } else {
    out('Linha para o GRUPOS.md (ou rode com --adicionar):');
    out(`  ${linhaGruposMd(dados)}`);
  }
  return { criado: true, jid, convite };
}

/**
 * Ponto de entrada testável.
 * @param {string[]} argv
 * @param {{ fetch?: typeof fetch, env?: object, gruposMd?: string, out?: (s: string) => void }} [deps]
 */
export async function main(argv, deps = {}) {
  const out = deps.out ?? (s => console.log(s));
  const { values: flags, positionals } = parseArgs({ args: argv, options: OPCOES, allowPositionals: true, strict: true });
  const [cmd, ...termos] = positionals;
  if (!cmd || flags.ajuda) { out(USO); return null; }

  const ctx = {
    out,
    gruposMd: deps.gruposMd ?? caminhoGruposMd(),
    get conexao() { return { ...evolutionDoAmbiente(deps.env ?? process.env), fetch: deps.fetch }; },
  };
  if (cmd === 'buscar') return cmdBuscar(separarTermos(termos), ctx);
  if (cmd === 'adicionar') return cmdAdicionar(termos, flags, ctx);
  if (cmd === 'criar') return cmdCriar(termos, flags, ctx);
  throw new Error(`comando desconhecido "${cmd}"\n${USO}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  carregarEnvLocal();
  main(process.argv.slice(2)).catch(err => {
    console.error('Erro:', err.message);
    process.exit(1);
  });
}
