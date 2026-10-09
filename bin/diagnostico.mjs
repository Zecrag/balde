#!/usr/bin/env node
/**
 * @file diagnostico.mjs — Checklist ✅/❌ do Balde, somente leitura.
 *
 *   node bin/diagnostico.mjs
 *
 * Carrega balde/.env (sem sobrescrever o ambiente) e verifica:
 *   1. Node >= 20
 *   2. Evolution configurada e instância conectada (GET /instance/connectionState/<inst>)
 *   3. GRUPOS.md: linhas válidas e cada convite → jid (GET /group/inviteInfo/<inst>)
 *   4. LLM: provedor + key presentes e uma chamada mínima responde
 *   5. Servidor do balde em 127.0.0.1:<BALDE_PORT|7391>/api/tarefas
 *   6. Serviço launchd com.desenvolvedor.balde carregado
 *   7. Webhook da instância (GET /webhook/find/<inst>) aponta para BALDE_WEBHOOK_ESPERADO (se configurado)
 *
 * Nunca imprime valor de segredo: toda a saída passa por mascarar().
 * Nunca altera nada: na Evolution só há GET; o único POST é o teste mínimo do LLM.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { configLLM } from '../lib/llm.mjs';
import { parseGruposMd } from '../lib/config.mjs';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LABEL = 'com.desenvolvedor.balde';

const TIMEOUT_MS = 10_000;

/** Lê KEY=valor de um .env; não sobrescreve o que já existe em `env`. */
export function carregarEnv(texto, env = {}) {
  for (const bruta of String(texto ?? '').split(/\r?\n/)) {
    const linha = bruta.trim();
    if (!linha || linha.startsWith('#')) continue;
    const [k, ...v] = linha.split('=');
    const chave = k.trim();
    if (chave && env[chave] === undefined) env[chave] = v.join('=').trim();
  }
  return env;
}

/** Valores que nunca podem aparecer na saída. */
export function segredosDe(env) {
  return Object.entries(env)
    .filter(([k, v]) => /KEY|TOKEN|SECRET|SENHA|PASSWORD/i.test(k) && typeof v === 'string' && v.length >= 4)
    .map(([, v]) => v);
}

export function mascarar(texto, segredos) {
  let s = String(texto);
  for (const seg of segredos) s = s.split(seg).join('***');
  return s;
}

const hostDe = (url) => { try { return new URL(url).host; } catch { return '(url inválida)'; } };

async function getJson(fetchFn, url, headers = {}) {
  const res = await fetchFn(url, { method: 'GET', headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  let data = null;
  try { data = await res.json(); } catch { /* corpo não-JSON */ }
  return { ok: res.ok, status: res.status, data };
}

const item = (ok, titulo, detalhes = []) => ({ ok, titulo, detalhes });

// ─── Checagens ───────────────────────────────────────────────────────────────

function checarNode(versao) {
  const maior = Number(String(versao).replace(/^v/, '').split('.')[0]);
  return item(maior >= 20, `Node ${versao} (precisa >= 20)`);
}

function evolutionDe(env) {
  const url = env.BALDE_EVOLUTION_URL?.replace(/\/+$/, '');
  const key = env.BALDE_EVOLUTION_KEY;
  const inst = env.BALDE_EVOLUTION_INSTANCIA;
  return url && key && inst ? { url, key, inst } : null;
}

async function checarEvolution(env, fetchFn) {
  const faltam = ['BALDE_EVOLUTION_URL', 'BALDE_EVOLUTION_KEY', 'BALDE_EVOLUTION_INSTANCIA'].filter(k => !env[k]);
  if (faltam.length) return item(false, 'Evolution', [`.env sem ${faltam.join(', ')}`]);
  const evo = evolutionDe(env);
  const titulo = `Evolution ${hostDe(evo.url)} · instância ${evo.inst}`;
  try {
    const r = await getJson(fetchFn, `${evo.url}/instance/connectionState/${encodeURIComponent(evo.inst)}`, { apikey: evo.key });
    if (!r.ok) return item(false, titulo, [`HTTP ${r.status}`]);
    const estado = r.data?.instance?.state ?? r.data?.state ?? 'desconhecido';
    return item(estado === 'open', titulo, [`estado: ${estado}`]);
  } catch (e) {
    return item(false, titulo, [`sem resposta: ${e.message}`]);
  }
}

async function checarGrupos(env, fetchFn, mdPath, lerArquivo) {
  let texto;
  try { texto = lerArquivo(mdPath); } catch {
    return item(false, 'GRUPOS.md', [`não encontrado em ${mdPath} (copie de GRUPOS.exemplo.md)`]);
  }
  const { linhas, avisos } = parseGruposMd(texto);
  const detalhes = [...avisos.map(a => `aviso: ${a}`)];
  let ok = linhas.length > 0;
  const evo = evolutionDe(env);
  for (const l of linhas) {
    const rotulo = l.tipo === 'despejo' ? `(despejo)` : `${l.empresa} · ${l.projeto}`;
    if (l.jid) { detalhes.push(`✅ ${rotulo} → ${l.jid} (jid direto)`); continue; }
    if (!l.inviteCode) { detalhes.push(`➖ ${rotulo} → sem grupo (não é lido)`); continue; }
    if (!evo) { ok = false; detalhes.push(`❌ ${rotulo} → convite não verificado (Evolution não configurada)`); continue; }
    try {
      const r = await getJson(fetchFn,
        `${evo.url}/group/inviteInfo/${encodeURIComponent(evo.inst)}?inviteCode=${encodeURIComponent(l.inviteCode)}`,
        { apikey: evo.key });
      const jid = r.data?.id;
      if (r.ok && String(jid ?? '').endsWith('@g.us')) {
        detalhes.push(`✅ ${rotulo} → "${r.data.subject ?? '(sem nome)'}" ${jid}`);
      } else {
        ok = false;
        detalhes.push(`❌ ${rotulo} → convite não resolveu (HTTP ${r.status})`);
      }
    } catch (e) {
      ok = false;
      detalhes.push(`❌ ${rotulo} → sem resposta: ${e.message}`);
    }
  }
  return item(ok, `GRUPOS.md: ${linhas.length} linha(s) válida(s)${avisos.length ? `, ${avisos.length} aviso(s)` : ''}`, detalhes);
}

/** Pedido mínimo por provedor: "responda ok", no máximo 5 tokens. */
function pedidoMinimo(cfg) {
  const prompt = 'responda ok';
  if (cfg.provedor === 'openai') {
    return {
      url: 'https://api.openai.com/v1/chat/completions',
      headers: { authorization: `Bearer ${cfg.key}`, 'content-type': 'application/json' },
      body: { model: cfg.modelo, messages: [{ role: 'user', content: prompt }], max_completion_tokens: 5 },
    };
  }
  if (cfg.provedor === 'anthropic') {
    return {
      url: 'https://api.anthropic.com/v1/messages',
      headers: { 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: { model: cfg.modelo, max_tokens: 5, messages: [{ role: 'user', content: prompt }] },
    };
  }
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.modelo)}:generateContent`,
    headers: { 'x-goog-api-key': cfg.key, 'content-type': 'application/json' },
    body: { contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 5 } },
  };
}

async function checarLLM(env, fetchFn) {
  const cfg = configLLM(env);
  if (!cfg) {
    const escolhido = env.BALDE_LLM?.trim() || '(não definido)';
    return item(false, 'LLM', [`BALDE_LLM=${escolhido} sem key do provedor — motor roda só na heurística`]);
  }
  const titulo = `LLM ${cfg.provedor} · modelo ${cfg.modelo}`;
  const p = pedidoMinimo(cfg);
  try {
    const res = await fetchFn(p.url, {
      method: 'POST', headers: p.headers, body: JSON.stringify(p.body), signal: AbortSignal.timeout(TIMEOUT_MS * 3),
    });
    if (res.ok) return item(true, titulo, ['chamada de teste: ok']);
    let msg = '';
    try { msg = (await res.json())?.error?.message ?? ''; } catch { /* sem corpo */ }
    return item(false, titulo, [`chamada de teste: erro HTTP ${res.status}${msg ? ` — ${msg.slice(0, 160)}` : ''}`]);
  } catch (e) {
    return item(false, titulo, [`chamada de teste: erro — ${e.message}`]);
  }
}

async function checarServidor(env, fetchFn) {
  const porta = Number(env.BALDE_PORT) || 7391;
  const url = `http://127.0.0.1:${porta}/api/tarefas`;
  try {
    const r = await getJson(fetchFn, url);
    return item(r.ok, `Servidor do balde em 127.0.0.1:${porta}`, [r.ok ? '/api/tarefas respondeu' : `/api/tarefas HTTP ${r.status}`]);
  } catch (e) {
    return item(false, `Servidor do balde em 127.0.0.1:${porta}`, [`não respondeu (${e.cause?.code ?? e.message})`]);
  }
}

function checarLaunchd(launchctl, plataforma, uid) {
  if (plataforma !== 'darwin') return item(false, `Serviço launchd ${LABEL}`, ['não é macOS']);
  const r = launchctl(['print', `gui/${uid}/${LABEL}`]);
  if (r.status !== 0) return item(false, `Serviço launchd ${LABEL}`, ['não carregado (node bin/servico.mjs instalar)']);
  const estado = String(r.stdout ?? '').match(/^\s*state = (.+)$/m)?.[1]?.trim();
  const pid = String(r.stdout ?? '').match(/^\s*pid = (\d+)$/m)?.[1];
  return item(true, `Serviço launchd ${LABEL}`, [`carregado${estado ? ` · ${estado}` : ''}${pid ? ` · pid ${pid}` : ''}`]);
}

async function checarWebhook(env, fetchFn) {
  const evo = evolutionDe(env);
  const esperado = env.BALDE_WEBHOOK_ESPERADO?.trim();
  const titulo = esperado
    ? `Webhook da instância → ${esperado}`
    : `Webhook da instância`;
  if (!evo) return item(false, titulo, ['Evolution não configurada']);
  try {
    const r = await getJson(fetchFn, `${evo.url}/webhook/find/${encodeURIComponent(evo.inst)}`, { apikey: evo.key });
    if (!r.ok) return item(false, titulo, [`HTTP ${r.status}`]);
    const alvo = r.data?.webhook?.url ?? r.data?.url;
    if (!alvo) return item(false, titulo, ['instância sem webhook configurado']);
    const host = hostDe(alvo);
    const ativo = r.data?.webhook?.enabled ?? r.data?.enabled;
    if (!esperado) {
      return item(true, titulo, [`aponta para ${host}${ativo === false ? ' (desativado)' : ''}`, 'somente leitura: nada foi alterado']);
    }
    const ok = host === esperado || host.endsWith(`.${esperado}`);
    return item(ok, titulo, [`aponta para ${host}${ativo === false ? ' (desativado)' : ''}${ok ? '' : ' — mudou!'}`, 'somente leitura: nada foi alterado']);
  } catch (e) {
    return item(false, titulo, [`sem resposta: ${e.message}`]);
  }
}

// ─── Orquestração ────────────────────────────────────────────────────────────

/**
 * Roda o checklist inteiro. Tudo injetável para teste (nenhuma rede real).
 * @returns {Promise<{ ok: boolean, titulo: string, detalhes: string[] }[]>}
 */
export async function diagnosticar(opts = {}) {
  const env = opts.env ?? process.env;
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const lerArquivo = opts.lerArquivo ?? (p => fs.readFileSync(p, 'utf8'));
  const launchctl = opts.launchctl ?? (args => spawnSync('/bin/launchctl', args, { encoding: 'utf8' }));
  const mdPath = opts.mdPath ?? path.resolve(env.BALDE_GRUPOS_MD || path.join(RAIZ, 'GRUPOS.md'));

  return [
    checarNode(opts.versaoNode ?? process.version),
    await checarEvolution(env, fetchFn),
    await checarGrupos(env, fetchFn, mdPath, lerArquivo),
    await checarLLM(env, fetchFn),
    await checarServidor(env, fetchFn),
    checarLaunchd(launchctl, opts.plataforma ?? process.platform, opts.uid ?? process.getuid?.()),
    await checarWebhook(env, fetchFn),
  ];
}

/** Texto final do checklist, já mascarado. */
export function formatar(resultados, segredos = []) {
  const linhas = ['Diagnóstico do Balde', ''];
  resultados.forEach((r, i) => {
    linhas.push(`${r.ok ? '✅' : '❌'} ${i + 1}. ${r.titulo}`);
    for (const d of r.detalhes) linhas.push(`     ${d}`);
  });
  const falhas = resultados.filter(r => !r.ok).length;
  linhas.push('', falhas ? `${falhas} de ${resultados.length} item(ns) com problema.` : 'Tudo certo.');
  return mascarar(linhas.join('\n'), segredos);
}

async function main() {
  const envPath = path.join(RAIZ, '.env');
  if (fs.existsSync(envPath)) carregarEnv(fs.readFileSync(envPath, 'utf8'), process.env);
  const resultados = await diagnosticar();
  console.log(formatar(resultados, segredosDe(process.env)));
  process.exitCode = resultados.every(r => r.ok) ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(e => { console.error(`Diagnóstico falhou: ${e.message}`); process.exitCode = 2; });
}
