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
  const data = dataCurta(hoje);
  const cabecalho = `${tipo === 'resumo' ? '📋 *Resumo do dia' : '⚡ *Prazos que pedem atenção'}${data ? ` · ${data}` : ''}*`;
  if (tipo === 'resumo') {
    const feitas = alertas.feitasHoje ?? [];
    const estados = alertas.porEstado ?? {};
    const semPrazo = alertas.semPrazo ?? [];
    const blocos = [cabecalho,
      feitas.length ? `✅ Concluídas hoje: ${feitas.length}\n${listar(feitas, t => `• ${limpar(t.titulo)}`)}` : '✅ Nada concluído hoje',
      `📊 Abertas ${alertas.abertas ?? 0} · Decidir ${estados.precisa_decisao ?? 0} · Falta info ${estados.aguardando_info ?? 0} · Pra fazer ${(estados.pronta ?? 0) + (estados.em_execucao ?? 0)}`,
    ];
    const prazos = [];
    for (const [campo, emoji, singular, plural] of [
      ['atrasadas', '🔴', 'atrasada', 'atrasadas'], ['venceHoje', '🟠', 'hoje', 'hoje'], ['proximas', '🟡', 'próxima', 'próximas'],
    ]) {
      const itens = alertas[campo] ?? [];
      if (!itens.length) continue;
      const empresas = [...new Set(itens.map(t => limpar(t.empresa || 'Sem empresa')))];
      const nomes = empresas.slice(0, LIMITE).join(', ') + (empresas.length > LIMITE ? `, +${empresas.length - LIMITE}` : '');
      prazos.push(`${emoji} ${itens.length} ${itens.length === 1 ? singular : plural} (${nomes})`);
    }
    if (prazos.length) blocos.push(prazos.join(' · '));
    const projetos = [
      ...(alertas.projetosAtrasados ?? []).map(p => ({ ...p, rotulo: `atrasado ${p.dias} d` })),
      ...(alertas.projetosNaJanela ?? []).map(p => ({ ...p, rotulo: p.dias === 0 ? 'hoje' : `faltam ${p.dias} d` })),
    ];
    if (projetos.length) blocos.push(`📅 Fim dos projetos\n${listar(projetos, p => `• ${limpar(p.empresa)} · ${limpar(p.projeto)} — ${dataCurta(p.fim)} (${p.rotulo})`)}`);
    blocos.push(`⏳ Sem prazo: ${semPrazo.length} abertas` + (semPrazo.length ? `\n${semPrazo.slice(0, 3).map(t => `• ${limpar(t.titulo)} · ${limpar(t.empresa)} — ${t.idadeDias === null ? 'idade indisponível' : `há ${t.idadeDias} d`}`).join('\n')}` : ''));
    if (alertas.baldeParado > 0) blocos.push(`🪣 No Balde para organizar: ${alertas.baldeParado}`);
    return blocos.join('\n\n');
  }
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
  if (!blocos.length) blocos.push('Tudo em dia! Nenhum alerta por aqui. ✅');
  return [cabecalho, ...blocos].join('\n\n');
}
