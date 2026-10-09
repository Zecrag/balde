/**
 * app.js — Lógica do Painel do Balde (ES module, sem build, sem frameworks)
 *
 * Responsabilidades:
 * - Busca a lista COMPLETA de tarefas a cada 10s; filtros são aplicados aqui
 *   (assim os dropdowns nunca perdem opções ao escolher uma empresa).
 * - Renderiza empresa (por ganho total) → projeto (por ganho) → tarefas na ordem da API
 *   (ganho desc → prazo/fim mais próximo → urgência).
 * - Card compacto numa linha; detalhes ao expandir. Checkbox = feita; feitas vão
 *   riscadas para "Feitas" (recolhida) no fim do projeto, desmarcar devolve.
 * - Ganho / início / fim são do PROJETO: aparecem no cabeçalho de cada projeto (com dias até o fim).
 * - Aba "Projetos": GRUPOS.md como tabela editável (GET/PUT /api/projetos); escolher/trocar grupo
 *   pela busca na Evolution (GET /grupos/buscar); relê o arquivo quando ele muda fora do painel.
 * - Modal "Distribuir" lista os destinos reais do DESTINOS.md e chama POST /:id/distribuir { nome }.
 * - GB-32: clicar na empresa recolhe/expande o bloco (lembrado em localStorage; ao abrir, todos
 *   recolhidos); barra lateral / chips para pular até a empresa; mover tarefa arrastando o card até
 *   o cabeçalho de outro projeto ou pelo seletor "Mover para…" (pares do GRUPOS.md + Avulso).
 *   Dentro do projeto: Decidir → Falta info → Pra fazer → Fazendo; Feitas recolhidas no fim.
 * - GB-41: projeto interno (sem grupo); datas dd/mm/aa e ganho total com máscara; Encerrar/Reabrir
 *   projeto (PATCH /api/projetos/:chave) — arquivados vão para "Arquivados" (recolhida) com as tarefas.
 * - GB-45: tag da última leitura + "Atualizar" (POST /api/ler) no topo de Tarefas; aba Custos
 *   (GET /api/uso?desde=&ate=; 404 = sem dados ainda). Funções puras em util.js.
 * - GB-46: cliente sem grupo (grupo opcional); "Ler este grupo" no cabeçalho do projeto
 *   (POST /api/ler { grupos: [jid] }); Configurações da IA na aba Custos (GET/PUT /api/config/llm):
 *   modelo de extração, de transcrição e teto diário; mensagens e áudios por projeto nos custos.
 */

import {
  mascaraData, dataCurta, dataValida, mascaraMoeda, moedaDoArquivo,
  normalizarUso, normalizarLeitura, intervalo, preencherDias, fmtUSD, fmtTokens, resultadoDosGrupos,
} from './util.js';

// ── Configuração ───────────────────────────────────────────
const API = '/api';
const POLL_MS = 10_000;

// ── Estado da app ──────────────────────────────────────────
let _tarefas  = [];
let _empresas = [];          // [{ empresa, ganhoTotal, projetos: [{ projeto, ganho }] }]
let _arquivados = [];        // [{ empresa, projetos: [{ projeto, ganho, tarefas }] }] — Status = arquivado
let _tarefasArquivadas = []; // tarefas de projeto arquivado (fora dos filtros e da lista principal)
const _arquivadosAbertos = new Set();   // seções de Arquivados abertas (o polling redesenha)
let _tarefaDistribuindo = null;
let _pollTimer = null;
let _filtroEmpresa = '';
let _filtroEstado  = '';
let _filtroProjeto = '';
const _expandidas = new Set();
const _feitasAbertas = new Set();   // empresa\tprojeto com a seção Feitas aberta
let _paresGrupos = [];               // [{ empresa, projeto }] do GRUPOS.md — destinos de "mover"
let _arrastando = null;              // id da tarefa sendo arrastada (polling não redesenha)
const _lendoProjeto = new Map();     // empresa\tprojeto → { lendo, texto, cls } do "Ler este grupo" (sobrevive ao polling)

// Empresas abertas (padrão: todas recolhidas). localStorage pode faltar: aí vale só na sessão.
const CHAVE_ABERTAS = 'balde.empresasAbertas';
const _empresasAbertas = new Set((() => {
  try { return JSON.parse(localStorage.getItem(CHAVE_ABERTAS) ?? '[]'); } catch { return []; }
})());
function salvarAbertas() {
  try { localStorage.setItem(CHAVE_ABERTAS, JSON.stringify([..._empresasAbertas])); } catch { /* sem storage */ }
}

// ── Elementos ─────────────────────────────────────────────
const $main    = document.getElementById('main');
const $toast   = document.getElementById('toast');
const $dot     = document.getElementById('sync-dot');
const $info    = document.getElementById('sync-info');
const $overlay = document.getElementById('modal-overlay');
const $destinos = document.getElementById('dist-destinos');
const $sel_e   = document.getElementById('filtro-empresa');
const $sel_st  = document.getElementById('filtro-estado');
const $sel_p   = document.getElementById('filtro-projeto');
const $dlgGrupo = document.getElementById('dlg-grupo');
const $dlgConfirmar = document.getElementById('dlg-confirmar');
const $nav     = document.getElementById('nav-empresas');
const $recolher = document.getElementById('btn-recolher');

// ── Rótulos ───────────────────────────────────────────────
const ESTADOS = [
  ['aguardando_info', 'Falta info'],
  ['pronta',          'Pra fazer'],
  ['precisa_decisao', 'Decidir'],
  ['em_execucao',     'Fazendo'],
  ['feita',           'Feita'],
  ['descartada',      'Descartada'],
];
const ROTULO = Object.fromEntries(ESTADOS);
// Ordem dentro do projeto: o que depende de você primeiro.
const ORDEM_ESTADO = { precisa_decisao: 0, aguardando_info: 1, pronta: 2, em_execucao: 3 };
const PROJETO_AVULSO = 'Avulso';
const labelEstado = e => ROTULO[e] ?? e;

// ── Utils ──────────────────────────────────────────────────
const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const fmtGanho = v => BRL.format(Number(v) || 0);

/** "2026-12-31" ou ISO → "31/12/26" (sem fuso: data-calendário). */
function fmtData(iso) {
  if (!iso) return null;
  const [a, m, d] = String(iso).slice(0, 10).split('-');
  return d && m && a ? `${d}/${m}/${a.slice(2)}` : null;
}

const diaISO = v => (v ? String(v).slice(0, 10) : '');

function venceLogo(iso) {
  if (!iso) return false;
  return new Date(diaISO(iso) + 'T23:59:59') <= new Date(Date.now() + 3 * 86_400_000);
}

/** Dias de calendário de hoje até a data (negativo = já passou). */
function diasAte(iso) {
  const [a, m, d] = diaISO(iso).split('-').map(Number);
  if (!a) return null;
  const hoje = new Date();
  return Math.round((Date.UTC(a, m - 1, d) - Date.UTC(hoje.getFullYear(), hoje.getMonth(), hoje.getDate())) / 86_400_000);
}

/** "01/01/26 – 31/12/26 · faltam 84 dias" para o cabeçalho do projeto. */
function periodoProjeto(p) {
  if (!p?.inicio && !p?.fim) return '';
  const datas = `${fmtData(p.inicio) ?? '…'} – ${fmtData(p.fim) ?? '…'}`;
  if (!p.fim) return `<span class="gp-periodo">${datas}</span>`;
  const n = diasAte(p.fim);
  const [txt, cls] = n < 0 ? [`encerrado há ${-n} dia${n === -1 ? '' : 's'}`, 'vencido']
    : n === 0 ? ['termina hoje', 'vencido']
    : [`falta${n === 1 ? '' : 'm'} ${n} dia${n === 1 ? '' : 's'}`, n <= 15 ? 'perto' : ''];
  return `<span class="gp-periodo" title="Início – fim do projeto">${datas} · <span class="gp-dias ${cls}">${txt}</span></span>`;
}

function classeUrgencia(u) {
  if (u >= 80) return 'u-critical';
  if (u >= 60) return 'u-high';
  if (u >= 40) return 'u-mid';
  return 'u-low';
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const ICONE = {
  chevronDir: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>`,
  chevron: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>`,
  empresa: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>`,
  msgs:    `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
  arquivar: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4"/></svg>`,
  enviar:  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M22 2L11 13"/><path d="M22 2 15 22 11 13 2 9l20-7z"/></svg>`,
};

// ── Toast ──────────────────────────────────────────────────
let _toastTimer;
function toast(msg, tipo = 'sucesso') {
  $toast.textContent = msg;
  $toast.className = `visivel ${tipo}`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { $toast.className = ''; }, 3000);
}

// ── Sync dot ──────────────────────────────────────────────
function setSyncStatus(status, label) {
  $dot.className = `sync-dot ${status}`;
  $info.textContent = label;
}

// ── API calls ─────────────────────────────────────────────
async function fetchTarefas() {
  setSyncStatus('syncing', 'Atualizando…');
  try {
    const [r, rg] = await Promise.all([fetch(`${API}/tarefas`), fetch(`${API}/config/grupos`).catch(() => null)]);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const dados = await r.json();
    if (rg?.ok) {
      const { linhas = [] } = await rg.json();
      _paresGrupos = linhas.filter(l => l.empresa && l.status !== 'arquivado').map(l => ({ empresa: l.empresa, projeto: l.projeto }));
    }
    _tarefas = (dados.tarefas ?? []).filter(t => !t.arquivado);
    _tarefasArquivadas = (dados.tarefas ?? []).filter(t => t.arquivado);
    _empresas = dados.empresas ?? [];
    _arquivados = dados.arquivados ?? [];
    setSyncStatus('', `${_tarefas.length} tarefa${_tarefas.length !== 1 ? 's' : ''} · ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`);
    atualizarFiltroSelects();
    // Não redesenha por baixo de quem está digitando.
    if (!_arrastando && (!$main.contains(document.activeElement) || document.activeElement === $main)) render();
  } catch (e) {
    setSyncStatus('error', 'Erro ao sincronizar');
    console.error('[balde]', e);
  }
}

async function patchTarefa(id, campos) {
  const r = await fetch(`${API}/tarefas/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(campos),
  });
  if (!r.ok) {
    const corpo = await r.json().catch(() => ({}));
    throw new Error(corpo.erro || `HTTP ${r.status}`);
  }
  return (await r.json()).tarefa;
}

async function distribuirTarefa(id, nome) {
  const r = await fetch(`${API}/tarefas/${encodeURIComponent(id)}/distribuir`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nome }),
  });
  if (!r.ok) {
    const corpo = await r.json().catch(() => ({}));
    throw new Error(corpo.erro || `HTTP ${r.status}`);
  }
  return (await r.json()).tarefa;
}

async function fetchDestinos() {
  const r = await fetch(`${API}/destinos`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function fetchMensagens(chatId) {
  const r = await fetch(`${API}/mensagens?chatId=${encodeURIComponent(chatId)}`);
  if (!r.ok) return [];
  return (await r.json()).mensagens ?? [];
}

// ── Filtros (opções sempre da lista COMPLETA) ─────────────
function empresasOrdenadas() {
  const nomes = _empresas.map(e => e.empresa);
  for (const t of _tarefas) if (t.empresa && !nomes.includes(t.empresa)) nomes.push(t.empresa);
  return nomes;
}

function projetosDe(empresa) {
  const vistos = [];
  const add = p => { if (p && !vistos.includes(p)) vistos.push(p); };
  for (const e of _empresas) if (!empresa || e.empresa === empresa) e.projetos.forEach(p => add(p.projeto));
  for (const t of _tarefas) if (!empresa || t.empresa === empresa) add(t.projeto);
  return vistos;
}

function preencherSelect(el, valores, rotuloTodos, atual) {
  el.innerHTML = '';
  el.append(new Option(rotuloTodos, ''));
  for (const v of valores) el.append(new Option(v, v));
  el.value = valores.includes(atual) ? atual : '';
  return el.value;
}

function atualizarFiltroSelects() {
  _filtroEmpresa = preencherSelect($sel_e, empresasOrdenadas(), 'Todas empresas', _filtroEmpresa);
  _filtroProjeto = preencherSelect($sel_p, projetosDe(_filtroEmpresa), 'Todos projetos', _filtroProjeto);
}

function tarefasFiltradas() {
  return _tarefas.filter(t =>
    (!_filtroEmpresa || t.empresa === _filtroEmpresa) &&
    (!_filtroProjeto || t.projeto === _filtroProjeto) &&
    (_filtroEstado ? t.estado === _filtroEstado : t.estado !== 'descartada'));
}

// ── Render ────────────────────────────────────────────────
const SEM_EMPRESA = '(sem empresa)';
const SEM_PROJETO = '(sem projeto)';
const chaveGrupo = (e, p) => `${e}\t${p}`;

/** Pares de destino para "mover": GRUPOS.md + Avulso de cada empresa, sem repetir. */
function paresMover() {
  const vistos = new Set();
  const pares = [];
  const add = (empresa, projeto) => {
    const k = chaveGrupo(empresa, projeto);
    if (!vistos.has(k)) { vistos.add(k); pares.push({ empresa, projeto }); }
  };
  for (const { empresa, projeto } of _paresGrupos) add(empresa, projeto);
  for (const empresa of [...new Set(_paresGrupos.map(p => p.empresa))]) add(empresa, PROJETO_AVULSO);
  return pares;
}

function contarEstados(tarefas) {
  const c = { abertas: 0, precisa_decisao: 0, aguardando_info: 0, pronta: 0 };
  for (const t of tarefas) {
    if (t.estado === 'feita' || t.estado === 'descartada') continue;
    c.abertas++;
    if (t.estado in c) c[t.estado]++;
  }
  return c;
}

function contadoresEmpresa(c) {
  const chip = (estado, n, rotulo) => n ? `<span class="chip chip-estado-${estado}" title="${rotulo}">${rotulo} ${n}</span>` : '';
  return `<span class="ge-contadores">
    <span class="ge-abertas" title="Tarefas abertas">${c.abertas} aberta${c.abertas === 1 ? '' : 's'}</span>
    ${chip('precisa_decisao', c.precisa_decisao, 'Decidir')}
    ${chip('aguardando_info', c.aguardando_info, 'Falta info')}
    ${chip('pronta', c.pronta, 'Pra fazer')}
  </span>`;
}

function render() {
  const lista = tarefasFiltradas();
  // Empresas/projetos do GRUPOS.md sem tarefas também aparecem (são destino de arrastar),
  // a não ser com filtro de estado.
  const incluirVazios = !_filtroEstado;

  const ordemEmpresa = empresasOrdenadas();
  const resumo = Object.fromEntries(_empresas.map(e => [e.empresa, e]));

  // empresa → projeto → { ativas, feitas }, preservando a ordem da API dentro do projeto
  const grupos = new Map();
  const garantir = (e, p) => {
    if (!grupos.has(e)) grupos.set(e, new Map());
    if (p && !grupos.get(e).has(p)) grupos.get(e).set(p, { ativas: [], feitas: [] });
  };
  if (incluirVazios) {
    for (const info of _empresas) {
      if (_filtroEmpresa && info.empresa !== _filtroEmpresa) continue;
      for (const p of info.projetos) if (!_filtroProjeto || p.projeto === _filtroProjeto) garantir(info.empresa, p.projeto);
    }
  }
  for (const t of lista) {
    const e = t.empresa || SEM_EMPRESA;
    const p = t.projeto || SEM_PROJETO;
    garantir(e, p);
    grupos.get(e).get(p)[t.estado === 'feita' ? 'feitas' : 'ativas'].push(t);
  }
  for (const [e, ps] of grupos) if (!ps.size) grupos.delete(e);

  if (!grupos.size) {
    $main.innerHTML = `<div class="estado-vazio">${_tarefas.length ? 'Nenhuma tarefa com esses filtros.' : 'Nenhuma tarefa ainda. Quando chegar mensagem nos grupos, ela aparece aqui.'}</div>${renderArquivados()}`;
    renderNav([]);
    return;
  }

  const posEmpresa = e => { const i = ordemEmpresa.indexOf(e); return i < 0 ? Infinity : i; };
  const empresas = [...grupos.keys()].sort((a, b) => posEmpresa(a) - posEmpresa(b));
  const posEstado = t => ORDEM_ESTADO[t.estado] ?? 9;

  let html = '';
  const navItens = [];
  for (const empresa of empresas) {
    const info = resumo[empresa];
    const infoProj = Object.fromEntries((info?.projetos ?? []).map(p => [p.projeto, p]));
    const ganhoDe = p => infoProj[p]?.ganho ?? 0;
    const projetos = [...grupos.get(empresa).keys()].sort((a, b) => ganhoDe(b) - ganhoDe(a));
    const todas = projetos.flatMap(p => [...grupos.get(empresa).get(p).ativas, ...grupos.get(empresa).get(p).feitas]);
    const conta = contarEstados(todas);
    const aberta = _empresasAbertas.has(empresa);
    const idCorpo = `ge-corpo-${navItens.length}`;
    navItens.push({ empresa, abertas: conta.abertas, idSecao: `ge-${navItens.length}` });

    html += `<section class="grupo-empresa ${aberta ? 'aberta' : 'recolhida'}" id="ge-${navItens.length - 1}" aria-label="Empresa ${esc(empresa)}">
      <h2 class="grupo-empresa-titulo">
        <button class="ge-toggle" type="button" data-toggle-empresa="${esc(empresa)}" data-drop-empresa="${esc(empresa)}"
                aria-expanded="${aberta}" aria-controls="${idCorpo}">
          <span class="ge-seta">${ICONE.chevronDir}</span>
          <span class="ge-nome">${esc(empresa)}</span>
          ${contadoresEmpresa(conta)}
          ${info ? `<span class="ge-ganho" title="Ganho total da empresa (soma dos projetos ativos)">${fmtGanho(info.ganhoTotal)}</span>` : ''}
        </button>
      </h2>
      <div class="ge-corpo" id="${idCorpo}" ${aberta ? '' : 'hidden'}>`;

    for (const projeto of projetos) {
      const { ativas, feitas } = grupos.get(empresa).get(projeto);
      ativas.sort((a, b) => posEstado(a) - posEstado(b));   // sort estável: mantém a ordem da API no empate
      const p = infoProj[projeto];
      html += `<div class="grupo-projeto" aria-label="Projeto ${esc(projeto)}">
        <h3 class="grupo-projeto-titulo" data-drop-empresa="${esc(empresa)}" data-drop-projeto="${esc(projeto)}">
          <span class="gp-nome">${esc(projeto)}</span>
          <span class="gp-conta" title="Tarefas abertas">${ativas.length}</span>
          ${p?.tipo ? `<span class="chip chip-tipo-${esc(p.tipo)}">${esc(p.tipo)}</span>` : ''}
          <span class="gp-ganho" title="Ganho total do projeto">${p?.ganho ? fmtGanho(p.ganho) : 'sem ganho'}</span>
          ${periodoProjeto(p)}
          ${botaoLerGrupo(empresa, projeto, p)}
          ${projetoNoGrupos(empresa, projeto) ? `<button class="btn btn-ghost btn-sm gp-encerrar" type="button"
              data-arquivar-empresa="${esc(empresa)}" data-arquivar-projeto="${esc(projeto)}"
              aria-label="Encerrar o projeto ${esc(empresa)} · ${esc(projeto)}" title="Encerrar e arquivar o projeto">${ICONE.arquivar} Encerrar</button>` : ''}
        </h3>`;
      html += ativas.map(renderTarefa).join('');
      if (!ativas.length && !feitas.length) html += `<p class="gp-vazio">Sem tarefas. Arraste um card para cá.</p>`;
      if (feitas.length) {
        const chave = esc(chaveGrupo(empresa, projeto));
        html += `<details class="secao-feitas" data-feitas="${chave}" ${_feitasAbertas.has(chaveGrupo(empresa, projeto)) ? 'open' : ''}>
          <summary>Feitas <span class="gp-conta">${feitas.length}</span></summary>
          <div class="feitas-lista">${feitas.map(renderFeita).join('')}</div>
        </details>`;
      }
      html += `</div>`;
    }
    html += `</div></section>`;
  }

  $main.innerHTML = html + renderArquivados();
  renderNav(navItens);
}

/** "Ler este grupo": só para projeto com grupo do WhatsApp; o resultado fica ao lado. */
function botaoLerGrupo(empresa, projeto, p) {
  const jids = p?.grupos ?? [];
  if (!jids.length) return '';
  const st = _lendoProjeto.get(chaveGrupo(empresa, projeto)) ?? {};
  return `<button class="btn btn-ghost btn-sm gp-ler" type="button" data-ler-empresa="${esc(empresa)}" data-ler-projeto="${esc(projeto)}"
      data-ler-jids="${esc(jids.join(','))}" ${st.lendo ? 'disabled aria-busy="true"' : ''}
      aria-label="Ler agora só o grupo de ${esc(empresa)} · ${esc(projeto)}" title="Lê só este grupo (o Atualizar lê todos)">
      ${st.lendo ? '<span class="spinner" aria-hidden="true"></span> Lendo…' : `${ICONE.msgs} Ler este grupo`}</button>
    <span class="gp-ler-res ${st.cls ?? ''}" aria-live="polite">${esc(st.texto ?? '')}</span>`;
}

async function lerProjeto(empresa, projeto, jids) {
  const k = chaveGrupo(empresa, projeto);
  _lendoProjeto.set(k, { lendo: true });
  render();
  let st;
  try {
    const r = await fetch(`${API}/ler`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grupos: jids }) });
    const dados = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(dados.erro || `HTTP ${r.status}`);
    const x = resultadoDosGrupos(dados, jids);
    st = {
      texto: `${x.mensagens} mensage${x.mensagens === 1 ? 'm nova' : 'ns novas'}${x.audios ? ` · ${x.audios} áudio${x.audios === 1 ? '' : 's'}` : ''} · ${fmtUSD(x.usd)}${x.aviso ? ` · ${x.aviso}` : ''}`,
      cls: x.aviso ? 'aviso' : '',
    };
  } catch (err) {
    st = { texto: `Não deu para ler: ${err.message}`, cls: 'erro' };
  }
  _lendoProjeto.set(k, st);
  await Promise.all([fetchTarefas(), atualizarTagLeitura()]);
  render();
  if (_aba === 'custos') carregarCustos();
}

/** Projeto de verdade do GRUPOS.md (dá para encerrar); Avulso e "(sem projeto)" não. */
function projetoNoGrupos(empresa, projeto) {
  return _paresGrupos.some(p => p.empresa === empresa && p.projeto === projeto);
}

/** "Arquivados": projetos encerrados com as tarefas deles, recolhido. Reabrir devolve o projeto. */
function renderArquivados() {
  const empresas = _arquivados.filter(e => !_filtroEmpresa || e.empresa === _filtroEmpresa);
  const projetos = empresas.flatMap(e => e.projetos.map(p => ({ ...p, empresa: e.empresa })))
    .filter(p => !_filtroProjeto || p.projeto === _filtroProjeto);
  if (!projetos.length) return '';
  const itens = projetos.map(p => {
    const chave = chaveGrupo(p.empresa, p.projeto);
    const tarefas = _tarefasArquivadas.filter(t => t.empresa === p.empresa && t.projeto === p.projeto && t.estado !== 'descartada');
    return `<div class="arq-projeto">
      <div class="arq-linha">
        <span class="arq-nome">${esc(p.empresa)} · ${esc(p.projeto)}</span>
        <span class="gp-ganho" title="Ganho total do projeto">${p.ganho ? fmtGanho(p.ganho) : 'sem ganho'}</span>
        ${periodoProjeto(p)}
        <button class="btn btn-ghost btn-sm" type="button" data-reabrir-empresa="${esc(p.empresa)}" data-reabrir-projeto="${esc(p.projeto)}"
          aria-label="Reabrir o projeto ${esc(p.empresa)} · ${esc(p.projeto)}">Reabrir</button>
      </div>
      ${tarefas.length ? `<details class="secao-feitas" data-arq="${esc(chave)}" ${_arquivadosAbertos.has(chave) ? 'open' : ''}>
        <summary>Tarefas <span class="gp-conta">${tarefas.length}</span></summary>
        <ul class="arq-tarefas">${tarefas.map(t => `<li class="${t.estado === 'feita' ? 'feita' : ''}">
          <span class="chip chip-estado-${esc(t.estado)}">${esc(labelEstado(t.estado))}</span> ${esc(t.titulo || '(sem título)')}</li>`).join('')}</ul>
      </details>` : '<p class="gp-vazio">Sem tarefas.</p>'}
    </div>`;
  }).join('');
  return `<details class="secao-arquivados" data-arq="__todos" ${_arquivadosAbertos.has('__todos') ? 'open' : ''}>
    <summary>${ICONE.arquivar} Arquivados <span class="gp-conta">${projetos.length}</span></summary>
    <div class="arq-lista">${itens}</div>
  </details>`;
}

/** Barra lateral (desktop) / chips (celular): cada empresa com a contagem de abertas. */
function renderNav(itens) {
  $nav.innerHTML = itens.length ? `<p class="nav-titulo">Clientes</p><ul class="nav-lista">${itens.map(i => `
    <li><button class="nav-item ${_empresasAbertas.has(i.empresa) ? 'aberta' : ''}" type="button"
        data-ir-empresa="${esc(i.empresa)}" data-ir-secao="${i.idSecao}" data-drop-empresa="${esc(i.empresa)}">
      <span class="nav-nome">${esc(i.empresa)}</span><span class="nav-conta" title="Abertas">${i.abertas}</span>
    </button></li>`).join('')}</ul>` : '';
  const visiveis = itens.map(i => i.empresa);
  const todasAbertas = visiveis.length > 0 && visiveis.every(e => _empresasAbertas.has(e));
  $recolher.textContent = todasAbertas ? 'Recolher tudo' : 'Expandir tudo';
  $recolher.dataset.acao = todasAbertas ? 'recolher' : 'expandir';
  $recolher.hidden = !visiveis.length;
}

function alternarEmpresa(empresa, abrir = !_empresasAbertas.has(empresa)) {
  if (abrir) _empresasAbertas.add(empresa); else _empresasAbertas.delete(empresa);
  salvarAbertas();
}

function renderFeita(t) {
  return `
  <div class="tarefa-compacta feita" data-id="${esc(t.id)}">
    <label class="t-check" title="Desmarcar volta para Pra fazer">
      <input type="checkbox" checked data-check-id="${esc(t.id)}" aria-label="Desmarcar ${esc(t.titulo)}">
    </label>
    <span class="t-titulo">${esc(t.titulo)}</span>
  </div>`;
}

function renderTarefa(t) {
  const id = esc(t.id);
  const aberta = _expandidas.has(t.id);
  const limite = t.prazo ? diaISO(t.prazo) : null;
  const opcoes = ESTADOS.map(([v, r]) => `<option value="${v}" ${t.estado === v ? 'selected' : ''}>${r}</option>`).join('');
  const atual = chaveGrupo(t.empresa, t.projeto);
  const pares = paresMover();
  if (t.empresa && t.projeto && !pares.some(p => chaveGrupo(p.empresa, p.projeto) === atual)) pares.unshift({ empresa: t.empresa, projeto: t.projeto });
  const porEmpresa = new Map();
  for (const p of pares) (porEmpresa.get(p.empresa) ?? porEmpresa.set(p.empresa, []).get(p.empresa)).push(p.projeto);
  const opcoesMover = [...porEmpresa].map(([empresa, projetos]) => `<optgroup label="${esc(empresa)}">${projetos.map(projeto => {
    const v = chaveGrupo(empresa, projeto);
    return `<option value="${esc(v)}" ${v === atual ? 'selected' : ''}>${esc(empresa)} · ${esc(projeto)}</option>`;
  }).join('')}</optgroup>`).join('');

  return `
  <article class="tarefa-compacta ${classeUrgencia(t.urgencia ?? 0)} ${aberta ? 'aberta' : ''}" data-id="${id}" aria-label="${esc(t.titulo)}">
    <div class="t-linha" data-drag-id="${id}" draggable="true">
      <label class="t-check" title="Marcar como feita">
        <input type="checkbox" data-check-id="${id}" aria-label="Marcar ${esc(t.titulo)} como feita">
      </label>
      <button class="t-titulo" type="button" data-expand-id="${id}" aria-expanded="${aberta}" aria-controls="detalhes-${id}">${esc(t.titulo || '(sem título)')}</button>
      <span class="t-info">
        <span class="t-meta">${esc(t.empresa || '–')} · ${esc(t.projeto || '–')}</span>
        <span class="chip chip-estado-${esc(t.estado)}">${esc(labelEstado(t.estado))}</span>
        <span class="t-prazo ${venceLogo(limite) ? 'vence' : ''}" title="Prazo da tarefa">${limite ? esc(fmtData(limite) ?? t.prazo) : 'sem prazo'}</span>
      </span>
      <button class="btn-expandir" type="button" data-expand-id="${id}" aria-label="${aberta ? 'Recolher' : 'Expandir'} detalhes" aria-expanded="${aberta}">${ICONE.chevron}</button>
    </div>

    <div class="t-detalhes" id="detalhes-${id}" ${aberta ? '' : 'hidden'}>
      ${t.descricao ? `<p class="tarefa-descricao">${esc(t.descricao)}</p>` : ''}
      ${t.faltando?.length ? `<div class="tarefa-faltando"><strong>Falta:</strong> ${esc(t.faltando.join(' · '))}</div>` : ''}
      ${t.destino ? `<div class="tarefa-destino">Distribuída para ${esc(t.destino.nome ?? t.destino.alvo)} (${esc(t.destino.tipo)})</div>` : ''}

      <div class="t-campos">
        <label class="campo">Título
          <input type="text" data-campo="titulo" data-id="${id}" value="${esc(t.titulo)}" autocomplete="off">
        </label>
        <label class="campo">Estado
          <select data-campo="estado" data-id="${id}">${opcoes}</select>
        </label>
        <label class="campo campo-mover">Mover para…
          <select data-mover-id="${id}">${opcoesMover}</select>
        </label>
      </div>
      ${t.movidaDe ? `<p class="campo-dica">Movida de ${esc(t.movidaDe.empresa ?? '–')} · ${esc(t.movidaDe.projeto ?? '–')}</p>` : ''}
      <p class="campo-dica">Ganho, início e fim são do projeto — edite na aba Projetos.</p>

      <div class="tarefa-actions">
        <button class="btn btn-primary" type="button" data-dist-id="${id}">${ICONE.enviar} Distribuir</button>
        <button class="mensagens-toggle" type="button" data-msg-id="${id}" data-chat-id="${esc(t.chatId ?? '')}" aria-expanded="false">${ICONE.msgs} Mensagens-fonte</button>
      </div>
      <div class="mensagens-lista" id="msgs-${id}"></div>
    </div>
  </article>`;
}

// ── Eventos (delegação no <main>, sobrevive ao re-render) ─
$main.addEventListener('click', async e => {
  const toggle = e.target.closest('[data-toggle-empresa]');
  if (toggle) {
    alternarEmpresa(toggle.dataset.toggleEmpresa);
    render();
    $main.querySelector(`[data-toggle-empresa="${CSS.escape(toggle.dataset.toggleEmpresa)}"]`)?.focus();
    return;
  }

  const expandir = e.target.closest('[data-expand-id]');
  if (expandir) {
    const id = expandir.dataset.expandId;
    const card = expandir.closest('.tarefa-compacta');
    const detalhes = document.getElementById('detalhes-' + id);
    const abrir = detalhes.hidden;
    detalhes.hidden = !abrir;
    card.classList.toggle('aberta', abrir);
    card.querySelectorAll('[data-expand-id]').forEach(b => b.setAttribute('aria-expanded', String(abrir)));
    if (abrir) _expandidas.add(id); else _expandidas.delete(id);
    return;
  }

  const ler = e.target.closest('[data-ler-jids]');
  if (ler) {
    await lerProjeto(ler.dataset.lerEmpresa, ler.dataset.lerProjeto, ler.dataset.lerJids.split(',').filter(Boolean));
    return;
  }

  const arquivar = e.target.closest('[data-arquivar-empresa]');
  if (arquivar) {
    await encerrarProjeto(arquivar.dataset.arquivarEmpresa, arquivar.dataset.arquivarProjeto);
    return;
  }
  const reabrir = e.target.closest('[data-reabrir-empresa]');
  if (reabrir) {
    reabrir.disabled = true;
    if (!(await definirStatusProjeto(reabrir.dataset.reabrirEmpresa, reabrir.dataset.reabrirProjeto, 'ativo'))) reabrir.disabled = false;
    return;
  }

  const dist = e.target.closest('[data-dist-id]');
  if (dist) {
    await abrirDistribuir(dist.dataset.distId);
    return;
  }

  const msgBtn = e.target.closest('[data-msg-id]');
  if (msgBtn) await alternarMensagens(msgBtn);
});

// Lembra quais seções "Feitas" estão abertas (o polling redesenha a lista).
$main.addEventListener('toggle', e => {
  const arq = e.target.closest?.('[data-arq]');
  if (arq && e.target === arq) {
    if (arq.open) _arquivadosAbertos.add(arq.dataset.arq); else _arquivadosAbertos.delete(arq.dataset.arq);
    return;
  }
  const d = e.target.closest?.('[data-feitas]');
  if (!d) return;
  if (d.open) _feitasAbertas.add(d.dataset.feitas); else _feitasAbertas.delete(d.dataset.feitas);
}, true);

$main.addEventListener('change', async e => {
  const chk = e.target.closest('[data-check-id]');
  if (chk) {
    const estado = chk.checked ? 'feita' : 'pronta';
    chk.disabled = true;
    try {
      await patchTarefa(chk.dataset.checkId, { estado });
      if (estado === 'feita') _expandidas.delete(chk.dataset.checkId);
      chk.blur();
      await fetchTarefas();
    } catch (err) {
      chk.checked = !chk.checked;
      chk.disabled = false;
      toast('Erro: ' + err.message, 'erro');
    }
    return;
  }

  const mover = e.target.closest('[data-mover-id]');
  if (mover) {
    const [empresa, projeto] = mover.value.split('\t');
    mover.disabled = true;
    const ok = await moverTarefa(mover.dataset.moverId, empresa, projeto);
    if (!ok) { mover.disabled = false; mover.value = chaveGrupo(...tarefaPorId(mover.dataset.moverId)); }
    return;
  }

  const campoEl = e.target.closest('[data-campo]');
  if (!campoEl) return;
  const { campo, id } = campoEl.dataset;
  const valor = campoEl.value.trim();
  let payload;
  if (campo === 'titulo') { if (!valor) return; payload = { titulo: valor }; }
  else payload = { [campo]: valor };

  campoEl.disabled = true;
  try {
    await patchTarefa(id, payload);
    toast(campo === 'estado' ? `Estado: ${labelEstado(valor)}` : 'Salvo');
    campoEl.disabled = false;
    campoEl.blur();
    await fetchTarefas();
  } catch (err) {
    campoEl.disabled = false;
    toast('Erro ao salvar: ' + err.message, 'erro');
  }
});

// ── Mover tarefa (seletor ou arrastar) ────────────────────
function tarefaPorId(id) {
  const t = _tarefas.find(x => x.id === id);
  return [t?.empresa, t?.projeto];
}

async function moverTarefa(id, empresa, projeto) {
  const [deE, deP] = tarefaPorId(id);
  if (!empresa || !projeto || (empresa === deE && projeto === deP)) return true;
  try {
    await patchTarefa(id, { empresa, projeto });
    // Abre o destino para a tarefa movida continuar à vista.
    alternarEmpresa(empresa, true);
    if (document.activeElement && $main.contains(document.activeElement)) document.activeElement.blur();
    toast(`Movida para ${empresa} · ${projeto}`);
    await fetchTarefas();
    return true;
  } catch (err) {
    toast('Erro ao mover: ' + err.message, 'erro');
    return false;
  }
}

// Arrastar: card → cabeçalho de projeto (move); → empresa/chip (move se ela tem um só projeto,
// senão expande para mostrar os projetos).
let _expandirTimer = null;
function alvoDrop(el) { return el?.closest?.('[data-drop-empresa]') ?? null; }
function projetoDoAlvo(alvo) {
  if (alvo.dataset.dropProjeto) return alvo.dataset.dropProjeto;
  const projetos = [...new Set(_paresGrupos.filter(p => p.empresa === alvo.dataset.dropEmpresa).map(p => p.projeto))];
  return projetos.length === 1 ? projetos[0] : null;
}
function limparDrop() {
  clearTimeout(_expandirTimer);
  document.querySelectorAll('.drop-alvo').forEach(el => el.classList.remove('drop-alvo'));
}

document.addEventListener('dragstart', e => {
  const card = e.target.closest?.('[data-drag-id]');
  if (!card || !$main.contains(card)) return;
  _arrastando = card.dataset.dragId;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', _arrastando);
  card.closest('.tarefa-compacta')?.classList.add('arrastando');
  document.body.classList.add('arrastando-tarefa');
});
document.addEventListener('dragend', () => {
  document.querySelector('.arrastando')?.classList.remove('arrastando');
  document.body.classList.remove('arrastando-tarefa');
  limparDrop();
  _arrastando = null;
});
document.addEventListener('dragover', e => {
  if (!_arrastando) return;
  const alvo = alvoDrop(e.target);
  if (!alvo) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (alvo.classList.contains('drop-alvo')) return;
  limparDrop();
  alvo.classList.add('drop-alvo');
  // Parar sobre uma empresa recolhida com vários projetos abre ela.
  const empresa = alvo.dataset.dropEmpresa;
  if (!alvo.dataset.dropProjeto && !_empresasAbertas.has(empresa)) {
    _expandirTimer = setTimeout(() => {
      alternarEmpresa(empresa, true);
      const secao = document.querySelector(`[data-toggle-empresa="${CSS.escape(empresa)}"]`)?.closest('.grupo-empresa');
      const corpo = secao?.querySelector('.ge-corpo');
      if (corpo) { corpo.hidden = false; secao.classList.replace('recolhida', 'aberta'); }
      secao?.querySelector('.ge-toggle')?.setAttribute('aria-expanded', 'true');
    }, 600);
  }
});
document.addEventListener('drop', async e => {
  if (!_arrastando) return;
  const alvo = alvoDrop(e.target);
  if (!alvo) return;
  e.preventDefault();
  const id = _arrastando;
  const projeto = projetoDoAlvo(alvo);
  limparDrop();
  if (!projeto) { toast('Solte no cabeçalho de um projeto', 'erro'); return; }
  await moverTarefa(id, alvo.dataset.dropEmpresa, projeto);
});

async function alternarMensagens(btn) {
  const id = btn.dataset.msgId;
  const container = document.getElementById(`msgs-${id}`);
  if (!container) return;
  if (container.classList.contains('aberta')) {
    container.classList.remove('aberta');
    btn.setAttribute('aria-expanded', 'false');
    return;
  }
  btn.disabled = true;
  try {
    const msgs = await fetchMensagens(btn.dataset.chatId);
    container.innerHTML = msgs.length === 0
      ? `<p class="estado-vazio estado-vazio-inline">Nenhuma mensagem encontrada.</p>`
      : msgs.map(m => `
        <div class="msg-item">
          <div class="msg-meta">
            <span>${esc(m.autor ?? '?')}</span>
            <span>${m.ts ? new Date(m.ts).toLocaleString('pt-BR') : ''}</span>
          </div>
          <div class="msg-texto">${esc(m.texto || m.transcricao || '(sem texto)')}</div>
        </div>`).join('');
  } catch {
    container.innerHTML = `<p class="estado-vazio estado-vazio-inline erro">Erro ao carregar mensagens.</p>`;
  } finally {
    container.classList.add('aberta');
    btn.setAttribute('aria-expanded', 'true');
    btn.disabled = false;
  }
}

// ── Modal distribuir ──────────────────────────────────────
document.getElementById('modal-cancelar').addEventListener('click', fecharModal);
$overlay.addEventListener('click', e => { if (e.target === $overlay) fecharModal(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $overlay.classList.contains('aberto')) fecharModal();
});

let _focoAntesDoModal = null;

function fecharModal() {
  // Tira o foco de dentro antes de esconder (aria-hidden não pode cobrir o elemento focado).
  if ($overlay.contains(document.activeElement)) document.activeElement.blur();
  if (_focoAntesDoModal?.isConnected) _focoAntesDoModal.focus();
  _focoAntesDoModal = null;
  $overlay.classList.remove('aberto');
  $overlay.setAttribute('aria-hidden', 'true');
  _tarefaDistribuindo = null;
}

const TIPO_DESTINO = { webhook: 'Webhook', agente: 'Agente', comando: 'Comando' };

async function abrirDistribuir(id) {
  _tarefaDistribuindo = id;
  _focoAntesDoModal = document.activeElement;
  const t = _tarefas.find(x => x.id === id);
  document.getElementById('dist-tarefa').textContent = t?.titulo ?? '';
  const $confirmar = document.getElementById('modal-confirmar');
  $destinos.innerHTML = `<div class="skeleton-line lg"></div>`;
  $confirmar.disabled = true;
  $overlay.classList.add('aberto');
  $overlay.removeAttribute('aria-hidden');
  try {
    const { arquivo, destinos } = await fetchDestinos();
    document.getElementById('dist-arquivo').textContent = arquivo;
    if (!destinos.length) {
      $destinos.innerHTML = `<p class="estado-vazio estado-vazio-inline">Nenhum destino em DESTINOS.md. Copie o DESTINOS.exemplo.md e configure.</p>`;
      return;
    }
    $destinos.innerHTML = destinos.map((d, i) => `
      <label class="destino">
        <input type="radio" name="destino" value="${esc(d.nome)}" ${i === 0 ? 'checked' : ''}>
        <span class="destino-nome">${esc(d.nome)}</span>
        <span class="chip chip-destino-${esc(d.tipo)}">${esc(TIPO_DESTINO[d.tipo] ?? d.tipo)}</span>
        <span class="destino-alvo" title="${esc(d.alvo)}">${esc(d.alvo)}</span>
      </label>`).join('');
    $confirmar.disabled = false;
    $destinos.querySelector('input')?.focus();
  } catch (err) {
    $destinos.innerHTML = `<p class="estado-vazio estado-vazio-inline erro">Erro ao ler destinos: ${esc(err.message)}</p>`;
  }
}

document.getElementById('modal-confirmar').addEventListener('click', async () => {
  if (!_tarefaDistribuindo) return;
  const nome = $destinos.querySelector('input[name="destino"]:checked')?.value;
  if (!nome) return;

  const btn = document.getElementById('modal-confirmar');
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner" aria-hidden="true"></span> Enviando…`;
  try {
    await distribuirTarefa(_tarefaDistribuindo, nome);
    toast(`Na fila para ${nome}`);
    fecharModal();
    await fetchTarefas();
  } catch (e) {
    toast('Erro ao distribuir: ' + e.message, 'erro');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `${ICONE.enviar} Enviar`;
  }
});

// ── Abas ──────────────────────────────────────────────────
const $abas = { tarefas: document.getElementById('aba-tarefas'), projetos: document.getElementById('aba-projetos'), custos: document.getElementById('aba-custos') };
const $views = { tarefas: document.getElementById('view-tarefas'), projetos: document.getElementById('projetos'), custos: document.getElementById('custos') };
const ORDEM_ABAS = Object.keys($abas);
let _aba = 'tarefas';

function mostrarAba(nome, focar = true) {
  _aba = nome;
  for (const [k, $b] of Object.entries($abas)) {
    const ativa = k === nome;
    $b.setAttribute('aria-selected', String(ativa));
    $b.tabIndex = ativa ? 0 : -1;
    $views[k].hidden = !ativa;
  }
  if (focar) $abas[nome].focus();
  history.replaceState(null, '', nome === 'tarefas' ? location.pathname : `#${nome}`);
  if (nome === 'projetos') carregarProjetos();
  if (nome === 'custos') { carregarCustos(); carregarConfigIA(); }
}

for (const [k, $b] of Object.entries($abas)) {
  $b.addEventListener('click', () => mostrarAba(k, false));
  $b.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const i = ORDEM_ABAS.indexOf(k) + (e.key === 'ArrowRight' ? 1 : -1);
    mostrarAba(ORDEM_ABAS[(i + ORDEM_ABAS.length) % ORDEM_ABAS.length]);
  });
}

// ── Aba Projetos (GRUPOS.md editável) ─────────────────────
// Estado local da tabela; só vai para o arquivo no "Salvar" (PUT /api/projetos).
const $pjCorpo = document.getElementById('pj-corpo');
const $pjErros = document.getElementById('pj-erros');
const $pjStatus = document.getElementById('pj-status');
const $pjSalvar = document.getElementById('pj-salvar');
const $pjDescartar = document.getElementById('pj-descartar');
const CAMPOS_PJ = ['empresa', 'projeto', 'link', 'ganho', 'inicio', 'fim', 'tipo', 'status'];
const TIPOS_PJ = ['cliente', 'despejo', 'interno'];
const arquivada = l => String(l.status ?? '').toLowerCase() === 'arquivado';

const _pj = { linhas: [], versao: null, arquivo: '', avisos: [], sujo: false, erros: [], carregado: false };
let _pjAlvo = null;          // índice da linha que está escolhendo grupo

function marcarSujo(sujo = true) {
  _pj.sujo = sujo;
  $pjSalvar.disabled = !sujo;
  $pjDescartar.hidden = !sujo;
  $pjStatus.textContent = sujo ? 'Alterações não salvas' : '';
  $pjStatus.className = `pj-status ${sujo ? 'sujo' : ''}`;
}

function aplicarEstado(dados) {
  // Arquivo pode ter dd/mm/aaaa e ganho sem centavos: mostra já no formato das máscaras.
  _pj.linhas = dados.linhas.map(l => ({
    ...l, inicio: dataCurta(l.inicio), fim: dataCurta(l.fim), ganho: moedaDoArquivo(l.ganho),
    status: arquivada(l) ? 'arquivado' : 'ativo',
  }));
  _pj.versao = dados.versao;
  _pj.nomesPendentes = Boolean(dados.nomesPendentes);
  _pj.arquivo = dados.arquivo;
  _pj.avisos = dados.avisos ?? [];
  _pj.erros = [];
  _pj.carregado = true;
  document.getElementById('pj-caminho').textContent = dados.arquivo;
  marcarSujo(false);
  renderProjetos();
}

/** Relê o GRUPOS.md. Nunca passa por cima de alteração não salva. */
async function carregarProjetos({ silencioso = false } = {}) {
  if (_pj.sujo && !silencioso) return;
  if (!silencioso && !_pj.carregado) $pjCorpo.innerHTML = `<div class="skeleton"><div class="skeleton-line lg"></div><div class="skeleton-line med"></div></div>`;
  try {
    const r = await fetch(`${API}/projetos`);
    const dados = await r.json();
    if (!r.ok) throw new Error(dados.erro || `HTTP ${r.status}`);
    if (dados.nomesPendentes) setTimeout(() => carregarProjetos({ silencioso: true }), 3000);
    if (_pj.sujo) { completarNomes(dados); return; }
    if (silencioso && assinatura(dados) === assinatura(_pj)) return;
    // Não redesenha por baixo de quem está digitando.
    if (silencioso && $views.projetos.contains(document.activeElement) && document.activeElement !== document.body) return;
    aplicarEstado(dados);
  } catch (e) {
    if (!silencioso) $pjCorpo.innerHTML = `<p class="estado-vazio estado-vazio-inline erro">Erro ao ler GRUPOS.md: ${esc(e.message)}</p>`;
  }
}

/** Com edição pendente, só preenche o nome do grupo que chegou da Evolution (não mexe no que foi digitado). */
function completarNomes(dados) {
  const nomes = new Map(dados.linhas.filter(l => l.jid && l.grupoNome).map(l => [l.jid.toLowerCase(), l.grupoNome]));
  let mudou = _pj.nomesPendentes !== Boolean(dados.nomesPendentes);
  _pj.nomesPendentes = Boolean(dados.nomesPendentes);
  for (const l of _pj.linhas) {
    const nome = !l.grupoNome && nomes.get(String(l.link ?? '').trim().toLowerCase());
    if (nome) { l.grupoNome = nome; mudou = true; }
  }
  if (mudou && !$views.projetos.contains(document.activeElement)) renderProjetos();
}

/** Muda quando o arquivo muda ou quando chegam nomes de grupo da Evolution. */
const assinatura = d => `${d.versao}|${d.linhas.map(l => l.grupoNome ?? '').join('|')}`;

function erroDe(i, campo) {
  return _pj.erros.find(e => e.linha === i + 1 && e.campo === campo);
}

function inputPj(i, l, k, attrs = '', cls = '') {
  const erro = erroDe(i, k);
  return `<input class="pj-in ${cls}" data-i="${i}" data-k="${k}" value="${esc(l[k])}" autocomplete="off" ${attrs}
    ${erro ? `aria-invalid="true" title="${esc(erro.msg)}"` : ''}>`;
}

function renderProjetos() {
  const avisos = _pj.avisos.length && !_pj.sujo
    ? `<ul class="grupos-avisos" role="alert">${_pj.avisos.map(a => `<li>${esc(a)}</li>`).join('')}</ul>` : '';
  $pjErros.innerHTML = _pj.erros.length
    ? `<ul class="pj-erros" role="alert">${_pj.erros.map(e => `<li>Linha ${e.linha}: ${esc(e.msg)}</li>`).join('')}</ul>` : '';

  if (!_pj.linhas.length) {
    $pjCorpo.innerHTML = `${avisos}<p class="estado-vazio estado-vazio-inline">Nenhum projeto ainda. Use "Ligar grupo" para o primeiro grupo do WhatsApp ou "Novo cliente/projeto" para um projeto sem grupo.</p>`;
    return;
  }

  const linhaHtml = (l, i) => {
    const interno = l.tipo === 'interno';
    const nome = interno ? 'Sem grupo (projeto interno)'
      : l.grupoNome || (!l.link ? 'Sem grupo — recebe tarefas pelo despejo'
        : _pj.nomesPendentes ? 'Buscando nome do grupo…' : 'Grupo sem nome conhecido');
    const tipos = TIPOS_PJ.map(t => `<option value="${t}" ${l.tipo === t ? 'selected' : ''}>${t}</option>`).join('');
    const rotulo = `${l.empresa || 'sem empresa'} · ${l.projeto || 'sem projeto'}`;
    return `<tr data-linha="${i}" class="${_pj.erros.some(e => e.linha === i + 1) ? 'com-erro' : ''}">
      <td class="pj-num" data-rotulo="#">${i + 1}</td>
      <td data-rotulo="Empresa">${inputPj(i, l, 'empresa', `aria-label="Empresa da linha ${i + 1}" placeholder="Empresa"`)}</td>
      <td data-rotulo="Projeto">${inputPj(i, l, 'projeto', `aria-label="Projeto da linha ${i + 1}" placeholder="Projeto"`)}</td>
      <td class="pj-col-grupo" data-rotulo="Grupo">
        <div class="pj-grupo">
          <span class="pj-grupo-nome ${l.grupoNome && !interno ? '' : 'sem-nome'}">${esc(nome)}</span>
          ${interno ? '' : `<div class="pj-grupo-linha">
            ${inputPj(i, l, 'link', `aria-label="jid ou link do grupo da linha ${i + 1}" placeholder="1203…@g.us ou https://chat.whatsapp.com/…" spellcheck="false"`, 'mono')}
            <button class="btn btn-ghost btn-sm" type="button" data-acao="trocar-grupo" data-i="${i}" aria-label="${l.link ? 'Trocar' : 'Escolher'} grupo de ${esc(rotulo)}">${l.link ? 'Trocar' : 'Escolher'}</button>
          </div>`}
        </div>
      </td>
      <td data-rotulo="Ganho total (R$)">${inputPj(i, l, 'ganho', `inputmode="numeric" aria-label="Ganho total em reais da linha ${i + 1}" placeholder="0,00"`, 'num')}</td>
      <td data-rotulo="Início">${inputPj(i, l, 'inicio', `inputmode="numeric" maxlength="8" aria-label="Início da linha ${i + 1} (dd/mm/aa)" placeholder="dd/mm/aa"`, 'data')}</td>
      <td data-rotulo="Fim">${inputPj(i, l, 'fim', `inputmode="numeric" maxlength="8" aria-label="Fim da linha ${i + 1} (dd/mm/aa)" placeholder="dd/mm/aa"`, 'data')}</td>
      <td data-rotulo="Tipo"><select class="pj-in" data-i="${i}" data-k="tipo" aria-label="Tipo da linha ${i + 1}" ${erroDe(i, 'tipo') ? 'aria-invalid="true"' : ''}>${tipos}</select></td>
      <td class="pj-col-remover"><div class="pj-acoes-linha">
        <button class="btn btn-ghost btn-icone btn-remover btn-arquivar" type="button" data-acao="arquivar" data-i="${i}" aria-label="Encerrar ${esc(rotulo)}" title="Encerrar (arquivar)">${ICONE.arquivar}</button>
        <button class="btn btn-ghost btn-icone btn-remover" type="button" data-acao="remover" data-i="${i}" aria-label="Remover ${esc(rotulo)}" title="Remover">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>
        </button>
      </div></td>
    </tr>`;
  };

  const ativas = _pj.linhas.map((l, i) => [l, i]).filter(([l]) => !arquivada(l));
  const arquivadas = _pj.linhas.map((l, i) => [l, i]).filter(([l]) => arquivada(l));
  const tabela = ativas.length ? `
    <div class="tabela-scroll pj-tabela-wrap">
      <table class="tabela-grupos pj-tabela">
        <thead><tr><th class="pj-num">#</th><th>Empresa</th><th>Projeto</th><th>Grupo</th><th class="num">Ganho total (R$)</th><th>Início</th><th>Fim</th><th>Tipo</th><th><span class="sr-only">Ações</span></th></tr></thead>
        <tbody>${ativas.map(([l, i]) => linhaHtml(l, i)).join('')}</tbody>
      </table>
    </div>` : `<p class="estado-vazio estado-vazio-inline">Nenhum projeto ativo.</p>`;
  const secaoArq = arquivadas.length ? `
    <details class="secao-arquivados pj-arquivados" ${_pjArqAberto ? 'open' : ''}>
      <summary>${ICONE.arquivar} Arquivados <span class="gp-conta">${arquivadas.length}</span></summary>
      <ul class="arq-lista">${arquivadas.map(([l, i]) => `<li class="arq-linha">
        <span class="pj-num">${i + 1}</span>
        <span class="arq-nome">${esc(l.empresa || 'sem empresa')} · ${esc(l.projeto || 'sem projeto')}</span>
        <span class="gp-ganho">${l.ganho ? `R$ ${esc(l.ganho)}` : 'sem ganho'}</span>
        <span class="chip chip-tipo-${esc(l.tipo)}">${esc(l.tipo)}</span>
        <button class="btn btn-ghost btn-sm" type="button" data-acao="reabrir" data-i="${i}"
          aria-label="Reabrir ${esc(l.empresa)} · ${esc(l.projeto)}">Reabrir</button>
      </li>`).join('')}</ul>
    </details>` : '';
  $pjCorpo.innerHTML = `${avisos}${tabela}${secaoArq}`;
}

let _pjArqAberto = false;

$pjCorpo.addEventListener('input', e => {
  const el = e.target.closest('[data-k]');
  if (!el) return;
  const i = Number(el.dataset.i);
  const l = _pj.linhas[i];
  const k = el.dataset.k;
  // Máscaras: data só números com barras automáticas (dd/mm/aa); ganho em reais com centavos.
  if (k === 'inicio' || k === 'fim') el.value = mascaraData(el.value);
  if (k === 'ganho') el.value = mascaraMoeda(el.value);
  l[k] = el.value;
  if (k === 'link') l.grupoNome = null;   // link digitado: nome só depois de salvar
  el.removeAttribute('aria-invalid');
  el.removeAttribute('title');
  marcarSujo();
  if (k === 'tipo') {
    // Interno não tem grupo; mudar o tipo redesenha a célula do grupo.
    if (l.tipo === 'interno') { l.link = ''; l.grupoNome = null; }
    _pj.erros = _pj.erros.filter(x => !(x.linha === i + 1 && x.campo === 'link'));
    renderProjetos();
    $pjCorpo.querySelector(`[data-i="${i}"][data-k="tipo"]`)?.focus();
  }
});

// Data incompleta ou impossível: marca ao sair do campo (o servidor valida de novo ao salvar).
$pjCorpo.addEventListener('focusout', e => {
  const el = e.target.closest('[data-k="inicio"], [data-k="fim"]');
  if (!el || dataValida(el.value)) return;
  el.setAttribute('aria-invalid', 'true');
  el.title = 'Data inválida — use dd/mm/aa';
});

$pjCorpo.addEventListener('toggle', e => {
  if (e.target.classList?.contains('pj-arquivados')) _pjArqAberto = e.target.open;
}, true);

$pjCorpo.addEventListener('click', e => {
  const btn = e.target.closest('[data-acao]');
  if (!btn) return;
  const i = Number(btn.dataset.i);
  if (btn.dataset.acao === 'trocar-grupo') abrirEscolherGrupo(i);
  if (btn.dataset.acao === 'remover') pedirRemocao(i);
  if (btn.dataset.acao === 'arquivar') arquivarLinha(i, 'arquivado');
  if (btn.dataset.acao === 'reabrir') arquivarLinha(i, 'ativo');
});

document.getElementById('pj-adicionar').addEventListener('click', () => {
  _pj.linhas.push({ empresa: '', projeto: '', link: '', ganho: '', inicio: '', fim: '', tipo: 'cliente', status: 'ativo', grupoNome: null });
  marcarSujo();
  renderProjetos();
  abrirEscolherGrupo(_pj.linhas.length - 1);
});

// Cliente/projeto sem grupo (grupo é opcional): recebe tarefas pelo despejo; "Escolher" liga um grupo depois.
document.getElementById('pj-novo').addEventListener('click', () => {
  _pj.linhas.push({ empresa: '', projeto: '', link: '', ganho: '', inicio: '', fim: '', tipo: 'cliente', status: 'ativo', grupoNome: null });
  marcarSujo();
  renderProjetos();
  $pjCorpo.querySelector(`[data-i="${_pj.linhas.length - 1}"][data-k="empresa"]`)?.focus();
});

/**
 * Encerrar/Reabrir pela aba Projetos. Sem alteração pendente vai direto para o arquivo (PATCH);
 * com alteração pendente muda só a linha aqui e entra no próximo "Salvar".
 */
async function arquivarLinha(i, status) {
  const l = _pj.linhas[i];
  if (status === 'arquivado' && !(await confirmar({
    titulo: 'Encerrar projeto?',
    texto: `${l.empresa || 'sem empresa'} · ${l.projeto || 'sem projeto'} vai para Arquivados com as tarefas. O grupo deixa de ser lido e o ganho sai do total. Dá para reabrir depois.`,
    botao: 'Encerrar',
  }))) return;
  if (_pj.sujo || !l.empresa) {
    for (const x of _pj.linhas) if (x.empresa === l.empresa && x.projeto === l.projeto) x.status = status;
    marcarSujo();
    renderProjetos();
    toast(status === 'arquivado' ? 'Encerrado aqui — clique em Salvar para gravar' : 'Reaberto aqui — clique em Salvar para gravar');
    return;
  }
  await definirStatusProjeto(l.empresa, l.projeto || 'Geral', status, _pj.versao);
}

$pjDescartar.addEventListener('click', () => {
  marcarSujo(false);
  _pj.erros = [];
  carregarProjetos();
});

$pjSalvar.addEventListener('click', async () => {
  $pjSalvar.disabled = true;
  $pjSalvar.innerHTML = `<span class="spinner" aria-hidden="true"></span> Salvando…`;
  try {
    const linhas = _pj.linhas.map(l => Object.fromEntries(CAMPOS_PJ.map(k => [k, String(l[k] ?? '').trim()])));
    const invalida = _pj.linhas.findIndex(l => !dataValida(l.inicio) || !dataValida(l.fim));
    if (invalida >= 0) {
      $pjSalvar.disabled = false;
      toast(`Linha ${invalida + 1}: data inválida — use dd/mm/aa`, 'erro');
      $pjCorpo.querySelector(`[data-i="${invalida}"][data-k="${dataValida(_pj.linhas[invalida].inicio) ? 'fim' : 'inicio'}"]`)?.focus();
      return;
    }
    const r = await fetch(`${API}/projetos`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ linhas, versao: _pj.versao }),
    });
    const dados = await r.json().catch(() => ({}));
    if (r.status === 400 && dados.erros) {
      _pj.erros = dados.erros;
      renderProjetos();
      $pjSalvar.disabled = false;
      toast('Corrija as linhas marcadas', 'erro');
      return;
    }
    if (r.status === 409) {
      $pjSalvar.disabled = false;
      $pjStatus.textContent = 'O arquivo mudou fora do painel. Descarte para recarregar.';
      toast(dados.erro || 'GRUPOS.md mudou fora do painel', 'erro');
      return;
    }
    if (!r.ok) throw new Error(dados.erro || `HTTP ${r.status}`);
    aplicarEstado(dados);
    toast('GRUPOS.md salvo — o Balde recarrega sozinho');
    setTimeout(fetchTarefas, 800);   // dá tempo do watcher regravar a config
  } catch (err) {
    $pjSalvar.disabled = false;
    toast('Erro ao salvar: ' + err.message, 'erro');
  } finally {
    $pjSalvar.textContent = 'Salvar';
  }
});

window.addEventListener('beforeunload', e => { if (_pj.sujo) e.preventDefault(); });
window.addEventListener('focus', () => { if (_aba === 'projetos') carregarProjetos({ silencioso: true }); });
setInterval(() => { if (_aba === 'projetos' && !document.hidden) carregarProjetos({ silencioso: true }); }, POLL_MS);

// Confirmação genérica (remover, encerrar). Resolve true só no botão de confirmar.
let _confirmarResolve = null;
function confirmar({ titulo, texto, botao }) {
  document.getElementById('dlg-confirmar-titulo').textContent = titulo;
  document.getElementById('dlg-confirmar-texto').textContent = texto;
  document.getElementById('dlg-confirmar-sim').textContent = botao;
  _confirmarResolve?.(false);
  $dlgConfirmar.showModal();
  return new Promise(resolve => { _confirmarResolve = resolve; });
}
function fecharConfirmar(ok) {
  const r = _confirmarResolve;
  _confirmarResolve = null;
  if ($dlgConfirmar.open) $dlgConfirmar.close();
  r?.(ok);
}
document.getElementById('dlg-confirmar-nao').addEventListener('click', () => fecharConfirmar(false));
document.getElementById('dlg-confirmar-sim').addEventListener('click', () => fecharConfirmar(true));
$dlgConfirmar.addEventListener('close', () => fecharConfirmar(false));

// Remover (com confirmação)
async function pedirRemocao(i) {
  const l = _pj.linhas[i];
  const ok = await confirmar({
    titulo: 'Remover projeto?',
    texto: `${l.empresa || 'sem empresa'} · ${l.projeto || 'sem projeto'}${l.grupoNome ? ` (${l.grupoNome})` : ''} sai da tabela. O grupo deixa de entrar no Balde quando você salvar.`,
    botao: 'Remover',
  });
  if (!ok) return;
  _pj.linhas.splice(i, 1);
  _pj.erros = [];
  marcarSujo();
  renderProjetos();
  $pjSalvar.focus();
}

// ── Encerrar / reabrir projeto (GB-41) ────────────────────
/** PATCH /api/projetos/:chave { status }. Atualiza Tarefas e Projetos. true = deu certo. */
async function definirStatusProjeto(empresa, projeto, status, versao) {
  try {
    const r = await fetch(`${API}/projetos/${encodeURIComponent(`${empresa}\t${projeto}`)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(versao ? { status, versao } : { status }),
    });
    const dados = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(dados.erro || `HTTP ${r.status}`);
    if (!_pj.sujo) aplicarEstado(dados);
    toast(status === 'arquivado' ? `${empresa} · ${projeto} encerrado — está em Arquivados` : `${empresa} · ${projeto} reaberto`);
    await fetchTarefas();
    setTimeout(fetchTarefas, 800);   // o watcher regrava a config em seguida
    return true;
  } catch (err) {
    toast('Erro: ' + err.message, 'erro');
    return false;
  }
}

async function encerrarProjeto(empresa, projeto) {
  const ok = await confirmar({
    titulo: 'Encerrar projeto?',
    texto: `${empresa} · ${projeto} vai para Arquivados com as tarefas. O grupo deixa de ser lido e o ganho sai do total. Dá para reabrir depois.`,
    botao: 'Encerrar',
  });
  if (ok) await definirStatusProjeto(empresa, projeto, 'arquivado');
}

// Escolher / trocar o grupo de uma linha (busca na Evolution, só leitura)
const $buscaRes = document.getElementById('grupos-busca-resultado');
const _achados = new Map();   // jid → grupo da última busca

function abrirEscolherGrupo(i) {
  _pjAlvo = i;
  const l = _pj.linhas[i];
  document.getElementById('dlg-grupo-alvo').textContent = l.empresa || l.projeto
    ? `Para a linha ${i + 1}: ${l.empresa || '…'} · ${l.projeto || '…'}` : `Para a linha ${i + 1} (nova)`;
  $buscaRes.innerHTML = '';
  const $q = document.getElementById('grupos-busca');
  $q.value = l.empresa || '';
  $dlgGrupo.showModal();
  $q.focus();
  $q.select();
}

function itemBusca(g) {
  _achados.set(g.jid, g);
  const outra = _pj.linhas.findIndex((l, i) => i !== _pjAlvo && String(l.link ?? '').trim().toLowerCase() === g.jid.toLowerCase());
  return `<li class="busca-item" data-jid="${esc(g.jid)}">
    <div>
      <div class="busca-nome">${esc(g.nome || '(sem nome)')}${g.tamanho ? ` · ${g.tamanho} pessoas` : ''}</div>
      <div class="busca-jid">${esc(g.jid)}</div>
    </div>
    <button class="btn ${outra >= 0 ? 'btn-ghost' : 'btn-primary'}" type="button" data-acao="usar-grupo" ${outra >= 0 ? 'disabled' : ''}>
      ${outra >= 0 ? `Já na linha ${outra + 1}` : 'Usar este'}
    </button>
  </li>`;
}

document.getElementById('grupos-busca-form').addEventListener('submit', async e => {
  e.preventDefault();
  const q = document.getElementById('grupos-busca').value.trim();
  if (!q) return;
  $buscaRes.innerHTML = `<div class="skeleton"><div class="skeleton-line med"></div></div>`;
  try {
    const r = await fetch(`${API}/grupos/buscar?q=${encodeURIComponent(q)}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.erro || `HTTP ${r.status}`);
    _achados.clear();
    $buscaRes.innerHTML = data.resultados.map(({ termo, grupos }) => `
      <p class="busca-termo">"${esc(termo)}" — ${grupos.length} grupo(s)</p>
      <ul class="busca-grupos">${grupos.map(itemBusca).join('')}</ul>`).join('')
      + data.naoEncontrados.map(t => `<p class="busca-termo erro">"${esc(t)}" não encontrado — o número não está nesse grupo.</p>`).join('');
  } catch (err) {
    $buscaRes.innerHTML = `<p class="estado-vazio estado-vazio-inline erro">Erro na busca: ${esc(err.message)}</p>`;
  }
});

$buscaRes.addEventListener('click', e => {
  const btn = e.target.closest('[data-acao="usar-grupo"]');
  if (!btn || _pjAlvo === null) return;
  const g = _achados.get(btn.closest('.busca-item').dataset.jid);
  const l = _pj.linhas[_pjAlvo];
  l.link = g.jid;
  l.grupoNome = g.nome || null;
  if (!l.empresa && g.empresa) l.empresa = g.empresa;
  if (!l.projeto && g.projeto) l.projeto = g.projeto;
  _pj.erros = _pj.erros.filter(x => !(x.linha === _pjAlvo + 1 && x.campo === 'link'));
  const alvo = _pjAlvo;
  marcarSujo();
  renderProjetos();
  $dlgGrupo.close();
  $pjCorpo.querySelector(`[data-i="${alvo}"][data-k="${l.empresa ? 'ganho' : 'empresa'}"]`)?.focus();
});

document.getElementById('dlg-grupo-fechar').addEventListener('click', () => $dlgGrupo.close());
$dlgGrupo.addEventListener('close', () => { _pjAlvo = null; });
for (const $d of [$dlgGrupo, $dlgConfirmar]) {
  $d.addEventListener('click', e => { if (e.target === $d) $d.close(); });
}

document.getElementById('pj-abrir').addEventListener('click', async e => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const r = await fetch(`${API}/config/abrir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    toast('GRUPOS.md aberto no editor — salve e o painel relê');
  } catch (err) {
    toast('Erro ao abrir: ' + err.message, 'erro');
  } finally {
    btn.disabled = false;
  }
});

// ── Leitura do WhatsApp e custos (GB-45) ──────────────────
const $tagLeitura = document.getElementById('tag-leitura');
const $btnLer = document.getElementById('btn-ler');
const $lerRes = document.getElementById('ler-resultado');
const $custos = document.getElementById('custos-corpo');
const CHAVE_PERIODO = 'balde.custosPeriodo';
let _periodo = (() => { try { return localStorage.getItem(CHAVE_PERIODO) || 'hoje'; } catch { return 'hoje'; } })();

/** GET /api/uso. 404 = o servidor ainda não registra leituras → null (sem dados). */
async function buscarUso(params = {}) {
  const q = new URLSearchParams(params).toString();
  const r = await fetch(`${API}/uso${q ? `?${q}` : ''}`);
  if (r.status === 404) return null;
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(dados.erro || `HTTP ${r.status}`);
  return normalizarUso(dados);
}

const fmtQuando = ts => {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : `${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
};

async function atualizarTagLeitura() {
  try {
    const uso = await buscarUso(intervalo('mes'));
    let u = uso?.ultima;
    if (!u?.ts) {
      // Leitura sem custo no mês (ou /api/uso ausente): a hora vem de GET /api/ler (dados/leitura.json).
      const r = await fetch(`${API}/ler`).catch(() => null);
      const est = r?.ok ? await r.json().catch(() => null) : null;
      if (est?.ultimaLeitura) u = { ts: est.ultimaLeitura, usd: 0 };
    }
    $tagLeitura.textContent = u?.ts ? `Última leitura ${fmtQuando(u.ts)} · ${fmtUSD(u.usd)}` : 'Última leitura: sem dados';
    $tagLeitura.classList.toggle('sem-dados', !u?.ts);
  } catch {
    $tagLeitura.textContent = 'Última leitura: indisponível';
    $tagLeitura.classList.add('sem-dados');
  }
}

$btnLer.addEventListener('click', async () => {
  $btnLer.disabled = true;
  $btnLer.setAttribute('aria-busy', 'true');
  $lerRes.className = 'ler-resultado';
  $lerRes.textContent = 'Lendo os grupos…';
  try {
    const r = await fetch(`${API}/ler`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const dados = await r.json().catch(() => ({}));
    if (r.status === 404) throw new Error('leitura manual ainda não disponível neste servidor');
    if (!r.ok) throw Object.assign(new Error(dados.erro || `HTTP ${r.status}`), { aviso: r.status === 429 });
    const l = normalizarLeitura(dados);
    $lerRes.textContent = `${l.mensagens} mensage${l.mensagens === 1 ? 'm nova' : 'ns novas'} · ${fmtUSD(l.usd)}${l.aviso ? ` · ${l.aviso}` : ''}`;
    $lerRes.classList.toggle('aviso', Boolean(l.aviso));
    await Promise.all([fetchTarefas(), atualizarTagLeitura()]);
    if (_aba === 'custos') carregarCustos();
  } catch (err) {
    $lerRes.textContent = err.aviso ? err.message : `Não deu para ler: ${err.message}`;
    $lerRes.classList.add(err.aviso ? 'aviso' : 'erro');
  } finally {
    $btnLer.disabled = false;
    $btnLer.removeAttribute('aria-busy');
  }
});

// Filtro de período (Hoje / 7 dias / Mês)
document.querySelectorAll('[data-periodo]').forEach($b => {
  $b.setAttribute('aria-pressed', String($b.dataset.periodo === _periodo));
  $b.addEventListener('click', () => {
    _periodo = $b.dataset.periodo;
    try { localStorage.setItem(CHAVE_PERIODO, _periodo); } catch { /* sem storage */ }
    document.querySelectorAll('[data-periodo]').forEach(x => x.setAttribute('aria-pressed', String(x === $b)));
    carregarCustos();
  });
});

let _custosSeq = 0;   // troca rápida de período: só a resposta do último pedido desenha
async function carregarCustos() {
  const seq = ++_custosSeq;
  const periodo = intervalo(_periodo);
  if (!$custos.children.length) $custos.innerHTML = `<div class="skeleton"><div class="skeleton-line lg"></div><div class="skeleton-line med"></div></div>`;
  try {
    const uso = await buscarUso(periodo);
    if (seq === _custosSeq) renderCustos(uso, periodo);
  } catch (err) {
    if (seq !== _custosSeq) return;
    $custos.innerHTML = `<p class="estado-vazio estado-vazio-inline erro">Erro ao ler os custos: ${esc(err.message)}</p>`;
  }
}

/** Contagem que a API pode não informar (null) → "–". */
const fmtOu = v => (v === null || v === undefined ? '–' : fmtTokens(v));
/** Áudios: contagem quando houver; senão os minutos transcritos. */
const fmtAudio = x => (x.audios !== null && x.audios !== undefined ? fmtTokens(x.audios)
  : x.segundosAudio ? `${fmtTokens(Math.ceil(x.segundosAudio / 60))} min` : '–');

function renderCustos(uso, periodo) {
  if (!uso) {
    $custos.innerHTML = `<div class="estado-vazio">Sem dados de custo ainda. Eles aparecem depois da primeira leitura dos grupos.</div>`;
    return;
  }
  const { total, leituras, porProjeto, porDia } = uso;
  const kpi = (rotulo, valor, dica = '') => `<div class="kpi"><span class="kpi-rotulo">${rotulo}</span><span class="kpi-valor">${valor}</span>${dica ? `<span class="kpi-dica">${dica}</span>` : ''}</div>`;
  const kpis = `<div class="kpis">
    ${kpi('Total', fmtUSD(total.usd), `${leituras.length} leitura${leituras.length === 1 ? '' : 's'}`)}
    ${kpi('Tokens', fmtTokens(total.tokens), total.chamadas !== null ? `${fmtTokens(total.chamadas)} chamada${total.chamadas === 1 ? '' : 's'}` : '')}
    ${total.mensagens !== null
      ? kpi('Mensagens', fmtTokens(total.mensagens), `${fmtAudio(total)} de áudio`)
      : kpi('Áudio transcrito', total.segundosAudio ? `${fmtTokens(Math.ceil(total.segundosAudio / 60))} min` : '0 min')}
    ${kpi('Por mensagem', total.mensagens ? fmtUSD(total.usd / total.mensagens) : '–', total.mensagens === null ? 'a leitura ainda não informa mensagens' : '')}
  </div>`;

  // Gráfico por dia: barras em US$ (rótulo e valor acessíveis em cada barra)
  const dias = preencherDias(porDia, periodo.desde, periodo.ate);
  const max = Math.max(...dias.map(d => d.usd), 0);
  const grafico = dias.length > 1 ? `<section class="custos-bloco" aria-labelledby="c-dia">
    <h2 class="custos-h" id="c-dia">Por dia</h2>
    <ol class="barras" style="--n:${dias.length}">${dias.map(d => {
      const [, m, dia] = d.dia.split('-');
      const h = max ? Math.max(d.usd ? 3 : 0, Math.round((d.usd / max) * 100)) : 0;
      return `<li class="barra" title="${dia}/${m}: ${fmtUSD(d.usd)} · ${fmtTokens(d.tokens)} tokens">
        <span class="barra-col"><span class="barra-fill" style="height:${h}%"></span></span>
        <span class="barra-dia">${dia}/${m}</span>
        <span class="sr-only">${fmtUSD(d.usd)}</span>
      </li>`;
    }).join('')}</ol>
  </section>` : '';

  const ranking = `<section class="custos-bloco" aria-labelledby="c-rank">
    <h2 class="custos-h" id="c-rank">Por empresa · projeto</h2>
    ${porProjeto.length ? `<div class="tabela-scroll"><table class="tabela-grupos tabela-custos">
      <thead><tr><th>Empresa · projeto</th><th class="num">US$</th><th class="num">Tokens</th><th class="num">Chamadas</th><th class="num">Mensagens</th><th class="num">Áudios</th><th class="num">Por mensagem</th></tr></thead>
      <tbody>${porProjeto.map(p => `<tr>
        <td>${esc(p.empresa)} · ${esc(p.projeto)}</td>
        <td class="num">${fmtUSD(p.usd)}</td><td class="num">${fmtTokens(p.tokens)}</td>
        <td class="num">${fmtOu(p.chamadas)}</td><td class="num">${fmtOu(p.mensagens)}</td><td class="num">${fmtAudio(p)}</td>
        <td class="num">${p.porMensagem === null ? '–' : fmtUSD(p.porMensagem)}</td>
      </tr>`).join('')}</tbody>
    </table></div>` : '<p class="gp-vazio">Sem custo por projeto neste período.</p>'}
  </section>`;

  const lista = `<section class="custos-bloco" aria-labelledby="c-leit">
    <h2 class="custos-h" id="c-leit">Leituras</h2>
    ${leituras.length ? `<div class="tabela-scroll"><table class="tabela-grupos tabela-custos">
      <thead><tr><th>Quando</th><th class="num">US$</th><th class="num">Tokens</th><th class="num">Chamadas</th><th class="num">Mensagens</th><th class="num">Áudios</th><th>Aviso</th></tr></thead>
      <tbody>${leituras.map(l => `<tr>
        <td>${esc(fmtQuando(l.ts) || '–')}</td>
        <td class="num">${fmtUSD(l.usd)}</td><td class="num">${fmtTokens(l.tokens)}</td>
        <td class="num">${fmtOu(l.chamadas)}</td><td class="num">${fmtOu(l.mensagens)}</td><td class="num">${fmtAudio(l)}</td>
        <td class="aviso">${esc(l.aviso ?? '')}</td>
      </tr>`).join('')}</tbody>
    </table></div>` : '<p class="gp-vazio">Nenhuma leitura neste período.</p>'}
  </section>`;

  $custos.innerHTML = kpis + grafico + ranking + lista;
}

// ── Configurações da IA (GB-46): GET/PUT /api/config/llm ──
const $cfg = {
  form: document.getElementById('cfg-ia'), extracao: document.getElementById('cfg-extracao'),
  transcricao: document.getElementById('cfg-transcricao'), teto: document.getElementById('cfg-teto'),
  salvar: document.getElementById('cfg-salvar'), status: document.getElementById('cfg-status'),
  tipica: document.getElementById('cfg-tipica'),
};
let _cfg = null;
const fmtPreco = n => `US$ ${Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
const NOME_TRANSCRICAO = { local: 'whisper local (nesta máquina)' };

function renderConfigIA(d) {
  _cfg = d;
  const opcao = (m, rotulo, atual) => `<option value="${esc(m.id)}" ${m.id === atual ? 'selected' : ''} ${m.disponivel || m.id === atual ? '' : 'disabled'}>${esc(rotulo)}</option>`;
  const ex = d.efetivo.modeloExtracao;
  const listaEx = d.opcoes.extracao.some(m => m.id === ex) ? d.opcoes.extracao : [{ id: ex, disponivel: true, fora: true }, ...d.opcoes.extracao];
  $cfg.extracao.innerHTML = listaEx.map(m => opcao(m, m.fora ? `${m.id} (do .env)`
    : `${m.id} · ≈ ${fmtUSD(m.estimativaLeituraUSD)}/leitura${m.disponivel ? '' : ` (${m.motivo})`}`, ex)).join('');
  const tr = d.efetivo.modeloTranscricao;
  const listaTr = d.opcoes.transcricao.some(m => m.id === tr) ? d.opcoes.transcricao : [{ id: tr, disponivel: true, fora: true }, ...d.opcoes.transcricao];
  $cfg.transcricao.innerHTML = listaTr.map(m => opcao(m, m.fora ? `${m.id} (do .env)`
    : `${NOME_TRANSCRICAO[m.id] ?? m.id} · ${m.porMinutoUSD ? `≈ ${fmtUSD(m.estimativaLeituraUSD)}/leitura` : 'grátis'}${m.disponivel ? '' : ` (${m.motivo})`}`, tr)).join('');
  $cfg.teto.value = String(d.efetivo.limiteDiaUSD).replace('.', ',');
  dicasConfigIA();
  document.getElementById('cfg-teto-dica').textContent = `Gasto hoje ${fmtUSD(d.efetivo.gastoHojeUSD)}. Ao atingir, as mensagens ficam pendentes para o dia seguinte.`;
  const t = d.leituraTipica;
  $cfg.tipica.textContent = `Leitura típica (${t.base}): ${t.chamadas} grupo${t.chamadas === 1 ? '' : 's'} com novidade, ${t.mensagens} mensagens, ${String(t.minutosAudio).replace('.', ',')} min de áudio. `
    + `Vale a partir da próxima leitura, sem reiniciar. Fica em ${d.arquivo}.`;
  $cfg.salvar.disabled = true;
}

/** Preço da tabela (lib/llm.mjs) do modelo selecionado, embaixo de cada seletor. */
function dicasConfigIA() {
  if (!_cfg) return;
  const ex = _cfg.opcoes.extracao.find(m => m.id === $cfg.extracao.value);
  const tr = _cfg.opcoes.transcricao.find(m => m.id === $cfg.transcricao.value);
  document.getElementById('cfg-extracao-dica').textContent = (ex
    ? `${fmtPreco(ex.entradaPor1M)} entrada / ${fmtPreco(ex.saidaPor1M)} saída por 1M tokens · ≈ ${fmtUSD(ex.estimativaLeituraUSD)} por leitura típica. `
    : 'Modelo do .env, fora da tabela de preços. ')
    + (_cfg.efetivo.llmLigado ? 'Uma chamada por grupo com mensagem nova.' : 'IA desligada no .env (BALDE_LLM=off): a leitura usa a heurística local, sem custo.');
  document.getElementById('cfg-transcricao-dica').textContent = (tr
    ? (tr.porMinutoUSD ? `${fmtPreco(tr.porMinutoUSD)} por minuto · ≈ ${fmtUSD(tr.estimativaLeituraUSD)} por leitura típica. ` : 'Grátis, roda nesta máquina. ')
    : '') + 'Áudio repetido sai do cache, sem custo.';
}

async function carregarConfigIA() {
  try {
    const r = await fetch(`${API}/config/llm`);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.erro || `HTTP ${r.status}`);
    renderConfigIA(d);
    $cfg.status.textContent = '';
  } catch (err) {
    $cfg.status.textContent = `Não deu para ler as configurações: ${err.message}`;
    $cfg.status.className = 'pj-status erro';
  }
}

$cfg.form.addEventListener('input', () => {
  dicasConfigIA();
  $cfg.salvar.disabled = !_cfg;
  $cfg.status.textContent = 'Alterações não salvas';
  $cfg.status.className = 'pj-status sujo';
});
$cfg.form.addEventListener('submit', async e => {
  e.preventDefault();
  if (!_cfg) return;
  const teto = Number($cfg.teto.value.replace(',', '.'));
  if (!$cfg.teto.value.trim() || !Number.isFinite(teto) || teto < 0 || teto > 50) {
    $cfg.teto.setAttribute('aria-invalid', 'true');
    $cfg.teto.focus();
    toast('Teto diário: use um valor entre 0 e 50 (ex.: 0,50)', 'erro');
    return;
  }
  $cfg.teto.removeAttribute('aria-invalid');
  $cfg.salvar.disabled = true;
  try {
    const r = await fetch(`${API}/config/llm`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modeloExtracao: $cfg.extracao.value, modeloTranscricao: $cfg.transcricao.value, limiteDiaUSD: teto }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.erro || `HTTP ${r.status}`);
    renderConfigIA(d);
    $cfg.status.textContent = 'Salvo — vale na próxima leitura';
    $cfg.status.className = 'pj-status';
    toast('Configurações da IA salvas');
  } catch (err) {
    $cfg.salvar.disabled = false;
    $cfg.status.textContent = `Não salvou: ${err.message}`;
    $cfg.status.className = 'pj-status erro';
  }
});

// ── Filtros ───────────────────────────────────────────────
$sel_e.addEventListener('change', () => {
  _filtroEmpresa = $sel_e.value;
  _filtroProjeto = preencherSelect($sel_p, projetosDe(_filtroEmpresa), 'Todos projetos', _filtroProjeto);
  render();
});
$sel_st.addEventListener('change', () => { _filtroEstado = $sel_st.value; render(); });
$sel_p.addEventListener('change', () => { _filtroProjeto = $sel_p.value; render(); });
document.getElementById('btn-atualizar').addEventListener('click', fetchTarefas);

// ── Recolher/expandir tudo e navegação rápida ─────────────
$recolher.addEventListener('click', () => {
  const abrir = $recolher.dataset.acao !== 'recolher';
  for (const b of $main.querySelectorAll('[data-toggle-empresa]')) alternarEmpresa(b.dataset.toggleEmpresa, abrir);
  render();
});

$nav.addEventListener('click', e => {
  const item = e.target.closest('[data-ir-empresa]');
  if (!item) return;
  alternarEmpresa(item.dataset.irEmpresa, true);
  render();
  const secao = document.getElementById(item.dataset.irSecao);
  secao?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  secao?.querySelector('.ge-toggle')?.focus({ preventScroll: true });
});

// ── Skeletons para o primeiro carregamento ─────────────────
function renderSkeletons(n = 4) {
  $main.innerHTML = Array.from({ length: n }, () => `
    <div class="skeleton" aria-hidden="true">
      <div class="skeleton-line lg"></div>
    </div>`).join('');
}

// ── Polling a cada 10s ─────────────────────────────────────
function iniciarPolling() {
  clearInterval(_pollTimer);
  _pollTimer = setInterval(fetchTarefas, POLL_MS);
  setInterval(() => { if (!document.hidden) atualizarTagLeitura(); }, 60_000);
}

// ── Init ──────────────────────────────────────────────────
(async () => {
  renderSkeletons();
  const hash = location.hash.slice(1);
  mostrarAba(ORDEM_ABAS.includes(hash) ? hash : 'tarefas', false);
  atualizarTagLeitura();
  await fetchTarefas();
  iniciarPolling();
})();
