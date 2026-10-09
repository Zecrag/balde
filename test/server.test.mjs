/**
 * @file server.test.mjs — chave BALDE_EVOLUTION e carga do .env
 * A "Evolution" aqui é um http local falso: nada sai da máquina.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'balde-server-'));
process.env.BALDE_DADOS = join(tmp, 'dados');
process.env.BALDE_CONFIG = join(tmp, 'config');

const { carregarEnvLocal, evolutionLigada, iniciarServidor } = await import('../server.mjs');

describe('BALDE_EVOLUTION', () => {
  it('liga por padrão e desliga com 0/false/off ou opção evolution:false', () => {
    // GB-44: leitura manual por padrão; contínua só com BALDE_LEITURA=auto
    assert.equal(evolutionLigada({}, {}), false);
    assert.equal(evolutionLigada({}, { BALDE_EVOLUTION: '1' }), false);
    assert.equal(evolutionLigada({}, { BALDE_LEITURA: 'auto' }), true);
    assert.equal(evolutionLigada({}, { BALDE_LEITURA: 'auto', BALDE_EVOLUTION: '0' }), false);
    for (const v of ['0', 'false', 'OFF', ' 0 ']) assert.equal(evolutionLigada({}, { BALDE_EVOLUTION: v }), false, v);
    assert.equal(evolutionLigada({ evolution: false }, {}), false);
  });

  it('.env não sobrescreve variável que já veio do ambiente (nem vazia)', () => {
    const envPath = join(tmp, '.env');
    writeFileSync(envPath, 'BALDE_EVOLUTION=1\nBALDE_X=do-env\nBALDE_VAZIA=preenchida\n# comentario\n');
    const env = { BALDE_EVOLUTION: '0', BALDE_VAZIA: '' };
    carregarEnvLocal(envPath, env);
    assert.equal(env.BALDE_EVOLUTION, '0');
    assert.equal(env.BALDE_VAZIA, '');
    assert.equal(env.BALDE_X, 'do-env');
    assert.equal(evolutionLigada({}, env), false);
  });

  describe('servidor com BALDE_EVOLUTION=0', () => {
    let evolutionFalsa, chamadas = 0, servidor;
    const salvo = {};
    before(async () => {
      evolutionFalsa = http.createServer((req, res) => { chamadas++; res.writeHead(404); res.end(); });
      await new Promise(r => evolutionFalsa.listen(0, '127.0.0.1', r));
      for (const k of ['BALDE_EVOLUTION', 'BALDE_EVOLUTION_URL', 'BALDE_EVOLUTION_KEY', 'BALDE_EVOLUTION_INSTANCIA']) salvo[k] = process.env[k];
      process.env.BALDE_EVOLUTION = '0';
      process.env.BALDE_EVOLUTION_URL = `http://127.0.0.1:${evolutionFalsa.address().port}`;
      process.env.BALDE_EVOLUTION_KEY = 'teste';
      process.env.BALDE_EVOLUTION_INSTANCIA = 'teste';
    });
    after(async () => {
      if (servidor) await new Promise(r => servidor.close(r));
      await new Promise(r => evolutionFalsa.close(r));
      for (const [k, v] of Object.entries(salvo)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      rmSync(tmp, { recursive: true, force: true });
    });

    it('não fala com a Evolution mesmo com URL/KEY/INSTANCIA configuradas', async () => {
      servidor = await iniciarServidor({ porta: 0, host: '127.0.0.1' });
      await new Promise(r => setTimeout(r, 400));
      assert.equal(chamadas, 0);
    });
  });
});

after(() => rmSync(tmp, { recursive: true, force: true }));
