/** Proteções locais conservadoras: nunca inferir pagamento de mídia não lida. */
import { ESTADOS } from '../tipos.mjs';
import { mesmaTarefa } from './similaridade.mjs';
export const normalizar = s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
export const aberta = t => ![ESTADOS.FEITA, ESTADOS.DESCARTADA].includes(t.estado);
export const textoMensagem = m => [m?.texto, m?.transcricao, m?.descricaoImagem].filter(Boolean).join(' ');
export function mesmoCliente(a, b) {
  const empresa = normalizar(a.empresa);
  return empresa && !['?', '(sem empresa)', 'balde'].includes(empresa)
    && empresa === normalizar(b.empresa)
    && normalizar(a.clienteSugerido) === normalizar(b.clienteSugerido);
}
export function conversaSemAcao(texto) {
  if (!normalizar(texto)) return false;
  let t = normalizar(texto).replace(/^(oi|ola|bom dia|boa tarde|boa noite)[!.,\s]*/g, '').trim();
  if (!t || /^(ok|okay|obrigad[oa]|valeu|perfeito|combinado|pode ser|confirmado|ate la)[!.\s]*$/.test(t)) return true;
  // Aceite com restrição de agenda não é pedido de agendamento.
  return /^(pode ser|combinado|confirmado)[!.,\s]+/.test(t)
    && /\b(tenho outra reuniao|ja (esta )?(marcad[oa]|agendad[oa]))\b/.test(t)
    && !/\b(remarcar|remarque|mudar|mude|envie|mande|preciso|favor)\b/.test(t);
}
export function tituloRuido(titulo) {
  return /^(cumprimentar|saudar)\b/.test(normalizar(titulo))
    || /^(responder|enviar|mandar|dizer|dar)\b.*\b(bom dia|boa tarde|boa noite)\b/.test(normalizar(titulo));
}
export function pagamentoConfirmado(m) {
  const t = normalizar(textoMensagem(m));
  if (/\b(nao|ainda|vou|irei|amanha|depois|falso|agendado|pendente|estorno)\b|\?/.test(t)) return false;
  return /\b(paguei|ja pagamos|pagamento (realizado|confirmado|efetuado)|pix (feito|enviado)|segue (o )?comprovante|comprovante de pagamento|esta pago)\b/.test(t);
}
export function tarefaCobranca(t) {
  return /\b(cobrar|cobranca|receber pagamento|gerar.*(pix|qr|boleto)|criar.*(pix|qr|boleto)|enviar.*(cobranca|boleto|qr))\b/.test(normalizar(t.titulo));
}
export function candidatasLimpeza(tarefas, mensagens = []) {
  const porId = new Map(mensagens.map(m => [m.id, m]));
  const mantidas = [], candidatas = [];
  for (const t of tarefas.filter(aberta)) {
    const fontes = (t.fontes || t.mensagensRef || []).map(id => porId.get(id));
    const ruido = tituloRuido(t.titulo) || (fontes.length > 0 && fontes.every(m => m && conversaSemAcao(textoMensagem(m))));
    const duplicata = mantidas.find(a => mesmoCliente(a, t) && normalizar(a.projeto) === normalizar(t.projeto) && mesmaTarefa(t, a));
    if (ruido || duplicata) candidatas.push({ id: t.id, motivo: ruido ? 'ruido' : 'duplicata', ...(duplicata ? { duplicataDe: duplicata.id } : {}) });
    else mantidas.push(t);
  }
  return candidatas;
}
