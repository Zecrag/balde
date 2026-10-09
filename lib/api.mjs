/**
 * @file api.mjs — HTTP handler do Balde (node:http, sem dependências npm)
 *
 * Uso:
 *   import { criarApi } from './lib/api.mjs';
 *   const handler = criarApi({ store });
 *   // handler(req, res) pode ser passado para http.createServer()
 *
 * Rotas:
 *   GET  /api/tarefas              — lista com filtros: empresa, projeto, estado
 *   PATCH /api/tarefas/:id         — edita estado, prazo, responsavel, titulo, descricao (ganho/início/fim são do projeto: ignorados)
 *                                    { empresa, projeto } move a tarefa: só par do GRUPOS.md (ou projeto 'Avulso'); grava movidaDe
 *   POST  /api/tarefas/:id/distribuir — grava destino + linha em dados/fila-distribuicao.jsonl
 *   GET  /api/destinos             — destinos autorizados de DESTINOS.md (Nome | Tipo | Alvo)
 *   GET  /api/mensagens?chatId=    — mensagens-fonte de uma tarefa
 *   GET  /api/config/grupos        — tabela do GRUPOS.md (linhas + avisos + caminho absoluto)
 *   GET  /api/projetos             — tabela do GRUPOS.md como texto editável (+ nome do grupo no WhatsApp, versão)
 *   PUT  /api/projetos             — { linhas, versao? } valida e regrava o GRUPOS.md (atômico, mantém as instruções)
 *   PATCH /api/projetos/:chave     — { status: ativo|arquivado, versao? } encerra/reabre o projeto (chave = "empresa\tprojeto")
 *   GET  /api/tarefas também devolve `arquivados` (empresa → projetos arquivados, com contagem de tarefas);
 *        tarefa de projeto arquivado vem com arquivado: true e fica fora de `empresas`.
 *   POST /api/config/abrir         — abre o GRUPOS.md no editor do Mac (caminho fixo)
 *   GET  /api/grupos/buscar?q=     — grupos da Evolution por nome (só leitura), com linha pronta
 *        Os nomes dos grupos (jid → nome) ficam em config/nomes-grupos.json: a aba Projetos mostra o
 *        nome guardado na hora e a Evolution (lenta: fetchAllGroups leva ~25 s) atualiza em segundo plano.
 *   POST /api/grupos/adicionar     — { jid, empresa, projeto, tipo } no fim do GRUPOS.md (sem duplicar)
 *   GET  /painel/*  ou  /          — serve arquivos estáticos de balde/painel/
 */

import { readFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, extname, dirname, resolve, sep } from 'node:path';
import { timingSafeEqual, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { obterStorePadrao } from './store.mjs';
import {
  caminhoGruposMd, caminhoGruposExemplo, garantirGruposMd, parseGruposMd, parseLinkGrupo,
  lerTabelaGruposMd, validarLinhasProjetos, montarGruposMd, gravarAtomico, definirStatusProjeto,
  caminhoNomesGrupos,
} from './config.mjs';
import {
  evolutionDoAmbiente, listarGrupos, buscarGrupos, separarTermos, sugerirEmpresaProjeto,
  linhaGruposMd, adicionarAoGruposMd, empresasDoGruposMd, jidsDoGruposMd,
} from './ingestao/grupos-evolution.mjs';
import { calcularPrazoISO } from './motor/datas.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const PAINEL_DIR = resolve(__dir, '..', 'painel');
const LIMITE_CORPO = 1024 * 1024; // 1 MB
const PROJETO_AVULSO = 'Avulso';   // projeto sempre aceito ao mover, para qualquer empresa do GRUPOS.md

// ─── MIME types mínimos ──────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function parseUrl(raw) {
  try { return new URL(raw, 'http://localhost'); } catch { return null; }
}

function erroHttp(status, msg) {
  return Object.assign(new Error(msg), { status });
}

/** Lê o corpo JSON com teto de 1 MB (413 acima disso; 400 se não for JSON). */
async function lerCorpo(req) {
  const declarado = Number(req.headers['content-length']);
  if (Number.isFinite(declarado) && declarado > LIMITE_CORPO) {
    req.resume();
    throw erroHttp(413, 'Corpo maior que 1 MB');
  }
  return new Promise((resolve, reject) => {
    const partes = [];
    let tamanho = 0;
    const aoDado = c => {
      tamanho += c.length;
      if (tamanho > LIMITE_CORPO) {
        req.off('data', aoDado);
        req.resume(); // descarta o resto sem acumular
        reject(erroHttp(413, 'Corpo maior que 1 MB'));
        return;
      }
      partes.push(c);
    };
    req.on('data', aoDado);
    req.on('end', () => {
      if (tamanho > LIMITE_CORPO) return;
      const body = Buffer.concat(partes).toString('utf8');
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(erroHttp(400, 'JSON inválido')); }
    });
    req.on('error', reject);
  });
}

function json(res, status, data) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}

function jsonError(res, status, msg) {
  json(res, status, { erro: msg });
}

// ─── Ordenação por urgência ───────────────────────────────────────────────────
/** Urgência efetiva: considera prazo próximo como bônus. */
function urgenciaEfetiva(t) {
  let u = t.urgencia ?? 0;
  if (t.prazo) {
    const dias = (new Date(t.prazo) - Date.now()) / 86_400_000;
    if (dias < 0)  u = Math.min(100, u + 30);      // vencido
    else if (dias < 1)  u = Math.min(100, u + 20); // hoje
    else if (dias < 3)  u = Math.min(100, u + 10); // 3 dias
  }
  return u;
}

// ─── Ganho / datas do PROJETO (GRUPOS.md) ─────────────────────────────────────
/** Anexa `efetivo` (ganho/início/fim do projeto). Valores antigos gravados na tarefa não contam. */
function comEfetivo(t, projeto) {
  return {
    ...t,
    efetivo: {
      ganho:  projeto?.receitaMensal ?? 0,
      inicio: projeto?.inicio ?? null,
      fim:    projeto?.fim ?? null,
    },
  };
}

/** Data mais próxima entre prazo e fim (ms), ou Infinity. */
function dataLimite(t) {
  const ds = [t.prazo, t.efetivo.fim].filter(Boolean).map(d => new Date(d).getTime()).filter(Number.isFinite);
  return ds.length ? Math.min(...ds) : Infinity;
}

/** Ordem: ganho desc → prazo/fim mais próximo → urgência. */
export function compararTarefas(a, b) {
  if (b.efetivo.ganho !== a.efetivo.ganho) return b.efetivo.ganho - a.efetivo.ganho;
  const da = dataLimite(a), db = dataLimite(b);
  if (da !== db) return da < db ? -1 : 1;
  return urgenciaEfetiva(b) - urgenciaEfetiva(a);
}

const chaveProjeto = (empresa, projeto) => `${empresa}\t${projeto}`;

/**
 * Empresas por ganho total (soma do ganho TOTAL de cada projeto), projetos por ganho, com início/fim/tipo.
 * Projetos em `arquivados` (Set de "empresa\tprojeto") ficam de fora — e a empresa que só tem
 * projetos arquivados some.
 */
export function resumirEmpresas(tarefas, clientes, arquivados = new Set()) {
  const empresas = new Map();
  const add = (empresa, projeto, dados) => {
    if (!empresa || arquivados.has(chaveProjeto(empresa, projeto))) return;
    if (!empresas.has(empresa)) empresas.set(empresa, new Map());
    const ps = empresas.get(empresa);
    if (!ps.has(projeto)) ps.set(projeto, { projeto, ganho: 0, inicio: null, fim: null, tipo: null, ...dados });
  };
  for (const c of clientes) {
    add(c.empresa, c.projeto, { ganho: c.receitaMensal || 0, inicio: c.inicio ?? null, fim: c.fim ?? null, tipo: c.tipoTicket ?? 'cliente', grupos: c.grupos ?? [] });
  }
  for (const t of tarefas) add(t.empresa, t.projeto, {});
  return [...empresas].map(([empresa, ps]) => {
    const projetos = [...ps.values()].sort((a, b) => b.ganho - a.ganho || a.projeto.localeCompare(b.projeto));
    return { empresa, ganhoTotal: projetos.reduce((s, p) => s + p.ganho, 0), projetos };
  }).sort((a, b) => b.ganhoTotal - a.ganhoTotal || a.empresa.localeCompare(b.empresa));
}

/**
 * Projetos arquivados (linhas Status = arquivado do GRUPOS.md), agrupados por empresa,
 * com o ganho/datas do projeto e quantas tarefas ele tem (fora as descartadas).
 */
export function resumirArquivados(tarefas, linhasArquivadas) {
  const empresas = new Map();
  for (const l of linhasArquivadas) {
    if (!l.empresa) continue;
    if (!empresas.has(l.empresa)) empresas.set(l.empresa, new Map());
    const ps = empresas.get(l.empresa);
    const p = ps.get(l.projeto) ?? { projeto: l.projeto, ganho: 0, inicio: l.inicio, fim: l.fim, tipo: l.tipo, tarefas: 0 };
    p.ganho = Math.max(p.ganho, l.ganho || 0);
    ps.set(l.projeto, p);
  }
  for (const t of tarefas) {
    const p = empresas.get(t.empresa)?.get(t.projeto);
    if (p && t.estado !== 'descartada') p.tarefas++;
  }
  return [...empresas].map(([empresa, ps]) => ({ empresa, projetos: [...ps.values()] }))
    .sort((a, b) => a.empresa.localeCompare(b.empresa));
}

/** Cache jid → nome dos grupos (síncrono, só na criação da API); ausente ou ilegível = vazio. */
function lerNomesCache(arquivo) {
  if (!arquivo) return new Map();
  try {
    const obj = JSON.parse(readFileSync(arquivo, 'utf8'));
    return new Map(Object.entries(obj).filter(([j, n]) => typeof j === 'string' && typeof n === 'string' && n));
  } catch { return new Map(); }
}

/** Versão do GRUPOS.md (hash do conteúdo) para não sobrescrever edição feita fora do painel. */
const versaoDe = texto => (texto === null ? '' : createHash('sha1').update(texto).digest('hex').slice(0, 16));

async function lerTextoOuNull(arquivo) {
  try { return await readFile(arquivo, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

const TIPOS_DESTINO = ['agente', 'webhook', 'comando'];

/** Caminho fixo do DESTINOS.md (mesma regra do lib/distribuidor.mjs). */
export function caminhoDestinos() {
  return process.env.BALDE_DESTINOS || join(__dir, '..', 'DESTINOS.md');
}

/** Lê DESTINOS.md como o distribuidor lê: linhas | Nome | Tipo | Alvo | com tipo conhecido. */
export async function lerDestinos(arquivo) {
  let texto;
  try { texto = await readFile(arquivo, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return texto.split('\n').filter(l => l.trim().startsWith('|'))
    .map(l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()))
    .filter(([nome, tipo]) => nome && TIPOS_DESTINO.includes(tipo))
    .map(([nome, tipo, alvo]) => ({ nome, tipo, alvo }));
}

function abrirNoMac(caminho) {
  execFile('open', [caminho], err => {
    if (err) console.warn('[Balde] Não consegui abrir', caminho, '-', err.message);
  });
}

// ─── Handler de arquivos estáticos ───────────────────────────────────────────
async function servirEstatico(res, filePath) {
  if (!filePath.startsWith(PAINEL_DIR + sep) || !existsSync(filePath)) {
    jsonError(res, 404, 'Arquivo não encontrado');
    return;
  }
  const ext = extname(filePath).toLowerCase();
  const mime = MIME[ext] ?? 'application/octet-stream';
  try {
    const content = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': content.length });
    res.end(content);
  } catch {
    jsonError(res, 500, 'Erro ao ler arquivo');
  }
}

// ─── Proteção contra outros sites (GB-25) ────────────────────────────────────
const METODOS_ESCRITA = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** 127.x, ::1 e localhost são loopback; 0.0.0.0, :: e IPs de rede não são. */
export function hostLoopback(host) {
  const h = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

function tokenConfere(recebido, esperado) {
  if (!esperado || typeof recebido !== 'string') return false;
  const a = Buffer.from(recebido), b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Decide se o request pode seguir; devolve [status, mensagem] para recusar ou null.
 * - Host precisa ser 127.0.0.1:<porta> ou localhost:<porta> (anti DNS rebinding).
 * - Fora de loopback, /api exige X-Balde-Token = BALDE_WEBHOOK_TOKEN.
 * - Escrita exige Content-Type application/json e Origin ausente ou do próprio painel.
 */
function recusar(req, method, pathname, { loopback, token }) {
  const porta = req.socket?.localPort;
  const host = String(req.headers.host ?? '').toLowerCase();
  const hostsLocais = [`127.0.0.1:${porta}`, `localhost:${porta}`];
  if (loopback && !hostsLocais.includes(host)) return [403, 'Host não permitido'];

  if (!loopback && pathname.startsWith('/api') && !tokenConfere(req.headers['x-balde-token'], token)) {
    return [401, 'X-Balde-Token ausente ou inválido'];
  }

  if (METODOS_ESCRITA.has(method)) {
    const tipo = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (tipo !== 'application/json') return [403, 'Content-Type deve ser application/json'];
    const origin = req.headers.origin;
    const origensOk = hostsLocais.map(h => `http://${h}`);
    if (!loopback && host) origensOk.push(`http://${host}`);
    if (origin !== undefined && !origensOk.includes(String(origin).toLowerCase())) {
      return [403, 'Origin não permitida'];
    }
  }
  return null;
}

// ─── API principal ────────────────────────────────────────────────────────────
/**
 * Cria o handler HTTP do Balde.
 * @param {Object} opts
 * @param {import('./store.mjs')} opts.store
 * @param {() => object[]} [opts.lerClientes]   — projetos (config/clientes.json, gerado do GRUPOS.md)
 * @param {string} [opts.gruposMdPath]          — caminho fixo do GRUPOS.md
 * @param {(caminho: string) => void} [opts.abrirArquivo] — abre no editor (padrão: `open` do macOS)
 * @param {string} [opts.destinosPath]          — DESTINOS.md (destinos autorizados do distribuidor)
 * @param {string} [opts.host]                  — host de escuta (BALDE_HOST); fora de loopback /api exige token
 * @param {string} [opts.token]                 — X-Balde-Token esperado (BALDE_WEBHOOK_TOKEN)
 * @param {() => Promise<{jid: string, nome: string}[]>} [opts.listarGruposEvolution] — grupos do número (padrão: Evolution do .env)
 * @param {string|null} [opts.nomesCachePath] — cache jid → nome dos grupos (padrão config/nomes-grupos.json; null = só memória)
 * @returns {(req: import('http').IncomingMessage, res: import('http').ServerResponse) => void}
 */
export function criarApi({
  store,
  lerClientes = () => obterStorePadrao().lerClientes(),
  gruposMdPath = caminhoGruposMd(),
  abrirArquivo = abrirNoMac,
  destinosPath = caminhoDestinos(),
  host = process.env.BALDE_HOST ?? '127.0.0.1',
  token = process.env.BALDE_WEBHOOK_TOKEN,
  listarGruposEvolution = () => listarGrupos(evolutionDoAmbiente()),
  nomesCachePath = caminhoNomesGrupos(),
}) {
  const protecao = { loopback: hostLoopback(host), token };

  // Nomes dos grupos no WhatsApp (jid → nome). A Evolution é lenta (fetchAllGroups ~25 s), então
  // o mapa fica guardado em disco (config/nomes-grupos.json): o GET responde na hora com o nome
  // guardado e, a cada 10 min, atualiza em segundo plano (só GET na Evolution, sem LLM). Só fica
  // nomesPendentes = true quando falta o nome de algum grupo da tabela e a busca ainda roda.
  let nomes = { em: 0, mapa: lerNomesCache(nomesCachePath), buscando: null };
  function guardarNomes(grupos) {
    let mudou = false;
    for (const g of grupos ?? []) {
      if (!g?.jid || !g.nome || nomes.mapa.get(g.jid) === g.nome) continue;
      nomes.mapa.set(g.jid, g.nome);
      mudou = true;
    }
    if (mudou && nomesCachePath) {
      mkdir(dirname(nomesCachePath), { recursive: true })
        .then(() => gravarAtomico(nomesCachePath, JSON.stringify(Object.fromEntries(nomes.mapa), null, 2) + '\n'))
        .catch(e => console.warn('[Balde] Não gravei o cache de nomes dos grupos:', e.message));
    }
  }
  function atualizarNomes() {
    nomes.buscando ??= (async () => {
      try {
        guardarNomes(await listarGruposEvolution());
        nomes = { ...nomes, em: Date.now(), buscando: null };
      } catch {
        nomes = { ...nomes, em: Date.now() - 9 * 60_000, buscando: null }; // tenta de novo em 1 min
      }
    })();
    return nomes.buscando;
  }
  async function nomesDosGrupos(jids = []) {
    if (Date.now() - nomes.em < 10 * 60_000) return { mapa: nomes.mapa, pendente: false };
    const busca = atualizarNomes();
    const falta = () => jids.some(j => !nomes.mapa.has(j));
    if (falta()) await Promise.race([busca, new Promise(r => setTimeout(r, 1500).unref?.())]);
    return { mapa: nomes.mapa, pendente: Boolean(nomes.buscando) && falta() };
  }

  /** Destino de "mover tarefa": par empresa·projeto do GRUPOS.md, ou 'Avulso' de uma empresa que está lá. */
  async function validarMovimento(empresa, projeto) {
    if (typeof empresa !== 'string' || typeof projeto !== 'string' || !empresa.trim() || !projeto.trim()) {
      return { erro: 'Para mover informe empresa e projeto' };
    }
    const e = empresa.trim(), p = projeto.trim();
    const { linhas } = parseGruposMd((await lerTextoOuNull(gruposMdPath)) ?? '');
    const ativas = linhas.filter(l => l.status !== 'arquivado');
    const existe = ativas.some(l => l.empresa === e && (l.projeto === p || p === PROJETO_AVULSO));
    if (!existe) {
      const arquivado = linhas.some(l => l.empresa === e && l.projeto === p);
      return { erro: arquivado ? `"${e} · ${p}" está arquivado — reabra antes de mover para lá` : `"${e} · ${p}" não está no GRUPOS.md` };
    }
    return { empresa: e, projeto: p };
  }

  async function estadoProjetos() {
    const texto = await lerTextoOuNull(gruposMdPath);
    const { linhas } = lerTabelaGruposMd(texto ?? '');
    const { avisos } = texto === null ? { avisos: [] } : parseGruposMd(texto);
    const jids = linhas.map(l => parseLinkGrupo(l.link)?.jid).filter(Boolean);
    const { mapa, pendente } = jids.length ? await nomesDosGrupos(jids) : { mapa: new Map(), pendente: false };
    return {
      arquivo: gruposMdPath,
      existe: texto !== null,
      versao: versaoDe(texto),
      avisos,
      nomesPendentes: pendente,
      linhas: linhas.map(l => {
        const jid = parseLinkGrupo(l.link)?.jid ?? null;
        return { ...l, jid, grupoNome: (jid && mapa.get(jid)) || null };
      }),
    };
  }
  return async function handler(req, res) {
    const u = parseUrl(req.url ?? '/');
    if (!u) { jsonError(res, 400, 'URL inválida'); return; }

    const pathname = u.pathname;
    const method = (req.method ?? 'GET').toUpperCase();

    const recusa = recusar(req, method, pathname, protecao);
    if (recusa) { req.resume(); jsonError(res, ...recusa); return; }

    // Painel é same-origin: preflight responde sem liberar CORS para ninguém.
    if (method === 'OPTIONS') {
      res.writeHead(204, { Allow: 'GET, PATCH, POST, PUT, OPTIONS' });
      res.end();
      return;
    }

    // ── GET /api/tarefas ────────────────────────────────────────────────────
    if (method === 'GET' && pathname === '/api/tarefas') {
      try {
        const clientes = lerClientes() || [];
        // Arquivados vêm direto do GRUPOS.md (clientes.json já não tem esses projetos).
        const linhasArq = parseGruposMd((await lerTextoOuNull(gruposMdPath)) ?? '').linhas.filter(l => l.status === 'arquivado');
        const arquivados = new Set(linhasArq.map(l => chaveProjeto(l.empresa, l.projeto)));
        const projetoDe = t => {
          if (arquivados.has(chaveProjeto(t.empresa, t.projeto))) {
            const l = linhasArq.find(x => x.empresa === t.empresa && x.projeto === t.projeto);
            return { receitaMensal: l.ganho, inicio: l.inicio, fim: l.fim };
          }
          return clientes.find(c => c.empresa === t.empresa && c.projeto === t.projeto);
        };
        const todas = (await store.listarTarefas()).map(t => ({
          ...comEfetivo(t, projetoDe(t)),
          arquivado: arquivados.has(chaveProjeto(t.empresa, t.projeto)),
        }));

        const empresa = u.searchParams.get('empresa');
        const projeto = u.searchParams.get('projeto');
        const estado  = u.searchParams.get('estado');
        let tarefas = todas;
        if (empresa) tarefas = tarefas.filter(t => t.empresa === empresa);
        if (projeto)  tarefas = tarefas.filter(t => t.projeto === projeto);
        if (estado)   tarefas = tarefas.filter(t => t.estado === estado);
        tarefas = [...tarefas].sort(compararTarefas);

        json(res, 200, {
          tarefas,
          empresas: resumirEmpresas(todas, clientes, arquivados),
          arquivados: resumirArquivados(todas, linhasArq),
        });
      } catch (e) {
        jsonError(res, e.status ?? 500, e.message);
      }
      return;
    }

    // ── PATCH /api/tarefas/:id ──────────────────────────────────────────────
    const matchPatch = pathname.match(/^\/api\/tarefas\/([^/]+)$/);
    if (method === 'PATCH' && matchPatch) {
      const id = decodeURIComponent(matchPatch[1]);
      try {
        const body = await lerCorpo(req);
        // ganho/início/fim são do projeto (GRUPOS.md): não entram na tarefa.
        const permitidos = ['estado', 'prazo', 'responsavel', 'titulo', 'descricao', 'links', 'nota'];
        const campos = {};
        for (const k of permitidos) {
          if (k in body) {
            if (k === 'prazo') {
              campos.prazo = body.prazo ? (calcularPrazoISO(body.prazo, new Date()) || String(body.prazo).slice(0, 10)) : null;
            } else if (k === 'links') {
              campos.links = Array.isArray(body.links) ? body.links : [];
            } else if (k === 'nota') {
              campos.nota = body.nota ? String(body.nota) : null;
            } else {
              campos[k] = body[k];
            }
          }
        }
        if ('empresa' in body || 'projeto' in body) {
          const atual = (await store.listarTarefas()).find(t => t.id === id);
          if (!atual) { jsonError(res, 404, 'Tarefa não encontrada'); return; }
          const destino = await validarMovimento(body.empresa, body.projeto);
          if (destino.erro) { jsonError(res, 400, destino.erro); return; }
          if (destino.empresa !== atual.empresa || destino.projeto !== atual.projeto) {
            Object.assign(campos, destino, {
              movidaDe: { empresa: atual.empresa ?? null, projeto: atual.projeto ?? null, em: new Date().toISOString() },
            });
          }
        }
        const tarefa = typeof store.atualizarTarefa === 'function'
          ? await store.atualizarTarefa(id, campos)
          : store.upsertTarefa({ id, ...campos });
        json(res, 200, { tarefa });
      } catch (e) {
        jsonError(res, e.status ?? 500, e.message);
      }
      return;
    }

    // ── GET /api/leituras/log ────────────────────────────────────────────────
    if (method === 'GET' && pathname === '/api/leituras/log') {
      try {
        const limite = Number(url.searchParams.get('limite')) || 50;
        const { lerLogLeituras, caminhoDados } = await import('./leitura.mjs');
        const dadosDir = caminhoDados({}, process.env);
        json(res, 200, lerLogLeituras(dadosDir, limite));
      } catch (e) {
        jsonError(res, e.status ?? 500, e.message);
      }
      return;
    }

    // ── POST /api/tarefas/:id/distribuir ────────────────────────────────────
    const matchDist = pathname.match(/^\/api\/tarefas\/([^/]+)\/distribuir$/);
    if (method === 'POST' && matchDist) {
      const id = decodeURIComponent(matchDist[1]);
      try {
        const body = await lerCorpo(req);
        // Preferido: { nome } de uma linha do DESTINOS.md. Legado: { tipo, alvo }.
        let destino, destinoFila;
        if (body.nome) {
          const achados = (await lerDestinos(destinosPath)).filter(d => d.nome === body.nome);
          if (achados.length !== 1) {
            jsonError(res, 400, `Destino "${body.nome}" ausente ou ambíguo em DESTINOS.md`);
            return;
          }
          destino = achados[0];
          destinoFila = destino.nome;
        } else {
          const { tipo, alvo } = body;
          if (!tipo || !alvo) {
            jsonError(res, 400, 'Campos obrigatórios: nome (ou tipo + alvo)');
            return;
          }
          destino = destinoFila = { tipo, alvo };
        }
        const tarefa = await store.atualizarTarefa(id, { destino });
        const entrada = {
          tarefaId: id,
          destino: destinoFila,
          ts: new Date().toISOString(),
        };
        await store.gravarDistribuicao(entrada);
        json(res, 200, { tarefa, distribuicao: entrada });
      } catch (e) {
        jsonError(res, e.status ?? 500, e.message);
      }
      return;
    }


    // ── GET /api/destinos ───────────────────────────────────────────────────
    if (method === 'GET' && pathname === '/api/destinos') {
      try {
        json(res, 200, { arquivo: destinosPath, destinos: await lerDestinos(destinosPath) });
      } catch (e) {
        jsonError(res, e.status ?? 500, e.message);
      }
      return;
    }

    // ── GET /api/config/grupos ──────────────────────────────────────────────
    if (method === 'GET' && pathname === '/api/config/grupos') {
      try {
        let texto = null;
        try { texto = await readFile(gruposMdPath, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        const { linhas, avisos } = texto === null ? { linhas: [], avisos: [] } : parseGruposMd(texto);
        json(res, 200, { arquivo: gruposMdPath, existe: texto !== null, linhas, avisos });
      } catch (e) {
        jsonError(res, e.status ?? 500, e.message);
      }
      return;
    }

    // ── GET /api/projetos ───────────────────────────────────────────────────
    if (method === 'GET' && pathname === '/api/projetos') {
      try {
        json(res, 200, await estadoProjetos());
      } catch (e) {
        jsonError(res, e.status ?? 500, e.message);
      }
      return;
    }

    // ── PUT /api/projetos ───────────────────────────────────────────────────
    // Regrava SÓ a tabela do caminho fixo do GRUPOS.md; o watcher recarrega sozinho.
    if (method === 'PUT' && pathname === '/api/projetos') {
      try {
        const body = await lerCorpo(req);
        const textoAtual = await lerTextoOuNull(gruposMdPath);
        if (body.versao !== undefined && body.versao !== versaoDe(textoAtual)) {
          json(res, 409, { erro: 'GRUPOS.md mudou fora do painel — recarregue antes de salvar.', versao: versaoDe(textoAtual) });
          return;
        }
        const { erros, celulas } = validarLinhasProjetos(body.linhas);
        if (erros.length) {
          json(res, 400, { erro: erros.map(e => `Linha ${e.linha}: ${e.msg}`).join(' · '), erros });
          return;
        }
        const exemplo = await lerTextoOuNull(caminhoGruposExemplo());
        await gravarAtomico(gruposMdPath, montarGruposMd(textoAtual ?? '', celulas, exemplo ?? ''));
        json(res, 200, await estadoProjetos());
      } catch (e) {
        jsonError(res, e.status ?? 500, e.message);
      }
      return;
    }

    // ── PATCH /api/projetos/:chave ──────────────────────────────────────────
    // Encerra (arquivado) ou reabre (ativo) um projeto: muda só a coluna Status do GRUPOS.md.
    // O watcher recarrega e o grupo de projeto arquivado deixa de ser lido.
    const matchProjeto = pathname.match(/^\/api\/projetos\/([^/]+)$/);
    if (method === 'PATCH' && matchProjeto) {
      try {
        const body = (await lerCorpo(req)) ?? {};
        let chave;
        try { chave = decodeURIComponent(matchProjeto[1]); } catch { jsonError(res, 400, 'Chave inválida'); return; }
        const [empresa, projeto, ...resto] = chave.split('\t');
        if (!empresa || !projeto || resto.length) { jsonError(res, 400, 'Chave deve ser "empresa\\tprojeto"'); return; }
        if (!['ativo', 'arquivado'].includes(body.status)) { jsonError(res, 400, 'status deve ser ativo ou arquivado'); return; }
        const textoAtual = await lerTextoOuNull(gruposMdPath);
        if (body.versao !== undefined && body.versao !== versaoDe(textoAtual)) {
          json(res, 409, { erro: 'GRUPOS.md mudou fora do painel — recarregue antes de salvar.', versao: versaoDe(textoAtual) });
          return;
        }
        const r = definirStatusProjeto(textoAtual ?? '', empresa, projeto, body.status);
        if (!r.linhas) { jsonError(res, 404, `"${empresa} · ${projeto}" não está no GRUPOS.md`); return; }
        await gravarAtomico(gruposMdPath, r.texto);
        json(res, 200, await estadoProjetos());
      } catch (e) {
        jsonError(res, e.status ?? 500, e.message);
      }
      return;
    }

    // ── POST /api/config/abrir ──────────────────────────────────────────────
    // Abre SEMPRE o caminho fixo do GRUPOS.md; nada do request vira caminho.
    if (method === 'POST' && pathname === '/api/config/abrir') {
      try {
        await garantirGruposMd(gruposMdPath);
        abrirArquivo(gruposMdPath);
        json(res, 200, { ok: true, arquivo: gruposMdPath });
      } catch (e) {
        jsonError(res, e.status ?? 500, e.message);
      }
      return;
    }

    // ── GET /api/grupos/buscar?q= ───────────────────────────────────────────
    // Só leitura na Evolution; cada grupo vem com a linha sugerida do GRUPOS.md.
    if (method === 'GET' && pathname === '/api/grupos/buscar') {
      try {
        const termos = separarTermos(u.searchParams.get('q') ?? '');
        if (!termos.length) { jsonError(res, 400, 'Informe q (termos separados por vírgula)'); return; }
        const todos = await listarGruposEvolution();
        guardarNomes(todos);   // a busca também atualiza o cache de nomes da aba Projetos
        const { resultados, naoEncontrados } = buscarGrupos(todos, termos);
        const empresas = await empresasDoGruposMd(gruposMdPath);
        const jaTem = await jidsDoGruposMd(gruposMdPath);
        json(res, 200, {
          resultados: resultados.map(({ termo, grupos }) => ({
            termo,
            grupos: grupos.map(g => {
              const sug = sugerirEmpresaProjeto(g.nome, empresas, termo);
              return { ...g, ...sug, jaNoGruposMd: jaTem.has(g.jid), linha: linhaGruposMd({ ...sug, jid: g.jid }) };
            }),
          })),
          naoEncontrados,
        });
      } catch (e) {
        jsonError(res, e.status ?? 502, e.message);
      }
      return;
    }

    // ── POST /api/grupos/adicionar ──────────────────────────────────────────
    // Escreve só no caminho fixo do GRUPOS.md; 409 se o jid já está lá.
    if (method === 'POST' && pathname === '/api/grupos/adicionar') {
      try {
        const { jid, empresa, projeto, tipo } = await lerCorpo(req);
        const r = await adicionarAoGruposMd({ jid, empresa, projeto, tipo }, gruposMdPath);
        if (!r.adicionado) { jsonError(res, 409, 'Esse grupo já está no GRUPOS.md'); return; }
        json(res, 200, r);
      } catch (e) {
        jsonError(res, e.status ?? 500, e.message);
      }
      return;
    }

    // ── GET /api/mensagens?chatId= ──────────────────────────────────────────
    if (method === 'GET' && pathname === '/api/mensagens') {
      try {
        const chatId = u.searchParams.get('chatId') ?? '';
        const mensagens = await store.listarMensagens(chatId);
        json(res, 200, { mensagens });
      } catch (e) {
        jsonError(res, e.status ?? 500, e.message);
      }
      return;
    }

    // ── Arquivos estáticos do painel ────────────────────────────────────────
    if (method === 'GET') {
      let rel = pathname.replace(/^\/painel\/?/, '') || 'index.html';
      if (pathname === '/' || pathname === '') rel = 'index.html';
      rel = rel.replace(/^\/+/, '');
      const filePath = resolve(PAINEL_DIR, rel);
      await servirEstatico(res, filePath);
      return;
    }

    jsonError(res, 404, 'Rota não encontrada');
  };
}
