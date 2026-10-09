/**
 * Script de geração de fixtures de mídia para os testes GB-8.
 * Gera: texto.pdf (PDF com texto embutido), silencio.ogg (stub mínimo)
 * Uso: node criar-fixtures.mjs (só precisa rodar uma vez)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

// ---------- PDF com texto embutido (formato mínimo válido) -------------------
// Conteúdo esperado nos testes: "Conteúdo do PDF de teste GB-8"
const TEXTO_PDF = 'Conteudo do PDF de teste GB-8';

function criarPdfMinimo(texto) {
  // Usamos latin1 para o stream para evitar problemas de encoding
  const stream = `BT /F1 12 Tf 50 700 Td (${texto}) Tj ET`;
  const streamBytes = Buffer.from(stream, 'latin1');

  const objStream = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]\n   /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${streamBytes.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];

  const partes = ['%PDF-1.4\n'];
  const offsets = [];
  let pos = partes[0].length;
  for (const obj of objStream) {
    offsets.push(pos);
    partes.push(obj);
    pos += Buffer.byteLength(obj, 'latin1');
  }

  const xrefPos = pos;
  const xref = [
    'xref\n',
    `0 ${objStream.length + 1}\n`,
    '0000000000 65535 f \n',
    ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`),
    'trailer\n',
    `<< /Size ${objStream.length + 1} /Root 1 0 R >>\n`,
    'startxref\n',
    `${xrefPos}\n`,
    '%%EOF\n',
  ];

  return Buffer.from([...partes, ...xref].join(''), 'latin1');
}

const pdfPath = path.join(DIR, 'texto.pdf');
if (!fs.existsSync(pdfPath)) {
  fs.writeFileSync(pdfPath, criarPdfMinimo(TEXTO_PDF));
  console.log('Criado:', pdfPath);
} else {
  console.log('Já existe:', pdfPath);
}

// ---------- Stub de áudio (arquivo ogg mínimo) --------------------------------
// Apenas um arquivo com alguns bytes — não é áudio real, serve para testar
// a lógica "sem provedor → pendenteMidia:true" sem depender de codec.
const oggPath = path.join(DIR, 'silencio.ogg');
if (!fs.existsSync(oggPath)) {
  // Cabeçalho mínimo OGG (magic + zeros) — suficiente para o teste de caminho
  const ogg = Buffer.from('4f676753000200000000000000000000000000000000', 'hex');
  fs.writeFileSync(oggPath, ogg);
  console.log('Criado:', oggPath);
} else {
  console.log('Já existe:', oggPath);
}
