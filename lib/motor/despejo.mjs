/**
 * despejo.mjs — Roteamento das mensagens do grupo despejo para empresa · projeto.
 *
 * O despejo (ex.: "BALDE ALICE") é onde o dono joga tudo; a tarefa não deve
 * ficar na empresa do grupo, e sim no cliente/projeto de que ela trata:
 *   a) menção explícita ("material do site da Acme", "é da Exemplo", "#acme",
 *      "cliente: X") define empresa · projeto e vira o contexto fixo do despejo
 *      pelos próximos 30 min / 10 mensagens, até nova menção;
 *   b) assunto administrativo da empresa do dono (boleto, nota fiscal, razão
 *      social, cadastro…) → BALDE_EMPRESA_DONO · BALDE_PROJETO_ADMIN;
 *   c) cliente citado que não existe NUNCA vira empresa (GB-36b): a tarefa segue as
 *      regras b/d e leva o nome em `clienteSugerido` (só nomes plausíveis, ≥ 3 letras);
 *   d) sem pista → BALDE_DESTINO_SEM_PISTA (ver destinosDono).
 * Nome parecido ("Aitus" → Acme, "Volca" → Exemplo) casa por similaridade.
 */

/**
 * Destinos do dono, lidos do ambiente NA HORA (o .env carrega depois dos imports):
 *   BALDE_EMPRESA_DONO      — empresa do administrativo (padrão fictício "Exemplo")
 *   BALDE_PROJETO_ADMIN     — projeto administrativo (padrão "Administrativo")
 *   BALDE_DESTINO_SEM_PISTA — "Empresa · Projeto" sem pista (padrão "Alice · Pessoal")
 * Os nomes reais ficam só no .env — o código exportado não carrega nenhum.
 */
export function destinosDono(env = process.env) {
  const empresaDono = env.BALDE_EMPRESA_DONO?.trim() || 'Exemplo';
  const administrativo = { empresa: empresaDono, projeto: env.BALDE_PROJETO_ADMIN?.trim() || 'Administrativo' };
  const [empresa, projeto] = String(env.BALDE_DESTINO_SEM_PISTA ?? '').replace(/^['"]|['"]$/g, '')
    .split(/\s*[·|]\s*/).map(s => s.trim());
  const pessoal = empresa ? { empresa, projeto: projeto || 'Pessoal' } : { empresa: 'Alice', projeto: 'Pessoal' };
  return { empresaDono, administrativo, pessoal };
}

/** Padrões fictícios (sem env); o roteamento usa destinosDono(). */
export const EMPRESA_DONO = destinosDono({}).empresaDono;
export const ADMINISTRATIVO = Object.freeze(destinosDono({}).administrativo);
export const PESSOAL = Object.freeze(destinosDono({}).pessoal);

/** Contexto fixo vale por este tempo ou este número de mensagens, o que vier antes. */
export const FIXO_MS = 30 * 60_000;
export const FIXO_MENSAGENS = 10;

/** Similaridade mínima (1 − Levenshtein/maior) entre nome citado e nome conhecido. */
const LIMIAR_NOME = 0.6;
/** Nome solto no texto (sem "da X", "#x", "cliente: X") exige mais — evita "dados" → Delta. */
const LIMIAR_SOLTO = 0.8;

const PADRAO_ADMINISTRATIVO = /\b(boletos?|notas? fisca(l|is)|nf-?e?|raz[aã]o social|cadastros?|cnpj|inscri[cç][aã]o (estadual|municipal)|contador|contabilidade|imposto|das|darf|guia|certificado digital|alvar[aá])\b/i;

/**
 * Capturas explícitas de nome de cliente. `livre`: o nome capturado vale mesmo
 * minúsculo ("#acme", "cliente: acme"); nos demais, cliente desconhecido só
 * conta se vier com inicial maiúscula ("material do site da Acme").
 */
const PALAVRA = '[\\p{L}\\d&]+';
const PADROES_MENCAO = [
  { livre: true, re: /(?:^|\s)#(\p{L}[\p{L}\d_-]{1,40})(?=$|[\s,.;:!?])/u },
  { livre: true, re: /\bcliente\s*[:=-]\s*([\p{L}\d][\p{L}\d&.\- ]{1,40}?)\s*(?=[,.;!?\n]|$)/iu },
  // Lookahead + /g: casamentos sobrepostos ("material do site da Acme" tenta "site da Acme")
  { livre: false, re: new RegExp(`(?=(?:^|\\s)(?:[ée]|eh)\\s+d[aoe]s?\\s+(${PALAVRA}(?:\\s+${PALAVRA})?))`, 'giu') },
  { livre: false, re: new RegExp(`(?=\\b(?:site|material|campanha|projeto|an[uú]ncios?|conta|loja|app|landing|post(?:s|agens)?|v[ií]deos?|arte|logo|cliente|raz[aã]o social|cnpj|contrato|cadastro|boletos?|notas?)\\s+(?:d[aoe]s?\\s+)?(${PALAVRA}(?:\\s+${PALAVRA})?))`, 'giu') },
];

/** Palavras capitalizadas que não são cliente. */
const NAO_CLIENTE = new Set(['novo', 'nova', 'novos', 'novas', 'final', 'abaixo', 'acima', 'aqui', 'anexo', 'segue', 'atual', 'antigo', 'antiga',
  'pdf', 'png', 'jpg', 'pix', 'ok', 'home', 'black', 'friday', 'whatsapp', 'instagram', 'facebook', 'google', 'meta', 'pix', 'natal',
  'balde', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado', 'domingo', 'janeiro', 'fevereiro', 'marco',
  'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']);

const ARTIGOS = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'geral']);
const STOP = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'the', 'geral', 'projeto', 'ads', 'site', 'mkt']);

const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const palavras = s => norm(s).split(/[^a-z0-9&]+/).filter(Boolean);

/**
 * Texto que dá para ler. PDF mal extraído chega como binário cru, onde "#x" e
 * "da X" aparecem por acaso — esse texto não serve de pista.
 */
export function legivel(texto) {
  if (typeof texto !== 'string' || !texto.trim()) return false;
  const amostra = texto.slice(0, 4000);
  const ruins = (amostra.match(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f\ufffd]/g) ?? []).length;
  if (ruins / amostra.length >= 0.01) return false;
  if (amostra.length < 200) return true;
  const comuns = (amostra.match(/[\p{L}\d\s.,;:!?()'"\-\/#@&%$+*=_]/gu) ?? []).length;
  return comuns / amostra.length > 0.85;
}

export function similaridadeNome(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const m = a.length, n = b.length;
  let ant = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(ant[j] + 1, cur[j - 1] + 1, ant[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    ant = cur;
  }
  return 1 - ant[n] / Math.max(m, n);
}

/**
 * Legenda e nome do arquivo da mídia ("Boleto_Arutech_consultoria.pdf" → "Boleto Arutech
 * consultoria"): o enriquecimento troca o texto da mensagem pelo conteúdo extraído.
 */
function legendasDe(mensagem) {
  const msg = mensagem.raw?.data?.message ?? mensagem.raw?.message ?? {};
  const saida = new Set();
  for (const tipo of ['documentMessage', 'imageMessage', 'videoMessage', 'documentWithCaptionMessage']) {
    const m = msg[tipo]?.message?.documentMessage ?? msg[tipo];
    for (const v of [m?.caption, m?.fileName, m?.title]) {
      if (typeof v === 'string' && v.trim()) saida.add(v.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_]+/g, ' ').trim());
    }
  }
  return [...saida];
}

/** Uma palavra casa com um nome: igual (nomes curtos) ou parecida (≥ 4 letras). */
function palavraCasa(palavra, nome, limiar = LIMIAR_NOME) {
  if (palavra === nome) return true;
  if (palavra.length < 4 || nome.length < 4) return false;
  return similaridadeNome(palavra, nome) >= limiar;
}

/**
 * Empresas conhecidas (sem o próprio despejo), com seus projetos. A empresa do
 * dono entra sempre, com o projeto Administrativo.
 * @param {{ empresa: string, projeto: string, tipo?: string, ganho?: number }[]} projetos
 */
export function empresasConhecidas(projetos) {
  const mapa = new Map();
  const add = (empresa, projeto, ganho = 0) => {
    if (!empresa || empresa === '?') return;
    const k = norm(empresa);
    if (!mapa.has(k)) mapa.set(k, { empresa, projetos: [], ganho: 0 });
    const e = mapa.get(k);
    if (projeto && !e.projetos.some(p => norm(p) === norm(projeto))) e.projetos.push(projeto);
    e.ganho = Math.max(e.ganho, Number(ganho) || 0);
  };
  for (const p of projetos ?? []) if (!/despejo/i.test(p.tipo ?? '')) add(p.empresa, p.projeto, p.ganho);
  const { administrativo } = destinosDono();
  add(administrativo.empresa, administrativo.projeto);
  return [...mapa.values()];
}

/** Empresa conhecida citada no trecho (nome inteiro ou palavra parecida). */
function acharEmpresa(trecho, empresas, limiar = LIMIAR_NOME) {
  const ps = palavras(trecho);
  let melhor = null;
  let nota = 0;
  for (const e of empresas) {
    const chaves = palavras(e.empresa).filter(w => !STOP.has(w));
    for (const c of chaves) {
      for (const p of ps) {
        if (!palavraCasa(p, c, limiar)) continue;
        const s = similaridadeNome(p, c);
        if (s > nota) { melhor = e; nota = s; }
      }
    }
  }
  return melhor;
}

/** Projeto da empresa: o citado no texto, senão Geral, senão o único/primeiro. */
const SINONIMOS_PROJETO = { anuncio: 'ads', anuncios: 'ads', campanha: 'ads', campanhas: 'ads', trafego: 'ads', impulsionamento: 'ads', landing: 'site', pagina: 'site' };

function escolherProjeto(empresa, texto) {
  const ps = palavras(texto).flatMap(w => SINONIMOS_PROJETO[w] ? [w, SINONIMOS_PROJETO[w]] : [w]);
  const citado = empresa.projetos.find(p => palavras(p).filter(w => w.length >= 2 && !ARTIGOS.has(w))
    .some(w => ps.some(x => palavraCasa(x, w))));
  if (citado) return citado;
  return empresa.projetos.find(p => norm(p) === 'geral') ?? empresa.projetos[0] ?? 'Geral';
}

/**
 * Menção explícita na mensagem.
 * @returns {{ empresa: string, projeto: string } | { clienteSugerido: string } | null}
 */
export function detectarMencao(texto, empresas) {
  if (!texto) return null;
  let sugerido = null;
  for (const { livre, re } of PADROES_MENCAO) {
    const achados = re.global ? [...texto.matchAll(re)] : [texto.match(re)].filter(Boolean);
    for (const m of achados) {
      const capturado = m[1].trim().split(/\s+/).filter((w, i, a) => !(GANCHOS.test(w) && i < a.length - 1)).join(' ');
      const conhecida = acharEmpresa(capturado, empresas);
      if (conhecida) return { empresa: conhecida.empresa, projeto: escolherProjeto(conhecida, texto) };
      // Desconhecido: nunca vira empresa — só fica como sugestão, se parecer nome de verdade
      const nome = livre ? capturado : iniciaisMaiusculas(capturado);
      if (!sugerido && pareceNome(nome)) sugerido = nome.replace(/^\p{Ll}/u, c => c.toUpperCase());
    }
  }
  // Sem padrão explícito: nome conhecido solto no texto também é menção
  const conhecida = acharEmpresa(texto, empresas, LIMIAR_SOLTO);
  if (conhecida) return { empresa: conhecida.empresa, projeto: escolherProjeto(conhecida, texto) };
  return sugerido ? { clienteSugerido: sugerido } : null;
}

/**
 * Nome de cliente plausível: palavras só de letras, ≥ 3 letras, com vogal, sem
 * sigla em caixa alta nem token aleatório ("5OX", "Kç", "BUILDA", "xptq").
 */
export function pareceNome(nome) {
  if (!nome) return false;
  const ws = nome.trim().split(/\s+/);
  if (ws.length > 3) return false;
  const dono = new Set(palavras(destinosDono().pessoal.empresa));
  if (ws.every(w => NAO_CLIENTE.has(norm(w)) || dono.has(norm(w)))) return false;
  return ws.every(w => /^\p{L}+$/u.test(w) && w.length >= 3 && /[aeiouáéíóúâêôãõ]/i.test(w)
    && w !== w.toUpperCase() && !/[^aeiouáéíóúâêôãõ\s]{4,}/i.test(w));
}

/** Palavras-gancho do padrão ("Material Site Acme" → pula "Site"). */
const GANCHOS = /^(site|material|campanha|projeto|an[uú]ncios?|conta|loja|app|landing|posts?|postage(m|ns)|v[ií]deos?|arte|logo|cliente|boletos?|notas?|contrato|cadastro|cnpj|d[aoe]s?)$/i;

/** "Fulano Beta conforme" → "Fulano Beta"; "semana passada" → "". */
function iniciaisMaiusculas(trecho) {
  const saida = [];
  for (const w of trecho.split(/\s+/)) {
    if (!saida.length && GANCHOS.test(w)) continue;
    if (!/^\p{Lu}/u.test(w)) break;
    saida.push(w);
  }
  return saida.join(' ');
}

/**
 * Decide empresa · projeto de uma mensagem do despejo e o contexto fixo seguinte.
 * Destino é SEMPRE um projeto conhecido (GRUPOS.md), o administrativo ou o destino
 * sem pista do dono (destinosDono; ou o projeto interno de triagem, se existir) — nunca empresa nova.
 * Cliente citado que não existe só vai em `clienteSugerido`.
 *
 * @param {{ texto?: string, transcricao?: string, descricaoImagem?: string, ts?: string, raw?: Object }} mensagem
 * @param {{ empresa: string, projeto: string, ateMs: number, restantes: number } | null} fixo
 * @param {Array} projetos — listarProjetos()
 * @returns {{ destino: { empresa: string, projeto: string, receitaMensal: number, clienteSugerido?: string, motivo: string },
 *             fixo: Object|null }}
 */
export function rotearDespejo(mensagem, fixo, projetos) {
  const texto = [...legendasDe(mensagem), mensagem.texto, mensagem.transcricao, mensagem.descricaoImagem]
    .filter(legivel).join(' ');
  const agora = Number.isFinite(Date.parse(mensagem.ts ?? '')) ? Date.parse(mensagem.ts) : Date.now();
  const empresas = empresasConhecidas(projetos);
  const receita = nome => empresas.find(e => norm(e.empresa) === norm(nome))?.ganho ?? 0;
  const mencao = detectarMencao(texto, empresas);
  const sugerido = mencao?.clienteSugerido;
  const destino = (alvo, motivo) => ({
    empresa: alvo.empresa, projeto: alvo.projeto, receitaMensal: receita(alvo.empresa), motivo,
    ...(sugerido ? { clienteSugerido: sugerido } : {}),
  });

  if (mencao?.empresa) {
    const alvo = { empresa: mencao.empresa, projeto: mencao.projeto };
    return { destino: destino(alvo, 'mencao'), fixo: { ...alvo, ateMs: agora + FIXO_MS, restantes: FIXO_MENSAGENS } };
  }

  // Citou outro cliente (mesmo sem cadastro): o contexto fixo anterior acaba
  if (fixo?.empresa && !sugerido && fixo.restantes > 0 && agora <= fixo.ateMs) {
    return { destino: destino(fixo, 'contexto'), fixo: { ...fixo, restantes: fixo.restantes - 1 } };
  }

  const { administrativo, pessoal } = destinosDono();
  if (PADRAO_ADMINISTRATIVO.test(texto)) return { destino: destino(administrativo, 'administrativo'), fixo: null };
  return { destino: destino(triagem(projetos) ?? pessoal, sugerido ? 'cliente-desconhecido' : 'pessoal'), fixo: null };
}

/** Projeto interno de triagem do GRUPOS.md, se o dono tiver criado um. */
function triagem(projetos) {
  const p = (projetos ?? []).find(x => /triagem/i.test(`${x.projeto} ${x.empresa}`) && !/despejo/i.test(x.tipo ?? ''));
  return p ? { empresa: p.empresa, projeto: p.projeto } : null;
}
