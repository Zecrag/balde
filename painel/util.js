/**
 * util.js — Funções puras do painel (sem DOM): máscaras de data/moeda e leitura do uso da IA.
 * Importado pelo app.js no navegador e pelos testes no Node.
 *
 * GET /api/uso?desde=aaaa-mm-dd&ate=aaaa-mm-dd (lib/leitura.mjs → resumoUso):
 *   { total, porLeitura: { <leituraId>: {…, inicio, grupos} }, porEmpresaProjeto: { "Empresa · Projeto": {…} },
 *     porDia: { "aaaa-mm-dd": {…} } }   com {…} = { custoUSD, chamadas, tokensIn, tokensOut, segundosAudio }
 * Também aceita listas (leituras/porProjeto/porDia como arrays) e nomes curtos (usd, tokens, mensagens,
 * audios). Mensagens e áudios por leitura/projeto vêm do resumoUso (GB-46: contados de leituras.jsonl).
 * POST /api/ler (lerAgora): { leituraId, inicio, fim, custoUSD, chamadas, bloqueadoPorTeto, avisos: [], grupos: [{ novas, audios, … }] }.
 * 404 = servidor sem leitura → painel mostra "sem dados".
 */

// ── Datas dd/mm/aa ────────────────────────────────────────

/** Máscara: só números, barras automáticas, no máximo dd/mm/aa (8 caracteres). */
export function mascaraData(valor) {
  let d = String(valor ?? '').replace(/\D/g, '');
  if (d.length === 8 && d.slice(4, 6) === '20') d = d.slice(0, 4) + d.slice(6);   // colou dd/mm/20aa
  d = d.slice(0, 6);
  if (d.length <= 2) return d;
  if (d.length <= 4) return `${d.slice(0, 2)}/${d.slice(2)}`;
  return `${d.slice(0, 2)}/${d.slice(2, 4)}/${d.slice(4)}`;
}

/** "31/12/2026" → "31/12/26" (o que já vem do arquivo no formato antigo); o resto fica igual. */
export function dataCurta(valor) {
  const s = String(valor ?? '').trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/20(\d{2})$/);
  return m ? `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[3]}` : s;
}

/** '' ou dd/mm/aa de verdade (dia existe) → true. */
export function dataValida(valor) {
  const s = String(valor ?? '').trim();
  if (!s) return true;
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
  if (!m) return false;
  const [d, mes, a] = [Number(m[1]), Number(m[2]), 2000 + Number(m[3])];
  const dt = new Date(Date.UTC(a, mes - 1, d));
  return dt.getUTCFullYear() === a && dt.getUTCMonth() === mes - 1 && dt.getUTCDate() === d;
}

// ── Moeda BR ──────────────────────────────────────────────

/** Máscara de moeda: os dígitos são centavos. "600000" → "6.000,00" · "" → "". */
export function mascaraMoeda(valor) {
  const d = String(valor ?? '').replace(/\D/g, '').replace(/^0+/, '').slice(0, 13);
  if (!d) return '';
  return (Number(d) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Valor do arquivo (6000, "6000", "6.000,00", "6000,5") → "6.000,00"; ilegível volta como veio. */
export function moedaDoArquivo(valor) {
  const s = String(valor ?? '').trim();
  if (!s) return '';
  const n = Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s);
  return Number.isFinite(n) ? n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : s;
}

// ── Uso da IA (aba Custos) ────────────────────────────────

const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const pad = n => String(n).padStart(2, '0');

/** Data local → "aaaa-mm-dd". */
export function diaLocal(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Período do filtro: hoje | 7d (hoje e os 6 dias anteriores) | mes (desde o dia 1). */
export function intervalo(periodo, agora = new Date()) {
  const ate = diaLocal(agora);
  if (periodo === '7d') return { desde: diaLocal(new Date(agora.getFullYear(), agora.getMonth(), agora.getDate() - 6)), ate };
  if (periodo === 'mes') return { desde: diaLocal(new Date(agora.getFullYear(), agora.getMonth(), 1)), ate };
  return { desde: ate, ate };
}

const temNum = v => v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v));
/** Soma um campo dos grupos de uma leitura (grupos: [{ novas, audios }]); null se não houver grupos. */
const somaGrupos = (l, k) => (Array.isArray(l.grupos) ? l.grupos.reduce((t, g) => t + num(g[k]), 0) : null);

function normLeitura(l) {
  const avisos = Array.isArray(l.avisos) ? l.avisos.filter(Boolean) : [];
  const msgs = l.mensagens ?? l.mensagensNovas ?? l.novas ?? somaGrupos(l, 'novas');
  const auds = l.audios ?? somaGrupos(l, 'audios');
  return {
    ts: l.ts ?? l.inicio ?? l.fim ?? l.em ?? null,
    usd: num(l.usd ?? l.custoUSD ?? l.custo),
    tokens: num(l.tokens ?? num(l.tokensIn ?? l.entrada) + num(l.tokensOut ?? l.saida)),
    chamadas: temNum(l.chamadas) ? num(l.chamadas) : null,
    segundosAudio: num(l.segundosAudio),
    mensagens: temNum(msgs) ? num(msgs) : null,     // null = a API não informou
    audios: temNum(auds) ? num(auds) : null,
    aviso: l.aviso ?? l.limite ?? (avisos.length ? avisos.join(' · ') : null) ?? (l.bloqueadoPorTeto ? 'limite do dia atingido' : null),
  };
}

/** Lista ou mapa { chave: valor } → lista, com a chave em `chave`. */
const comoLista = v => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.entries(v).map(([chave, x]) => ({ chave, ...x })) : []);

/** Resposta de GET /api/uso (qualquer dos nomes aceitos) → formato único do painel. */
export function normalizarUso(dados) {
  const d = dados ?? {};
  // "fora-de-leitura" = chamadas pagas sem leitura (backfill etc.): entram no total, não na lista.
  const leituras = comoLista(d.leituras ?? d.porLeitura ?? d.itens)
    .filter(l => l.chave !== 'fora-de-leitura')
    .map(l => ({ id: l.leituraId ?? l.chave ?? null, ...normLeitura(l) }))
    .sort((a, b) => String(b.ts ?? '').localeCompare(String(a.ts ?? '')));

  const somaOuNull = (lista, k) => (lista.some(l => l[k] !== null) ? lista.reduce((t, l) => t + num(l[k]), 0) : null);
  const t = d.total ? normLeitura(d.total) : null;
  const total = {
    usd: t ? t.usd : leituras.reduce((s, l) => s + l.usd, 0),
    tokens: t ? t.tokens : leituras.reduce((s, l) => s + l.tokens, 0),
    chamadas: t?.chamadas ?? somaOuNull(leituras, 'chamadas'),
    segundosAudio: t ? t.segundosAudio : leituras.reduce((s, l) => s + l.segundosAudio, 0),
    mensagens: t?.mensagens ?? somaOuNull(leituras, 'mensagens'),
    audios: t?.audios ?? somaOuNull(leituras, 'audios'),
  };

  const porProjeto = comoLista(d.porEmpresaProjeto ?? d.porProjeto ?? d.projetos ?? d.ranking).map(p => {
    const n = normLeitura(p);
    const [e, ...resto] = String(p.chave ?? '').split(' · ');
    return {
      empresa: p.empresa || e || '(sem empresa)', projeto: p.projeto || resto.join(' · ') || '(sem projeto)',
      usd: n.usd, tokens: n.tokens, chamadas: n.chamadas, segundosAudio: n.segundosAudio,
      mensagens: n.mensagens, audios: n.audios,
      porMensagem: n.mensagens ? n.usd / n.mensagens : null,
    };
  }).sort((a, b) => b.usd - a.usd || b.tokens - a.tokens);

  let porDia;
  if (d.porDia && typeof d.porDia === 'object') {
    porDia = comoLista(d.porDia).map(x => {
      const n = normLeitura(x);
      return { dia: String(x.dia ?? x.chave).slice(0, 10), usd: n.usd, tokens: n.tokens };
    });
  } else {
    const m = new Map();
    for (const l of leituras) {
      if (!l.ts) continue;
      const dia = diaLocal(new Date(l.ts));
      const atual = m.get(dia) ?? { dia, usd: 0, tokens: 0 };
      atual.usd += l.usd; atual.tokens += l.tokens;
      m.set(dia, atual);
    }
    porDia = [...m.values()];
  }
  porDia.sort((a, b) => a.dia.localeCompare(b.dia));

  const ultimaBruta = d.ultima ?? d.ultimaLeitura;
  const ultima = ultimaBruta ? normLeitura(ultimaBruta) : (leituras[0] ?? null);
  return { total, leituras, porProjeto, porDia, ultima };
}

/** Resposta de POST /api/ler → { mensagens, usd, aviso }. */
export function normalizarLeitura(dados) {
  const d = dados ?? {};
  const l = normLeitura(d.leitura ?? d);
  return { mensagens: l.mensagens ?? 0, usd: l.usd, aviso: d.aviso ?? d.limite ?? l.aviso ?? null };
}

/**
 * Resultado de POST /api/ler só para os grupos pedidos ("Ler este grupo"): uma leitura geral em
 * andamento é compartilhada e devolve todos os grupos, então filtra pelos jids.
 * @returns {{ mensagens: number, audios: number, usd: number, tarefas: number, aviso: string|null }}
 */
export function resultadoDosGrupos(dados, jids = []) {
  const d = dados ?? {};
  const gs = (Array.isArray(d.grupos) ? d.grupos : []).filter(g => jids.includes(g?.jid));
  const soma = f => gs.reduce((t, g) => t + num(f(g)), 0);
  const avisos = [];
  if (!gs.length) avisos.push('grupo não está na leitura (salve o projeto e confira o GRUPOS.md)');
  if (gs.some(g => g.iniciado)) avisos.push('primeira leitura deste grupo: conta a partir de agora');
  if (gs.some(g => g.bloqueado)) avisos.push('limite do dia atingido');
  for (const g of gs) if (g.erro) avisos.push(String(g.erro));
  const pend = soma(g => g.pendentes);
  if (pend) avisos.push(`${pend} pendente${pend === 1 ? '' : 's'} para a próxima leitura`);
  return {
    mensagens: soma(g => g.mensagens ?? g.novas),
    audios: soma(g => g.audios),
    usd: soma(g => g.custoUSD),
    tarefas: soma(g => num(g.tarefasNovas) + num(g.atualizadas)),
    aviso: avisos.length ? avisos.join(' · ') : null,
  };
}

/** Dias de `desde` a `ate` (inclusive), com zero onde não houve uso — eixo do gráfico. */
export function preencherDias(porDia, desde, ate) {
  const mapa = new Map(porDia.map(x => [x.dia, x]));
  const out = [];
  const [a, m, d] = desde.split('-').map(Number);
  for (let dt = new Date(a, m - 1, d); diaLocal(dt) <= ate && out.length < 62; dt.setDate(dt.getDate() + 1)) {
    const dia = diaLocal(dt);
    out.push(mapa.get(dia) ?? { dia, usd: 0, tokens: 0 });
  }
  return out;
}

const USD = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const USD_FINO = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
/** US$ 1,23 · abaixo de 1 centavo mostra 4 casas (US$ 0,0021) para não virar "0,00". */
export function fmtUSD(v) {
  const n = num(v);
  return `US$ ${n > 0 && n < 0.01 ? USD_FINO.format(n) : USD.format(n)}`;
}
const TOK = new Intl.NumberFormat('pt-BR');
export const fmtTokens = v => TOK.format(Math.round(num(v)));
