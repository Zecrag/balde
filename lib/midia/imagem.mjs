/**
 * @file balde/lib/midia/imagem.mjs
 * Descrição de imagem via LLM com visão (lib/llm.mjs).
 *
 * Classifica a imagem (print, comprovante, layout, foto, documento, outro) e
 * resume o que importa para virar tarefa: valores, datas, textos visíveis, erro
 * mostrado no print, o que o layout pede. Sem LLM ou em falha: null (nunca lança).
 */

import fs from 'node:fs';
import path from 'node:path';
import { chamarLLM } from '../llm.mjs';

export const CATEGORIAS_IMAGEM = Object.freeze(['print', 'comprovante', 'layout', 'foto', 'documento', 'outro']);

/**
 * Formato real pelos bytes iniciais — a extensão mente: mídia do WhatsApp baixada
 * direto do CDN vem criptografada (.enc) e a OpenAI devolve 400 invalid_image_format.
 * @param {Buffer} buf
 * @returns {string|null} mime suportado pelos provedores, ou null
 */
export function formatoImagem(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/** Acima disso a API recusa ou fica cara demais — não descreve. */
const TAMANHO_MAXIMO = 5 * 1024 * 1024;

const SYSTEM = `Você descreve imagens recebidas em grupos de WhatsApp de uma agência/freelancer para virar micro-tarefas.
Classifique a imagem em uma categoria:
- "print": captura de tela (site, app, erro, conversa, painel)
- "comprovante": comprovante de pagamento, Pix, boleto, nota fiscal
- "layout": arte, mockup, referência visual, peça de design
- "foto": foto comum
- "documento": foto/scan de documento, contrato, RG, CNPJ
- "outro": nada acima
Escreva "descricao" em português, 1 a 3 frases objetivas, citando o que é acionável: valores, datas, nomes, mensagens de erro, textos visíveis e o que parece ser pedido.
Formato: {"categoria": "...", "descricao": "...", "textoVisivel": "trechos de texto relevantes ou vazio"}`;

/**
 * @param {string} arquivo
 * @param {string} [legenda] — texto que veio junto com a imagem
 * @param {import('../llm.mjs').OpcoesLLM} [opcoes]
 * @returns {Promise<{ descricaoImagem: string, categoriaImagem: string } | null>}
 */
export async function descreverImagem(arquivo, legenda = '', opcoes = {}) {
  let base64;
  let mime;
  try {
    const stat = fs.statSync(arquivo);
    if (stat.size === 0 || stat.size > TAMANHO_MAXIMO) return null;
    const buf = fs.readFileSync(arquivo);
    mime = formatoImagem(buf);
    if (!mime) {
      console.warn(`[balde] Imagem ${path.basename(arquivo)} não é png/jpeg/gif/webp (criptografada?) — sem descrição`);
      return null;
    }
    base64 = buf.toString('base64');
  } catch {
    return null;
  }
  const prompt = legenda?.trim()
    ? `Legenda enviada junto com a imagem: "${legenda.trim()}"\nDescreva a imagem.`
    : 'Descreva a imagem.';

  let resposta;
  try {
    resposta = await chamarLLM({ system: SYSTEM, prompt, imagens: [{ base64, mime }], json: true, maxTokens: 600 }, opcoes);
  } catch {
    return null;
  }
  const json = resposta?.json;
  if (!json || typeof json.descricao !== 'string' || !json.descricao.trim()) return null;

  const categoria = CATEGORIAS_IMAGEM.includes(json.categoria) ? json.categoria : 'outro';
  const textoVisivel = typeof json.textoVisivel === 'string' ? json.textoVisivel.trim() : '';
  const descricao = json.descricao.trim() + (textoVisivel ? ` Texto: ${textoVisivel}` : '');

  return { descricaoImagem: `[${categoria}] ${descricao}`, categoriaImagem: categoria };
}
