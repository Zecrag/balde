/**
 * similaridade.mjs — Rede de segurança contra tarefa duplicada no mesmo chat.
 *
 * Conservadora (GB-30): pedidos diferentes no mesmo grupo são tarefas separadas,
 * mesmo falando do mesmo projeto ("anúncios", "vídeo", "campanha"). Só funde
 * quando o título extraído tem o MESMO verbo principal (ou sinônimo) e o MESMO
 * objeto que uma tarefa aberta. Nomes de empresa/projeto não contam como
 * semelhança — todo título do grupo os carrega. A descrição não entra: o LLM a
 * escreve com o contexto do grupo, e isso juntava pedidos distintos.
 */

/** Jaccard mínimo entre os objetos (título sem o verbo) para ser a mesma tarefa. */
export const LIMIAR_SIMILARIDADE = 0.6;

/** Título sem verbo reconhecível: exige quase o mesmo título inteiro. */
const LIMIAR_SEM_VERBO = 0.75;

/** Objeto contido no outro conta como o mesmo se dividirem ao menos isto de palavras. */
const MIN_CONTIDO = 3;

const STOPWORDS = new Set([
  'a', 'o', 'as', 'os', 'um', 'uma', 'uns', 'umas', 'de', 'da', 'do', 'das', 'dos',
  'em', 'na', 'no', 'nas', 'nos', 'para', 'pra', 'pro', 'por', 'com', 'sem', 'e', 'ou',
  'que', 'se', 'ao', 'aos', 'mas', 'ja', 'ainda', 'nao', 'mais', 'muito', 'isso', 'esse',
  'essa', 'este', 'esta', 'me', 'te', 'voce', 'ola', 'oi', 'ate',
]);

/** Verbos que querem dizer o mesmo trabalho. O primeiro de cada grupo é o canônico. */
const GRUPOS_VERBO = [
  ['criar', 'fazer', 'montar', 'produzir', 'elaborar', 'desenvolver', 'definir', 'escrever', 'redigir'],
  ['enviar', 'mandar', 'encaminhar', 'entregar'],
  ['ajustar', 'corrigir', 'arrumar', 'consertar', 'alterar', 'trocar', 'mudar', 'atualizar', 'editar', 'revisar'],
  ['confirmar', 'verificar', 'conferir', 'checar', 'validar'],
  ['adicionar', 'inserir', 'incluir', 'colocar', 'acrescentar'],
  ['publicar', 'subir', 'postar'],
  ['agendar', 'marcar'],
  ['pagar', 'quitar'],
];
const VERBO_CANONICO = new Map(GRUPOS_VERBO.flatMap(grupo => grupo.map(v => [v, grupo[0]])));

/** Nome do dono (BALDE_DESTINO_SEM_PISTA) aparece em todo vocativo: não conta como semelhança. */
const nomeDono = {
  has(t) {
    const empresa = String(process.env.BALDE_DESTINO_SEM_PISTA ?? 'Alice').split(/[·|]/)[0];
    return empresa.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).includes(t);
  },
};

/** Tokens normalizados em ordem (sem acento, minúsculos, sem stopwords, ≥ 2 letras). */
export function tokens(texto) {
  return new Set(
    (texto || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .split(/[^a-z0-9]+/)
      .filter(t => t.length >= 2 && !STOPWORDS.has(t) && !nomeDono.has(t)),
  );
}

export function jaccard(a, b) {
  const ta = a instanceof Set ? a : tokens(a);
  const tb = b instanceof Set ? b : tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  return intersecao(ta, tb) / (ta.size + tb.size - intersecao(ta, tb));
}

function intersecao(a, b) {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

/** Infinitivo no começo do título ("Trocar banner…") → verbo principal. */
const ehInfinitivo = t => /^[a-z]{3,}(ar|er|ir|or)$/.test(t);

/**
 * Verbo principal (canônico) e objeto do título, sem os tokens de empresa/projeto.
 * @returns {{ verbo: string|null, objeto: Set<string>, todos: Set<string> }}
 */
export function nucleo(titulo, ignorar = new Set()) {
  const lista = [...tokens(titulo)].filter(t => !ignorar.has(t));
  const [primeiro, ...resto] = lista;
  if (primeiro && ehInfinitivo(primeiro)) {
    return { verbo: VERBO_CANONICO.get(primeiro) ?? primeiro, objeto: new Set(resto), todos: new Set(lista) };
  }
  return { verbo: null, objeto: new Set(lista), todos: new Set(lista) };
}

/** Mesmo objeto: Jaccard alto, ou um contido no outro com palavras suficientes. */
function mesmoObjeto(a, b, limiar) {
  if (a.size === 0 || b.size === 0) return false;
  if (jaccard(a, b) >= limiar) return true;
  const comum = intersecao(a, b);
  return comum >= MIN_CONTIDO && comum === Math.min(a.size, b.size);
}

const normTitulo = s => [...tokens(s)].join(' ');

/**
 * As duas são a mesma tarefa?
 * @param {{ titulo?: string }} extraida
 * @param {{ titulo?: string, empresa?: string, projeto?: string }} tarefa
 */
export function mesmaTarefa(extraida, tarefa, limiar = LIMIAR_SIMILARIDADE) {
  if (!extraida?.titulo || !tarefa?.titulo) return false;
  if (normTitulo(extraida.titulo) === normTitulo(tarefa.titulo)) return true;

  const ignorar = new Set([...tokens(tarefa.empresa), ...tokens(tarefa.projeto)]);
  const a = nucleo(extraida.titulo, ignorar);
  const b = nucleo(tarefa.titulo, ignorar);

  if (a.verbo && b.verbo) return a.verbo === b.verbo && mesmoObjeto(a.objeto, b.objeto, limiar);
  return jaccard(a.todos, b.todos) >= Math.max(limiar, LIMIAR_SEM_VERBO);
}

/**
 * Tarefa aberta que é a mesma da extraída (a de objeto mais parecido), ou null.
 * @param {{ titulo?: string, descricao?: string }} extraida
 * @param {Array} abertas — tarefas abertas do mesmo chat
 * @returns {Object|null}
 */
export function acharSimilar(extraida, abertas, limiar = LIMIAR_SIMILARIDADE) {
  let melhor = null;
  let melhorNota = -1;
  for (const tarefa of abertas) {
    if (!mesmaTarefa(extraida, tarefa, limiar)) continue;
    const nota = jaccard(extraida.titulo, tarefa.titulo);
    if (nota > melhorNota) {
      melhor = tarefa;
      melhorNota = nota;
    }
  }
  return melhor;
}

/** Radical curto: "impulsionar" e "impulsionamento" → "impul"; "vídeos" → "video". */
const radical = t => t.slice(0, 5);

/** Palavras que não dizem a intenção (números por extenso, quantidades). */
const SEM_INTENCAO = new Set(['dois', 'duas', 'tres', 'quatro', 'cinco', 'todos', 'todas', 'novo', 'nova', 'novos', 'novas']);

/**
 * Mesma intenção, para tarefas de mensagens contíguas: ignora o verbo principal
 * (avaliar x programar) e compara os radicais do resto do título. Exige ao menos
 * 2 radicais em comum cobrindo 2/3 do título menor — "Adicionar legendas ao vídeo"
 * x "Criar anúncio do vídeo" (só "video" em comum) continua separado.
 */
export function mesmaIntencao(extraida, tarefa) {
  if (!extraida?.titulo || !tarefa?.titulo) return false;
  const ignorar = new Set([...tokens(tarefa.empresa), ...tokens(tarefa.projeto)]);
  const rad = titulo => new Set([...nucleo(titulo, ignorar).objeto]
    .filter(t => !SEM_INTENCAO.has(t) && !/^\d+$/.test(t)).map(radical));
  const a = rad(extraida.titulo);
  const b = rad(tarefa.titulo);
  const comum = intersecao(a, b);
  return comum >= 2 && comum >= Math.ceil((2 / 3) * Math.min(a.size, b.size));
}
