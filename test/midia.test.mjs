/**
 * @file balde/test/midia.test.mjs
 * Testes GB-8: enriquecimento de mídia (áudio→texto, PDF→texto).
 *
 * Roda com: node --test test/midia.test.mjs
 * Não requer nenhuma key de API — testa comportamento sem provedor.
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balde-midia-test-'));
process.env.BALDE_DADOS = path.join(tempDir, 'dados');

import { enriquecer } from '../lib/midia/index.mjs';
import { lerCache, gravarCache, hashArquivo, caminhoCache } from '../lib/midia/cache.mjs';
import { extrairPdf } from '../lib/midia/pdf.mjs';
import { provedorTranscricao } from '../lib/midia/audio.mjs';

const DIR_FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'midia');
const PDF_FIXTURE = path.join(DIR_FIXTURES, 'texto.pdf');
const OGG_FIXTURE = path.join(DIR_FIXTURES, 'silencio.ogg');

// Limpeza no fim do arquivo
after(() => {
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------- fixture de mensagem base ----------------------------------------

/** @returns {import('../lib/tipos.mjs').Mensagem} */
function mensagemBase(overrides = {}) {
  return {
    id: `teste-${Date.now()}`,
    chatId: 'chat-teste',
    chatNome: 'Grupo Teste',
    origem: 'grupo',
    autor: 'Autor Teste',
    ts: new Date().toISOString(),
    tipo: 'texto',
    texto: null,
    raw: {},
    ...overrides,
  };
}

// ---------- cleanup de cache entre testes ------------------------------------

function limparCacheHash(arquivo) {
  try {
    const hash = hashArquivo(arquivo);
    const arqCache = caminhoCache(hash);
    if (fs.existsSync(arqCache)) fs.unlinkSync(arqCache);
  } catch { /* ignora */ }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. PDF fixture com texto → mensagem.texto contém o conteúdo do PDF
// ═══════════════════════════════════════════════════════════════════════════
describe('PDF: extração de texto', () => {
  before(() => limparCacheHash(PDF_FIXTURE));

  test('fixture PDF existe', () => {
    assert.ok(fs.existsSync(PDF_FIXTURE), `Fixture não encontrado: ${PDF_FIXTURE}`);
  });

  test('extrairPdf retorna texto do fixture', () => {
    const texto = extrairPdf(PDF_FIXTURE);
    assert.ok(texto, 'extrairPdf deve retornar texto não-nulo');
    assert.ok(
      texto.includes('GB-8'),
      `Texto extraído deve conter "GB-8"; obtido: ${JSON.stringify(texto)}`,
    );
  });

  test('enriquecer(pdf) → mensagem.texto contém conteúdo do PDF', async () => {
    const msg = mensagemBase({ tipo: 'pdf', midiaPath: PDF_FIXTURE });
    const resultado = await enriquecer(msg);
    assert.ok(resultado.texto, 'texto deve estar preenchido');
    assert.ok(resultado.texto.includes('GB-8'), `texto deve conter "GB-8"; obtido: ${JSON.stringify(resultado.texto)}`);
    assert.notEqual(resultado.pendenteMidia, true, 'pendenteMidia não deve ser true');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Áudio sem provedor configurado → pendenteMidia:true e sem exceção
// ═══════════════════════════════════════════════════════════════════════════
describe('Áudio: sem provedor configurado', () => {
  // Chave OpenAI também liga a transcrição: fora do ambiente para não chamar a API real
  const VARS = ['BALDE_TRANSCRICAO', 'BALDE_OPENAI_KEY', 'OPENAI_API_KEY'];
  const originais = {};

  before(() => {
    for (const v of VARS) { originais[v] = process.env[v]; delete process.env[v]; }
    limparCacheHash(OGG_FIXTURE);
  });

  after(() => {
    for (const v of VARS) {
      if (originais[v] !== undefined) process.env[v] = originais[v];
      else delete process.env[v];
    }
  });

  test('provedorTranscricao: explícito vence; sem ele, OpenAI se houver chave', () => {
    assert.equal(provedorTranscricao({}), '');
    assert.equal(provedorTranscricao({ OPENAI_API_KEY: 'k' }), 'openai');
    assert.equal(provedorTranscricao({ BALDE_OPENAI_KEY: 'k' }), 'openai');
    assert.equal(provedorTranscricao({ BALDE_TRANSCRICAO: 'Groq', OPENAI_API_KEY: 'k' }), 'groq');
  });

  test('fixture ogg existe', () => {
    assert.ok(fs.existsSync(OGG_FIXTURE), `Fixture não encontrado: ${OGG_FIXTURE}`);
  });

  test('enriquecer(audio) sem provedor → pendenteMidia:true e sem exceção', async () => {
    const msg = mensagemBase({ tipo: 'audio', midiaPath: OGG_FIXTURE });
    let resultado;
    await assert.doesNotReject(async () => {
      resultado = await enriquecer(msg);
    }, 'enriquecer não deve rejeitar a promise');
    assert.equal(resultado.pendenteMidia, true, 'pendenteMidia deve ser true');
    assert.equal(resultado.transcricao, null, 'transcricao deve ser null');
  });

  test('enriquecer(audio) sem midiaPath → pendenteMidia:true sem exceção', async () => {
    const msg = mensagemBase({ tipo: 'audio' }); // sem midiaPath
    let resultado;
    await assert.doesNotReject(async () => {
      resultado = await enriquecer(msg);
    });
    assert.equal(resultado.pendenteMidia, true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Cache: mesmo arquivo 2x → segunda vez vem do cache
// ═══════════════════════════════════════════════════════════════════════════
describe('Cache: segunda chamada usa cache', () => {
  before(() => limparCacheHash(PDF_FIXTURE));
  after(() => limparCacheHash(PDF_FIXTURE));

  test('primeira chamada grava no cache, segunda lê do cache', async () => {
    const msg1 = mensagemBase({ id: 'cache-1', tipo: 'pdf', midiaPath: PDF_FIXTURE });
    const resultado1 = await enriquecer(msg1);
    assert.ok(resultado1.texto, 'primeira chamada deve extrair texto');

    // Verifica que o arquivo de cache foi criado
    const hash = hashArquivo(PDF_FIXTURE);
    const arqCache = caminhoCache(hash);
    assert.ok(fs.existsSync(arqCache), `Arquivo de cache deve existir em: ${arqCache}`);

    // Segunda chamada: modifica o extrator para saber se foi chamado de novo
    // Como não temos DI, verificamos indiretamente: o cache foi gerado com o
    // mesmo texto, então resultado2.texto === resultado1.texto
    const msg2 = mensagemBase({ id: 'cache-2', tipo: 'pdf', midiaPath: PDF_FIXTURE });
    const resultado2 = await enriquecer(msg2);
    assert.equal(resultado2.texto, resultado1.texto, 'segunda chamada deve retornar o mesmo texto (do cache)');
    assert.notEqual(resultado2.pendenteMidia, true, 'cache não deve marcar como pendente');
  });

  test('lerCache retorna dados para arquivo já cacheado', () => {
    const cached = lerCache(PDF_FIXTURE);
    assert.ok(cached, 'lerCache deve encontrar cache existente');
    assert.ok(cached.dados, 'cache deve ter dados');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Tipos não-mídia passam sem modificação
// ═══════════════════════════════════════════════════════════════════════════
describe('Passagem direta de mensagens não-mídia', () => {
  test('tipo texto → retorna sem alterar', async () => {
    const msg = mensagemBase({ tipo: 'texto', texto: 'Olá, mundo' });
    const resultado = await enriquecer(msg);
    assert.equal(resultado.texto, 'Olá, mundo');
    assert.equal(resultado.pendenteMidia, undefined);
  });

  test('tipo outro → retorna sem alterar', async () => {
    const msg = mensagemBase({ tipo: 'outro' });
    const resultado = await enriquecer(msg);
    assert.deepEqual(resultado, msg);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Cache: API direta
// ═══════════════════════════════════════════════════════════════════════════
describe('Cache: API direta', () => {
  test('hashArquivo é determinístico', () => {
    const h1 = hashArquivo(PDF_FIXTURE);
    const h2 = hashArquivo(PDF_FIXTURE);
    assert.equal(h1, h2, 'hash deve ser igual para o mesmo arquivo');
    assert.equal(h1.length, 64, 'hash SHA-256 deve ter 64 hex chars');
  });

  test('gravarCache + lerCache round-trip', () => {
    const hash = 'deadbeef'.repeat(8); // 64 chars
    const dados = { texto: 'round-trip test', transcricao: null };
    gravarCache(hash, dados);
    // lerCache usa hashArquivo(arquivo) — neste caso testamos o caminho direto
    const arqCache = caminhoCache(hash);
    assert.ok(fs.existsSync(arqCache));
    const lido = JSON.parse(fs.readFileSync(arqCache, 'utf8'));
    assert.deepEqual(lido, dados);
    // cleanup
    try { fs.unlinkSync(arqCache); } catch { /* ignora */ }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. PDF: arquivo inexistente → null sem exceção
// ═══════════════════════════════════════════════════════════════════════════
describe('PDF: arquivo inexistente', () => {
  test('extrairPdf com arquivo inexistente → null', () => {
    const resultado = extrairPdf('/nao/existe/arquivo.pdf');
    assert.equal(resultado, null);
  });

  test('enriquecer(pdf) com midiaPath inexistente → pendenteMidia:true', async () => {
    const msg = mensagemBase({ tipo: 'pdf', midiaPath: '/nao/existe/arquivo.pdf' });
    const resultado = await enriquecer(msg);
    assert.equal(resultado.pendenteMidia, true);
  });
});
