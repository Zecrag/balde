/**
 * @file config.mjs — GRUPOS.md: a tabela que o dono edita à mão.
 *
 * GRUPOS.md é a ÚNICA fonte de:
 *   - grupos autorizados (link de convite ou jid @g.us) → config/grupos.json (lido pela ingestão)
 *   - empresa / projeto / ganho / início / fim / tipo   → config/clientes.json (lido pelo motor)
 *
 * Formato (uma linha por grupo; cabeçalho e separador são ignorados):
 *   | Empresa | Projeto | Link do grupo | Ganho total (R$) | Início | Fim | Tipo | Status |
 *   |---|---|---|---|---|---|---|---|
 *   | Alfa Tech | Site | https://chat.whatsapp.com/AbC123 | 6.000,00 | 01/01/26 | 31/12/26 | cliente | ativo |
 *
 * - Tipo: cliente | despejo (vazio = cliente) | interno (projeto SEM grupo: Link vazio; não é lido da
 *   Evolution, só existe como empresa/projeto conhecido para receber tarefas do grupo de despejo).
 * - Link do grupo é OPCIONAL para qualquer tipo (GB-46): cliente sem grupo não é lido, só recebe
 *   tarefas pelo despejo/WhatsApp pessoal. Preenchido, precisa ser jid @g.us ou link de convite.
 * - Ganho = valor TOTAL do projeto, formato BR (6.000,00). O cabeçalho antigo "Ganho R$/mês" continua
 *   válido (as colunas são lidas pela posição).
 * - Datas dd/mm/aa (ano 20aa), opcionais; dd/mm/aaaa já gravado é aceito e vira dd/mm/aa ao salvar.
 * - Status: ativo | arquivado (coluna opcional; ausente = ativo). Projeto arquivado sai do painel e
 *   o grupo dele deixa de ser lido (fora de grupos.json / clientes.json).
 * - Linha inválida vira aviso e é ignorada — nunca derruba o servidor.
 * - Link → jid via Evolution (GET /group/inviteInfo/<inst>?inviteCode=), com cache em config/link-cache.json.
 * - iniciarWatcher() reprocessa ao salvar (fs.watch no diretório, com debounce).
 */

import fs, { readFileSync } from 'node:fs';
import { readFile, writeFile, mkdir, copyFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.join(__dirname, '..');

export const TIPOS_GRUPO = Object.freeze(['cliente', 'despejo']);
/** Tipos aceitos na tabela: os de grupo + 'interno' (projeto sem grupo). */
export const TIPO_INTERNO = 'interno';
export const TIPOS_PROJETO = Object.freeze([...TIPOS_GRUPO, TIPO_INTERNO]);
/** Status do projeto (coluna opcional; vazio = ativo). */
export const STATUS_PROJETO = Object.freeze(['ativo', 'arquivado']);

/** Caminho fixo do GRUPOS.md (BALDE_GRUPOS_MD só para testes/instalações fora do padrão). */
export function caminhoGruposMd() {
  return path.resolve(process.env.BALDE_GRUPOS_MD || path.join(RAIZ, 'GRUPOS.md'));
}

export function caminhoGruposExemplo() {
  return path.join(RAIZ, 'GRUPOS.exemplo.md');
}

function caminhoConfigDir() {
  return process.env.BALDE_CONFIG || path.join(RAIZ, 'config');
}

/**
 * Cache dos nomes dos grupos no WhatsApp (jid → nome), em config/nomes-grupos.json.
 * Sob `node --test` sem BALDE_CONFIG não há cache em disco (testes nunca tocam config/ real).
 */
export function caminhoNomesGrupos(env = process.env) {
  if (!env.BALDE_CONFIG && env.NODE_TEST_CONTEXT) return null;
  return path.join(env.BALDE_CONFIG || path.join(RAIZ, 'config'), 'nomes-grupos.json');
}

// ─── Parsers puros ───────────────────────────────────────────────────────────

/**
 * "6.000,00" → 6000 · "R$ 1.250,5" → 1250.5 · "900" → 900 · "" → 0 · "abc" → null
 * @param {string} txt
 * @returns {number|null}
 */
export function parseGanhoBR(txt) {
  let s = String(txt ?? '').replace(/R\$/gi, '').replace(/\s/g, '');
  if (!s) return 0;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

/**
 * "31/12/26" → "2026-12-31" · "31/12/2026" → "2026-12-31" · "" → null · data impossível → undefined
 * Ano com 2 dígitos = 20aa.
 * @param {string} txt
 * @returns {string|null|undefined}
 */
export function parseDataBR(txt) {
  const s = String(txt ?? '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return undefined;
  const [, d, mes] = m.map(Number);
  const a = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const dt = new Date(Date.UTC(a, mes - 1, d));
  if (dt.getUTCFullYear() !== a || dt.getUTCMonth() !== mes - 1 || dt.getUTCDate() !== d) return undefined;
  return `${a}-${String(mes).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Classifica o link: jid de grupo ou código de convite.
 * @returns {{ jid: string }|{ inviteCode: string }|null}
 */
export function parseLinkGrupo(txt) {
  const s = String(txt ?? '').trim().replace(/^<|>$/g, '');
  if (/^[\w.-]+@g\.us$/.test(s)) return { jid: s };
  const m = s.match(/^https?:\/\/chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9]+)\/?(?:[?#].*)?$/);
  if (m) return { inviteCode: m[1] };
  return null;
}

/**
 * Lê a tabela markdown. Não resolve links (puro, síncrono).
 * @param {string} texto
 * @returns {{ linhas: object[], avisos: string[] }}
 */
export function parseGruposMd(texto) {
  const linhas = [];
  const avisos = [];
  String(texto ?? '').split(/\r?\n/).forEach((bruta, i) => {
    const n = i + 1;
    const linha = bruta.trim();
    if (!linha.startsWith('|')) return;
    const celulas = linha.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
    if (celulas.every(c => /^:?-{2,}:?$/.test(c) || c === '')) return;  // separador
    if (/^empresa$/i.test(celulas[0])) return;                          // cabeçalho
    if (celulas.length < 7) {
      avisos.push(`Linha ${n}: esperava 7 colunas, achou ${celulas.length}.`);
      return;
    }
    const [empresa, projeto, link, ganhoTxt, inicioTxt, fimTxt, tipoTxt, statusTxt] = celulas;
    const status = (statusTxt || 'ativo').toLowerCase();
    if (!STATUS_PROJETO.includes(status)) {
      avisos.push(`Linha ${n}: status "${statusTxt}" inválido (use ativo ou arquivado).`);
      return;
    }
    const tipo = (tipoTxt || 'cliente').toLowerCase();
    if (!TIPOS_PROJETO.includes(tipo)) {
      avisos.push(`Linha ${n}: tipo "${tipoTxt}" inválido (use cliente, despejo ou interno).`);
      return;
    }
    if ((tipo === 'cliente' || tipo === TIPO_INTERNO) && !empresa) {
      avisos.push(`Linha ${n}: empresa vazia.`);
      return;
    }
    const interno = tipo === TIPO_INTERNO;
    if (interno && link) {
      avisos.push(`Linha ${n}: tipo interno não tem grupo — deixe o Link vazio.`);
      return;
    }
    const alvo = interno || !link ? { jid: null } : parseLinkGrupo(link);  // sem link = sem grupo (não é lido)
    if (!alvo) {
      avisos.push(`Linha ${n}: link "${link}" não é https://chat.whatsapp.com/… nem jid @g.us.`);
      return;
    }
    const ganho = parseGanhoBR(ganhoTxt);
    if (ganho === null) {
      avisos.push(`Linha ${n}: ganho "${ganhoTxt}" inválido (use 6.000,00).`);
      return;
    }
    const inicio = parseDataBR(inicioTxt);
    const fim = parseDataBR(fimTxt);
    if (inicio === undefined || fim === undefined) {
      avisos.push(`Linha ${n}: data inválida (use dd/mm/aa).`);
      return;
    }
    linhas.push({ linha: n, empresa, projeto: projeto || 'Geral', link, ...alvo, ganho, inicio, fim, tipo, status });
  });
  return { linhas, avisos };
}

// ─── Tabela editável (aba Projetos do painel) ────────────────────────────────

export const CABECALHO_TABELA = '| Empresa | Projeto | Link do grupo | Ganho total (R$) | Início | Fim | Tipo | Status |';
const SEPARADOR_TABELA = '|---|---|---|---|---|---|---|---|';
const CAMPOS_TABELA = ['empresa', 'projeto', 'link', 'ganho', 'inicio', 'fim', 'tipo', 'status'];

const ehLinhaTabela = l => l.trim().startsWith('|');
const celulasDe = l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());

/**
 * Separa o GRUPOS.md em: texto antes da tabela (instruções), linhas da tabela como
 * texto cru (inclusive as inválidas, para o painel deixar corrigir) e texto depois.
 * @param {string} texto
 * @returns {{ antes: string, linhas: object[], depois: string }}
 */
export function lerTabelaGruposMd(texto) {
  const todas = String(texto ?? '').split(/\r?\n/);
  const ini = todas.findIndex(ehLinhaTabela);
  if (ini < 0) return { antes: String(texto ?? '').replace(/\s+$/, ''), linhas: [], depois: '' };
  let fim = ini;
  while (fim < todas.length && ehLinhaTabela(todas[fim])) fim++;
  const linhas = [];
  for (const bruta of todas.slice(ini, fim)) {
    const c = celulasDe(bruta);
    if (c.every(x => /^:?-{2,}:?$/.test(x) || x === '')) continue;
    if (/^empresa$/i.test(c[0])) continue;
    linhas.push(Object.fromEntries(CAMPOS_TABELA.map((k, i) => [k, c[i] ?? ''])));
  }
  return {
    antes: todas.slice(0, ini).join('\n').replace(/\s+$/, ''),
    linhas,
    depois: todas.slice(fim).join('\n').replace(/^\s+|\s+$/g, ''),
  };
}

const textoCelula = v => String(v ?? '').replace(/\|/g, '/').replace(/[\r\n]+/g, ' ').trim();

/** 6000 → "6.000,00" · "6.000,00" → "6.000,00" · 0/"" → "" */
function ganhoParaCelula(n) {
  if (!n) return '';
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** "2026-12-31" → "31/12/26" · "1/2/2026" → "01/02/26" · "" → "" · inválida → como veio (o validador acusa) */
export function dataParaCelula(txt) {
  const s = textoCelula(txt);
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/) ? s : parseDataBR(s);
  if (!iso) return s;
  const [a, m, d] = iso.split('-');
  return `${d}/${m}/${a >= '2000' && a <= '2099' ? a.slice(2) : a}`;
}

/** Chave para detectar grupo repetido: jid ou código do convite. */
function chaveGrupo(link) {
  const alvo = parseLinkGrupo(link);
  if (!alvo) return null;
  return alvo.jid ? alvo.jid.toLowerCase() : `convite:${alvo.inviteCode}`;
}

/**
 * Valida as linhas vindas do painel e devolve as células já normalizadas.
 * Regras: empresa e projeto obrigatórios; grupo opcional — se preenchido, jid @g.us ou link chat.whatsapp.com;
 * ganho BR (total do projeto); datas dd/mm/aa (fim não antes do início); tipo cliente|despejo|interno;
 * status ativo|arquivado (vazio = ativo); sem grupo repetido. Tipo interno: grupo obrigatoriamente vazio.
 * @param {object[]} linhas — { empresa, projeto, link, ganho, inicio, fim, tipo, status }
 * @returns {{ erros: {linha: number, campo: string, msg: string}[], celulas: string[][] }}
 */
export function validarLinhasProjetos(linhas) {
  const erros = [];
  const celulas = [];
  if (!Array.isArray(linhas)) return { erros: [{ linha: 0, campo: 'linhas', msg: 'linhas deve ser uma lista' }], celulas };
  const vistos = new Map();
  linhas.forEach((l, i) => {
    const n = i + 1;
    const erro = (campo, msg) => erros.push({ linha: n, campo, msg });
    if (!l || typeof l !== 'object') { erro('linha', 'linha inválida'); return; }
    const empresa = textoCelula(l.empresa);
    const projeto = textoCelula(l.projeto);
    const link = textoCelula(l.link).replace(/^<|>$/g, '');
    const tipo = (textoCelula(l.tipo) || 'cliente').toLowerCase();
    if (!empresa) erro('empresa', 'empresa obrigatória');
    if (!projeto) erro('projeto', 'projeto obrigatório');

    const chave = tipo === TIPO_INTERNO ? null : chaveGrupo(link);
    if (tipo === TIPO_INTERNO) { if (link) erro('link', 'projeto interno não tem grupo — deixe o grupo vazio'); }
    else if (!link) { /* sem grupo: projeto existe, só não é lido */ }
    else if (!chave) erro('link', 'grupo deve ser jid …@g.us ou link https://chat.whatsapp.com/…');
    else if (vistos.has(chave)) erro('link', `grupo repetido (já está na linha ${vistos.get(chave)})`);
    else vistos.set(chave, n);

    const ganho = typeof l.ganho === 'number' ? (Number.isFinite(l.ganho) ? l.ganho : null) : parseGanhoBR(l.ganho);
    if (ganho === null || ganho < 0) erro('ganho', 'ganho inválido (use 6.000,00)');

    const inicioTxt = dataParaCelula(l.inicio);
    const fimTxt = dataParaCelula(l.fim);
    const inicio = parseDataBR(inicioTxt);
    const fim = parseDataBR(fimTxt);
    if (inicio === undefined) erro('inicio', 'início inválido (use dd/mm/aa)');
    if (fim === undefined) erro('fim', 'fim inválido (use dd/mm/aa)');
    if (inicio && fim && fim < inicio) erro('fim', 'fim antes do início');

    if (!TIPOS_PROJETO.includes(tipo)) erro('tipo', 'tipo deve ser cliente, despejo ou interno');
    const status = (textoCelula(l.status) || 'ativo').toLowerCase();
    if (!STATUS_PROJETO.includes(status)) erro('status', 'status deve ser ativo ou arquivado');
    celulas.push([empresa, projeto, link, ganhoParaCelula(ganho), inicioTxt, fimTxt, tipo, status]);
  });
  return { erros, celulas };
}

/**
 * Monta o GRUPOS.md: instruções originais + tabela nova + o que vinha depois dela.
 * @param {string} textoAtual — conteúdo atual (vazio usa o cabeçalho do exemplo)
 * @param {string[][]} celulas
 */
export function montarGruposMd(textoAtual, celulas, textoExemplo = '') {
  const atual = lerTabelaGruposMd(textoAtual);
  const antes = atualizarInstrucoes(atual.antes || lerTabelaGruposMd(textoExemplo).antes);
  const tabela = [CABECALHO_TABELA, SEPARADOR_TABELA, ...celulas.map(c => `| ${c.join(' | ')} |`.replace(/ {2,}\|/g, ' |'))];
  return [antes, tabela.join('\n'), atual.depois].filter(Boolean).join('\n\n') + '\n';
}

/** Instruções do exemplo antigo (ganho mensal, ano com 4 dígitos) → texto atual. Linhas do dono ficam como estão. */
const INSTRUCOES_ANTIGAS = [
  ['- **Ganho R$/mês**: formato BR, ex. `6.000,00`.', '- **Ganho total (R$)**: valor total do projeto, formato BR, ex. `6.000,00`.'],
  ['- **Início / Fim**: `dd/mm/aaaa`, opcionais.', '- **Início / Fim**: `dd/mm/aa` (ano 20aa), opcionais.'],
  ['- **Tipo**: `cliente` (grupo de um projeto) ou `despejo` (grupo onde você joga coisas soltas).',
    '- **Tipo**: `cliente` (grupo de um projeto), `despejo` (grupo onde você joga coisas soltas) ou `interno` (projeto sem grupo: deixe o link vazio).\n'
    + '- **Status**: `ativo` ou `arquivado` (vazio = ativo). Projeto arquivado sai do painel e o grupo deixa de ser lido.'],
];
function atualizarInstrucoes(antes) {
  return INSTRUCOES_ANTIGAS.reduce((txt, [velho, novo]) => txt.split('\n').map(l => (l.trim() === velho ? novo : l)).join('\n'), antes);
}

/**
 * Arquiva ou reabre um projeto: muda só a coluna Status das linhas empresa·projeto.
 * As outras linhas vão como estão no arquivo (inclusive as inválidas); só ganham a coluna Status (vazia = ativo).
 * @returns {{ texto: string, linhas: number }} — linhas = quantas linhas mudaram de projeto (0 = não achou)
 */
export function definirStatusProjeto(textoAtual, empresa, projeto, status) {
  if (!STATUS_PROJETO.includes(status)) throw Object.assign(new Error('status deve ser ativo ou arquivado'), { status: 400 });
  const { linhas } = lerTabelaGruposMd(textoAtual);
  let achadas = 0;
  const celulas = linhas.map(l => {
    const ehDele = l.empresa === empresa && (l.projeto || 'Geral') === projeto;
    if (ehDele) achadas++;
    return CAMPOS_TABELA.map(k => (k !== 'status' ? textoCelula(l[k]) : ehDele ? status : textoCelula(l[k]) || 'ativo'));
  });
  if (!achadas) return { texto: textoAtual, linhas: 0 };
  return { texto: montarGruposMd(textoAtual, celulas), linhas: achadas };
}

/**
 * Grava atomicamente: escreve num temporário no mesmo diretório e renomeia por cima.
 * Quem lê (watcher, TextEdit) nunca vê o arquivo pela metade.
 */
export async function gravarAtomico(caminho, conteudo) {
  const tmp = path.join(path.dirname(caminho), `.${path.basename(caminho)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(tmp, conteudo, 'utf8');
    await rename(tmp, caminho);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

// ─── Resolução link → jid (Evolution) ────────────────────────────────────────

/** Resolver padrão: Evolution. Testes injetam o seu e nunca chegam aqui. */
export async function resolverConviteEvolution(inviteCode) {
  const url = process.env.BALDE_EVOLUTION_URL;
  const key = process.env.BALDE_EVOLUTION_KEY;
  const inst = process.env.BALDE_EVOLUTION_INSTANCIA;
  if (!url || !key || !inst) throw new Error('Evolution não configurada (BALDE_EVOLUTION_URL/KEY/INSTANCIA)');
  const res = await fetch(`${url}/group/inviteInfo/${encodeURIComponent(inst)}?inviteCode=${encodeURIComponent(inviteCode)}`, {
    headers: { apikey: key },
  });
  if (!res.ok) throw new Error(`Evolution respondeu HTTP ${res.status}`);
  const data = await res.json();
  if (!data?.id || !String(data.id).endsWith('@g.us')) throw new Error('convite sem jid de grupo');
  return data.id;
}

async function lerJson(caminho, fallback) {
  try { return JSON.parse(await readFile(caminho, 'utf8')); } catch { return fallback; }
}

// ─── Processamento ───────────────────────────────────────────────────────────

/**
 * Lê GRUPOS.md, resolve links e grava config/clientes.json + config/grupos.json.
 * Sem GRUPOS.md, não mexe em nada.
 *
 * @param {Object} [opts]
 * @param {string} [opts.mdPath]
 * @param {string} [opts.configDir]
 * @param {(inviteCode: string) => Promise<string>} [opts.resolver]
 * @returns {Promise<{ existe: boolean, clientes: object[], grupos: object[], avisos: string[] }>}
 */
export async function processarGruposMd(opts = {}) {
  const mdPath = opts.mdPath ?? caminhoGruposMd();
  const configDir = opts.configDir ?? caminhoConfigDir();
  const resolver = opts.resolver ?? resolverConviteEvolution;

  let texto;
  try {
    texto = await readFile(mdPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { existe: false, clientes: [], grupos: [], avisos: [] };
    throw e;
  }

  const { linhas, avisos } = parseGruposMd(texto);
  const cachePath = path.join(configDir, 'link-cache.json');
  const cache = await lerJson(cachePath, {});
  let cacheMudou = false;

  const grupos = [];
  const porProjeto = new Map();
  for (const l of linhas) {
    if (l.status === 'arquivado') continue;   // arquivado: grupo não é lido, projeto sai da config
    let jid = l.jid;
    if (!jid && l.inviteCode) {
      jid = cache[l.inviteCode];
      if (!jid) {
        try {
          jid = await resolver(l.inviteCode);
          cache[l.inviteCode] = jid;
          cacheMudou = true;
        } catch (err) {
          avisos.push(`Linha ${l.linha}: não consegui resolver ${l.link} (${err.message}).`);
          continue;
        }
      }
    }

    if (jid) grupos.push({ link: l.link, jid, empresa: l.empresa, projeto: l.projeto, tipo: l.tipo }); // sem grupo: não é lido
    if (!l.empresa) continue; // despejo sem empresa: autorizado, mas sem cliente fixo

    const chave = `${l.empresa}\u0000${l.projeto}`;
    let cliente = porProjeto.get(chave);
    if (!cliente) {
      cliente = {
        empresa: l.empresa,
        projeto: l.projeto,
        grupos: [],
        receitaMensal: l.ganho,
        tipoTicket: l.tipo,
        pesoUrgencia: 1,
        inicio: l.inicio,
        fim: l.fim,
      };
      porProjeto.set(chave, cliente);
    } else {
      cliente.receitaMensal = Math.max(cliente.receitaMensal, l.ganho);
      cliente.inicio ??= l.inicio;
      cliente.fim ??= l.fim;
    }
    if (jid && !cliente.grupos.includes(jid)) cliente.grupos.push(jid);
  }

  const clientes = [...porProjeto.values()];
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, 'clientes.json'), JSON.stringify(clientes, null, 2));
  await writeFile(path.join(configDir, 'grupos.json'), JSON.stringify(grupos, null, 2));
  if (cacheMudou) await writeFile(cachePath, JSON.stringify(cache, null, 2));

  for (const a of avisos) console.warn('[Balde] GRUPOS.md —', a);
  return { existe: true, clientes, grupos, avisos };
}

/**
 * Empresas/projetos conhecidos (todas as linhas válidas com empresa, inclusive tipo interno, sem grupo).
 * Projetos arquivados ficam de fora (a não ser com incluirArquivados).
 * Síncrono e sem Evolution — para o motor encaixar tarefas do grupo de despejo.
 * @param {{ mdPath?: string, texto?: string, incluirArquivados?: boolean }} [opts]
 * @returns {{ empresa: string, projeto: string, tipo: string, ganho: number, inicio: string|null, fim: string|null, comGrupo: boolean, status: string }[]}
 */
export function listarProjetos(opts = {}) {
  let texto = opts.texto;
  if (texto === undefined) {
    try { texto = readFileSync(opts.mdPath ?? caminhoGruposMd(), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  }
  const porChave = new Map();
  for (const l of parseGruposMd(texto).linhas) {
    if (!l.empresa) continue;
    if (l.status === 'arquivado' && !opts.incluirArquivados) continue;
    const k = `${l.empresa}\u0000${l.projeto}`;
    const atual = porChave.get(k);
    if (!atual) {
      porChave.set(k, { empresa: l.empresa, projeto: l.projeto, tipo: l.tipo, ganho: l.ganho, inicio: l.inicio, fim: l.fim, comGrupo: Boolean(l.jid || l.inviteCode), status: l.status });
    } else {
      atual.ganho = Math.max(atual.ganho, l.ganho);
      atual.comGrupo ||= Boolean(l.jid || l.inviteCode);
    }
  }
  return [...porChave.values()];
}

/** Cria GRUPOS.md a partir do exemplo se ainda não existir. Devolve o caminho. */
export async function garantirGruposMd(mdPath = caminhoGruposMd()) {
  if (!fs.existsSync(mdPath)) await copyFile(caminhoGruposExemplo(), mdPath);
  return mdPath;
}

/**
 * Processa agora e reprocessa a cada gravação do GRUPOS.md.
 * Observa o diretório (editores salvam via rename, o que mata um watch no arquivo).
 * @returns {{ close(): void, pronto: Promise<object> }}
 */
export function iniciarWatcher(opts = {}) {
  const mdPath = opts.mdPath ?? caminhoGruposMd();
  const nome = path.basename(mdPath);
  let fila = Promise.resolve();
  const rodar = () => {
    fila = fila
      .then(() => processarGruposMd({ ...opts, mdPath }))
      .catch(err => { console.error('[Balde] Erro ao processar GRUPOS.md:', err.message); return null; });
    return fila;
  };

  const pronto = rodar();
  let timer = null;
  let watcher = null;
  try {
    watcher = fs.watch(path.dirname(mdPath), (_evento, arquivo) => {
      if (arquivo && arquivo.toString() !== nome) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        console.log('[Balde] GRUPOS.md salvo — recarregando grupos.');
        rodar();
      }, opts.debounceMs ?? 200);
    });
  } catch (err) {
    console.warn('[Balde] Aviso: não consegui observar GRUPOS.md:', err.message);
  }

  return {
    pronto,
    close() {
      clearTimeout(timer);
      watcher?.close();
    },
  };
}
