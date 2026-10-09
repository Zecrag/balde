/**
 * @file datas.mjs — Normalização de prazos e datas relativas para ISO absoluto.
 */

/**
 * Converte um prazo textual ou data relativa em data ISO absoluta (AAAA-MM-DD).
 * Se não houver prazo ou for nulo/vazio, retorna null.
 *
 * @param {string|null} prazo
 * @param {string|Date} [dataBase=new Date()] — data da mensagem
 * @returns {string|null} ISO AAAA-MM-DD ou null
 */
export function calcularPrazoISO(prazo, dataBase = new Date()) {
  if (!prazo) return null;
  const s = String(prazo).toLowerCase().trim();
  if (!s || s === 'null' || s === 'sem prazo' || s === 'nenhum' || s === 'sem data') return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

  const base = typeof dataBase === 'string' ? new Date(dataBase) : (dataBase instanceof Date ? dataBase : new Date());
  if (isNaN(base.getTime())) return null;

  const anoBase = base.getUTCFullYear();
  const mesBase = base.getUTCMonth();
  const diaBase = base.getUTCDate();
  const diaSemana = base.getUTCDay();

  // dd/mm/aaaa ou dd/mm/aa ou dd/mm
  const mData = s.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(20\d{2}|\d{2}))?\b/);
  if (mData) {
    const d = Number(mData[1]);
    const m = Number(mData[2]) - 1;
    let a = mData[3] ? Number(mData[3]) : anoBase;
    if (a < 100) a += 2000;
    return new Date(Date.UTC(a, m, d)).toISOString().slice(0, 10);
  }

  // dia X (ex.: "dia 12", "até dia 12")
  const mDia = s.match(/\bdia\s+(\d{1,2})\b/);
  if (mDia) {
    const d = Number(mDia[1]);
    let m = mesBase;
    let a = anoBase;
    if (d < diaBase) {
      m += 1;
      if (m > 11) { m = 0; a += 1; }
    }
    return new Date(Date.UTC(a, m, d)).toISOString().slice(0, 10);
  }

  // hoje
  if (/\bhoje\b/.test(s)) {
    return new Date(Date.UTC(anoBase, mesBase, diaBase)).toISOString().slice(0, 10);
  }
  // amanhã
  if (/\bamanh[aã]\b/.test(s) && !/\bdepois\b/.test(s)) {
    return new Date(Date.UTC(anoBase, mesBase, diaBase + 1)).toISOString().slice(0, 10);
  }
  // depois de amanhã
  if (/\bdepois\s+de\s+amanh[aã]\b/.test(s)) {
    return new Date(Date.UTC(anoBase, mesBase, diaBase + 2)).toISOString().slice(0, 10);
  }

  // dias da semana ("quinta", "quinta que vem", etc.)
  const diasMapa = {
    domingo: 0,
    segunda: 1,
    terca: 2,
    terça: 2,
    quarta: 3,
    quinta: 4,
    sexta: 5,
    sabado: 6,
    sábado: 6,
  };

  for (const [nomeDia, targetDay] of Object.entries(diasMapa)) {
    const re = new RegExp(`\\b${nomeDia}(?:-feira)?\\b`);
    if (re.test(s)) {
      let diff = targetDay - diaSemana;
      if (diff <= 0) diff += 7;
      if (/\b(que\s+vem|seguinte|outra)\b/.test(s)) {
        diff += 7;
      }
      return new Date(Date.UTC(anoBase, mesBase, diaBase + diff)).toISOString().slice(0, 10);
    }
  }

  return null;
}
