/** Texto determinístico para celular; não envia mensagens. */
const LIMITE = 5;
const limpar = valor => String(valor ?? '').replace(/[\r\n*_~`]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
function dataCurta(valor) {
  if (!valor) return '';
  if (typeof valor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(valor)) return `${valor.slice(8, 10)}/${valor.slice(5, 7)}`;
  const data = new Date(valor);
  return Number.isFinite(data.getTime()) ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' }).format(data) : '';
}
function listar(itens, renderizar) {
  const linhas = itens.slice(0, LIMITE).map(renderizar);
  if (itens.length > LIMITE) linhas.push(`+${itens.length - LIMITE}`);
  return linhas.join('\n');
}

export function montarTexto(tipo, alertas, { hoje } = {}) {
  if (!['resumo', 'urgente'].includes(tipo)) throw new TypeError('tipo deve ser resumo ou urgente');
  const grupos = new Map();
  for (const [campo, emoji, rotulo] of [['atrasadas', '🔴', 'atrasada'], ['venceHoje', '🟠', 'hoje'], ['proximas', '🟡', 'próxima']]) {
    for (const tarefa of alertas[campo] ?? []) {
      const empresa = tarefa.empresa || 'Sem empresa';
      if (!grupos.has(empresa)) grupos.set(empresa, []);
      grupos.get(empresa).push({ ...tarefa, emoji, rotulo });
    }
  }
  const blocos = [];
  for (const [empresa, itens] of [...grupos].slice(0, LIMITE)) {
    blocos.push(`*${limpar(empresa)}*\n${listar(itens, t => `${t.emoji} ${limpar(t.titulo)}${t.projeto ? ` · ${limpar(t.projeto)}` : ''} — ${dataCurta(t.prazo)} (${t.rotulo}${t.dias ? ` ${t.dias}d` : ''})`)}`);
  }
  if (grupos.size > LIMITE) blocos.push(`+${grupos.size - LIMITE} empresas`);
  if (tipo === 'resumo') {
    if (alertas.feitasHoje?.length) blocos.push(`✅ *Feitas hoje (${alertas.feitasHoje.length})*\n${listar(alertas.feitasHoje, t => `• ${limpar(t.titulo)} · ${limpar(t.empresa)}`)}`);
    if (alertas.projetosAtrasados?.length) blocos.push(`🔴 *Projetos atrasados*\n${listar(alertas.projetosAtrasados, p => `• ${limpar(p.empresa)} · ${limpar(p.projeto)} — ${dataCurta(p.fim)} (${p.dias}d; ${p.abertas} abertas)`)}`);
    if (alertas.baldeParado > 0) blocos.push(`🪣 *Balde*: ${alertas.baldeParado} tarefa(s) aguardando organização.`);
  }
  if (!blocos.length) return 'Tudo em dia! Nenhum alerta por aqui. ✅';
  const data = dataCurta(hoje);
  return [`*${tipo === 'resumo' ? 'Resumo do dia' : 'Prazos que pedem atenção'}${data ? ` · ${data}` : ''}*`, ...blocos].join('\n\n');
}
