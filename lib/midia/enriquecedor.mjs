/**
 * @file balde/lib/midia/enriquecedor.mjs
 * `enriquecer(mensagem)` — ponto central do enriquecimento de mídia.
 *
 * Regras:
 *  - Áudio  → transcreverAudioLeitura: whisper local se existir, senão BALDE_TRANSCRICAO_MODELO
 *             (padrão gpt-4o-mini-transcribe; BALDE_TRANSCRICAO=groq usa a Groq), corte em 300 s.
 *             Sem provedor/binário/key: transcricao:null + pendenteMidia:true.
 *  - PDF    → extrai texto (pdftotext ou extrator JS puro).
 *             Sem texto extraível: texto:null + pendenteMidia:true.
 *  - Imagem → descreve via LLM (lib/llm.mjs) em mensagem.descricaoImagem +
 *             mensagem.categoriaImagem (print, comprovante, layout…).
 *             Sem LLM: devolve a mensagem intacta (não marca pendente nem cacheia).
 *  - Cache  → por hash SHA-256 do arquivo em dados/midia/.cache/
 *  - Nunca lança — qualquer erro retorna a mensagem com pendenteMidia:true.
 *
 * @param {import('../tipos.mjs').Mensagem} mensagem
 * @returns {Promise<import('../tipos.mjs').Mensagem>}
 */

import { lerCache, gravarCache, hashArquivo } from './cache.mjs';
import { transcreverAudioLeitura } from './audio.mjs';
import { extrairPdf } from './pdf.mjs';
import { descreverImagem } from './imagem.mjs';

const TIPOS_AUDIO = new Set(['audio']);
const TIPOS_PDF = new Set(['pdf']);
const TIPOS_IMAGEM = new Set(['imagem']);

/**
 * Enriquece uma mensagem com transcrição (áudio) ou texto extraído (PDF).
 * @param {import('../tipos.mjs').Mensagem} mensagem
 * @returns {Promise<import('../tipos.mjs').Mensagem>}
 */
export async function enriquecer(mensagem) {
  // Apenas tipos com mídia fazem sentido
  if (!TIPOS_AUDIO.has(mensagem.tipo) && !TIPOS_PDF.has(mensagem.tipo) && !TIPOS_IMAGEM.has(mensagem.tipo)) {
    return mensagem;
  }

  const arquivo = mensagem.midiaPath;
  if (!arquivo) {
    return { ...mensagem, pendenteMidia: true };
  }

  // ── Cache: tenta retornar resultado anterior ──────────────────────────────
  let hash;
  try {
    hash = hashArquivo(arquivo);
    const cached = lerCache(arquivo);
    // Imagem cacheada sem descrição (de antes do LLM) não conta como hit
    if (cached && !(TIPOS_IMAGEM.has(mensagem.tipo) && !cached.dados?.descricaoImagem)) {
      return { ...mensagem, ...cached.dados };
    }
  } catch {
    // arquivo inacessível → retorna pendente
    return { ...mensagem, transcricao: null, pendenteMidia: true };
  }

  // ── Processamento por tipo ─────────────────────────────────────────────────
  let resultado = { ...mensagem };

  try {
    if (TIPOS_AUDIO.has(mensagem.tipo)) {
      resultado = await enriquecerAudio(resultado, arquivo);
    } else if (TIPOS_PDF.has(mensagem.tipo)) {
      resultado = enriquecerPdf(resultado, arquivo);
    } else if (TIPOS_IMAGEM.has(mensagem.tipo)) {
      resultado = await enriquecerImagem(resultado, arquivo);
    }
  } catch {
    resultado = { ...mensagem, transcricao: null, pendenteMidia: true };
  }

  // ── Grava no cache (só se não estiver pendente — evita cachear falhas ────
  if (!resultado.pendenteMidia && hash) {
    try {
      // O que vai para o cache são apenas os campos enriquecidos
      const campos = {};
      if (resultado.transcricao !== undefined) campos.transcricao = resultado.transcricao;
      if (TIPOS_IMAGEM.has(mensagem.tipo)) {
        if (resultado.descricaoImagem) {
          campos.descricaoImagem = resultado.descricaoImagem;
          campos.categoriaImagem = resultado.categoriaImagem;
        }
      } else if (resultado.texto !== undefined) {
        campos.texto = resultado.texto;
      }
      // Imagem sem descrição não é cacheada: quando o LLM ligar, descreve
      if (Object.keys(campos).length > 0) gravarCache(hash, campos);
    } catch {
      // falha no cache não impede o resultado
    }
  }

  return resultado;
}

// ---------- auxiliares -------------------------------------------------------

/**
 * @param {import('../tipos.mjs').Mensagem} mensagem
 * @param {string} arquivo
 * @returns {Promise<import('../tipos.mjs').Mensagem>}
 */
async function enriquecerAudio(mensagem, arquivo) {
  // GB-44: mesmo caminho barato da leitura (whisper local, modelo mais barato, corte em 300 s, teto diário)
  const { transcricao } = await transcreverAudioLeitura({ ...mensagem, midiaPath: arquivo });
  if (transcricao === null) {
    return { ...mensagem, transcricao: null, pendenteMidia: true };
  }
  return { ...mensagem, transcricao, texto: transcricao, pendenteMidia: false };
}

/**
 * @param {import('../tipos.mjs').Mensagem} mensagem
 * @param {string} arquivo
 * @returns {import('../tipos.mjs').Mensagem}
 */
function enriquecerPdf(mensagem, arquivo) {
  const texto = extrairPdf(arquivo);
  if (texto === null) {
    return { ...mensagem, texto: null, pendenteMidia: true };
  }
  return { ...mensagem, texto, pendenteMidia: false };
}

/**
 * @param {import('../tipos.mjs').Mensagem} mensagem
 * @param {string} arquivo
 * @returns {Promise<import('../tipos.mjs').Mensagem>}
 */
async function enriquecerImagem(mensagem, arquivo) {
  const descricao = await descreverImagem(arquivo, mensagem.texto);
  if (!descricao) return mensagem;
  return {
    ...mensagem,
    descricaoImagem: descricao.descricaoImagem,
    categoriaImagem: descricao.categoriaImagem,
  };
}
