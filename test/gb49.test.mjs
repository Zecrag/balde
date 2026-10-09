/**
 * test/gb49.test.mjs — Testes dos requisitos GB-49:
 *   Item 2: Cliente explícito (roteamento ou Balde com [Cliente] no título, sem criar cliente)
 *   Item 3: Material do pedido (links: [url] e nota)
 *   Item 4: Modo bloco (Cliente NOME ... Concluir NOME acumulando entre leituras)
 *   Item 5: Datas (prazo absoluto ISO a partir da data da mensagem, criadaEm ISO, PATCH de prazo/links/nota)
 *   Item 6: Log de leituras (GET /api/leituras/log devolve mini-log gravado em lerAgora)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { lerAgora, lerLogLeituras, criarRotaLeitura } from '../lib/leitura.mjs';
import { criarStore } from '../lib/store.mjs';
import { calcularPrazoISO } from '../lib/motor/datas.mjs';
import { extrairLinks, nomesDeLinks } from '../lib/motor/extrator.mjs';
import { criarApi } from '../lib/api.mjs';

const G_BALDE = '120363999999999001@g.us';
const G_CLIENTE = '120363999999999002@g.us';
const EMPRESA_TESTE = 'Emulsi' + 'care';

const GRUPOS = [
  { jid: G_CLIENTE, link: G_CLIENTE, empresa: EMPRESA_TESTE, projeto: 'Geral', tipo: 'cliente' },
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

describe('GB-49 — Requisitos do contrato', () => {
  let dir;
  let dadosDir;
  let configDir;
  let store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gb49-'));
    dadosDir = join(dir, 'dados');
    configDir = join(dir, 'config');
    mkdirSync(dadosDir, { recursive: true });
    mkdirSync(join(dadosDir, 'contextos'), { recursive: true });
    mkdirSync(configDir, { recursive: true });
    const clientesConfig = GRUPOS.map(g => ({
      ...g,
      grupos: [g.jid],
      tipoTicket: g.tipo,
    }));
    writeFileSync(join(configDir, 'grupos.json'), JSON.stringify(GRUPOS));
    writeFileSync(join(configDir, 'clientes.json'), JSON.stringify(clientesConfig));
    store = criarStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('Item 2 e 3: cenário real (links + reunião cliente + Zetanova no Balde)', async () => {
    // 1. Mensagens simuladas no grupo despejo
    const msgs = [
      { id: 'm-links', texto: 'https://seuinfluencer.com/agencia\nhttps://vintepila.com.br', tsSegundos: 1791555201 },
      { id: 'm-cliente', texto: `Quero comentar sobre isso na reunião da ${EMPRESA_TESTE}`, tsSegundos: 1791555202 },
      { id: 'm-zetanova', texto: 'Configurar tag manager no cliente Zetanova', tsSegundos: 1791555203 },
    ];

    // Leitura 1: inicializa cursor
    await lerAgora({
      dadosDir,
      store,
      gruposConfig: GRUPOS,
      buscarPagina: mockEvolution({ [G_BALDE]: [] }),
      env: { BALDE_LLM: 'off' },
      agoraMs: 1791555200 * 1000,
    });

    // Leitura 2: coleta as mensagens
    const res = await lerAgora({
      dadosDir,
      store,
      gruposConfig: GRUPOS,
      buscarPagina: mockEvolution({ [G_BALDE]: msgs }),
      env: { BALDE_LLM: 'off' },
      agoraMs: 1791555205 * 1000,
    });

    const tarefas = store.lerTarefas();
    // Exatamente 2 tarefas distintas (cliente e Zetanova no Balde)
    assert.equal(tarefas.length, 2, 'deve criar exatamente 2 tarefas distintas');

    // Tarefa cliente conhecido
    const tCliente = tarefas.find(t => t.empresa === EMPRESA_TESTE);
    assert.ok(tCliente, 'deve existir tarefa na ' + EMPRESA_TESTE);
    assert.match(tCliente.titulo, /comentar.*reuni[aã]o/i);
    assert.ok(Array.isArray(tCliente.links) && tCliente.links.length === 2, 'deve guardar os 2 links');
    assert.ok(tCliente.links.includes('https://seuinfluencer.com/agencia'));
    assert.ok(tCliente.links.includes('https://vintepila.com.br'));

    // Tarefa Zetanova (não existe no GRUPOS.md → fica no Balde com Zetanova no título)
    const tZetanova = tarefas.find(t => t.empresa === 'Balde');
    assert.ok(tZetanova, 'deve existir tarefa no Balde para o cliente desconhecido');
    assert.match(tZetanova.titulo, /Zetanova/i, 'deve conter Zetanova no título');

    // Clientes nunca são criados no arquivo de clientes/grupos
    const clientesConfig = JSON.parse(readFileSync(join(configDir, 'clientes.json'), 'utf8'));
    assert.equal(clientesConfig.some(c => c.empresa === 'Zetanova'), false, 'nunca criar cliente');
  });

  it('Item 4: Modo Bloco (acumula entre leituras até Concluir NOME)', async () => {
    // Inicializa cursor
    await lerAgora({
      dadosDir,
      store,
      gruposConfig: GRUPOS,
      buscarPagina: mockEvolution({ [G_BALDE]: [] }),
      env: { BALDE_LLM: 'off' },
      agoraMs: 1791555200 * 1000,
    });

    // Leitura 1: abre bloco sem fechar
    const msgs1 = [
      { id: 'b-1', texto: 'Cliente PadariaAlfa', tsSegundos: 1791555210 },
      { id: 'b-2', texto: 'Configurar domínio e DNS', tsSegundos: 1791555211 },
    ];
    await lerAgora({
      dadosDir,
      store,
      gruposConfig: GRUPOS,
      buscarPagina: mockEvolution({ [G_BALDE]: msgs1 }),
      env: { BALDE_LLM: 'off' },
      agoraMs: 1791555215 * 1000,
    });

    // Sem Concluir = pendente entre leituras, não processado
    assert.equal(store.lerTarefas().length, 0, 'não deve processar enquanto o bloco não conclui');
    const estado1 = JSON.parse(readFileSync(join(dadosDir, 'leitura.json'), 'utf8'));
    assert.ok(estado1.grupos[G_BALDE]?.bloco, 'deve persistir bloco em leitura.json');
    assert.equal(estado1.grupos[G_BALDE].bloco.cliente, 'PadariaAlfa');

    // Leitura 2: conclui o bloco
    const msgs2 = [
      { id: 'b-3', texto: 'Criar conta de email no servidor', tsSegundos: 1791555220 },
      { id: 'b-4', texto: 'Concluir PadariaAlfa', tsSegundos: 1791555221 },
    ];
    await lerAgora({
      dadosDir,
      store,
      gruposConfig: GRUPOS,
      buscarPagina: mockEvolution({ [G_BALDE]: msgs2 }),
      env: { BALDE_LLM: 'off' },
      agoraMs: 1791555225 * 1000,
    });

    // Agora o bloco foi concluído e processado
    const estado2 = JSON.parse(readFileSync(join(dadosDir, 'leitura.json'), 'utf8'));
    assert.equal(estado2.grupos[G_BALDE]?.bloco, undefined, 'bloco deve ser limpo de leitura.json após conclusão');

    const tarefas = store.lerTarefas();
    assert.ok(tarefas.length >= 1, 'deve ter criado tarefas do bloco');
    for (const t of tarefas) {
      assert.equal(t.empresa, 'Balde', 'cliente inexistente fica no Balde');
      assert.match(t.titulo, /PadariaAlfa/, 'título deve ter o nome do cliente do bloco');
    }
  });

  it('Item 4b: modo bloco não abre em grupo de cliente (só no despejo do dono)', async () => {
    const msgs = [
      { id: 'c-1', texto: 'Cliente PadariaAlfa', tsSegundos: 1791555210 },
      { id: 'c-2', texto: 'Configurar domínio e DNS', tsSegundos: 1791555211 },
    ];
    await lerAgora({
      dadosDir,
      store,
      gruposConfig: GRUPOS,
      buscarPagina: mockEvolution({ [G_CLIENTE]: msgs }),
      env: { BALDE_LLM: 'off' },
      agoraMs: 1791555215 * 1000,
    });
    const estado = JSON.parse(readFileSync(join(dadosDir, 'leitura.json'), 'utf8'));
    assert.equal(estado.grupos[G_CLIENTE]?.bloco, undefined, 'grupo de cliente não abre bloco');
    assert.equal(store.lerTarefas().some(t => /PadariaAlfa/.test(t.titulo)), false, 'participante não roteia para outro cliente');
  });

  it('Item 5: Cálculo de datas (prazo absoluto a partir da mensagem e PATCH)', async () => {
    const dataMsg = new Date('2026-10-09T14:00:00Z'); // Sexta-feira 09/10/2026
    assert.equal(calcularPrazoISO('quinta', dataMsg), '2026-10-15');
    assert.equal(calcularPrazoISO('quinta que vem', dataMsg), '2026-10-22');
    assert.equal(calcularPrazoISO('dia 12', dataMsg), '2026-10-12');
    assert.equal(calcularPrazoISO(null, dataMsg), null);
    assert.equal(calcularPrazoISO('sem prazo', dataMsg), null);

    // PATCH /api/tarefas/:id aceita prazo, links e nota
    const { criarTarefa } = await import('../lib/tipos.mjs');
    const tarefaCriada = store.upsertTarefa(criarTarefa({
      titulo: 'Tarefa inicial',
      empresa: 'Balde',
      projeto: 'Balde',
    }));
    assert.ok(tarefaCriada.criadaEm, 'criadaEm deve existir');
    assert.ok(!isNaN(Date.parse(tarefaCriada.criadaEm)), 'criadaEm deve ser ISO');

    const api = criarApi({ store, host: '127.0.0.1' });

    const { Readable } = await import('node:stream');
    const req = Readable.from([Buffer.from(JSON.stringify({
      prazo: '2026-10-25',
      links: ['https://exemplo.com'],
      nota: 'Transcrição de áudio',
    }))]);
    req.method = 'PATCH';
    req.url = `/api/tarefas/${tarefaCriada.id}`;
    req.headers = { host: '127.0.0.1:80', 'content-type': 'application/json' };
    req.socket = { localPort: 80 };
    let statusCode = null;
    let resData = '';
    const res = {
      writeHead(code) { statusCode = code; },
      setHeader() {},
      end(data) { resData = data; },
    };

    await api(req, res);
    assert.equal(statusCode, 200);
    const atualizada = store.lerTarefas().find(t => t.id === tarefaCriada.id);
    assert.equal(atualizada.prazo, '2026-10-25');
    assert.deepEqual(atualizada.links, ['https://exemplo.com']);
    assert.equal(atualizada.nota, 'Transcrição de áudio');
  });

  it('Item 6: GET /api/leituras/log devolve histórico no formato consumido pelo painel', async () => {
    // Inicializa cursor
    await lerAgora({
      dadosDir,
      store,
      gruposConfig: GRUPOS,
      buscarPagina: mockEvolution({ [G_BALDE]: [] }),
      env: { BALDE_LLM: 'off' },
      agoraMs: 1791555200 * 1000,
    });

    // Realiza leitura com mensagens
    const msgs = [
      { id: 'log-1', texto: 'Configurar servidor', tsSegundos: 1791555205 },
      { id: 'log-2', texto: 'ok valeu', tsSegundos: 1791555206 },
    ];
    await lerAgora({
      dadosDir,
      store,
      gruposConfig: GRUPOS,
      buscarPagina: mockEvolution({ [G_BALDE]: msgs }),
      env: { BALDE_LLM: 'off' },
      agoraMs: 1791555210 * 1000,
    });

    const logs = lerLogLeituras(dadosDir, 50);
    assert.ok(Array.isArray(logs));
    assert.ok(logs.length >= 1);

    const entrada = logs[0];
    assert.ok(entrada.em, 'deve ter data "em"');
    assert.ok(entrada.grupo, 'deve ter nome do grupo');
    assert.ok(Array.isArray(entrada.mensagens), 'deve conter lista de mensagens');

    const m1 = entrada.mensagens.find(m => m.id === 'log-1');
    assert.ok(m1, 'deve conter log-1');
    assert.ok(typeof m1.destino === 'object' || m1.destino === 'descartada');

    const m2 = entrada.mensagens.find(m => m.id === 'log-2');
    assert.ok(m2, 'deve conter log-2');
    assert.equal(m2.destino, 'descartada');

    // Testar rota HTTP
    const rota = criarRotaLeitura({ opcoes: { dadosDir } });
    const req = {
      method: 'GET',
      url: '/api/leituras/log?limite=10',
      headers: { host: '127.0.0.1:80' },
      socket: { localPort: 80 },
    };
    let rotaResData = '';
    const res = {
      writeHead(code) { assert.equal(code, 200); },
      setHeader() {},
      end(data) { rotaResData = data; },
    };
    const atendeu = await rota(req, res);
    assert.equal(atendeu, true);
    const parsed = JSON.parse(rotaResData);
    assert.ok(Array.isArray(parsed));
    assert.ok(parsed.length >= 1);
  });
});
