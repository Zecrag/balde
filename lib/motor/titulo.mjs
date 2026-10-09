/**
 * titulo.mjs — Título curto e acionável para micro-tarefas.
 *
 * Regras: ≤ 70 caracteres, sem cortar palavra no meio, sem saudação
 * ("Olá", "Bom dia"…) nem abertura de anexo ("Segue", "Te encaminho"…).
 */

export const TITULO_MAX = 70;

const FIM = '(?![\\p{L}\\p{N}])';
const SAUDACAO = new RegExp(`^(ol[aá]|oi+|opa|e a[ií]|bom dia|boa tarde|boa noite|tudo bem|tudo certo|pessoal|galera|gente)${FIM}[\\s,.!?:;-]*`, 'iu');
const ABERTURA = new RegExp(`^(segue(m)? (em )?anexo|segue(m)?|em anexo|anexo|te encaminho|encaminho|te mando|mandei (o )?[aá]udio:?|por favor|por gentileza|preciso que (voc[eê] )?|precisamos que (voc[eê] )?|preciso de|precisamos de|preciso|precisamos|precisaria|poderia|pode|consegue|gostaria de|queria|quero)${FIM}[\\s,.!?:;-]*`, 'iu');
/** Vocativo no começo: "Alice, ..." (até 3 palavras antes da vírgula). */
const VOCATIVO = /^\p{L}+(?:\s+\p{L}+){0,2},\s+/u;
const ARTIGO = /^(a|o|as|os|um|uma)\s+/i;
/** Palavras que não podem terminar um título cortado. */
const PENDURADAS = new Set(['a', 'o', 'as', 'os', 'um', 'uma', 'de', 'da', 'do', 'das', 'dos', 'e', 'em', 'no', 'na', 'nos', 'nas', 'para', 'pra', 'pro', 'com', 'por', 'que', 'se', 'ou', 'até', 'ao', 'à', 'sem', 'sobre', 'entre']);

const INFINITIVO = {
  altera: 'Alterar', cria: 'Criar', adiciona: 'Adicionar', implementa: 'Implementar',
  corrige: 'Corrigir', arruma: 'Arrumar', conserta: 'Consertar', envia: 'Enviar',
  manda: 'Mandar', verifica: 'Verificar', confere: 'Conferir', checa: 'Checar',
  configura: 'Configurar', instala: 'Instalar', sobe: 'Subir', paga: 'Pagar',
  atualiza: 'Atualizar', faz: 'Fazer', 'faça': 'Fazer', troca: 'Trocar', muda: 'Mudar',
  emite: 'Emitir', revisa: 'Revisar', publica: 'Publicar', liga: 'Ligar', agenda: 'Agendar',
  comenta: 'Comentar',
};

/**
 * Remove saudações/aberturas do começo, repetidamente.
 * @param {string} texto
 */
export function limparAbertura(texto) {
  let s = (texto ?? '').trim();
  for (let i = 0; i < 6; i++) {
    const antes = s;
    s = s.replace(SAUDACAO, '').trim();
    s = s.replace(ABERTURA, '').trim();
    // Vocativo antes de saudação/pedido: "Alice, tudo bem? Segue…" / "Alice, preciso…"
    const semVocativo = s.replace(VOCATIVO, '');
    if (semVocativo !== s && (SAUDACAO.test(semVocativo) || ABERTURA.test(semVocativo))) s = semVocativo.trim();
    if (s === antes) break;
  }
  return s.replace(ARTIGO, '').trim();
}

/**
 * Corta em limite de palavra, sem deixar preposição/artigo pendurado no fim.
 * @param {string} texto
 * @param {number} [max]
 */
export function encurtarTitulo(texto, max = TITULO_MAX) {
  let s = (texto ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s.replace(/[\s,;:–-]+$/, '');

  const palavras = s.split(' ');
  const saida = [];
  for (const p of palavras) {
    const candidato = [...saida, p].join(' ');
    if (candidato.length > max) break;
    saida.push(p);
  }
  // Palavra única maior que o limite: não há como não cortar
  if (saida.length === 0) return s.slice(0, max);

  while (saida.length > 1 && PENDURADAS.has(saida[saida.length - 1].toLowerCase().replace(/[^\p{L}]/gu, ''))) {
    saida.pop();
  }
  return saida.join(' ').replace(/[\s,;:–-]+$/, '');
}

/**
 * Gera título acionável a partir do texto bruto da mensagem.
 * @param {string} texto
 * @param {string|null} [prazo]
 */
export function gerarTitulo(texto, prazo = null) {
  const limpo = limparAbertura(texto);
  let frase = limpo.split(/(?<=[\p{L}0-9)])[.!?\n]/u)[0].trim();
  if (!frase) frase = limparAbertura(String(texto ?? '').split(/[.!?\n]/)[0]) || String(texto ?? '').trim();

  const primeira = frase.split(/\s+/)[0]?.toLowerCase();
  if (primeira && INFINITIVO[primeira]) frase = INFINITIVO[primeira] + frase.slice(primeira.length);
  frase = frase.replace(/[?!]+$/, '').trim();

  // Prazo sempre no fim (tirado do meio da frase), para não sumir no corte
  let sufixo = '';
  if (prazo) {
    const prazoLimpo = String(prazo).replace(/^até\s+/i, '').trim();
    const escapado = prazoLimpo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const semPrazo = frase.replace(new RegExp(`\\s*(até\\s+)?${escapado}`, 'i'), '').trim();
    sufixo = ` até ${prazoLimpo}`;
    if (sufixo.length > 25) sufixo = '';
    else if (semPrazo) frase = semPrazo;
  }

  frase = encurtarTitulo(frase, TITULO_MAX - sufixo.length) + sufixo;
  return frase.charAt(0).toUpperCase() + frase.slice(1);
}

/**
 * Saneia um título vindo do LLM: tira saudação/abertura e respeita o limite.
 * @param {unknown} titulo
 * @param {string} [fallback] — texto bruto para gerar título se o LLM não mandou
 */
export function sanearTitulo(titulo, fallback = '') {
  const base = typeof titulo === 'string' && titulo.trim() ? titulo : null;
  if (!base) return gerarTitulo(fallback);
  const limpo = limparAbertura(base).replace(/[.!?]+$/, '');
  const frase = encurtarTitulo(limpo || base.trim());
  return frase.charAt(0).toUpperCase() + frase.slice(1);
}
