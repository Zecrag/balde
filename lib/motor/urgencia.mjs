/**
 * urgencia.mjs — Cálculo de urgência 0-100.
 *
 * Fórmula:
 *   urgencia = clamp(0, 100,
 *     baseReceita + bonusPrazo + bonusTipo + bonusCobranca
 *   )
 *
 * Onde:
 *   baseReceita   = normalizar(receitaMensal × pesoUrgencia)  → 0-40
 *   bonusPrazo    = proximidade do prazo                       → 0-40
 *   bonusTipo     = tipo do ticket                             → 0-20
 *   bonusCobranca = cliente cobrou andamento/prazo (×10 cada)  → 0-30
 */

/** Pontos de urgência por cobrança registrada na tarefa. */
const PONTOS_COBRANCA = 10;

// ─── Pesos por tipo de ticket ───────────────────────────────────
const PESOS_TIPO = {
  hospedagem:      5,
  boleto:          15,
  operacional:     10,
  desenvolvimento: 8,
  geral:           5,
};

// ─── Mapeamento de prazos textuais ─────────────────────────────
const PRAZOS_TEXTUAIS = {
  'pra ontem':                0,
  'urgente':                  0,
  'asap':                     0,
  'o mais rápido possível':   0,
  'hoje':                     0,
  'fim do dia':               0,
  'amanhã':                   1,
  'segunda':                  null, // calculado pelo dia
  'terça':                    null,
  'quarta':                   null,
  'quinta':                   null,
  'sexta':                    null,
  'sábado':                   null,
  'domingo':                  null,
  'semana que vem':           7,
  'próxima semana':           7,
  'fim do mês':               30,
};

/**
 * Calcula urgência de 0-100 para uma tarefa.
 *
 * @param {Object} params
 * @param {number} params.receitaMensal  — R$ mensal do cliente
 * @param {number} params.pesoUrgencia   — multiplicador de urgência do cliente
 * @param {string|null} params.prazo     — prazo textual ou data
 * @param {string} params.tipo           — tipo do ticket
 * @param {number} [params.cobrancas]    — quantas vezes o cliente cobrou (0-3)
 * @returns {number} urgência 0-100
 */
export function calcularUrgencia({ receitaMensal = 0, pesoUrgencia = 1, prazo = null, tipo = 'geral', cobrancas = 0 }) {
  const baseReceita = calcularBaseReceita(receitaMensal, pesoUrgencia);
  const bonusPrazo  = calcularBonusPrazo(prazo);
  const bonusTipo   = PESOS_TIPO[tipo] ?? PESOS_TIPO.geral;
  const bonusCobranca = clamp(0, 3, Number(cobrancas) || 0) * PONTOS_COBRANCA;

  return clamp(0, 100, Math.round(baseReceita + bonusPrazo + bonusTipo + bonusCobranca));
}

/**
 * Normaliza receita × peso para escala 0-40.
 * Assume que receita ≤ 50_000 R$ é o teto (ajustável).
 */
function calcularBaseReceita(receita, peso) {
  const TETO = 50_000;
  const valor = Math.min(receita * peso, TETO);
  return (valor / TETO) * 40;
}

/**
 * Converte prazo em bonus de urgência 0-40.
 * Quanto mais próximo, maior o bônus.
 */
function calcularBonusPrazo(prazo) {
  if (!prazo) return 10; // sem prazo = urgência moderada base

  const diasRestantes = parsePrazoDias(prazo);
  if (diasRestantes === null) return 10;

  if (diasRestantes <= 0) return 40;   // vencido ou hoje
  if (diasRestantes <= 1) return 35;   // amanhã
  if (diasRestantes <= 3) return 28;   // esta semana
  if (diasRestantes <= 7) return 20;   // próxima semana
  if (diasRestantes <= 14) return 12;
  if (diasRestantes <= 30) return 8;
  return 4;                            // > 30 dias
}

/**
 * Tenta converter prazo em número de dias restantes.
 */
function parsePrazoDias(prazo) {
  if (typeof prazo !== 'string') return null;

  const prazoNorm = prazo.toLowerCase().trim();

  // Prazos textuais conhecidos
  for (const [chave, dias] of Object.entries(PRAZOS_TEXTUAIS)) {
    if (prazoNorm.includes(chave)) {
      if (dias !== null) return dias;
      // Dia da semana — calcula distância
      return diasAteDiaSemana(chave);
    }
  }

  // Tenta dd/mm ou dd/mm/yyyy
  const matchData = prazo.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (matchData) {
    const dia = parseInt(matchData[1]);
    const mes = parseInt(matchData[2]) - 1;
    const ano = matchData[3]
      ? parseInt(matchData[3] < 100 ? `20${matchData[3]}` : matchData[3])
      : new Date().getFullYear();
    const alvo = new Date(ano, mes, dia);
    const diff = Math.ceil((alvo - Date.now()) / (1000 * 60 * 60 * 24));
    return Math.max(diff, 0);
  }

  return null;
}

function diasAteDiaSemana(nome) {
  const dias = {
    domingo: 0, segunda: 1, terça: 2, quarta: 3,
    quinta: 4, sexta: 5, sábado: 6,
  };
  const alvo = dias[nome];
  if (alvo === undefined) return null;

  const hoje = new Date().getDay();
  let diff = alvo - hoje;
  if (diff <= 0) diff += 7; // próxima ocorrência
  return diff;
}

function clamp(min, max, val) {
  return Math.max(min, Math.min(max, val));
}
