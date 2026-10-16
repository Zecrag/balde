/** Checklist de execução: deduplica texto sem perder checks já marcados. */
import { normalizar, aberta, mesmoCliente } from './triagem.mjs';
import { tokens } from './similaridade.mjs';
export function normalizarSubitens(lista) {
  if (!Array.isArray(lista)) return [];
  const saida = [], vistos = new Set();
  for (const item of lista.slice(0, 100)) {
    const texto = (typeof item === 'string' ? item : item?.texto);
    if (typeof texto !== 'string' || !texto.trim()) continue;
    const limpo = texto.trim().slice(0, 500), chave = normalizar(limpo);
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    saida.push({ texto: limpo, feito: item?.feito === true });
  }
  return saida;
}
export function juntarSubitens(atuais, novos) {
  return normalizarSubitens([...normalizarSubitens(atuais), ...normalizarSubitens(novos)]);
}
export const mesmoEscopo = (a, b) => mesmoCliente(a, b) && normalizar(a.projeto) === normalizar(b.projeto);
export function pareceOrientacao(texto) {
  return /\b(lembrando|lembrar de|atencao|orientacao|em italico|em negrito|formatar|formatacao|usar (a |o )?(fonte|cor)|manter (a |o )?(fonte|cor))\b/.test(normalizar(texto));
}
/** Só sugere quando há contexto lexical claro e um único pai plausível. */
export function acharPrincipal(extraida, tarefas, textoFonte = '') {
  if (!pareceOrientacao(`${extraida.titulo || ''} ${textoFonte}`)) return null;
  if (/^(criar|desenvolver|produzir|publicar|enviar|agendar)\b/.test(normalizar(extraida.titulo))) return null;
  const termos = tokens(`${extraida.titulo || ''} ${textoFonte}`);
  const candidatos = tarefas.filter(t => aberta(t) && t.id !== extraida.id && mesmoEscopo(extraida, t)
    && !pareceOrientacao(t.titulo)
    && [...tokens(`${t.titulo} ${t.descricao || ''}`)].filter(x => termos.has(x)).length >= 2);
  return candidatos.length === 1 ? candidatos[0] : null;
}
export function candidatasComplemento(tarefas) {
  return tarefas.filter(aberta).flatMap(t => {
    const pai = acharPrincipal(t, tarefas, t.descricao || '');
    return pai ? [{ id: t.id, principalId: pai.id }] : [];
  });
}
/** Conversão auditável: original preservada como descartada e vinculada ao pai. */
export function converterComplementos(tarefas, pares, agora = new Date().toISOString()) {
  const resultado = structuredClone(tarefas);
  const filhos = new Set(pares.map(p => p.id));
  if (filhos.size !== pares.length || pares.some(p => filhos.has(p.principalId))) throw new Error('Conversão duplicada ou encadeada');
  for (const par of pares) {
    const filha = resultado.find(t => t.id === par.id), pai = resultado.find(t => t.id === par.principalId);
    if (!filha || !pai || !mesmoEscopo(filha, pai)) throw new Error('Par inválido ou fora do cliente/projeto');
    if (filha.convertidaPara === pai.id) continue;
    if (filha.estado === 'descartada' || pai.estado === 'descartada') throw new Error('Tarefa descartada não pode ser convertida');
    pai.subitens = juntarSubitens(pai.subitens, [{ texto: filha.titulo, feito: filha.estado === 'feita' }]);
    pai.fontes = [...new Set([...(pai.fontes || pai.mensagensRef || []), ...(filha.fontes || filha.mensagensRef || [])])];
    pai.links = [...new Set([...(pai.links || []), ...(filha.links || [])])];
    pai.atualizadaEm = agora;
    filha.estadoAntesConversao = filha.estado;
    filha.estado = 'descartada';
    filha.convertidaPara = pai.id;
    filha.atualizadaEm = agora;
  }
  return resultado;
}
