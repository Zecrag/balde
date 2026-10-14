/**
 * @file test/gb56.test.mjs
 * Testes do contrato GB-56:
 * Regra de perspectiva no prompt do extrator (lote, bloco e contínuo):
 * "Tarefas são do dono/equipe: o que o cliente pede vira a ação que NÓS executamos (ex.: cliente pede tutorial → 'Criar tutorial…').
 * Nunca 'Solicitar…' para algo que o cliente já pediu; 'Solicitar/Cobrar' só quando NÓS dependemos de algo do cliente."
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { lerAgora, SYSTEM_LOTE, extrairGrupoBloco } from '../lib/leitura.mjs';
import { SYSTEM_PROMPT, extrairTarefas } from '../lib/motor/extrator.mjs';
import { criarStore } from '../lib/store.mjs';

const REGRA_PERSPECTIVA = "Tarefas são do dono/equipe: o que o cliente pede vira a ação que NÓS executamos (ex.: cliente pede tutorial → 'Criar tutorial…'). Nunca 'Solicitar…' para algo que o cliente já pediu; 'Solicitar/Cobrar' só quando NÓS dependemos de algo do cliente.";

describe('GB-56 — Regra de perspectiva no prompt do extrator', () => {
  let dir;
  let dados;
  let config;
  let store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gb56-'));
    dados = join(dir, 'dados');
    config = join(dir, 'config');
    process.env.BALDE_DADOS = dados;
    process.env.BALDE_CONFIG = config;
    mkdirSync(join(dados, 'contextos'), { recursive: true });
    mkdirSync(join(dados, 'midia'), { recursive: true });
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, 'clientes.json'), JSON.stringify([
      { empresa: 'ClienteTeste', projeto: 'Site', grupos: ['120363999999999056@g.us'], receitaMensal: 5000 },
    ]));
    store = criarStore(dir);
  });

  afterEach(() => {
    delete process.env.BALDE_DADOS;
    delete process.env.BALDE_CONFIG;
    rmSync(dir, { recursive: true, force: true });
  });

  it('SYSTEM_LOTE e SYSTEM_PROMPT contêm a regra de perspectiva', () => {
    assert.ok(SYSTEM_LOTE.includes(REGRA_PERSPECTIVA), 'SYSTEM_LOTE deve conter a regra de perspectiva');
    assert.ok(SYSTEM_PROMPT.includes(REGRA_PERSPECTIVA), 'SYSTEM_PROMPT deve conter a regra de perspectiva');
    assert.ok(SYSTEM_LOTE.length < 1400, `SYSTEM_LOTE deve ser menor que 1400 caracteres (${SYSTEM_LOTE.length})`);
  });

  it('Mock lerAgora (lote normal): chamada ao LLM recebe o prompt com a regra de perspectiva', async () => {
    let systemRecebido = '';
    const chamadas = [];
    const llmMock = {
      chamadas,
      fetch: async (url, init) => {
        const body = JSON.parse(init.body);
        chamadas.push({ url, body });
        systemRecebido = body.messages[0]?.content ?? '';
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{
              message: {
                content: JSON.stringify({
                  n: [{
                    m: ['msg-1'],
                    t: 'Criar tutorial do painel admin',
                    nt: 'Fazer um vídeo ou documento simples explicando o painel.',
                    e: 'pronta',
                    r: 'eu',
                    tp: 'operacional',
                    et: 'producao',
                  }],
                  a: [],
                }),
              },
            }],
            usage: { prompt_tokens: 100, completion_tokens: 50 },
          }),
        };
      },
    };

    writeFileSync(join(dados, 'leitura.json'), JSON.stringify({
      grupos: {
        '120363999999999056@g.us': {
          cursor: { ts: 1000, ids: [] },
        },
      },
      ultimaLeitura: new Date().toISOString(),
    }));

    const buscarPagina = async () => ({
      records: [{
        key: { id: 'msg-1', remoteJid: '120363999999999056@g.us' },
        messageTimestamp: 2000,
        pushName: 'Cliente',
        tipo: 'texto',
        texto: 'Você pode me fazer um tutorial de como usar o painel?',
      }],
      pages: 1,
    });

    const normalizar = async r => ({
      id: r.key.id,
      chatId: r.key.remoteJid,
      chatNome: 'Grupo Teste',
      origem: 'grupo',
      autor: r.pushName,
      ts: new Date(r.messageTimestamp * 1000).toISOString(),
      tipo: r.tipo,
      texto: r.texto,
    });

    await lerAgora({
      env: { OPENAI_API_KEY: 'sk-mock' },
      dadosDir: dados,
      store,
      gruposConfig: [{ jid: '120363999999999056@g.us', empresa: 'ClienteTeste', projeto: 'Site', tipo: 'cliente' }],
      buscarPagina,
      normalizar,
      fetch: llmMock.fetch,
      log: () => {},
      agoraMs: Date.now(),
    });

    assert.equal(chamadas.length, 1);
    assert.ok(systemRecebido.includes(REGRA_PERSPECTIVA), 'prompt de lote enviado ao LLM deve conter a regra');
  });

  it('Mock extrairGrupoBloco (bloco): chamada ao LLM recebe o prompt com a regra de perspectiva', async () => {
    let systemRecebido = '';
    const chamadas = [];
    const llmMockFetch = async (url, init) => {
      const body = JSON.parse(init.body);
      chamadas.push({ url, body });
      systemRecebido = body.messages[0]?.content ?? '';
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                n: [{
                  m: ['m-bloco-1'],
                  t: 'Preparar painel para incluir tours virtuais e vídeos',
                  nt: 'Deixar no painel de alteração a opção de incluir tours virtuais.',
                  e: 'pronta',
                  r: 'eu',
                  tp: 'desenvolvimento',
                  et: 'producao',
                }],
                a: [],
              }),
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        }),
      };
    };

    const g = { jid: '120363999999999056@g.us', empresa: 'ClienteTeste', projeto: 'Site' };
    const mensagens = [
      { id: 'm-abre', texto: 'Cliente ClienteTeste', origem: 'despejo' },
      { id: 'm-bloco-1', texto: 'Preciso que deixe no painel a opção de tours virtuais', origem: 'despejo' },
      { id: 'm-fecha', texto: 'Concluir ClienteTeste', origem: 'despejo' },
    ];
    const alvo = { empresa: 'ClienteTeste', projeto: 'Site' };

    await extrairGrupoBloco({
      g,
      mensagens,
      alvo,
      store,
      env: { OPENAI_API_KEY: 'sk-mock' },
      llmLigado: true,
      uso: {},
      usoPath: join(dados, 'uso.jsonl'),
      fetch: llmMockFetch,
      log: () => {},
      configBloco: { ativo: true, abrir: 'Cliente', fechar: 'Concluir' },
    });

    assert.equal(chamadas.length, 1);
    assert.ok(systemRecebido.includes(REGRA_PERSPECTIVA), 'prompt de bloco enviado ao LLM deve conter a regra');
  });

  it('Mock extrairTarefas (motor contínuo): chamada ao LLM recebe o prompt com a regra de perspectiva', async () => {
    let systemRecebido = '';
    const chamadas = [];
    const fetchFn = async (url, init) => {
      const body = JSON.parse(init.body);
      chamadas.push({ url, body });
      systemRecebido = body.messages[0]?.content ?? '';
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                tarefas: [{
                  titulo: 'Criar tutorial do painel admin',
                  descricao: 'Fazer tutorial',
                  nota: 'Fazer tutorial simples',
                  estado: 'pronta',
                  responsavel: 'eu',
                  faltando: [],
                  prazo: null,
                  tipo: 'geral',
                  etapa: 'producao',
                  proximoPasso: 'Gravar tutorial',
                }],
                atualizacoes: [],
              }),
            },
          }],
          usage: { prompt_tokens: 80, completion_tokens: 40 },
        }),
      };
    };

    const contexto = {
      chatId: '120363999999999056@g.us',
      mensagens: [
        { id: 'msg-c1', autor: 'Cliente', texto: 'Você consegue criar um tutorial do painel admin?', ts: new Date().toISOString() },
      ],
    };

    await extrairTarefas(
      contexto,
      { empresa: 'ClienteTeste', projeto: 'Site', tipoGrupo: 'cliente' },
      [],
      { env: { OPENAI_API_KEY: 'sk-mock' }, fetch: fetchFn }
    );

    assert.equal(chamadas.length, 1);
    assert.ok(systemRecebido.includes(REGRA_PERSPECTIVA), 'prompt contínuo enviado ao LLM deve conter a regra');
  });
});
