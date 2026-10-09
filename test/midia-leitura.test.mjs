/**
 * midia-leitura.test.mjs — Transcrição barata da leitura manual (GB-44):
 * cache por hash, custo registrado com a leitura, teto diário. Só mocks.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const RAIZ = mkdtempSync(join(tmpdir(), 'balde-midia-leitura-'));
process.env.BALDE_DADOS = join(RAIZ, 'dados');

const { transcreverAudioLeitura, audioMaxSeg, lerAudioLigado, duracaoAudio } = await import('../lib/midia/audio.mjs');

let usoPath;
let arquivo;
beforeEach(() => {
  rmSync(RAIZ, { recursive: true, force: true });
  mkdirSync(join(RAIZ, 'dados', 'midia'), { recursive: true });
  usoPath = join(RAIZ, 'dados', 'uso-llm.jsonl');
  arquivo = join(RAIZ, 'dados', 'midia', `a-${Math.random()}.ogg`);
  writeFileSync(arquivo, `OggS${Math.random()}`);
});
afterEach(() => rmSync(RAIZ, { recursive: true, force: true }));

const msg = () => ({ id: 'au', tipo: 'audio', midiaPath: arquivo, raw: { data: { message: { audioMessage: { seconds: 60 } } } } });
function api(texto = 'mude o botão') {
  const chamadas = [];
  return { chamadas, fetch: async (url, init) => { chamadas.push({ url, init }); return { ok: true, status: 200, json: async () => ({ text: texto }) }; } };
}
const ENV = { OPENAI_API_KEY: 'sk-teste' };

describe('transcreverAudioLeitura', () => {
  it('chama a API uma vez; o mesmo áudio sai do cache sem custo', async () => {
    const f = api();
    const uso = { leituraId: 'L1', empresa: 'Acme', projeto: 'Site', grupoJid: 'g@g.us' };
    const r1 = await transcreverAudioLeitura(msg(), { env: ENV, fetch: f.fetch, usoPath, local: null, ffprobe: false, uso });
    assert.equal(r1.transcricao, 'mude o botão');
    assert.ok(Math.abs(r1.custoUSD - 0.003) < 1e-9, 'gpt-4o-mini-transcribe: 1 min × US$ 0,003');
    assert.equal(f.chamadas.length, 1);
    assert.match(f.chamadas[0].url, /audio\/transcriptions/);
    assert.equal(f.chamadas[0].init.body.get('model'), 'gpt-4o-mini-transcribe');

    const r2 = await transcreverAudioLeitura(msg(), { env: ENV, fetch: f.fetch, usoPath, local: null, ffprobe: false, uso });
    assert.equal(r2.provedor, 'cache');
    assert.equal(r2.custoUSD, 0);
    assert.equal(f.chamadas.length, 1);

    const linhas = readFileSync(usoPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(linhas.length, 1);
    assert.equal(linhas[0].tipo, 'transcricao');
    assert.equal(linhas[0].leituraId, 'L1');
    assert.equal(linhas[0].grupoJid, 'g@g.us');
    assert.equal(linhas[0].segundosAudio, 60);
  });

  it('teto do dia atingido: não chama a API', async () => {
    writeFileSync(usoPath, JSON.stringify({ ts: new Date().toISOString(), custoUSD: 0.5 }) + '\n');
    const f = api();
    const r = await transcreverAudioLeitura(msg(), { env: ENV, fetch: f.fetch, usoPath, local: null, ffprobe: false });
    assert.equal(r.transcricao, null);
    assert.match(r.motivo, /limite/);
    assert.equal(f.chamadas.length, 0);
  });

  it('sem chave nem whisper local: não transcreve e não grava uso', async () => {
    const f = api();
    const r = await transcreverAudioLeitura(msg(), { env: {}, fetch: f.fetch, usoPath, local: null, ffprobe: false });
    assert.equal(r.transcricao, null);
    assert.equal(f.chamadas.length, 0);
    assert.equal(existsSync(usoPath), false);
  });

  it('padrões: áudio ligado, corte em 300 s, duração vinda do WhatsApp', () => {
    assert.equal(lerAudioLigado({}), true);
    assert.equal(lerAudioLigado({ BALDE_LER_AUDIO: 'off' }), false);
    assert.equal(audioMaxSeg({}), 300);
    assert.equal(duracaoAudio(msg(), { ffprobe: false }), 60);
  });
});
