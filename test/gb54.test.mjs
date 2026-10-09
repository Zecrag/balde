/**
 * @file test/gb54.test.mjs
 * Testes do contrato GB-54:
 * 1. Extração do bloco e do lote: 1 áudio com 2 pedidos gera 2 tarefas distintas.
 *    - Cada tarefa com título de ação concreta.
 *    - Cada tarefa com nota = resumo (nunca o início cru da transcrição).
 *    - Cada tarefa com fontes = só os ids que embasam a tarefa (sem "Cliente X" / "Concluir X").
 * 2. Mensagens-fonte: gravação de transcricao em mensagens.jsonl, exibição da transcrição completa,
 *    e hidratação a partir de cache para mensagens existentes.
 * 3. API /api/mensagens filtra apenas as fontes da tarefa quando tarefaId é fornecido.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { lerAgora, SYSTEM_LOTE } from '../lib/leitura.mjs';
import { criarStore } from '../lib/store.mjs';
import { criarApi } from '../lib/api.mjs';
import { gravarCache } from '../lib/midia/cache.mjs';

const G_DESPEJO = '120363999999999054@g.us';
const CLIENTE_TESTE = 'AlfaSolucoes';
const GRUPOS = [
  { jid: G_DESPEJO, empresa: CLIENTE_TESTE, projeto: 'Site', tipo: 'despejo' },
];

const T0 = Math.floor(Date.UTC(2026, 9, 9, 15, 49) / 1000);

describe('GB-54 — Tarefas separadas por pedido e fontes com transcrição', () => {
  let dir;
  let dados;
  let config;
  let store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gb54-'));
    dados = join(dir, 'dados');
    config = join(dir, 'config');
    process.env.BALDE_DADOS = dados;
    process.env.BALDE_CONFIG = config;
    mkdirSync(join(dados, 'contextos'), { recursive: true });
    mkdirSync(join(dados, 'midia'), { recursive: true });
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, 'clientes.json'), JSON.stringify([
      { empresa: CLIENTE_TESTE, projeto: 'Site', grupos: [G_DESPEJO], receitaMensal: 1000 },
    ]));
    store = criarStore(dir);
  });

  afterEach(() => {
    delete process.env.BALDE_DADOS;
    delete process.env.BALDE_CONFIG;
    rmSync(dir, { recursive: true, force: true });
  });

  it('1 bloco com 1 áudio trazendo 2 pedidos gera 2 tarefas com fontes corretas e sem mensagens de controle', async () => {
    const audioPath = join(dados, 'midia', 'audio-2pedidos.ogg');
    writeFileSync(audioPath, 'FAKE_OGG_AUDIO_BYTES');

    const transcricaoCompleta = 'Bem, galera, boa tarde. Dono, eu queria ver contigo: deixar pronta a parte do portal para receber os vídeos 3D e tours virtuais; e falando sobre o painel, fazer um tutorial simples de como usar o painel admin.';

    const msgs = [
      { key: { id: 'msg-ctrl-1', remoteJid: G_DESPEJO }, messageTimestamp: T0 + 1, pushName: 'UsuarioDono', texto: `Cliente ${CLIENTE_TESTE}`, tipo: 'texto' },
      { key: { id: 'msg-audio-1', remoteJid: G_DESPEJO }, messageTimestamp: T0 + 2, pushName: 'UsuarioDono', texto: '', tipo: 'audio' },
      { key: { id: 'msg-ctrl-2', remoteJid: G_DESPEJO }, messageTimestamp: T0 + 3, pushName: 'UsuarioDono', texto: `Concluir ${CLIENTE_TESTE}`, tipo: 'texto' },
    ];

    const buscarPagina = async (jid, _page) => ({
      records: msgs,
      pages: 1,
    });

    const normalizar = async r => ({
      id: r.key.id,
      chatId: r.key.remoteJid,
      chatNome: 'Grupo Despejo',
      origem: 'grupo',
      autor: r.pushName,
      ts: new Date(r.messageTimestamp * 1000).toISOString(),
      tipo: r.tipo,
      texto: r.texto,
      ...(r.tipo === 'audio' ? { midiaPath: audioPath } : {}),
    });

    const transcrever = async m => {
      if (m.id === 'msg-audio-1') {
        return { transcricao: transcricaoCompleta, custoUSD: 0.001 };
      }
      return { transcricao: null, custoUSD: 0 };
    };

    let llmChamado = false;
    let systemRecebido = '';
    const llmFetch = async (url, init) => {
      llmChamado = true;
      const body = JSON.parse(init.body);
      systemRecebido = body.messages[0]?.content ?? '';
      const prompt = body.messages[1]?.content ?? '';

      // O prompt não deve conter as mensagens de controle Cliente X / Concluir X
      assert.ok(!prompt.includes(`Cliente ${CLIENTE_TESTE}`), 'prompt não deve ter mensagem de abertura');
      assert.ok(!prompt.includes(`Concluir ${CLIENTE_TESTE}`), 'prompt não deve ter mensagem de conclusão');

      const jsonResposta = {
        n: [
          {
            m: ['msg-audio-1'],
            t: 'Deixar portal pronto para vídeos 3D',
            nt: 'Preparar portal e painel para receber vídeos 3D e tours virtuais.',
            d: 'Deixar estrutura pronta para tours virtuais e vídeos no portal.',
            e: 'pronta',
            r: 'eu',
            tp: 'desenvolvimento',
            et: 'producao',
          },
          {
            m: ['msg-audio-1'],
            t: 'Criar tutorial do painel admin',
            nt: 'Gravar vídeo ou criar documento explicativo de como usar o painel.',
            d: 'Documento orientativo de uso do painel para outros usuários.',
            e: 'pronta',
            r: 'eu',
            tp: 'geral',
            et: 'producao',
          },
        ],
        a: [],
      };

      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(jsonResposta) } }],
          usage: { prompt_tokens: 400, completion_tokens: 150 },
        }),
      };
    };

    // 1. Inicializa o cursor com leitura vazia
    await lerAgora({
      dadosDir: dados,
      store,
      gruposConfig: GRUPOS,
      buscarPagina: async () => ({ records: [], pages: 1 }),
      env: { OPENAI_API_KEY: 'sk-teste' },
      agoraMs: T0 * 1000,
    });

    // 2. Executa a leitura do bloco
    const r = await lerAgora({
      dadosDir: dados,
      store,
      gruposConfig: GRUPOS,
      buscarPagina,
      normalizar,
      transcrever,
      fetch: llmFetch,
      env: { OPENAI_API_KEY: 'sk-teste' },
      agoraMs: (T0 + 10) * 1000,
    });

    assert.ok(llmChamado, 'LLM deve ter sido chamado');
    assert.ok(systemRecebido.includes('um item por pedido; não juntar'), 'SYSTEM_LOTE deve conter exigência de não juntar pedidos');

    const tarefas = store.lerTarefas();
    assert.equal(tarefas.length, 2, 'deve criar 2 tarefas distintas para os 2 pedidos');

    const t1 = tarefas.find(t => t.titulo.includes('vídeos 3D') || t.titulo.includes('portal'));
    const t2 = tarefas.find(t => t.titulo.includes('tutorial') || t.titulo.includes('painel'));

    assert.ok(t1, 'tarefa 1 deve existir');
    assert.ok(t2, 'tarefa 2 deve existir');

    // Verifica notas (devem ser os resumos, NUNCA o início cru da transcrição)
    assert.equal(t1.nota, 'Preparar portal e painel para receber vídeos 3D e tours virtuais.');
    assert.equal(t2.nota, 'Gravar vídeo ou criar documento explicativo de como usar o painel.');
    assert.ok(!t1.nota.startsWith('Bem, galera'), 'nota não pode ser o início cru da transcrição');
    assert.ok(!t2.nota.startsWith('Bem, galera'), 'nota não pode ser o início cru da transcrição');

    // Verifica fontes (apenas msg-audio-1, NUNCA msg-ctrl-1 nem msg-ctrl-2)
    assert.deepEqual(t1.fontes, ['msg-audio-1']);
    assert.deepEqual(t2.fontes, ['msg-audio-1']);
    assert.ok(!t1.fontes.includes('msg-ctrl-1'), 'fontes não deve conter mensagem de abertura');
    assert.ok(!t1.fontes.includes('msg-ctrl-2'), 'fontes não deve conter mensagem de conclusão');
    assert.ok(!t2.fontes.includes('msg-ctrl-1'), 'fontes não deve conter mensagem de abertura');
    assert.ok(!t2.fontes.includes('msg-ctrl-2'), 'fontes não deve conter mensagem de conclusão');

    // Verifica gravação em mensagens.jsonl com campo transcricao
    const rawMensagens = readFileSync(join(dados, 'mensagens.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    const audioGravado = rawMensagens.find(m => m.id === 'msg-audio-1');
    assert.ok(audioGravado, 'áudio deve ter sido gravado em mensagens.jsonl');
    assert.equal(audioGravado.transcricao, transcricaoCompleta, 'áudio gravado deve ter campo transcricao preenchido');

    // Verifica retorno de store.listarMensagens
    const msgsListadas = await store.listarMensagens(G_DESPEJO);
    const audioListado = msgsListadas.find(m => m.id === 'msg-audio-1');
    assert.equal(audioListado.transcricao, transcricaoCompleta);

    // Verifica endpoint /api/mensagens com tarefaId
    const api = criarApi({ store });
    const reqSimulado = {
      method: 'GET',
      url: `/api/mensagens?chatId=${encodeURIComponent(G_DESPEJO)}&tarefaId=${t1.id}`,
      headers: { host: '127.0.0.1:7391' },
      socket: { localPort: 7391 },
      resume: () => {},
      on: () => {},
    };
    let apiStatus = null;
    let apiBody = null;
    const resSimulado = {
      writeHead(s, _h) { apiStatus = s; },
      end(payload) { apiBody = JSON.parse(payload); },
    };
    await api(reqSimulado, resSimulado);

    assert.equal(apiStatus, 200);
    assert.equal(apiBody.mensagens.length, 1, 'deve retornar somente a fonte daquela tarefa');
    assert.equal(apiBody.mensagens[0].id, 'msg-audio-1');
    assert.equal(apiBody.mensagens[0].transcricao, transcricaoCompleta);
  });

  it('store.listarMensagens hidrata transcrição de cache para mensagens já existentes sem transcrição no jsonl', async () => {
    const audioPath = join(dados, 'midia', 'audio-legado.ogg');
    writeFileSync(audioPath, 'AUDIO_LEGADO_BYTES');

    // Simula mensagem gravada antigamente no mensagens.jsonl SEM transcrição
    const msgAntiga = {
      id: 'msg-legada-1',
      chatId: G_DESPEJO,
      origem: 'grupo',
      autor: 'Cliente',
      ts: new Date().toISOString(),
      tipo: 'audio',
      texto: '',
      midiaPath: audioPath,
    };
    writeFileSync(join(dados, 'mensagens.jsonl'), JSON.stringify(msgAntiga) + '\n');

    // Simula transcrição que já existe gravada no cache
    const { hashArquivo } = await import('../lib/midia/cache.mjs');
    const hash = hashArquivo(audioPath);
    gravarCache(hash, { transcricao: 'Transcrição recuperada do cache com sucesso.' });

    // Consulta mensagens
    const msgs = await store.listarMensagens(G_DESPEJO);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].id, 'msg-legada-1');
    assert.equal(msgs[0].transcricao, 'Transcrição recuperada do cache com sucesso.');
  });
});
