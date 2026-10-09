/**
 * @file balde/lib/midia/pdf.mjs
 * Extração de texto de PDFs.
 *
 * Estratégia:
 *   1. `pdftotext` (poppler) se disponível no PATH → usa-o.
 *   2. Extrator mínimo em JS puro para PDFs que contenham texto em stream
 *      (não funciona para PDFs puramente de imagem/scanned).
 *
 * Nunca lança — retorna null se o texto não puder ser extraído.
 */

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

// ---------- pdftotext --------------------------------------------------------

/**
 * @returns {boolean}
 */
function pdftotextDisponivel() {
  try {
    const r = spawnSync('which', ['pdftotext'], { encoding: 'utf8' });
    return r.status === 0 && Boolean(r.stdout.trim());
  } catch {
    return false;
  }
}

/**
 * @param {string} arquivo
 * @returns {string|null}
 */
function extrairComPdftotext(arquivo) {
  const r = spawnSync('pdftotext', ['-layout', arquivo, '-'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const texto = r.stdout.trim();
  return texto || null;
}

// ---------- extrator JS puro -------------------------------------------------

/**
 * Extrai texto de PDFs com streams de texto embutidos (BT…ET blocks).
 * Não lida com PDFs comprimidos (FlateDecode etc.) além dos streams de texto simples.
 * Suficiente para PDFs gerados por Word/Google Docs que guardam texto em claro.
 * @param {Buffer} buf
 * @returns {string|null}
 */
function extrairJsPuro(buf) {
  const conteudo = buf.toString('latin1'); // latin1 preserva bytes crus

  // Tenta localizar blocos BT ... ET (Begin Text / End Text)
  const blocos = [];
  const reBt = /BT([\s\S]*?)ET/g;
  let m;
  while ((m = reBt.exec(conteudo)) !== null) {
    blocos.push(m[1]);
  }

  if (!blocos.length) return null;

  // Coleta strings em parênteses (string literal PDF): (...) ou <hex>
  const linhas = [];
  for (const bloco of blocos) {
    // Strings literais: (texto)
    const reStr = /\(([^)\\]*(?:\\.[^)\\]*)*)\)/g;
    let ms;
    const partes = [];
    while ((ms = reStr.exec(bloco)) !== null) {
      // Decodifica escapes básicos do PDF
      const txt = ms[1]
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
        .replace(/\\(.)/g, '$1');
      partes.push(txt);
    }
    // Strings hex: <4865...>
    const reHex = /<([0-9a-fA-F]+)>/g;
    while ((ms = reHex.exec(bloco)) !== null) {
      const hex = ms[1];
      let txt = '';
      for (let i = 0; i < hex.length; i += 2) {
        txt += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
      }
      partes.push(txt);
    }
    if (partes.length) linhas.push(partes.join(''));
  }

  const texto = linhas.join('\n').replace(/\r\n?/g, '\n').trim();
  return texto || null;
}

// ---------- exportação pública -----------------------------------------------

/**
 * Extrai texto de um arquivo PDF. Tenta pdftotext primeiro; cai para
 * extrator JS puro. Nunca lança.
 * @param {string} arquivo - Caminho absoluto do PDF.
 * @returns {string|null}
 */
export function extrairPdf(arquivo) {
  try {
    if (pdftotextDisponivel()) {
      const texto = extrairComPdftotext(arquivo);
      if (texto) return texto;
    }

    // Fallback JS puro
    const buf = fs.readFileSync(arquivo);
    return extrairJsPuro(buf);
  } catch {
    return null;
  }
}
