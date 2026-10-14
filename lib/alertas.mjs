/** Alertas de calendário, sem I/O. Datas sem horário já representam um dia local. */
export function calcularAlertas({ tarefas = [], projetos = [], hoje = new Date(), janelaDias = 3, fuso = 'America/Sao_Paulo' } = {}) {
  const formato = new Intl.DateTimeFormat('en-CA', { timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit' });
  function dia(valor) {
    if (!valor) return null;
    let iso;
    if (typeof valor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(valor)) {
      iso = valor;
    } else {
      const data = new Date(valor);
      if (!Number.isFinite(data.getTime())) return null;
      const partes = Object.fromEntries(formato.formatToParts(data).map(p => [p.type, p.value]));
      iso = `${partes.year}-${partes.month}-${partes.day}`;
    }
    const data = new Date(`${iso}T00:00:00Z`);
    if (!Number.isFinite(data.getTime()) || data.toISOString().slice(0, 10) !== iso) return null;
    return data.getTime() / 86400000;
  }
  const atual = dia(hoje);
  if (atual === null) throw new TypeError('hoje deve ser uma data válida');
  if (!Number.isInteger(janelaDias) || janelaDias < 0) throw new RangeError('janelaDias deve ser um inteiro não negativo');
  const chave = item => `${item.empresa}|${item.projeto}`;
  const arquivados = new Set(projetos.filter(p => p.status === 'arquivado' || p.arquivado === true).map(chave));
  const despejos = new Set(projetos.filter(p => p.tipo === 'despejo').map(chave));
  const visivel = item => !item.arquivado && !arquivados.has(chave(item));
  const estado = t => t.estado ?? t.status;
  const aberta = t => !['feita', 'descartada'].includes(estado(t));
  const resultado = { atrasadas: [], venceHoje: [], proximas: [], projetosAtrasados: [], baldeParado: 0, feitasHoje: [], porEmpresa: {}, porProjeto: {}, abertas: 0, porEstado: {}, semPrazo: [], projetosNaJanela: [] };
  const empresas = new Map();
  const grupos = new Map();
  function gravidade(valor) {
    const prazo = dia(valor);
    if (prazo === null) return null;
    const distancia = prazo - atual;
    if (distancia < 0) return { tipo: 'atrasada', dias: -distancia };
    if (distancia === 0) return { tipo: 'hoje', dias: 0 };
    return distancia <= janelaDias ? { tipo: 'proxima', dias: distancia } : null;
  }
  function registrar(item, pior) {
    if (!pior) return;
    const ordem = { atrasada: 3, hoje: 2, proxima: 1 };
    for (const [mapa, k] of [[empresas, item.empresa], [grupos, chave(item)]]) {
      const anterior = mapa.get(k)?.pior;
      if (!anterior || ordem[pior.tipo] > ordem[anterior.tipo] ||
          (pior.tipo === anterior.tipo && (pior.tipo === 'atrasada' ? pior.dias > anterior.dias : pior.dias < anterior.dias))) {
        mapa.set(k, { pior: { ...pior } });
      }
    }
  }
  const abertas = new Map();
  for (const tarefa of tarefas.filter(visivel)) {
    if (estado(tarefa) === 'feita') {
      // O store atual registra a mudança de estado em atualizadaEm.
      if (dia(tarefa.concluidaEm ?? tarefa.feitaEm ?? tarefa.atualizadaEm) === atual) resultado.feitasHoje.push({ ...tarefa });
      continue;
    }
    if (!aberta(tarefa)) continue;
    resultado.abertas++;
    const e = estado(tarefa) ?? 'pronta';
    resultado.porEstado[e] = (resultado.porEstado[e] ?? 0) + 1;
    if (dia(tarefa.prazo) === null) {
      const criacao = dia(tarefa.criadaEm);
      resultado.semPrazo.push({ ...tarefa, idadeDias: criacao === null ? null : Math.max(0, atual - criacao) });
    }
    abertas.set(chave(tarefa), (abertas.get(chave(tarefa)) ?? 0) + 1);
    if (String(tarefa.empresa).trim().toLowerCase() === 'balde' || String(tarefa.projeto).trim().toLowerCase() === 'despejo' || despejos.has(chave(tarefa))) resultado.baldeParado++;
    const pior = gravidade(tarefa.prazo);
    if (!pior) continue;
    const { id, titulo, empresa, projeto, prazo } = tarefa;
    const lista = { atrasada: 'atrasadas', hoje: 'venceHoje', proxima: 'proximas' }[pior.tipo];
    resultado[lista].push({ id, titulo, empresa, projeto, prazo, dias: pior.dias });
    registrar(tarefa, pior);
  }
  const vistos = new Set();
  for (const projeto of projetos.filter(p => visivel(p) && p.status !== 'arquivado')) {
    const k = chave(projeto);
    if (vistos.has(k)) continue;
    vistos.add(k);
    const pior = gravidade(projeto.fim);
    registrar(projeto, pior);
    if (pior && pior.tipo !== 'atrasada') {
      const { empresa, projeto: nome, fim } = projeto;
      resultado.projetosNaJanela.push({ empresa, projeto: nome, fim, dias: pior.dias, abertas: abertas.get(k) ?? 0 });
    }
    if (pior?.tipo === 'atrasada') {
      const { empresa, projeto: nome, fim } = projeto;
      resultado.projetosAtrasados.push({ empresa, projeto: nome, fim, dias: pior.dias, abertas: abertas.get(k) ?? 0 });
    }
  }
  resultado.semPrazo.sort((a, b) => (b.idadeDias ?? -1) - (a.idadeDias ?? -1));
  resultado.projetosNaJanela.sort((a, b) => a.dias - b.dias);
  resultado.atrasadas.sort((a, b) => b.dias - a.dias);
  resultado.proximas.sort((a, b) => a.dias - b.dias);
  resultado.projetosAtrasados.sort((a, b) => b.dias - a.dias);
  resultado.porEmpresa = Object.fromEntries(empresas);
  resultado.porProjeto = Object.fromEntries(grupos);
  return resultado;
}
