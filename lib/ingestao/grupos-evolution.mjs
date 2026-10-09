/**
 * @file grupos-evolution.mjs — achar, adicionar e criar grupos pela Evolution.
 *
 * - listarGrupos:   GET  /group/fetchAllGroups/<inst>?getParticipants=false
 * - buscarGrupos:   busca sem acento / caixa / emoji, vários termos ("a, b")
 * - linhaGruposMd:  linha pronta para o GRUPOS.md (jid no lugar do link)
 * - adicionarAoGruposMd: acrescenta no fim do GRUPOS.md, sem duplicar jid
 * - criarGrupo:     POST /group/create/<inst> (só a CLI chama — ação externa)
 * - linkConvite:    GET  /group/inviteCode/<inst>?groupJid=
 *
 * Toda chamada de rede recebe `fetch` injetável (testes não tocam a Evolution).
 * Nunca mexe no webhook da instância.
 */

import { readFile, appendFile } from 'node:fs/promises';
import { TIPOS_GRUPO, caminhoGruposMd, garantirGruposMd, parseGruposMd } from '../config.mjs';

export const JID_GRUPO = /^[\w.-]+@g\.us$/;

// ─── Conexão ─────────────────────────────────────────────────────────────────

/** {url, key, inst} do ambiente (BALDE_EVOLUTION_URL/KEY/INSTANCIA); lança se faltar. */
export function evolutionDoAmbiente(env = process.env) {
  const url = String(env.BALDE_EVOLUTION_URL ?? '').replace(/\/+$/, '');
  const key = env.BALDE_EVOLUTION_KEY;
  const inst = env.BALDE_EVOLUTION_INSTANCIA;
  if (!url || !key || !inst) throw new Error('Evolution não configurada (BALDE_EVOLUTION_URL/KEY/INSTANCIA no .env)');
  return { url, key, inst };
}

async function chamar(conexao, metodo, rota, corpo) {
  const { url, key, fetch: f = globalThis.fetch } = conexao;
  const headers = { apikey: key };
  if (corpo !== undefined) headers['Content-Type'] = 'application/json';
  const res = await f(`${url}${rota}`, {
    method: metodo,
    headers,
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Evolution respondeu HTTP ${res.status}${txt ? `: ${txt.slice(0, 200)}` : ''}`);
  }
  return res.json();
}

/**
 * Todos os grupos em que o número da instância está.
 * @param {{url: string, key: string, inst: string, fetch?: typeof fetch}} conexao
 * @returns {Promise<{jid: string, nome: string, tamanho: number|null}[]>}
 */
export async function listarGrupos(conexao) {
  const data = await chamar(conexao, 'GET', `/group/fetchAllGroups/${encodeURIComponent(conexao.inst)}?getParticipants=false`);
  const lista = Array.isArray(data) ? data : (data?.groups ?? data?.data ?? []);
  return lista
    .filter(g => g && JID_GRUPO.test(String(g.id ?? '')))
    .map(g => ({ jid: g.id, nome: String(g.subject ?? '').trim(), tamanho: Number.isFinite(g.size) ? g.size : null }));
}

// ─── Busca ───────────────────────────────────────────────────────────────────

/** "Exemplo 🚀 | Ads" → "exemplo ads": sem acento, caixa, emoji nem pontuação. */
export function normalizarBusca(txt) {
  return String(txt ?? '')
    .normalize('NFD').replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** ["work", "hub,", "alfa"] → ["work hub", "alfa"] (vírgula separa termos). */
export function separarTermos(args) {
  return (Array.isArray(args) ? args.join(' ') : String(args ?? ''))
    .split(',').map(t => t.trim()).filter(Boolean);
}

/** Todas as palavras do termo aparecem no nome (em qualquer ordem). "acme" também acha "Acme". */
function nomeCasa(nome, termo) {
  const n = normalizarBusca(nome);
  const t = normalizarBusca(termo);
  if (!t) return false;
  if (t.split(' ').every(p => n.includes(p))) return true;
  return n.replace(/ /g, '').includes(t.replace(/ /g, ''));
}

/**
 * @param {{jid: string, nome: string}[]} grupos
 * @param {string[]} termos
 * @returns {{ resultados: {termo: string, grupos: object[]}[], naoEncontrados: string[] }}
 */
export function buscarGrupos(grupos, termos) {
  const resultados = [];
  const naoEncontrados = [];
  for (const termo of termos) {
    const achados = JID_GRUPO.test(termo)
      ? grupos.filter(g => g.jid === termo)
      : grupos.filter(g => nomeCasa(g.nome, termo));
    if (achados.length) resultados.push({ termo, grupos: achados.sort((a, b) => normalizarBusca(a.nome).localeCompare(normalizarBusca(b.nome))) });
    else naoEncontrados.push(termo);
  }
  return { resultados, naoEncontrados };
}

// ─── Linha do GRUPOS.md ──────────────────────────────────────────────────────

/** Tira emoji e espaços sobrando, sem tocar em acento. */
function limparNome(txt) {
  return String(txt ?? '')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Sugere empresa/projeto do nome do grupo: "Alfa Tech | Site" → {Alfa Tech, Site}.
 * Separadores: | - – — : / · x. Se uma empresa já conhecida aparecer no nome, ela vence;
 * sem separador, a palavra igual ao termo buscado (`dica`) vira a empresa.
 */
export function sugerirEmpresaProjeto(nome, empresasConhecidas = [], dica = '') {
  const limpo = limparNome(nome);
  const conhecida = empresasConhecidas
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .find(e => normalizarBusca(limpo).includes(normalizarBusca(e)));
  const partes = limpo.split(/\s+(?:[-/]|x)\s+|\s*[|–—·]\s*|\s*:\s+/i).map(p => p.trim()).filter(Boolean);
  if (conhecida) {
    const palavrasEmpresa = new Set(normalizarBusca(conhecida).split(' '));
    const resto = partes
      .map(p => p.split(' ').filter(w => !palavrasEmpresa.has(normalizarBusca(w))).join(' '))
      .filter(Boolean).join(' - ');
    return { empresa: conhecida, projeto: resto };
  }
  if (partes.length <= 1) {
    // "LEADS acme" buscado por "acme" → empresa acme, projeto LEADS
    const palavras = limpo.split(' ');
    const i = dica ? palavras.findIndex(w => normalizarBusca(w) === normalizarBusca(dica)) : -1;
    if (i >= 0 && palavras.length > 1) {
      return { empresa: palavras[i], projeto: palavras.filter((_, j) => j !== i).join(' ') };
    }
    return { empresa: limpo, projeto: '' };
  }
  return { empresa: partes[0], projeto: partes.slice(1).join(' - ') };
}

/** 3000 → "3.000,00"; texto já em formato BR passa como veio; vazio → "". */
export function formatarGanho(ganho) {
  if (ganho === undefined || ganho === null || ganho === '') return '';
  const s = String(ganho).trim();
  if (s.includes(',')) return s;
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const celula = v => String(v ?? '').replace(/\|/g, '/').replace(/[\r\n]+/g, ' ').trim();

/** `| Empresa | Projeto | jid | Ganho | | | tipo |` */
export function linhaGruposMd({ empresa = '', projeto = '', jid, ganho = '', tipo = 'cliente' }) {
  return `| ${[empresa, projeto, jid, formatarGanho(ganho), '', '', tipo || 'cliente'].map(celula).join(' | ')} |`
    .replace(/ {2,}\|/g, ' |');
}

/**
 * Acrescenta a linha no fim do GRUPOS.md (cria a partir do exemplo se faltar).
 * Não duplica: se o jid já aparece no arquivo, não escreve nada.
 * @returns {Promise<{ adicionado: boolean, linha: string, arquivo: string }>}
 */
export async function adicionarAoGruposMd(dados, arquivo = caminhoGruposMd()) {
  const jid = String(dados?.jid ?? '').trim();
  if (!JID_GRUPO.test(jid)) throw Object.assign(new Error('jid de grupo inválido (esperado ...@g.us)'), { status: 400 });
  const tipo = String(dados.tipo || 'cliente').toLowerCase();
  if (!TIPOS_GRUPO.includes(tipo)) throw Object.assign(new Error('tipo deve ser cliente ou despejo'), { status: 400 });
  if (tipo === 'cliente' && !celula(dados.empresa)) throw Object.assign(new Error('empresa obrigatória para tipo cliente'), { status: 400 });

  const linha = linhaGruposMd({ ...dados, jid, tipo });
  await garantirGruposMd(arquivo);
  const texto = await readFile(arquivo, 'utf8');
  if (texto.includes(jid)) return { adicionado: false, linha, arquivo };
  await appendFile(arquivo, `${texto.endsWith('\n') || texto === '' ? '' : '\n'}${linha}\n`, 'utf8');
  return { adicionado: true, linha, arquivo };
}

/** Empresas já presentes no GRUPOS.md, para melhorar a sugestão. */
export async function empresasDoGruposMd(arquivo = caminhoGruposMd()) {
  try {
    const texto = await readFile(arquivo, 'utf8');
    return [...new Set(parseGruposMd(texto).linhas.map(l => l.empresa).filter(Boolean))];
  } catch { return []; }
}

/** jids já presentes no GRUPOS.md (texto cru — pega até linha com erro). */
export async function jidsDoGruposMd(arquivo = caminhoGruposMd()) {
  try { return new Set((await readFile(arquivo, 'utf8')).match(/[\w.-]+@g\.us/g) ?? []); }
  catch { return new Set(); }
}

// ─── Criar grupo (só CLI) ────────────────────────────────────────────────────

/** "5511 9999-0000, +55 11 98888-0000" → ["5511999990000", "5511988880000"] */
export function normalizarParticipantes(txt) {
  return String(txt ?? '').split(',').map(p => p.replace(/\D/g, '')).filter(p => p.length >= 8);
}

/** Corpo do POST /group/create — usado também para o "o que faria" sem --sim. */
export function corpoCriarGrupo({ nome, participantes = [], descricao = '' }) {
  const subject = String(nome ?? '').trim();
  if (!subject) throw new Error('nome do grupo obrigatório');
  const corpo = { subject, participants: participantes };
  if (descricao) corpo.description = String(descricao);
  return corpo;
}

/** Cria o grupo na Evolution e devolve o jid. */
export async function criarGrupo(conexao, dados) {
  const data = await chamar(conexao, 'POST', `/group/create/${encodeURIComponent(conexao.inst)}`, corpoCriarGrupo(dados));
  const jid = data?.id ?? data?.groupJid ?? data?.gid;
  if (!JID_GRUPO.test(String(jid ?? ''))) throw new Error('Evolution criou mas não devolveu jid de grupo');
  return { jid, nome: data.subject ?? dados.nome };
}

/** Link de convite do grupo (https://chat.whatsapp.com/...). */
export async function linkConvite(conexao, jid) {
  const data = await chamar(conexao, 'GET', `/group/inviteCode/${encodeURIComponent(conexao.inst)}?groupJid=${encodeURIComponent(jid)}`);
  if (data?.inviteUrl) return data.inviteUrl;
  if (data?.inviteCode) return `https://chat.whatsapp.com/${data.inviteCode}`;
  return null;
}
