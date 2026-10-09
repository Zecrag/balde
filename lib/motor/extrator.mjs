/**
 * extrator.mjs — Extrator plugável de micro-tarefas.
 *
 * Com LLM configurado (lib/llm.mjs: BALDE_LLM ou key presente) → manda o contexto
 * do chat e recebe JSON de tarefas novas/atualizadas.
 * Sem LLM, ou se o LLM falhar → heurística local por padrões textuais.
 *
 * Ambos retornam o mesmo formato:
 *   { tarefas: [{ titulo, descricao, estado, faltando, prazo, tipo, etapa, proximoPasso, mensagensRef }],
 *     atualizacoes: [{ id, ... }] }
 *
 * A deduplicação (mesmo conteúdo no mesmo chat atualiza, não cria) roda antes
 * de qualquer extrator, então vale igual para LLM e heurística.
 */

import { ESTADOS } from '../tipos.mjs';
import { chamarLLM, llmDisponivel } from '../llm.mjs';
import { ETAPAS, normalizarEtapa } from './etapas.mjs';
import { gerarTitulo, sanearTitulo, TITULO_MAX } from './titulo.mjs';
import { calcularPrazoISO } from './datas.mjs';

export function extrairLinks(texto) {
  if (!texto || typeof texto !== 'string') return [];
  const matches = texto.match(/https?:\/\/[^\s<>"')]+|www\.[^\s<>"')]+/gi) || [];
  return [...new Set(matches.map(u => u.startsWith('http') ? u : `https://${u}`))];
}

export function nomesDeLinks(urls = []) {
  return urls.map(u => {
    try {
      const host = new URL(u.startsWith('http') ? u : `https://${u}`).hostname.replace(/^www\./, '');
      return host.split('.')[0];
    } catch { return ''; }
  }).filter(Boolean);
}

/** Quantas mensagens do chat vão como contexto para o LLM. */
const JANELA_LLM = Number(process.env.BALDE_LLM_JANELA) > 0 ? Number(process.env.BALDE_LLM_JANELA) : 20;

// ─── Seletor de extrator ────────────────────────────────────────

/**
 * Extrai tarefas de um contexto de chat.
 *
 * @param {import('../tipos.mjs').ContextoChat} contexto
 * @param {{ empresa: string, projeto: string, tipoGrupo?: string, origem?: string }} info
 * @param {Array} tarefasExistentes — tarefas abertas deste chat
 * @param {import('../llm.mjs').OpcoesLLM} [opcoesLLM] — injeção de env/fetch (testes)
 * @returns {Promise<{ tarefas: Object[], atualizacoes: Object[] }>}
 */
export async function extrairTarefas(contexto, info, tarefasExistentes, opcoesLLM = {}) {
  const ultimaMsg = contexto.mensagens[contexto.mensagens.length - 1];
  if (!ultimaMsg) return { tarefas: [], atualizacoes: [] };

  const duplicata = detectarDuplicata(contexto, ultimaMsg, tarefasExistentes);
  if (duplicata) return duplicata;

  if (llmDisponivel(opcoesLLM.env ?? process.env)) {
    const viaLLM = await extrairComLLM(contexto, info, tarefasExistentes, opcoesLLM);
    if (viaLLM) return viaLLM;
  }

  return extrairComHeuristica(contexto, info, tarefasExistentes);
}

// ─── Utilidades comuns ──────────────────────────────────────────

const norm = str => (str || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

/** Identificador da mensagem usado em `fontes`. */
const refDe = m => m.id || m.ts || m.timestamp;

/** Texto útil da mensagem: texto, senão transcrição, senão descrição da imagem. */
function textoDe(m) {
  return (m.texto || m.transcricao || m.descricaoImagem || '').trim();
}

/** Grupo "despejo" ou conversa pessoal: aceita qualquer tipo de tarefa. */
export function ehDespejo(info = {}) {
  if (info.origem === 'pessoal') return true;
  return /despejo|pessoal|inbox|caixa|anota/i.test(norm(info.tipoGrupo));
}

/**
 * Mesmo conteúdo (texto ou mídia) de uma tarefa aberta → só acrescenta a fonte.
 * @returns {{ tarefas: [], atualizacoes: Object[] } | null}
 */
function detectarDuplicata(contexto, ultimaMsg, tarefasExistentes) {
  const textoMsgNorm = norm(textoDe(ultimaMsg));

  for (const tarefa of tarefasExistentes) {
    const ehDuplicataTexto = textoMsgNorm.length > 0 && textoMsgNorm === norm(tarefa.descricao);

    let ehDuplicataMidia = false;
    if (ultimaMsg.midiaPath) {
      const fontes = tarefa.fontes || [];
      ehDuplicataMidia = contexto.mensagens.some(
        m => m !== ultimaMsg && fontes.includes(refDe(m)) && m.midiaPath === ultimaMsg.midiaPath,
      );
    }

    if (ehDuplicataTexto || ehDuplicataMidia) {
      const fontesExistentes = tarefa.fontes || tarefa.mensagensRef || [];
      const novaFonte = refDe(ultimaMsg);
      const atualizacoes = fontesExistentes.includes(novaFonte)
        ? []
        : [{ id: tarefa.id, fontes: [...fontesExistentes, novaFonte] }];
      return { tarefas: [], atualizacoes };
    }
  }
  return null;
}

// ─── Extrator heurístico ────────────────────────────────────────

/** Padrões que indicam um pedido / tarefa */
const PADROES_PEDIDO = [
  /\b(preciso|precisamos|precisaria)\b/i,
  /\b(pode|poderia|consegue|conseguiria)\b.*\?/i,
  /\b(faz|faça|faz favor|por favor)\b/i,
  /(^|\s)(até|prazo|deadline|urgente|urgência)(\s|$|\.|,|!|\?)/i,
  /\b(altera|alterar|mudar|trocar|atualizar|atualiza)\b/i,
  /\b(cria|criar|adiciona|adicionar|implementa|implementar)\b/i,
  /\b(corrige|corrigir|arruma|arrumar|conserta|consertar)\b/i,
  /\b(envia|enviar|manda|mandar|encaminho|encaminhar)\b/i,
  /\b(verifica|verificar|confere|conferir|checa|checar)\b/i,
  /\b(configura|configurar|instala|instalar|sobe|subir|deploya)\b/i,
  /\b(paga|pagar|pago)\b/i,
];

/** Padrões que indicam informação faltante / pergunta */
const PADROES_FALTANDO = [
  /\b(qual|quais|onde|como|quando)\b.*\?/i,
  /\b(falta|faltando|pendente|precisamos saber)\b/i,
  /\b(me passa|manda pra mim|envia os dados)\b/i,
  /\b(preciso de|preciso do|preciso da)\b.*\b(dados?|informação|informações)\b/i,
];

/** Padrões de prazo */
const PADROES_PRAZO = [
  /até\s+(segunda|terça|quarta|quinta|sexta|sábado|domingo)/i,
  /até\s+(amanhã|hoje|semana que vem|próxima semana|fim do mês|fim do dia)/i,
  /até\s+(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/i,
  /prazo[:\s]+(\S+(?:\s+\S+){0,3})/i,
  /\b(urgente|asap|o mais rápido possível|pra ontem)\b/i,
];

/** Padrões de tipo de ticket */
const PADROES_TIPO = [
  { tipo: 'hospedagem',       regex: /\b(hospedagem|hosting|servidor|domínio|dns|ssl|cpanel)\b/i },
  { tipo: 'boleto',           regex: /\b(boleto|nota fiscal|nf|razão social|cnpj|pagamento|cobrança|fatura)\b/i },
  { tipo: 'desenvolvimento',  regex: /\b(bug|erro|layout|feature|funcionalidade|api|banco|frontend|backend|deploy|site|app|sistema|código)\b/i },
  { tipo: 'operacional',      regex: /\b(email|e-mail|senha|acesso|login|conta|cadastro|usuário)\b/i },
];

/** Tipo para anotações do grupo despejo que não casam com os padrões acima. */
const PADRAO_ADMINISTRATIVO = /\b(contador|contabilidade|imposto|das|darf|banco|cart[oó]rio|documento|contrato|reuni[aã]o|agendar|agenda|ligar|liga|e-?mail|planilha|proposta|or[cç]amento|pix|transfer[eê]ncia)\b/i;

/** Etapa por padrões de texto — o primeiro que casa vence. */
const PADROES_ETAPA = [
  { etapa: 'financeiro', regex: /\b(boleto|nota fiscal|nf|pagamento|pagar|paga|pago|pix|cobran[cç]a|fatura|comprovante|or[cç]amento|reembolso)\b/i },
  { etapa: 'aprovacao',  regex: /\b(aprova|aprovar|aprovado|aprova[cç][aã]o|validar|valida|de acordo|pode publicar|ok pra publicar)\b/i },
  { etapa: 'ajustes',    regex: /\b(ajust\w*|corrig\w*|corrige|alter\w*|troca\w*|trocar|muda\w*|arruma\w*|conserta\w*|bug|erro|refaz\w*|revis\w*)\b/i },
  { etapa: 'entrega',    regex: /\b(entrega\w*|publica\w*|subir|sobe|deploy\w*|enviar o arquivo|arquivo final|vers[aã]o final|no ar)\b/i },
  { etapa: 'briefing',   regex: /\b(briefing|escopo|refer[eê]ncias?|ideia|quero um|queremos um|novo projeto|proposta)\b/i },
  { etapa: 'suporte',    regex: /\b(senha|acesso|login|fora do ar|caiu|n[aã]o abre|n[aã]o funciona|travou)\b/i },
];

/** Mensagens que nunca são tarefa, nem no despejo. */
const SO_CONVERSA = /^(?:(ok+|blz|beleza|show|top|valeu|vlw|obrigad[oa]|brigad[oa]|obg|tmj|perfeito|certo|combinado|kk+|haha+|rs+|sim|n[aã]o|bom dia|boa tarde|boa noite|oi+|ol[aá]|tudo bem\??|👍|🙏|❤️)[\s!.,?]*)+$/i;

/** No despejo: qualquer anotação com 2+ palavras que não seja só conversa. */
function pareceAnotacao(texto) {
  const t = texto.trim();
  return t.split(/\s+/).length >= 2 && !SO_CONVERSA.test(t);
}

/**
 * @param {string} texto
 * @param {string} tipo
 * @param {{ despejo: boolean }} opts
 */
function detectarEtapa(texto, tipo, { despejo }) {
  for (const { etapa, regex } of PADROES_ETAPA) {
    if (regex.test(texto)) return etapa;
  }
  if (tipo === 'boleto') return 'financeiro';
  if (despejo) return tipo === 'pessoal' ? 'pessoal' : 'administrativo';
  return 'producao';
}

/**
 * Próximo passo concreto, derivado de estado/etapa.
 */
export function sugerirProximoPasso({ estado, etapa, faltando = [] }) {
  if (estado === ESTADOS.AGUARDANDO_INFO && faltando.length > 0) {
    return `Pedir no grupo: ${faltando.join(', ')}`;
  }
  if (estado === ESTADOS.PRECISA_DECISAO) return 'Decidir entre as opções e responder no grupo';
  switch (etapa) {
    case 'briefing':       return 'Fechar escopo e referências com o cliente';
    case 'aprovacao':      return 'Enviar para aprovação e aguardar o ok';
    case 'ajustes':        return 'Fazer o ajuste e mandar print no grupo';
    case 'entrega':        return 'Entregar e confirmar o recebimento no grupo';
    case 'financeiro':     return 'Conferir os dados e emitir/enviar a cobrança';
    case 'suporte':        return 'Reproduzir o problema e responder com a solução';
    case 'administrativo': return 'Resolver e registrar o comprovante';
    case 'pessoal':        return 'Separar um horário na agenda e fazer';
    default:               return 'Executar e avisar no grupo quando terminar';
  }
}

/**
 * @param {import('../tipos.mjs').ContextoChat} contexto
 * @param {{ empresa: string, projeto: string, tipoGrupo?: string, origem?: string }} info
 * @param {Array} tarefasExistentes
 */
export function extrairComHeuristica(contexto, info, tarefasExistentes) {
  const mensagens = contexto.mensagens;
  const ultimaMsg = mensagens[mensagens.length - 1];
  if (!ultimaMsg) return { tarefas: [], atualizacoes: [] };

  const texto = textoDe(ultimaMsg);
  const textoMsgNorm = norm(texto);
  const novaFonte = refDe(ultimaMsg);
  const despejo = ehDespejo({ ...info, origem: info?.origem ?? ultimaMsg.origem });

  const atualizacoes = [];

  // Mensagem provê info faltante para tarefa aguardando info
  for (const tarefa of tarefasExistentes) {
    if (tarefa.estado !== ESTADOS.AGUARDANDO_INFO || !(tarefa.faltando?.length > 0)) continue;

    const infoFornecida = tarefa.faltando.filter(item => {
      const palavras = norm(item).split(/\s+/).filter(p => p.length > 3);
      return palavras.some(p => textoMsgNorm.includes(p));
    });
    if (infoFornecida.length === 0) continue;

    const faltandoRestante = tarefa.faltando.filter(f => !infoFornecida.includes(f));
    const fontesExistentes = tarefa.fontes || tarefa.mensagensRef || [];
    const estado = faltandoRestante.length === 0 ? ESTADOS.PRONTA : ESTADOS.AGUARDANDO_INFO;
    const etapa = tarefa.etapa || 'producao';
    atualizacoes.push({
      id: tarefa.id,
      faltando: faltandoRestante,
      estado,
      descricao: tarefa.descricao + `\n[Atualização] ${texto}`,
      proximoPasso: sugerirProximoPasso({ estado, etapa, faltando: faltandoRestante }),
      fontes: [...fontesExistentes, novaFonte].filter((v, i, a) => a.indexOf(v) === i),
      ...(estado === ESTADOS.PRONTA && tarefa.responsavel === 'cliente' ? { responsavel: 'eu' } : {}),
    });
  }

  // Se houve atualizações, não cria nova tarefa (mesma conversa)
  if (atualizacoes.length > 0) {
    return { tarefas: [], atualizacoes };
  }

  const linksMsg = extrairLinks(texto);
  const textoSemLinks = texto.replace(/https?:\/\/[^\s<>"')]+|www\.[^\s<>"')]+/gi, '').trim();
  if (linksMsg.length > 0 && !textoSemLinks) {
    // Apenas links enviados como material: não vira tarefa solta
    return { tarefas: [], atualizacoes: [] };
  }

  // Verifica se a mensagem contém um pedido (no despejo, qualquer anotação vale)
  const ehPedido = PADROES_PEDIDO.some(p => p.test(texto)) || (despejo && pareceAnotacao(texto));
  if (!ehPedido) {
    return { tarefas: [], atualizacoes: [] };
  }

  // Detecta estado
  const temPergunta = PADROES_FALTANDO.some(p => p.test(texto));
  const faltando = [];

  if (temPergunta) {
    const matchFaltando = texto.match(/(?:falta|preciso de?|me passa|manda)\s+(.+?)(?:\.|$)/i);
    faltando.push(matchFaltando ? matchFaltando[1].trim() : 'informação pendente');
  }

  const precisaDecisao = /\b(prefere|escolhe|opção|opções|alternativa|A ou B|qual deles)\b/i.test(texto);

  let estado;
  if (faltando.length > 0) {
    estado = ESTADOS.AGUARDANDO_INFO;
  } else if (precisaDecisao) {
    estado = ESTADOS.PRECISA_DECISAO;
  } else {
    estado = ESTADOS.PRONTA;
  }

  // Detecta prazo
  let prazo = null;
  for (const padrao of PADROES_PRAZO) {
    const match = texto.match(padrao);
    if (match) {
      prazo = match[1] || match[0];
      break;
    }
  }

  // Detecta tipo
  let tipo = 'geral';
  for (const { tipo: t, regex } of PADROES_TIPO) {
    if (regex.test(texto)) {
      tipo = t;
      break;
    }
  }
  if (tipo === 'geral' && despejo) {
    tipo = PADRAO_ADMINISTRATIVO.test(texto) ? 'administrativo' : 'pessoal';
  }

  const etapa = detectarEtapa(texto, tipo, { despejo });

  const links = [...linksMsg];
  const fontesRefs = [novaFonte];
  for (let i = mensagens.length - 2; i >= 0 && i >= mensagens.length - 3; i--) {
    const prev = mensagens[i];
    const prevTxt = textoDe(prev);
    const prevLinks = extrairLinks(prevTxt);
    const prevSemLinks = prevTxt.replace(/https?:\/\/[^\s<>"')]+|www\.[^\s<>"')]+/gi, '').trim();
    if (prevLinks.length > 0 && !prevSemLinks) {
      links.push(...prevLinks);
      if (!fontesRefs.includes(refDe(prev))) fontesRefs.unshift(refDe(prev));
    }
  }

  let titulo = gerarTitulo(texto, prazo);
  if (/comentar.*reuni[aã]o/i.test(texto) && links.length) {
    const nomes = nomesDeLinks(links);
    if (nomes.length) {
      titulo = `Comentar na reunião: ${nomes.join(', ')}`;
    }
  }

  const dataMsg = ultimaMsg?.ts ? new Date(ultimaMsg.ts) : new Date();
  const prazoISO = calcularPrazoISO(prazo, dataMsg);

  const tarefa = {
    titulo,
    descricao: texto,
    estado,
    faltando,
    prazo: prazoISO,
    tipo,
    etapa,
    proximoPasso: sugerirProximoPasso({ estado, etapa, faltando }),
    mensagensRef: fontesRefs,
    links,
    nota: null,
    responsavel: estado === ESTADOS.AGUARDANDO_INFO ? 'cliente' : 'eu',
  };

  return { tarefas: [tarefa], atualizacoes: [] };
}

// ─── Extrator LLM ──────────────────────────────────────────────

const ESTADOS_LLM = [ESTADOS.AGUARDANDO_INFO, ESTADOS.PRONTA, ESTADOS.PRECISA_DECISAO, ESTADOS.EM_EXECUCAO, ESTADOS.FEITA];
const TIPOS_LLM = ['hospedagem', 'boleto', 'desenvolvimento', 'operacional', 'administrativo', 'pessoal', 'geral'];
const CAMPOS_ATUALIZAVEIS = ['titulo', 'descricao', 'estado', 'faltando', 'prazo', 'tipo', 'etapa', 'proximoPasso', 'responsavel'];
/** Cada cobrança de andamento/prazo soma isto na urgência da tarefa (ver urgencia.mjs). */
export const MAX_COBRANCAS = 3;
/** Quem destrava a tarefa: eu (dono) ou o cliente (dado, arquivo, aprovação). */
const RESPONSAVEIS_LLM = ['eu', 'cliente'];

const SYSTEM_PROMPT = `Você organiza micro-tarefas a partir de conversas de WhatsApp de uma agência/freelancer.
A cada nova mensagem você recebe o contexto do chat e decide se ela cria tarefa nova, atualiza uma tarefa aberta ou não gera nada.

Regras:
- Analise SÓ a última mensagem, usando as anteriores e as tarefas abertas como contexto.
- Pedido DIFERENTE no mesmo grupo = tarefa NOVA em "tarefas". Ser do mesmo cliente, projeto ou campanha, ou citar as mesmas palavras ("anúncio", "vídeo", "site"), NÃO torna a mesma tarefa.
- Só é ATUALIZAÇÃO quando a mensagem COMPLEMENTA aquela tarefa específica: responde o que ela tem em "faltando" ou a pergunta dela, corrige ou muda o prazo dela, manda o arquivo/texto/link que ELA pedia, aprova ou conclui a entrega dela. Aí vai em "atualizacoes" com o "id" dela (copie o id exato da lista "Tarefas abertas") — não duplique.
- Exemplos — tarefa aberta "Definir promessa dos anúncios":
  · "Aqui está o vídeo que gravei, está sem legenda" → NOVA ("Adicionar legendas ao vídeo"): é outro trabalho, não a promessa.
  · "Você fez o link de pagamento em qual plataforma?" → NOVA ("Confirmar plataforma do link de pagamento").
  · "A promessa pode ser: perfume importado pela metade do preço" → ATUALIZAÇÃO da promessa.
- Exemplos — tarefa aberta "Trocar banner da home" com faltando ["textos finais"]:
  · "Os textos são: Black Friday 40% OFF" → ATUALIZAÇÃO (responde o que faltava).
  · "Muda o prazo do banner pra quinta" → ATUALIZAÇÃO (prazo).
  · "Também precisamos corrigir o formulário de contato" → NOVA.
- COBRANÇA de andamento ou prazo ("qual o prazo?", "tem novidade?", "como está o site?", "conseguiu ver aquilo?") NÃO é tarefa nova nem conversa vazia: é ATUALIZAÇÃO da tarefa pendente a que ela se refere, com "cobranca": true (sobe a urgência) e "descricao" registrando a cobrança ("Cliente cobrou o prazo"). Sem tarefa aberta correspondente, crie a tarefa do que está sendo cobrado.
- Na dúvida entre atualizar e criar, CRIE tarefa nova. Juntar pedidos diferentes esconde trabalho; uma tarefa a mais o dono descarta em um clique. Se a mensagem contiver mais de um pedido, crie uma tarefa para cada pedido: um item por pedido; não juntar.
- Imagem, vídeo, print ou link sem pedido só é atualização se for claramente o arquivo que uma tarefa aberta pedia; se não pede nada, listas vazias.
- Conversa sem pedido (saudação, agradecimento, ok, piada) → listas vazias.
- ENTREGA PARA REVISÃO: parceiro ou cliente avisando que entregou algo ("estamos com o site pronto", "finalizamos a etapa 1", "segue a versão final", "subimos a landing") SEMPRE gera trabalho para mim — nunca é conversa vazia: tarefa NOVA "Revisar/Aprovar <o que foi entregue>" (estado "pronta", responsavel "eu", etapa "aprovacao"), ou atualização da tarefa aberta daquela entrega levando-a para essa revisão.
- Grupo de clientes: só pedidos de trabalho. Grupo "despejo" ou conversa pessoal: qualquer coisa que o dono anotou para fazer vira tarefa (administrativa, pessoal, compras, ligações, pagamentos).
- "titulo": verbo no infinitivo + objeto, até ${TITULO_MAX} caracteres, frase completa (nunca cortada no meio), sem saudação, sem "Olá", "Segue", "Por favor". Ex.: "Trocar banner da home do site", "Emitir boleto com razão social nova".
- "nota": resumo claro em 1 a 2 frases do QUE fazer (nunca o início da transcrição).
- "estado": "aguardando_info" (depende de algo que o CLIENTE precisa entregar; liste em "faltando"), "precisa_decisao" (alguém precisa escolher ou APROVAR), "pronta" (dá para executar já), "em_execucao", "feita" (só em atualização, quando confirmam que terminou).
- "responsavel": quem destrava a tarefa agora — "cliente" quando a bola está com o cliente (mandar dado, arquivo, acesso, conteúdo, pagamento, ou aprovar/escolher), "eu" quando o próximo passo é meu.
- DEPENDÊNCIA DO CLIENTE: "estou aguardando vocês me mandarem X", "falta o cliente enviar Y", "assim que vocês liberarem o acesso" → estado "aguardando_info", responsavel "cliente", e "faltando" descreve o que o CLIENTE precisa entregar ("acesso ao gerenciador de anúncios", "fotos dos produtos", "textos da página Sobre").
- APROVAÇÃO: "consegue aprovar?", "dá uma olhada e me diz se pode publicar", "ficou bom?", "qual das duas versões?" → estado "precisa_decisao", responsavel "cliente", "faltando" com a aprovação pendente ("aprovação do layout da home"). Se sou EU quem precisa decidir, responsavel "eu".
- CONCLUSÃO na conversa: quando a última mensagem confirma que uma tarefa aberta terminou ("feito", "pronto", "subiu", "tá no ar", "publicado", "enviado", "pago") → atualização com estado "feita". Aprovação ou decisão recebida ("aprovado", "aprovado sem alterações", "pode publicar", "gostei, pode seguir", "definido", "escolhido", "fica a opção 2", "vamos com essa") → a tarefa de aprovação/decisão vira "feita" (atualização, nunca tarefa nova); se ainda falta executar algo depois do ok, ela vira "pronta" com responsavel "eu".
- Resposta do cliente que entrega o que faltava (o arquivo, o acesso, o dado) → atualização: tira o item de "faltando"; sem mais nada faltando, estado "pronta" e responsavel "eu".
- "faltando": itens concretos que faltam ("CNPJ novo", "logo em PNG"); vazio se nada falta.
- "prazo": como foi dito ("sexta", "07/10", "amanhã") ou null.
- "etapa": uma de ${Object.keys(ETAPAS).join(', ')}.
- "proximoPasso": ação concreta e curta que eu faço agora ("Pedir o CNPJ novo no grupo", "Gerar boleto no banco e mandar o PDF").
- "tipo": uma de ${TIPOS_LLM.join(', ')}.

Formato:
{"tarefas":[{"titulo":"","descricao":"","nota":"","estado":"","responsavel":"","faltando":[],"prazo":null,"tipo":"","etapa":"","proximoPasso":""}],
 "atualizacoes":[{"id":"","estado":"","responsavel":"","faltando":[],"prazo":null,"etapa":"","proximoPasso":"","descricao":"","cobranca":false}]}
Em "atualizacoes" mande só os campos que mudam (além do "id").`;

/**
 * Monta o prompt do usuário com o contexto do chat.
 * @returns {string}
 */
export function montarPromptContexto(contexto, info, tarefasExistentes) {
  const msgs = contexto.mensagens.slice(-JANELA_LLM);
  const ultima = msgs[msgs.length - 1];
  const linha = (m) => {
    const partes = [];
    if (m.texto) partes.push(m.texto);
    if (m.transcricao && m.transcricao !== m.texto) partes.push(`(áudio) ${m.transcricao}`);
    if (m.descricaoImagem) partes.push(`(imagem) ${m.descricaoImagem}`);
    if (!partes.length && m.tipo && m.tipo !== 'texto') partes.push(`(${m.tipo} sem conteúdo extraído)`);
    return `[${m.ts ?? ''}] ${m.autor || m.remetente || '?'}: ${partes.join(' | ')}`;
  };

  const tarefas = tarefasExistentes.map(t => ({
    id: t.id,
    titulo: t.titulo,
    estado: t.estado,
    responsavel: t.responsavel ?? null,
    faltando: t.faltando ?? [],
    prazo: t.prazo ?? null,
    etapa: t.etapa ?? null,
    proximoPasso: t.proximoPasso ?? null,
    descricao: (t.descricao ?? '').slice(0, 400),
  }));

  const despejo = ehDespejo({ ...info, origem: info?.origem ?? ultima?.origem });

  return [
    `Empresa: ${info?.empresa ?? '?'}`,
    `Projeto: ${info?.projeto ?? '?'}`,
    `Chat: ${ultima?.chatNome || contexto.chatId} (origem: ${ultima?.origem ?? '?'})`,
    `Tipo do grupo: ${info?.tipoGrupo || 'cliente'}${despejo ? ' — DESPEJO: qualquer tarefa vale' : ''}`,
    '',
    `Mensagens anteriores (${Math.max(0, msgs.length - 1)}):`,
    ...msgs.slice(0, -1).map(linha),
    '',
    `Tarefas abertas neste chat (${tarefas.length}):`,
    tarefas.length ? JSON.stringify(tarefas, null, 2) : '(nenhuma)',
    ...(tarefas.length
      ? ['Só devolva em "atualizacoes" (com o "id") se a ÚLTIMA MENSAGEM complementa ESSA tarefa: responde o que falta nela, muda o prazo dela, manda o que ela pedia ou a conclui. Pedido diferente, mesmo do mesmo projeto, vai em "tarefas" como tarefa nova. Na dúvida, crie.']
      : []),
    '',
    'ÚLTIMA MENSAGEM (analise esta):',
    ultima ? linha(ultima) : '(vazia)',
  ].join('\n');
}

/**
 * @returns {Promise<{ tarefas: Object[], atualizacoes: Object[] } | null>} null = cair no heurístico
 */
async function extrairComLLM(contexto, info, tarefasExistentes, opcoesLLM) {
  const ultimaMsg = contexto.mensagens[contexto.mensagens.length - 1];
  let resposta;
  try {
    resposta = await chamarLLM({
      system: SYSTEM_PROMPT,
      prompt: montarPromptContexto(contexto, info, tarefasExistentes),
      json: true,
      maxTokens: 2048,
    }, opcoesLLM);
  } catch (err) {
    console.warn(`[balde] Erro no LLM: ${err.message}, caindo pra heurística`);
    return null;
  }
  const json = resposta?.json;
  if (!json || typeof json !== 'object') return null;

  return sanearRespostaLLM(json, ultimaMsg, tarefasExistentes);
}

/**
 * Valida e normaliza o JSON do LLM. Nunca confia em ids/campos que o LLM inventar.
 */
export function sanearRespostaLLM(json, ultimaMsg, tarefasExistentes) {
  const fonte = refDe(ultimaMsg);
  const porId = new Map(tarefasExistentes.map(t => [t.id, t]));
  const porTitulo = new Map(tarefasExistentes.map(t => [norm(t.titulo), t]));

  const atualizacoes = [];
  const jaAtualizadas = new Set();

  const registrarAtualizacao = (tarefa, bruto) => {
    if (jaAtualizadas.has(tarefa.id)) return;
    const atualiz = { id: tarefa.id };
    for (const campo of CAMPOS_ATUALIZAVEIS) {
      if (bruto[campo] === undefined) continue;
      atualiz[campo] = bruto[campo];
    }
    normalizarCampos(atualiz, textoDe(ultimaMsg), tarefa);
    if (bruto.cobranca === true) {
      atualiz.cobrancas = Math.min(MAX_COBRANCAS, (tarefa.cobrancas ?? 0) + 1);
      if (!atualiz.descricao) atualiz.descricao = `Cobrança: ${textoDe(ultimaMsg)}`.trim();
    }
    if (atualiz.descricao && !atualiz.descricao.includes(tarefa.descricao ?? '')) {
      atualiz.descricao = `${tarefa.descricao}\n[Atualização] ${atualiz.descricao}`;
    }
    const fontes = tarefa.fontes || tarefa.mensagensRef || [];
    atualiz.fontes = fontes.includes(fonte) ? fontes : [...fontes, fonte];
    jaAtualizadas.add(tarefa.id);
    atualizacoes.push(atualiz);
  };

  for (const bruto of arr(json.atualizacoes)) {
    const tarefa = porId.get(bruto?.id);
    if (tarefa) registrarAtualizacao(tarefa, bruto);
  }

  const tarefas = [];
  const dataMsg = ultimaMsg?.ts ? new Date(ultimaMsg.ts) : new Date();
  for (const bruto of arr(json.tarefas)) {
    if (!bruto || typeof bruto !== 'object') continue;
    const titulo = sanearTitulo(bruto.titulo, bruto.descricao || textoDe(ultimaMsg));
    if (!titulo) continue;

    // Mesmo título de uma tarefa aberta → é atualização, não tarefa nova
    const existente = porTitulo.get(norm(titulo));
    if (existente) {
      registrarAtualizacao(existente, { ...bruto, titulo: undefined });
      continue;
    }

    const links = Array.isArray(bruto.links) && bruto.links.length ? bruto.links : extrairLinks(bruto.descricao || textoDe(ultimaMsg));
    const nota = typeof bruto.nota === 'string' && bruto.nota.trim()
      ? bruto.nota.trim()
      : (typeof bruto.nt === 'string' && bruto.nt.trim()
          ? bruto.nt.trim()
          : (typeof bruto.descricao === 'string' && bruto.descricao.trim() && bruto.descricao !== textoDe(ultimaMsg)
              ? bruto.descricao.trim()
              : null));
    const fontes = Array.isArray(bruto.fontes) && bruto.fontes.length
      ? bruto.fontes
      : (Array.isArray(bruto.mensagensRef) && bruto.mensagensRef.length
          ? bruto.mensagensRef
          : [fonte]);

    const tarefa = {
      titulo,
      descricao: typeof bruto.descricao === 'string' && bruto.descricao.trim() ? bruto.descricao.trim() : textoDe(ultimaMsg),
      estado: bruto.estado,
      responsavel: bruto.responsavel,
      faltando: bruto.faltando,
      prazo: bruto.prazo,
      tipo: bruto.tipo,
      etapa: bruto.etapa,
      proximoPasso: bruto.proximoPasso,
      fontes,
      mensagensRef: fontes,
      links,
      nota: nota ?? null,
    };
    normalizarCampos(tarefa, textoDe(ultimaMsg), {}, dataMsg);
    tarefas.push(tarefa);
  }

  return { tarefas, atualizacoes };
}

/** Normaliza in-place os campos presentes. */
function normalizarCampos(obj, textoFallback, tarefaBase = {}, dataBase = new Date()) {
  if ('titulo' in obj) obj.titulo = sanearTitulo(obj.titulo, textoFallback);
  if ('faltando' in obj || !tarefaBase.id) {
    obj.faltando = arr(obj.faltando).filter(f => typeof f === 'string' && f.trim()).map(f => f.trim());
  }
  if ('estado' in obj || !tarefaBase.id) {
    let estado = ESTADOS_LLM.includes(obj.estado) ? obj.estado : null;
    const faltando = obj.faltando ?? tarefaBase.faltando ?? [];
    if (!estado) estado = faltando.length ? ESTADOS.AGUARDANDO_INFO : (tarefaBase.estado ?? ESTADOS.PRONTA);
    obj.estado = estado;
  }
  if ('prazo' in obj) obj.prazo = calcularPrazoISO(obj.prazo, dataBase);
  if ('links' in obj) obj.links = Array.isArray(obj.links) ? obj.links.filter(u => typeof u === 'string') : [];
  if ('nota' in obj) obj.nota = typeof obj.nota === 'string' ? obj.nota.trim() : null;
  if ('tipo' in obj || !tarefaBase.id) obj.tipo = TIPOS_LLM.includes(obj.tipo) ? obj.tipo : (tarefaBase.tipo ?? 'geral');
  if ('etapa' in obj || !tarefaBase.id) obj.etapa = obj.etapa === undefined && tarefaBase.etapa ? tarefaBase.etapa : normalizarEtapa(obj.etapa);
  if ('descricao' in obj && typeof obj.descricao !== 'string') delete obj.descricao;

  if ('proximoPasso' in obj || !tarefaBase.id) {
    const passo = typeof obj.proximoPasso === 'string' ? obj.proximoPasso.trim() : '';
    obj.proximoPasso = passo || sugerirProximoPasso({
      estado: obj.estado ?? tarefaBase.estado,
      etapa: obj.etapa ?? tarefaBase.etapa,
      faltando: obj.faltando ?? tarefaBase.faltando,
    });
  }
  // Removeu o que faltava sem dizer o estado → fica pronta
  if (tarefaBase.id && Array.isArray(obj.faltando) && obj.faltando.length === 0 && !('estado' in obj)
      && tarefaBase.estado === ESTADOS.AGUARDANDO_INFO) {
    obj.estado = ESTADOS.PRONTA;
  }
  normalizarResponsavel(obj, tarefaBase);
  for (const k of Object.keys(obj)) if (obj[k] === undefined) delete obj[k];
}

/**
 * aguardando_info é sempre bola com o cliente; ao sair dela (ou de uma aprovação
 * do cliente) para execução, a bola volta para mim. Valor inválido do LLM é ignorado.
 * Tarefa nova sem responsável válido é minha — nunca fica sem dono (o padrão de
 * criarTarefa, 'ia', não é um responsável).
 */
export function normalizarResponsavel(obj, tarefaBase = {}) {
  const dado = RESPONSAVEIS_LLM.includes(obj.responsavel) ? obj.responsavel : undefined;
  delete obj.responsavel;
  const estado = obj.estado ?? tarefaBase.estado;
  let resp = dado;
  if (estado === ESTADOS.AGUARDANDO_INFO) resp = 'cliente';
  else if (!resp && tarefaBase.responsavel === 'cliente' && 'estado' in obj
           && [ESTADOS.PRONTA, ESTADOS.EM_EXECUCAO].includes(estado)) resp = 'eu';
  if (!resp && !tarefaBase.id) resp = 'eu';
  if (resp && resp !== tarefaBase.responsavel) obj.responsavel = resp;
}

function arr(v) {
  return Array.isArray(v) ? v : [];
}
