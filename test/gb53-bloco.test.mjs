/**
 * test/gb53-bloco.test.mjs — Testes do Modo Bloco configurável (GB-53):
 *   1. Config persistida em dados/config-bloco.json (padrão {ativo: true, abrir: "Cliente", fechar: "Concluir"}).
 *   2. Rotas GET e PUT /api/config/bloco com checagens e validação de palavras (1 a 20 letras, regex seguro) -> PUT inválido dá 400.
 *   3. GET /api/blocos/pendentes lista blocos abertos com {grupo, cliente, mensagens: N, desde}.
 *   4. Config com palavras trocadas ("Projeto"/"Fim") abre e fecha o bloco.
 *   5. ativo: false desliga o modo bloco (não abre bloco pendente).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';

import {
  lerAgora,
  criarRotaLeitura,
  lerConfigBloco,
  gravarConfigBloco,
  listarBlocosPendentes,
  acharAberturaBloco,
  acharFechamentoBloco,
  validarPalavraBloco,
  escaparRegex,
} from '../lib/leitura.mjs';
import { criarStore } from '../lib/store.mjs';

const G_BALDE = '120363999999999001@g.us';
const G_CLIENTE = '120363999999999002@g.us';

const GRUPOS = [
  { jid: G_CLIENTE, link: G_CLIENTE, empresa: 'ClienteX', projeto: 'Geral', tipo: 'cliente' },
  { jid: G_BALDE, link: G_BALDE, empresa: 'Balde', projeto: 'Balde', tipo: 'despejo' },
];

function mockEvolution(msgsPorJid = {}) {
  return async (jid, _page) => {
    const records = (msgsPorJid[jid] ?? []).map((m, idx) => ({
      key: { remoteJid: jid, id: m.id ?? `msg-${idx + 1}` },
      messageTimestamp: m.tsSegundos ?? 1791555200 + idx,
      pushName: m.autor ?? 'Dono',
      message: { conversation: m.texto ?? '' },
    }));
    return { records, pages: 1 };
  };
}

describe('GB-53: Modo bloco configurável', () => {
  let tmpDir;
  let dadosDir;
  let store;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'balde-gb53-'));
    dadosDir = join(tmpDir, 'dados');
    mkdirSync(dadosDir, { recursive: true });
    store = criarStore(tmpDir);
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('1. lerConfigBloco retorna padrão quando arquivo não existe', () => {
    const cfg = lerConfigBloco(dadosDir);
    assert.deepEqual(cfg, { ativo: true, abrir: 'Cliente', fechar: 'Concluir' });
  });

  it('2. validarPalavraBloco valida 1 a 20 letras e rejeita regex/números/espaços', () => {
    assert.equal(validarPalavraBloco('Cliente'), true);
    assert.equal(validarPalavraBloco('Projeto'), true);
    assert.equal(validarPalavraBloco('Fim'), true);
    assert.equal(validarPalavraBloco('Ação'), true);
    assert.equal(validarPalavraBloco('Início'), true);
    assert.equal(validarPalavraBloco('A'), true);

    // Inválidos:
    assert.equal(validarPalavraBloco(''), false);
    assert.equal(validarPalavraBloco('   '), false);
    assert.equal(validarPalavraBloco('Cliente123'), false);
    assert.equal(validarPalavraBloco('Cliente.*'), false);
    assert.equal(validarPalavraBloco('Cliente (teste)'), false);
    assert.equal(validarPalavraBloco('UmaPalavraMuitoLongaComMaisDeVinteLetras'), false);
    assert.equal(validarPalavraBloco(null), false);
    assert.equal(validarPalavraBloco(undefined), false);
  });

  it('3. acharAberturaBloco e acharFechamentoBloco respeitam palavras dinâmicas e ativo:false', () => {
    assert.equal(acharAberturaBloco('Cliente PadariaAlfa'), 'PadariaAlfa');
    assert.equal(acharFechamentoBloco('Concluir PadariaAlfa'), 'PadariaAlfa');

    // Palavras trocadas
    const cfgTrocada = { ativo: true, abrir: 'Projeto', fechar: 'Fim' };
    assert.equal(acharAberturaBloco('Projeto AlphaCorp', cfgTrocada), 'AlphaCorp');
    assert.equal(acharFechamentoBloco('Fim AlphaCorp', cfgTrocada), 'AlphaCorp');
    assert.equal(acharAberturaBloco('Cliente AlphaCorp', cfgTrocada), null);

    // ativo: false desliga
    const cfgDesligada = { ativo: false, abrir: 'Cliente', fechar: 'Concluir' };
    assert.equal(acharAberturaBloco('Cliente PadariaAlfa', cfgDesligada), null);
    assert.equal(acharFechamentoBloco('Concluir PadariaAlfa', cfgDesligada), null);
  });

  it('4. Rotas HTTP GET e PUT /api/config/bloco e validação de 400', async () => {
    const rota = criarRotaLeitura({ host: '127.0.0.1', opcoes: { dadosDir } });
    const srv = http.createServer(async (req, res) => {
      if (!(await rota(req, res))) { res.writeHead(404); res.end(); }
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;

    try {
      // GET padrão inicial
      const rGet1 = await fetch(`${base}/api/config/bloco`);
      assert.equal(rGet1.status, 200);
      const dGet1 = await rGet1.json();
      assert.deepEqual(dGet1, { ativo: true, abrir: 'Cliente', fechar: 'Concluir' });

      // PUT com palavra inválida -> 400
      const rPutInvalido1 = await fetch(`${base}/api/config/bloco`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ abrir: 'PalavraComNumeros123' }),
      });
      assert.equal(rPutInvalido1.status, 400);

      const rPutInvalido2 = await fetch(`${base}/api/config/bloco`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fechar: '.*regex' }),
      });
      assert.equal(rPutInvalido2.status, 400);

      const rPutInvalido3 = await fetch(`${base}/api/config/bloco`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ativo: 'não-booleano' }),
      });
      assert.equal(rPutInvalido3.status, 400);

      // PUT válido
      const rPutValido = await fetch(`${base}/api/config/bloco`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ativo: true, abrir: 'Projeto', fechar: 'Fim' }),
      });
      assert.equal(rPutValido.status, 200);
      const dPutValido = await rPutValido.json();
      assert.deepEqual(dPutValido, { ativo: true, abrir: 'Projeto', fechar: 'Fim' });

      // GET subsequente reflete alteração
      const rGet2 = await fetch(`${base}/api/config/bloco`);
      assert.equal(rGet2.status, 200);
      const dGet2 = await rGet2.json();
      assert.deepEqual(dGet2, { ativo: true, abrir: 'Projeto', fechar: 'Fim' });

      // Persistência em dados/config-bloco.json
      const arq = JSON.parse(readFileSync(join(dadosDir, 'config-bloco.json'), 'utf8'));
      assert.equal(arq.abrir, 'Projeto');
      assert.equal(arq.fechar, 'Fim');
      assert.equal(arq.ativo, true);
    } finally {
      await new Promise(r => srv.close(r));
    }
  });

  it('5. Modo bloco com palavras trocadas ("Projeto"/"Fim") abre e fecha o bloco e lista blocos pendentes', async () => {
    // Grava config com palavras trocadas
    writeFileSync(
      join(dadosDir, 'config-bloco.json'),
      JSON.stringify({ ativo: true, abrir: 'Projeto', fechar: 'Fim' }),
      'utf8'
    );

    // Inicialização da leitura
    await lerAgora({
      dadosDir,
      store,
      gruposConfig: GRUPOS,
      buscarPagina: mockEvolution({ [G_BALDE]: [] }),
      env: { BALDE_LLM: 'off' },
      agoraMs: 1791555200 * 1000,
    });

    // Leitura 1: abre bloco com "Projeto PadariaAlfa"
    const msgs1 = [
      { id: 'b-1', texto: 'Projeto PadariaAlfa', tsSegundos: 1791555210 },
      { id: 'b-2', texto: 'Configurar servidor DNS', tsSegundos: 1791555211 },
    ];
    await lerAgora({
      dadosDir,
      store,
      gruposConfig: GRUPOS,
      buscarPagina: mockEvolution({ [G_BALDE]: msgs1 }),
      env: { BALDE_LLM: 'off' },
      agoraMs: 1791555215 * 1000,
    });

    // Tarefas ainda não processadas
    assert.equal(store.lerTarefas().length, 0, 'não deve processar enquanto o bloco não conclui');

    // Bloco pendente em leitura.json
    const pendentes1 = listarBlocosPendentes(dadosDir);
    assert.equal(pendentes1.length, 1);
    assert.equal(pendentes1[0].cliente, 'PadariaAlfa');
    assert.equal(pendentes1[0].mensagens, 2);
    assert.ok(pendentes1[0].desde);

    // Leitura 2: conclui o bloco com "Fim PadariaAlfa"
    const msgs2 = [
      { id: 'b-3', texto: 'Criar contas de email', tsSegundos: 1791555220 },
      { id: 'b-4', texto: 'Fim PadariaAlfa', tsSegundos: 1791555221 },
    ];
    await lerAgora({
      dadosDir,
      store,
      gruposConfig: GRUPOS,
      buscarPagina: mockEvolution({ [G_BALDE]: msgs2 }),
      env: { BALDE_LLM: 'off' },
      agoraMs: 1791555225 * 1000,
    });

    // Bloco concluído e removido dos pendentes
    const pendentes2 = listarBlocosPendentes(dadosDir);
    assert.equal(pendentes2.length, 0, 'bloco deve estar limpo após conclusão');

    const tarefas = store.lerTarefas();
    assert.ok(tarefas.length >= 1, 'deve ter criado tarefas do bloco');
    for (const t of tarefas) {
      assert.equal(t.empresa, 'Balde');
      assert.match(t.titulo, /PadariaAlfa/);
    }
  });

  it('6. ativo: false desliga o modo bloco e não abre bloco pendente', async () => {
    // Grava config com ativo: false
    writeFileSync(
      join(dadosDir, 'config-bloco.json'),
      JSON.stringify({ ativo: false, abrir: 'Cliente', fechar: 'Concluir' }),
      'utf8'
    );

    // Inicialização da leitura
    await lerAgora({
      dadosDir,
      store,
      gruposConfig: GRUPOS,
      buscarPagina: mockEvolution({ [G_BALDE]: [] }),
      env: { BALDE_LLM: 'off' },
      agoraMs: 1791555200 * 1000,
    });

    const msgs = [
      { id: 'x-1', texto: 'Cliente PadariaAlfa', tsSegundos: 1791555210 },
      { id: 'x-2', texto: 'Configurar servidor DNS urgente', tsSegundos: 1791555211 },
    ];
    await lerAgora({
      dadosDir,
      store,
      gruposConfig: GRUPOS,
      buscarPagina: mockEvolution({ [G_BALDE]: msgs }),
      env: { BALDE_LLM: 'off' },
      agoraMs: 1791555215 * 1000,
    });

    const estado = JSON.parse(readFileSync(join(dadosDir, 'leitura.json'), 'utf8'));
    assert.equal(estado.grupos[G_BALDE]?.bloco, undefined, 'com ativo:false não deve abrir bloco');
    assert.equal(listarBlocosPendentes(dadosDir).length, 0);
  });

  it('7. GET /api/blocos/pendentes via HTTP', async () => {
    const rota = criarRotaLeitura({ host: '127.0.0.1', opcoes: { dadosDir } });
    const srv = http.createServer(async (req, res) => {
      if (!(await rota(req, res))) { res.writeHead(404); res.end(); }
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;

    try {
      // Vazio
      const r1 = await fetch(`${base}/api/blocos/pendentes`);
      assert.equal(r1.status, 200);
      assert.deepEqual(await r1.json(), []);

      // Simula leitura.json com um bloco pendente
      writeFileSync(
        join(dadosDir, 'leitura.json'),
        JSON.stringify({
          ultimaLeitura: '2026-10-09T18:00:00.000Z',
          grupos: {
            [G_BALDE]: {
              bloco: {
                grupo: 'Balde',
                cliente: 'PadariaAlfa',
                mensagens: [{ id: 'm1' }, { id: 'm2' }],
                desde: '2026-10-09T18:00:00.000Z',
              },
            },
          },
        }),
        'utf8'
      );

      const r2 = await fetch(`${base}/api/blocos/pendentes`);
      assert.equal(r2.status, 200);
      const blocos = await r2.json();
      assert.equal(blocos.length, 1);
      assert.deepEqual(blocos[0], {
        grupo: 'Balde',
        cliente: 'PadariaAlfa',
        mensagens: 2,
        desde: '2026-10-09T18:00:00.000Z',
      });
    } finally {
      await new Promise(r => srv.close(r));
    }
  });
});
