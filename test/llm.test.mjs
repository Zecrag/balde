/**
 * llm.test.mjs — Cliente único de LLM (anthropic | openai | gemini) com fetch mockado.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { configLLM, chamarLLM, parsearJSON, MODELOS_PADRAO } from '../lib/llm.mjs';

/** fetch falso: grava as chamadas e devolve as respostas da fila. */
function fetchFalso(...respostas) {
  const chamadas = [];
  const fn = async (url, init) => {
    chamadas.push({ url, init, body: JSON.parse(init.body) });
    const r = respostas.shift();
    if (r instanceof Error) throw r;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
    };
  };
  fn.chamadas = chamadas;
  return fn;
}

const ok = body => ({ status: 200, body });
const IMG = { base64: 'iVBORw0KGgo=', mime: 'image/png' };

describe('configLLM()', () => {
  it('sem key → null (sistema segue no heurístico)', () => {
    assert.equal(configLLM({}), null);
    assert.equal(configLLM({ BALDE_LLM: 'anthropic' }), null);
  });

  it('detecta o provedor pela key presente', () => {
    assert.equal(configLLM({ ANTHROPIC_API_KEY: 'a' }).provedor, 'anthropic');
    assert.equal(configLLM({ BALDE_ANTHROPIC_KEY: 'a' }).provedor, 'anthropic');
    assert.equal(configLLM({ OPENAI_API_KEY: 'o' }).provedor, 'openai');
    assert.equal(configLLM({ GEMINI_API_KEY: 'g' }).provedor, 'gemini');
  });

  it('BALDE_LLM escolhe entre várias keys; BALDE_LLM_MODELO sobrescreve o modelo', () => {
    const env = { ANTHROPIC_API_KEY: 'a', GEMINI_API_KEY: 'g', BALDE_LLM: 'gemini' };
    assert.equal(configLLM(env).provedor, 'gemini');
    assert.equal(configLLM(env).modelo, MODELOS_PADRAO.gemini);
    assert.equal(configLLM({ ...env, BALDE_LLM_MODELO: 'gemini-x' }).modelo, 'gemini-x');
  });

  it('modelos padrão por provedor', () => {
    assert.equal(configLLM({ ANTHROPIC_API_KEY: 'a' }).modelo, MODELOS_PADRAO.anthropic);
    assert.equal(configLLM({ OPENAI_API_KEY: 'o' }).modelo, MODELOS_PADRAO.openai);
    assert.equal(configLLM({ GEMINI_API_KEY: 'g' }).modelo, MODELOS_PADRAO.gemini);
  });

  it('BALDE_LLM=off desliga mesmo com key', () => {
    assert.equal(configLLM({ BALDE_LLM: 'off', OPENAI_API_KEY: 'o' }), null);
  });
});

describe('chamarLLM() — anthropic', () => {
  it('monta requisição com imagem base64 e parseia JSON', async () => {
    const fetch = fetchFalso(ok({ content: [{ type: 'text', text: '```json\n{"ok":true}\n```' }] }));
    const r = await chamarLLM(
      { system: 'sys', prompt: 'descreva', imagens: [IMG], json: true },
      { env: { ANTHROPIC_API_KEY: 'sk-ant' }, fetch, retryMs: 0 },
    );
    assert.deepEqual(r.json, { ok: true });
    assert.equal(r.provedor, 'anthropic');

    const { url, init, body } = fetch.chamadas[0];
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(init.headers['x-api-key'], 'sk-ant');
    assert.equal(init.headers['anthropic-version'], '2023-06-01');
    assert.equal(body.model, MODELOS_PADRAO.anthropic);
    assert.match(body.system, /^sys/);
    assert.match(body.system, /JSON/);
    const [img, txt] = body.messages[0].content;
    assert.deepEqual(img, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: IMG.base64 } });
    assert.deepEqual(txt, { type: 'text', text: 'descreva' });
  });
});

describe('chamarLLM() — openai', () => {
  it('usa response_format json_object e imagem como data URL', async () => {
    const fetch = fetchFalso(ok({ choices: [{ message: { content: '{"a":1}' } }] }));
    const r = await chamarLLM(
      { system: 'sys', prompt: 'p', imagens: [IMG], json: true },
      { env: { OPENAI_API_KEY: 'sk-oa' }, fetch, retryMs: 0 },
    );
    assert.deepEqual(r.json, { a: 1 });

    const { url, init, body } = fetch.chamadas[0];
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(init.headers.authorization, 'Bearer sk-oa');
    assert.equal(body.model, MODELOS_PADRAO.openai);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.messages[0].role, 'system');
    const partes = body.messages[1].content;
    assert.deepEqual(partes[1], { type: 'image_url', image_url: { url: `data:image/png;base64,${IMG.base64}` } });
  });
});

describe('chamarLLM() — gemini', () => {
  it('key no header (nunca na URL), inlineData e responseMimeType JSON', async () => {
    const fetch = fetchFalso(ok({ candidates: [{ content: { parts: [{ text: '{"b":' }, { text: '2}' }] } }] }));
    const r = await chamarLLM(
      { system: 'sys', prompt: 'p', imagens: [IMG], json: true },
      { env: { GEMINI_API_KEY: 'g-key' }, fetch, retryMs: 0 },
    );
    assert.deepEqual(r.json, { b: 2 });

    const { url, init, body } = fetch.chamadas[0];
    assert.equal(url, `https://generativelanguage.googleapis.com/v1beta/models/${MODELOS_PADRAO.gemini}:generateContent`);
    assert.ok(!url.includes('g-key'), 'key não pode ir na URL');
    assert.equal(init.headers['x-goog-api-key'], 'g-key');
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    assert.match(body.systemInstruction.parts[0].text, /^sys/);
    assert.deepEqual(body.contents[0].parts[0], { inlineData: { mimeType: 'image/png', data: IMG.base64 } });
  });
});

describe('chamarLLM() — timeout, retry e falhas', () => {
  const env = { OPENAI_API_KEY: 'k' };
  const resposta = ok({ choices: [{ message: { content: '{"x":1}' } }] });

  it('erro de rede na 1ª tentativa → retry e sucesso', async () => {
    const fetch = fetchFalso(new Error('ECONNRESET'), resposta);
    const r = await chamarLLM({ prompt: 'p', json: true }, { env, fetch, retryMs: 0 });
    assert.deepEqual(r.json, { x: 1 });
    assert.equal(fetch.chamadas.length, 2);
  });

  it('HTTP 503 → retry; 2 falhas → null', async () => {
    const fetch = fetchFalso({ status: 503, body: {} }, { status: 500, body: {} });
    assert.equal(await chamarLLM({ prompt: 'p' }, { env, fetch, retryMs: 0 }), null);
    assert.equal(fetch.chamadas.length, 2);
  });

  it('HTTP 401 → sem retry, null', async () => {
    const fetch = fetchFalso({ status: 401, body: {} });
    assert.equal(await chamarLLM({ prompt: 'p' }, { env, fetch, retryMs: 0 }), null);
    assert.equal(fetch.chamadas.length, 1);
  });

  it('GB-28: HTTP 400 loga code e message do provedor, nunca a key', async () => {
    const fetch = fetchFalso({ status: 400, body: { error: {
      message: 'You uploaded an unsupported image.', type: 'invalid_request_error', code: 'invalid_image_format',
    } } });
    const avisos = [];
    const warn = console.warn;
    console.warn = (...a) => avisos.push(a.join(' '));
    try {
      assert.equal(await chamarLLM({ prompt: 'p' }, { env, fetch, retryMs: 0 }), null);
    } finally {
      console.warn = warn;
    }
    assert.equal(fetch.chamadas.length, 1);
    assert.match(avisos.join('\n'), /HTTP 400 .*invalid_image_format — You uploaded an unsupported image\./);
    assert.ok(!/Bearer|authorization/i.test(avisos.join('\n')));
  });

  it('timeout aborta a tentativa e faz 1 retry', async () => {
    let n = 0;
    const fetch = (url, init) => new Promise((resolve, reject) => {
      n++;
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    });
    const r = await chamarLLM({ prompt: 'p' }, { env: { ...env, BALDE_LLM_TIMEOUT_MS: '20' }, fetch, retryMs: 0 });
    assert.equal(r, null);
    assert.equal(n, 2);
  });

  it('json=true e resposta sem JSON → null', async () => {
    const fetch = fetchFalso(ok({ choices: [{ message: { content: 'desculpe, não sei' } }] }));
    assert.equal(await chamarLLM({ prompt: 'p', json: true }, { env, fetch, retryMs: 0 }), null);
  });

  it('sem key não chama fetch', async () => {
    const fetch = fetchFalso();
    assert.equal(await chamarLLM({ prompt: 'p' }, { env: {}, fetch }), null);
    assert.equal(fetch.chamadas.length, 0);
  });
});

describe('parsearJSON()', () => {
  it('tolera cerca e texto em volta', () => {
    assert.deepEqual(parsearJSON('Aqui: {"a":[1]} fim'), { a: [1] });
    assert.deepEqual(parsearJSON('```\n{"a":2}\n```'), { a: 2 });
    assert.equal(parsearJSON('nada'), undefined);
  });
});

describe('uso e teto diário (GB-44)', async () => {
  const { mkdtempSync, rmSync, readFileSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { caminhoUso, custoEstimado } = await import('../lib/llm.mjs');

  it('sob node --test sem usoPath não grava, mesmo com env injetado sem NODE_TEST_CONTEXT', () => {
    assert.equal(caminhoUso({}, { OPENAI_API_KEY: 'k' }), null);
    assert.equal(caminhoUso({ usoPath: '/x/uso.jsonl' }, {}), '/x/uso.jsonl');
  });

  it('grava tokensIn/tokensOut, custo e os campos da leitura', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'balde-uso-'));
    try {
      const usoPath = join(dir, 'uso-llm.jsonl');
      const fetch = fetchFalso(ok({ choices: [{ message: { content: '{"n":[]}' } }], usage: { prompt_tokens: 2000, completion_tokens: 300 } }));
      const r = await chamarLLM({ system: 's', prompt: 'p', json: true }, {
        env: { OPENAI_API_KEY: 'k' }, fetch, usoPath, uso: { leituraId: 'L9', empresa: 'Acme', projeto: 'Site', grupoJid: 'g@g.us' },
      });
      assert.deepEqual(r.json, { n: [] });
      const [linha] = readFileSync(usoPath, 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(linha.leituraId, 'L9');
      assert.equal(linha.tipo, 'extracao');
      assert.equal(linha.tokensIn, 2000);
      assert.equal(linha.tokensOut, 300);
      assert.equal(linha.modelo, MODELOS_PADRAO.openai);
      assert.equal(linha.custoUSD, Number(custoEstimado(MODELOS_PADRAO.openai, 2000, 300, {}).toFixed(6)));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('teto atingido: não chama o provedor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'balde-uso-'));
    try {
      const usoPath = join(dir, 'uso-llm.jsonl');
      writeFileSync(usoPath, JSON.stringify({ ts: new Date().toISOString(), custoUSD: 0.5 }) + '\n');
      const fetch = fetchFalso(ok({ choices: [{ message: { content: '{}' } }] }));
      assert.equal(await chamarLLM({ prompt: 'p' }, { env: { OPENAI_API_KEY: 'k' }, fetch, usoPath }), null);
      assert.equal(fetch.chamadas.length, 0);
      assert.ok(await chamarLLM({ prompt: 'p' }, { env: { OPENAI_API_KEY: 'k', BALDE_LLM_LIMITE_DIA_USD: '1' }, fetch, usoPath }));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
