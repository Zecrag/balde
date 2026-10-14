/**
 * @file test/gb59.test.mjs
 * Testes do contrato GB-59:
 * 1. Config em dados/config-avisos.json, padrão {ativo:false, numeros:[], janelaDias:3, horarios:[{id, hora:"18:00", tipo:"resumo", ativo:true}]}.
 *    GET/PUT /api/config/avisos com proteções de Host/Origin/Content-Type e validações.
 * 2. GET /api/alertas?janela=N com pior por empresa (atrasada 1d + vence hoje -> atrasada 1d), projetos atrasados, baldeParado, etc.
 * 3. Agendador no servidor com persistência em dados/avisos-estado.json, fuso America/Sao_Paulo, sem duplicar envio no mesmo dia.
 * 4. Log em dados/avisos.jsonl com número mascarado e GET /api/avisos/log.
 * 5. POST /api/avisos/teste e POST /api/avisos/previa.
 * 6. Segurança de envio: fetch MOCK da Evolution, NUNCA envia para @g.us nem números fora da lista.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';

import {
  lerConfigAvisos,
  gravarConfigAvisos,
  validarConfigAvisos,
  mascararNumero,
  lerLogAvisos,
  gravarLogAvisos,
  lerEstadoAvisos,
  gravarEstadoAvisos,
  enviarMensagemEvolution,
  iniciarAgendadorAvisos,
  dispararAvisos,
  obterPreviaAvisos,
  horaAtualSaoPaulo,
  dataAtualSaoPaulo,
  contarEnviosHoje,
  TETO_ENVIOS_DIA,
} from '../lib/avisos.mjs';
import { calcularAlertas } from '../lib/alertas.mjs';
import { montarTexto } from '../lib/avisos-texto.mjs';
import { criarApi } from '../lib/api.mjs';
import { criarStore } from '../lib/store.mjs';

describe('GB-59 — Configuração de avisos e validações', () => {
  let dir;
  let dados;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gb59-cfg-'));
    dados = join(dir, 'dados');
    mkdirSync(dados, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('devolve a configuração padrão quando o arquivo não existe', () => {
    const config = lerConfigAvisos(dados);
    assert.equal(config.ativo, false);
    assert.deepEqual(config.numeros, []);
    assert.equal(config.janelaDias, 3);
    assert.equal(config.horarios.length, 1);
    assert.equal(config.horarios[0].hora, '18:00');
    assert.equal(config.horarios[0].tipo, 'resumo');
    assert.equal(config.horarios[0].ativo, true);
  });

  it('valida campos obrigatórios e rejeita entradas inválidas', () => {
    assert.ok(validarConfigAvisos(null).erro);
    assert.ok(validarConfigAvisos('string').erro);
    assert.ok(validarConfigAvisos({ ativo: 'sim' }).erro);
    assert.ok(validarConfigAvisos({ janelaDias: -1 }).erro);
    assert.ok(validarConfigAvisos({ janelaDias: 31 }).erro);
    assert.ok(validarConfigAvisos({ janelaDias: 3.5 }).erro);
    assert.ok(validarConfigAvisos({ numeros: [' 5511999998888'] }).erro);
    assert.ok(validarConfigAvisos({ horarios: [{ hora: ' 18:00', tipo: 'resumo' }] }).erro);
    assert.ok(validarConfigAvisos({ numeros: ['123'] }).erro, 'rejeita número curto');
    assert.ok(validarConfigAvisos({ numeros: ['5511999998888@g.us'] }).erro, 'rejeita grupo');
    assert.ok(validarConfigAvisos({ numeros: ['5511abcdef'] }).erro, 'rejeita caracteres não numéricos');
    assert.ok(validarConfigAvisos({ horarios: [{ hora: '25:00', tipo: 'resumo' }] }).erro);
    assert.ok(validarConfigAvisos({ horarios: [{ hora: '18:60', tipo: 'resumo' }] }).erro);
    assert.ok(validarConfigAvisos({ horarios: [{ hora: '18:00', tipo: 'invalido' }] }).erro);
  });

  it('grava atomicamente e relê a configuração salva', () => {
    const salva = gravarConfigAvisos({
      dadosDir: dados,
      corpo: {
        ativo: true,
        numeros: ['5511999998888', '5521988887777'],
        janelaDias: 5,
        horarios: [
          { hora: '09:00', tipo: 'urgente', ativo: true },
          { hora: '18:00', tipo: 'resumo', ativo: false },
        ],
      },
    });

    assert.ok(!salva.erro);
    assert.equal(salva.config.ativo, true);
    assert.deepEqual(salva.config.numeros, ['5511999998888', '5521988887777']);
    assert.equal(salva.config.janelaDias, 5);
    assert.equal(salva.config.horarios.length, 2);

    const lida = lerConfigAvisos(dados);
    assert.deepEqual(lida.numeros, ['5511999998888', '5521988887777']);
    assert.equal(lida.ativo, true);
  });
});

describe('GB-59 — Segurança no envio de mensagens Evolution', () => {
  const permitidos = ['5511999998888', '5521988887777'];
  const env = {
    BALDE_EVOLUTION_URL: 'https://evolution.teste.local',
    BALDE_EVOLUTION_KEY: 'chave-teste-123',
    BALDE_EVOLUTION_INSTANCIA: 'instancia-teste',
  };

  it('mascara número telefônico mantendo apenas início e fim', () => {
    assert.equal(mascararNumero('5511999998888'), '5511*****8888');
    assert.equal(mascararNumero('5521988887777'), '5521*****7777');
    assert.equal(mascararNumero('123'), '***');
  });

  it('rejeita terminantemente envio para grupos (@g.us)', async () => {
    let fetchChamado = false;
    const fetchMock = async () => { fetchChamado = true; return { ok: true }; };

    await assert.rejects(
      () => enviarMensagemEvolution({
        numero: '000000000000000000@g.us',
        texto: 'Aviso proibido',
        numerosPermitidos: permitidos,
        env,
        fetch: fetchMock,
      }),
      /proibido|@g\.us/i
    );
    assert.equal(fetchChamado, false, 'fetch não deve ser chamado para @g.us');
  });

  it('rejeita número fora da lista configurada', async () => {
    let fetchChamado = false;
    const fetchMock = async () => { fetchChamado = true; return { ok: true }; };

    await assert.rejects(
      () => enviarMensagemEvolution({
        numero: '5531999990000',
        texto: 'Aviso não autorizado',
        numerosPermitidos: permitidos,
        env,
        fetch: fetchMock,
      }),
      /não está na lista|autorizados/i
    );
    assert.equal(fetchChamado, false, 'fetch não deve ser chamado para número não autorizado');
  });

  it('rejeita terminantemente destinos com caracteres que não sejam dígitos', async () => {
    let fetchChamado = false;
    const fetchMock = async () => { fetchChamado = true; return { ok: true }; };

    await assert.rejects(
      () => enviarMensagemEvolution({
        numero: '+5511999998888',
        texto: 'Aviso com mais',
        numerosPermitidos: ['+5511999998888'],
        env,
        fetch: fetchMock,
      }),
      /não são dígitos/i
    );

    await assert.rejects(
      () => enviarMensagemEvolution({
        numero: '55-11-99999-8888',
        texto: 'Aviso com traços',
        numerosPermitidos: ['55-11-99999-8888'],
        env,
        fetch: fetchMock,
      }),
      /não são dígitos/i
    );
    assert.equal(fetchChamado, false);
  });

  it('envia mensagem com mock do fetch quando o número é autorizado', async () => {
    const chamadas = [];
    const fetchMock = async (url, init) => {
      chamadas.push({ url, init, body: JSON.parse(init.body) });
      return {
        ok: true,
        json: async () => ({ status: 'PENDING' }),
      };
    };

    const res = await enviarMensagemEvolution({
      numero: '5511999998888',
      texto: 'Resumo diário do Balde',
      numerosPermitidos: permitidos,
      env,
      fetch: fetchMock,
    });

    assert.equal(chamadas.length, 1);
    assert.equal(chamadas[0].url, 'https://evolution.teste.local/message/sendText/instancia-teste');
    assert.equal(chamadas[0].init.headers.apikey, 'chave-teste-123');
    assert.equal(chamadas[0].body.number, '5511999998888');
    assert.equal(chamadas[0].body.text, 'Resumo diário do Balde');
  });
});

describe('GB-59 — Agendador de avisos (fuso e deduplicação)', () => {
  let dir;
  let dados;
  let store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gb59-ag-'));
    dados = join(dir, 'dados');
    mkdirSync(dados, { recursive: true });
    store = {
      lerTarefas: () => [],
      listarTarefas: async () => [],
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('não dispara quando ativo: false', async () => {
    gravarConfigAvisos({
      dadosDir: dados,
      corpo: {
        ativo: false,
        numeros: ['5511999998888'],
        horarios: [{ id: 'h1', hora: '18:00', tipo: 'resumo', ativo: true }],
      },
    });

    let chamadas = 0;
    const fetchMock = async () => { chamadas++; return { ok: true, json: async () => ({}) }; };

    const agendador = iniciarAgendadorAvisos({
      dadosDir: dados,
      store,
      fetch: fetchMock,
    });

    const agora = new Date('2026-10-14T21:00:00Z'); // 18:00 em America/Sao_Paulo (UTC-3)
    const res = await agendador.tick(agora);
    agendador.parar();

    assert.equal(res.disparados, 0);
    assert.equal(chamadas, 0);
  });

  it('dispara no horário exato e NÃO dispara duas vezes no mesmo dia', async () => {
    gravarConfigAvisos({
      dadosDir: dados,
      corpo: {
        ativo: true,
        numeros: ['5511999998888'],
        horarios: [{ id: 'h1', hora: '18:00', tipo: 'resumo', ativo: true }],
      },
    });

    const chamadas = [];
    const fetchMock = async (url, init) => {
      chamadas.push({ url, init });
      return { ok: true, json: async () => ({ ok: true }) };
    };

    const envMock = {
      BALDE_EVOLUTION_URL: 'https://evolution.mock',
      BALDE_EVOLUTION_KEY: 'key-123',
      BALDE_EVOLUTION_INSTANCIA: 'inst-1',
    };

    const agendador = iniciarAgendadorAvisos({
      dadosDir: dados,
      store,
      fetch: fetchMock,
      env: envMock,
    });

    // 18:00 em São Paulo = 21:00 UTC
    const agora18 = new Date('2026-10-14T21:00:00Z');
    assert.equal(horaAtualSaoPaulo(agora18), '18:00');
    assert.equal(dataAtualSaoPaulo(agora18), '2026-10-14');

    // 1º tick: deve disparar
    const res1 = await agendador.tick(agora18);
    assert.equal(res1.disparados, 1);
    assert.equal(chamadas.length, 1);

    // Confere se persistiu em dados/avisos-estado.json
    const estado = lerEstadoAvisos(dados);
    assert.equal(estado.ultimoEnvio['h1'], '2026-10-14');

    // 2º tick no mesmo minuto/dia: NÃO deve duplicar
    const res2 = await agendador.tick(agora18);
    assert.equal(res2.disparados, 0);
    assert.equal(chamadas.length, 1, 'não deve chamar Evolution novamente');

    // Simula restart do servidor criando nova instância do agendador
    agendador.parar();
    const agendadorReiniciado = iniciarAgendadorAvisos({
      dadosDir: dados,
      store,
      fetch: fetchMock,
      env: envMock,
    });

    const res3 = await agendadorReiniciado.tick(agora18);
    agendadorReiniciado.parar();
    assert.equal(res3.disparados, 0, 'após restart ainda deve respeitar estado persistido');
    assert.equal(chamadas.length, 1);
  });

  it('registra histórico de envios com número mascarado em dados/avisos.jsonl', async () => {
    gravarConfigAvisos({
      dadosDir: dados,
      corpo: {
        ativo: true,
        numeros: ['5511999998888'],
        horarios: [{ id: 'h1', hora: '18:00', tipo: 'resumo', ativo: true }],
      },
    });

    const fetchMock = async () => ({ ok: true, json: async () => ({}) });
    const envMock = {
      BALDE_EVOLUTION_URL: 'https://evolution.mock',
      BALDE_EVOLUTION_KEY: 'key-123',
      BALDE_EVOLUTION_INSTANCIA: 'inst-1',
    };

    await dispararAvisos({
      tipo: 'resumo',
      dadosDir: dados,
      store,
      fetch: fetchMock,
      env: envMock,
      hoje: new Date('2026-10-14T21:00:00Z'),
    });

    const logs = lerLogAvisos(dados);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].tipo, 'resumo');
    assert.equal(logs[0].numero, '5511*****8888');
    assert.equal(logs[0].ok, true);
    assert.ok(logs[0].em);
  });

  it('respeita teto rígido de no máximo 10 envios por dia', async () => {
    gravarConfigAvisos({
      dadosDir: dados,
      corpo: {
        ativo: true,
        numeros: ['5511999998888'],
        horarios: [{ id: 'h1', hora: '18:00', tipo: 'resumo', ativo: true }],
      },
    });

    const hoje = new Date('2026-10-14T21:00:00Z');
    // Simula 10 envios já realizados hoje no log
    for (let i = 0; i < 10; i++) {
      gravarLogAvisos(dados, { em: hoje.toISOString(), tipo: 'resumo', numero: '5511*****8888', ok: true });
    }

    assert.equal(contarEnviosHoje(dados, hoje), 10);

    let chamouFetch = false;
    const fetchMock = async () => { chamouFetch = true; return { ok: true }; };

    await assert.rejects(
      () => dispararAvisos({
        tipo: 'resumo',
        dadosDir: dados,
        store,
        fetch: fetchMock,
        env: {
          BALDE_EVOLUTION_URL: 'https://evolution.mock',
          BALDE_EVOLUTION_KEY: 'key-123',
          BALDE_EVOLUTION_INSTANCIA: 'inst-1',
        },
        hoje,
      }),
      /Teto diário/i
    );

    assert.equal(chamouFetch, false, 'não deve chamar fetch ao atingir o teto de 10 envios');
  });
});

describe('GB-59 — Rotas HTTP na API (/api/config/avisos, /api/alertas, /api/avisos/*)', () => {
  let dir;
  let dados;
  let configDir;
  let store;
  let server;
  let baseUrl;
  let fetchMockChamadas = [];

  const fetchMock = async (url, init) => {
    fetchMockChamadas.push({ url, init });
    return { ok: true, json: async () => ({ ok: true }) };
  };

  const envMock = {
    BALDE_EVOLUTION_URL: 'https://evolution.mock',
    BALDE_EVOLUTION_KEY: 'key-test',
    BALDE_EVOLUTION_INSTANCIA: 'inst-test',
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gb59-api-'));
    dados = join(dir, 'dados');
    configDir = join(dir, 'config');
    mkdirSync(dados, { recursive: true });
    mkdirSync(configDir, { recursive: true });

    const gruposMd = join(dir, 'GRUPOS.md');
    writeFileSync(gruposMd, `
| Empresa | Projeto | Link do grupo | Ganho total (R$) | Início | Fim | Tipo | Status |
|---|---|---|---|---|---|---|---|
| Acme | Site | | 5.000,00 | 01/10/26 | 12/10/26 | cliente | ativo |
| Beta | App | | 3.000,00 | 01/10/26 | 20/10/26 | cliente | ativo |
| Arquivada | Antigo | | 0 | 01/10/26 | 02/10/26 | cliente | arquivado |
    `.trim());

    const tarefasIniciais = [
      { id: 'arq', titulo: 'Não mostrar', empresa: 'Arquivada', projeto: 'Antigo', prazo: '2020-01-01', estado: 'pronta' },
      { id: 't1', titulo: 'Tarefa Atrasada', empresa: 'Acme', projeto: 'Site', prazo: '2026-10-13', estado: 'pronta' },
      { id: 't2', titulo: 'Tarefa Hoje', empresa: 'Acme', projeto: 'Site', prazo: '2026-10-14', estado: 'pronta' },
      { id: 't3', titulo: 'Tarefa Concluída Hoje', empresa: 'Beta', projeto: 'App', estado: 'feita', atualizadaEm: '2026-10-14T15:00:00Z' },
      { id: 't4', titulo: 'Item Solto Balde', empresa: 'Balde', projeto: 'Balde', estado: 'pronta' },
    ];

    store = {
      lerTarefas: () => tarefasIniciais,
      listarTarefas: async () => tarefasIniciais,
      lerClientes: () => [],
    };

    fetchMockChamadas = [];

    const handler = criarApi({
      store,
      dadosDir: dados,
      gruposMdPath: gruposMd,
      env: envMock,
      fetch: fetchMock,
      host: '127.0.0.1',
    });

    server = http.createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  it('GET /api/config/avisos devolve o padrão inicial', async () => {
    const res = await fetch(`${baseUrl}/api/config/avisos`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ativo, false);
    assert.deepEqual(body.numeros, []);
  });

  it('recusa Host e Origin externos nas rotas de avisos', async () => {
    const hostStatus = await new Promise((resolve, reject) => {
      http.get(`${baseUrl}/api/config/avisos`, { headers: { Host: 'externo.invalid' } }, res => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject);
    });
    assert.equal(hostStatus, 403);
    for (const rota of ['/api/config/avisos', '/api/avisos/previa']) {
      const res = await fetch(`${baseUrl}${rota}`, {
        method: rota.includes('config') ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://externo.invalid' },
        body: '{}',
      });
      assert.equal(res.status, 403);
    }
    assert.equal(fetchMockChamadas.length, 0);
  });

  it('PUT /api/config/avisos salva nova configuração respeitando proteções', async () => {
    // 1. Rejeita se Content-Type não for application/json
    const resSemContentType = await fetch(`${baseUrl}/api/config/avisos`, {
      method: 'PUT',
      body: JSON.stringify({ ativo: true }),
    });
    assert.equal(resSemContentType.status, 403);

    // 2. Rejeita se corpo tiver número inválido
    const resInvalido = await fetch(`${baseUrl}/api/config/avisos`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ numeros: ['123'] }),
    });
    assert.equal(resInvalido.status, 400);

    // 3. Salva com sucesso
    const resOk = await fetch(`${baseUrl}/api/config/avisos`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ativo: true,
        numeros: ['5511999998888'],
        janelaDias: 4,
        horarios: [{ hora: '19:00', tipo: 'urgente', ativo: true }],
      }),
    });
    assert.equal(resOk.status, 200);
    const jsonOk = await resOk.json();
    assert.equal(jsonOk.ativo, true);
    assert.deepEqual(jsonOk.numeros, ['5511999998888']);
    assert.equal(jsonOk.janelaDias, 4);
  });

  it('GET /api/alertas calcula alertas com pior por empresa e contagem de balde', async () => {
    const res = await fetch(`${baseUrl}/api/alertas?janela=3`);
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.ok(Array.isArray(data.atrasadas));
    assert.ok(Array.isArray(data.venceHoje));
    assert.ok(Array.isArray(data.proximas));
    assert.ok(Array.isArray(data.projetosAtrasados));
    assert.ok(Array.isArray(data.feitasHoje));
    assert.equal(typeof data.baldeParado, 'number');

    // Regra do pior por empresa: Acme tem atrasada (t1) e venceHoje (t2) -> pior deve ser atrasada
    assert.equal(data.porEmpresa.Acme.pior.tipo, 'atrasada');
    assert.ok(data.projetosAtrasados.some(p => p.empresa === 'Acme' && p.fim === '2026-10-12'));
    assert.ok(!data.atrasadas.some(t => t.id === 'arq'));
    assert.ok(!data.projetosAtrasados.some(p => p.empresa === 'Arquivada'));
    assert.ok(data.baldeParado >= 1, 'deve contar tarefas do Balde');
  });

  it('POST /api/avisos/previa devolve texto determinístico sem enviar', async () => {
    const res = await fetch(`${baseUrl}/api/avisos/previa`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tipo: 'resumo' }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.tipo, 'resumo');
    assert.ok(typeof body.texto === 'string');
    assert.ok(body.texto.includes('Acme'));
    assert.equal(fetchMockChamadas.length, 0, 'não deve enviar mensagens na prévia');
  });

  it('disparo manual com fetch mock envia para os números configurados e loga', async () => {
    // Configura um número primeiro
    await fetch(`${baseUrl}/api/config/avisos`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ativo: false,
        numeros: ['5511999998888'],
      }),
    });

    const body = await dispararAvisos({ tipo: 'urgente', dadosDir: dados, store, env: envMock, fetch: fetchMock });
    assert.equal(body.ok, true);
    assert.equal(body.enviados, 1);
    assert.equal(fetchMockChamadas.length, 1);

    // Consulta o log via GET /api/avisos/log
    const resLog = await fetch(`${baseUrl}/api/avisos/log`);
    assert.equal(resLog.status, 200);
    const logs = await resLog.json();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].tipo, 'urgente');
    assert.equal(logs[0].numero, '5511*****8888');
    assert.equal(logs[0].ok, true);
  });
});

describe('GB-59 — Limites persistidos e privacidade', () => {
  it('reserva teto antes do fetch, inclusive concorrência, falhas e restart', async () => {
    const dadosDir = mkdtempSync(join(tmpdir(), 'gb59-limite-'));
    const numero = '5511999998888';
    const hoje = new Date('2024-01-01T21:00:00Z');
    const env = { BALDE_EVOLUTION_URL: 'https://mock.invalid', BALDE_EVOLUTION_KEY: 'mock', BALDE_EVOLUTION_INSTANCIA: 'mock' };
    let chamadas = 0;
    try {
      gravarConfigAvisos({ dadosDir, corpo: { numeros: [numero] } });
      const opcoes = { dadosDir, hoje, env, store: { lerTarefas: () => [] }, fetch: async () => {
        chamadas++;
        await new Promise(resolve => setTimeout(resolve, 5));
        throw new Error(`Erro privado ${numero}`);
      } };
      await Promise.allSettled(Array.from({ length: 15 }, () => dispararAvisos(opcoes)));
      assert.equal(chamadas, 10);
      assert.equal(lerEstadoAvisos(dadosDir).reservas['2024-01-01'], 10);
      await assert.rejects(() => dispararAvisos(opcoes), /Teto diário/);
      assert.equal(chamadas, 10);
      assert.ok(!readFileSync(join(dadosDir, 'avisos.jsonl'), 'utf8').includes(numero));
    } finally { rmSync(dadosDir, { recursive: true, force: true }); }
  });
});
