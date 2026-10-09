/**
 * midia-imagem.test.mjs — enriquecer(imagem) → descricaoImagem via LLM (fetch mockado).
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { enriquecer } from '../lib/midia/index.mjs';
import { descreverImagem } from '../lib/midia/imagem.mjs';

const KEYS = ['BALDE_LLM', 'BALDE_LLM_MODELO', 'BALDE_ANTHROPIC_KEY', 'ANTHROPIC_API_KEY',
  'BALDE_OPENAI_KEY', 'OPENAI_API_KEY', 'BALDE_GEMINI_KEY', 'GEMINI_API_KEY', 'BALDE_LLM_KEY', 'BALDE_DADOS'];

// PNG 1x1 válido
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

describe('enriquecer(imagem)', () => {
  let dir;
  let envSalvo;
  let fetchOriginal;
  let chamadas;

  before(() => {
    envSalvo = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
    fetchOriginal = globalThis.fetch;
  });

  after(() => {
    for (const [k, v] of Object.entries(envSalvo)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    globalThis.fetch = fetchOriginal;
  });

  beforeEach(() => {
    for (const k of KEYS) delete process.env[k];
    dir = mkdtempSync(join(tmpdir(), 'balde-img-'));
    process.env.BALDE_DADOS = join(dir, 'dados');
    chamadas = [];
  });

  afterEach(() => {
    globalThis.fetch = fetchOriginal;
    rmSync(dir, { recursive: true, force: true });
  });

  function imagem(nome = 'print.png', conteudo = PNG) {
    const arq = join(dir, nome);
    writeFileSync(arq, conteudo);
    return { id: 'm1', chatId: 'c1', tipo: 'imagem', texto: 'olha o erro', midiaPath: arq };
  }

  function mockarFetch(resposta) {
    globalThis.fetch = async (url, init) => {
      chamadas.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => resposta };
    };
  }

  it('sem LLM → mensagem intacta, sem pendente e sem exceção', async () => {
    const msg = imagem();
    const r = await enriquecer(msg);
    assert.equal(r.descricaoImagem, undefined);
    assert.notEqual(r.pendenteMidia, true);
  });

  it('anthropic: print → descricaoImagem + categoriaImagem; legenda vai no prompt', async () => {
    process.env.ANTHROPIC_API_KEY = 'teste';
    mockarFetch({ content: [{ type: 'text', text: JSON.stringify({
      categoria: 'print', descricao: 'Tela do checkout com erro 500 ao finalizar compra.', textoVisivel: 'Erro 500',
    }) }] });

    const r = await enriquecer(imagem());
    assert.equal(r.categoriaImagem, 'print');
    assert.match(r.descricaoImagem, /^\[print\] Tela do checkout/);
    assert.match(r.descricaoImagem, /Erro 500/);
    assert.equal(r.texto, 'olha o erro', 'legenda original é preservada');

    const body = chamadas[0].body;
    assert.equal(body.messages[0].content[0].type, 'image');
    assert.equal(body.messages[0].content[0].source.media_type, 'image/png');
    assert.equal(body.messages[0].content[0].source.data, PNG.toString('base64'));
    assert.match(body.messages[0].content[1].text, /olha o erro/);
  });

  it('openai: comprovante (jpg) e segunda chamada usa cache', async () => {
    process.env.OPENAI_API_KEY = 'teste';
    mockarFetch({ choices: [{ message: { content: '{"categoria":"comprovante","descricao":"Pix de R$ 300,00 para Acme em 07/10."}' } }] });

    const msg = imagem('comp.jpg', Buffer.from('ffd8ffe000104a464946000101000001', 'hex'));
    const r1 = await enriquecer(msg);
    assert.equal(r1.categoriaImagem, 'comprovante');
    assert.match(chamadas[0].body.messages[1].content[1].image_url.url, /^data:image\/jpeg;base64,/);

    const r2 = await enriquecer(msg);
    assert.equal(r2.descricaoImagem, r1.descricaoImagem);
    assert.equal(chamadas.length, 1, 'segunda chamada deve vir do cache');
  });

  it('gemini: layout; categoria desconhecida vira "outro"', async () => {
    const opcoes = {
      env: { GEMINI_API_KEY: 'teste' },
      retryMs: 0,
      fetch: async (url, init) => {
        chamadas.push({ url, body: JSON.parse(init.body) });
        return { ok: true, status: 200, json: async () => ({
          candidates: [{ content: { parts: [{ text: '{"categoria":"meme","descricao":"Arte de post com logo."}' }] } }],
        }) };
      },
    };
    const msg = imagem('arte.webp');
    const r = await descreverImagem(msg.midiaPath, '', opcoes);
    assert.equal(r.categoriaImagem, 'outro');
    assert.match(r.descricaoImagem, /Arte de post/);
    assert.equal(chamadas[0].body.contents[0].parts[0].inlineData.mimeType, 'image/png', 'mime vem dos bytes, não da extensão');
  });

  it('GB-28: .jpg criptografado do CDN do WhatsApp → não chama o LLM (evita HTTP 400)', async () => {
    process.env.OPENAI_API_KEY = 'teste';
    mockarFetch({ choices: [{ message: { content: '{"categoria":"foto","descricao":"x"}' } }] });
    const enc = Buffer.from('4e23368c15d4d8266b87a134022d961d'.repeat(8), 'hex');
    const r = await enriquecer(imagem('cdn.jpg', enc));
    assert.equal(r.descricaoImagem, undefined);
    assert.equal(chamadas.length, 0, 'bytes ilegíveis não vão pro provedor');
  });

  it('LLM falhando → mensagem intacta, sem exceção', async () => {
    process.env.OPENAI_API_KEY = 'teste';
    globalThis.fetch = async () => { throw new Error('rede caiu'); };
    const r = await enriquecer(imagem());
    assert.equal(r.descricaoImagem, undefined);
  });
});
