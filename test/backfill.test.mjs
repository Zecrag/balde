/**
 * backfill.test.mjs — bin/backfill.mjs com Evolution e motor mockados.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { backfill, coletarJanela, filtrarGrupos, tipoMidia } from '../bin/backfill.mjs';
import { criarStore } from '../lib/store.mjs';
import { acumularContexto } from '../lib/motor/contexto.mjs';

const G = '120363000000000001@g.us';
const H = '120363000000000002@g.us';
const AGORA = Date.UTC(2026, 9, 8, 12, 0, 0);
const AGORA_S = AGORA / 1000;
const DIA = 86400;

const reg = (jid, id, ts, extra = {}) => ({
  key: { id, remoteJid: jid, fromMe: false }, pushName: 'Fulano',
  message: { conversation: id }, messageType: 'conversation', messageTimestamp: ts, ...extra,
});
const audio = (jid, id, ts) => reg(jid, id, ts, { message: { audioMessage: { mimetype: 'audio/ogg' } }, messageType: 'audioMessage' });

/** Imita /chat/findMessages: mais recentes primeiro, 50 por página. */
function paginador(historico, chamadas = []) {
  return async (jid, page) => {
    chamadas.push({ jid, page });
    const todas = historico.filter(r => r.key.remoteJid === jid).sort((a, b) => b.messageTimestamp - a.messageTimestamp);
    return { records: todas.slice((page - 1) * 50, page * 50), pages: Math.max(1, Math.ceil(todas.length / 50)) };
  };
}

const normalizar = async r => ({
  id: r.key.id, chatId: r.key.remoteJid, chatNome: 'Grupo', origem: 'grupo', autor: r.pushName,
  ts: new Date(r.messageTimestamp * 1000).toISOString(),
  tipo: r.message.audioMessage ? 'audio' : 'texto', texto: r.message.conversation ?? '',
});

describe('backfill', () => {
  let dir, store, mensagensPath, cursorPath, log;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'balde-backfill-'));
    fs.mkdirSync(path.join(dir, 'dados', 'contextos'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config', 'clientes.json'), '[]');
    store = criarStore(dir);
    mensagensPath = path.join(dir, 'dados', 'mensagens.jsonl');
    cursorPath = path.join(dir, 'dados', 'evolution-cursor.json');
    log = [];
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const rodar = (historico, extra = {}) => {
    const processadas = [];
    const enriquecidas = [];
    return backfill({
      grupos: [{ jid: G, empresa: 'Acme', projeto: 'Site' }],
      buscarPagina: paginador(historico), normalizar, store, mensagensPath, cursorPath,
      enriquecer: async m => { enriquecidas.push(m.id); return m.tipo === 'audio' ? { ...m, transcricao: 'transcrito' } : m; },
      processar: async (m, s) => { processadas.push(m); acumularContexto(s, m); return { novas: [{}], atualizadas: [] }; },
      acumular: acumularContexto,
      dias: 30, agoraMs: AGORA, log: l => log.push(l), ...extra,
    }).then(resumo => ({ resumo, processadas, enriquecidas }));
  };

  it('processa só o que falta na janela, em ordem cronológica, com contexto na ordem real', async () => {
    // Já visto pelo balde (catch-up de 2 dias)
    const vista = await normalizar(reg(G, 'vista-1d', AGORA_S - DIA));
    fs.writeFileSync(mensagensPath, JSON.stringify(vista) + '\n');
    const historico = [
      reg(G, 'fora-40d', AGORA_S - 40 * DIA),
      reg(G, 'antiga-20d', AGORA_S - 20 * DIA),
      audio(G, 'audio-10d', AGORA_S - 10 * DIA),
      reg(G, 'vista-1d', AGORA_S - DIA),
      reg(G, 'nova-1h', AGORA_S - 3600),
      reg(H, 'outro-grupo', AGORA_S - DIA),
    ];
    const { resumo, processadas, enriquecidas } = await rodar(historico);

    assert.deepEqual(processadas.map(m => m.id), ['antiga-20d', 'audio-10d', 'nova-1h']);
    assert.equal(processadas[1].transcricao, 'transcrito'); // enriquecido antes do motor
    assert.deepEqual(enriquecidas, ['antiga-20d', 'audio-10d', 'vista-1d', 'nova-1h']);
    assert.deepEqual(store.lerContexto(G).mensagens.map(m => m.id), ['antiga-20d', 'audio-10d', 'vista-1d', 'nova-1h']);
    assert.equal(resumo.grupos[0].mensagens, 3);
    assert.equal(resumo.grupos[0].audios, 1);
    assert.equal(resumo.grupos[0].processadas, 3);

    // JSONL ganhou as novas; cursor no mais recente
    const ids = fs.readFileSync(mensagensPath, 'utf8').trim().split('\n').map(l => JSON.parse(l).id);
    assert.deepEqual(ids, ['vista-1d', 'antiga-20d', 'audio-10d', 'nova-1h']);
    assert.deepEqual(JSON.parse(fs.readFileSync(cursorPath, 'utf8'))[G], { ts: AGORA_S - 3600, ids: ['nova-1h'] });
    assert.ok(log.some(l => /Acme · Site: 3 nova\(s\) de 4 na janela · 1 áudio/.test(l)));

    // Segunda rodada: nada a fazer
    const segunda = await rodar(historico);
    assert.equal(segunda.processadas.length, 0);
  });

  it('cursor nunca recua', async () => {
    fs.writeFileSync(cursorPath, JSON.stringify({ [G]: { ts: AGORA_S - 60, ids: ['x'] } }));
    await rodar([reg(G, 'antiga-5d', AGORA_S - 5 * DIA)]);
    assert.equal(JSON.parse(fs.readFileSync(cursorPath, 'utf8'))[G].ts, AGORA_S - 60);
  });

  it('--simular só mostra o plano, sem gravar', async () => {
    const { processadas, resumo } = await rodar([audio(G, 'a', AGORA_S - DIA), reg(G, 'b', AGORA_S - 2 * DIA)], { simular: true });
    assert.equal(processadas.length, 0);
    assert.equal(fs.existsSync(mensagensPath), false);
    assert.deepEqual(resumo.grupos, [{ nome: 'Acme · Site', mensagens: 2, audios: 1, imagens: 0, processadas: 0 }]);
  });

  it('teto corta as mais antigas', async () => {
    const historico = [1, 2, 3, 4].map(i => reg(G, `m${i}`, AGORA_S - (10 - i) * DIA));
    const { processadas } = await rodar(historico, { teto: 2 });
    assert.deepEqual(processadas.map(m => m.id), ['m3', 'm4']);
    assert.ok(log.some(l => /teto de 2/.test(l)));
  });

  it('erro no motor não para o grupo e a mensagem fica registrada', async () => {
    const historico = [reg(G, 'quebra', AGORA_S - 2 * DIA), reg(G, 'segue', AGORA_S - DIA)];
    const vistas = [];
    const { resumo } = await rodar(historico, {
      processar: async m => { vistas.push(m.id); if (m.id === 'quebra') throw new Error('falhou'); return { novas: [], atualizadas: [] }; },
    });
    assert.deepEqual(vistas, ['quebra', 'segue']);
    assert.equal(resumo.erros, 1);
  });

  it('anexo de histórico do grupo entra na janela (dentro do piso, sem repetir)', async () => {
    const anexo = reg(G, 'bundle', AGORA_S - 3600, { message: { messageHistoryBundle: { mediaKey: 'k', directPath: '/v/x' } } });
    const historico = [anexo, reg(G, 'viva', AGORA_S - 60)];
    const expandir = async r => (r.key.id === 'bundle'
      ? [reg(G, 'hist-40d', AGORA_S - 40 * DIA), reg(G, 'hist-9d', AGORA_S - 9 * DIA), reg(G, 'viva', AGORA_S - 60), reg(H, 'outro', AGORA_S - DIA)]
      : []);
    const janela = await coletarJanela(paginador(historico), G, AGORA_S - 30 * DIA, expandir);
    assert.deepEqual(janela.map(x => x.id), ['hist-9d', 'bundle', 'viva']);
  });

  it('coletarJanela pagina até passar do piso', async () => {
    const historico = Array.from({ length: 120 }, (_, i) => reg(G, `m${i}`, AGORA_S - i * 3600));
    const chamadas = [];
    const janela = await coletarJanela(paginador(historico, chamadas), G, AGORA_S - 60 * 3600);
    assert.equal(janela.length, 61);
    assert.equal(janela[0].id, 'm60');
    assert.equal(chamadas.length, 2);
  });

  it('filtrarGrupos e tipoMidia', () => {
    const grupos = [{ jid: G, empresa: 'EmpresaX', projeto: 'Geral' }, { jid: H, empresa: 'EmpresaY', projeto: 'Site' }];
    assert.deepEqual(filtrarGrupos(grupos, 'empresax').map(g => g.jid), [G]);
    assert.deepEqual(filtrarGrupos(grupos, 'SITE').map(g => g.jid), [H]);
    assert.equal(filtrarGrupos(grupos).length, 2);
    assert.equal(tipoMidia(audio(G, 'a', 1)), 'audio');
    assert.equal(tipoMidia({ message: { documentMessage: { fileName: 'x.PDF' } } }), 'pdf');
    assert.equal(tipoMidia(reg(G, 'a', 1)), null);
  });
});

describe('estimativa antes de backfill/reprocessar (GB-44)', () => {
  it('uma chamada por mensagem com LLM ligado; zero com LLM desligado', async () => {
    const { estimarCustoMotor } = await import('../bin/reprocessar.mjs');
    const linhas = [];
    const com = await estimarCustoMotor({ mensagens: 100, audios: 2 }, 'x', { OPENAI_API_KEY: 'k', BALDE_LLM_MODELO: 'gpt-4.1-nano' }, l => linhas.push(l));
    assert.ok(com > 0.006 && com < 0.05, `estimativa ${com}`);
    assert.match(linhas.join('\n'), /100 chamada\(s\) de LLM/);
    assert.match(linhas.join('\n'), /tabela configurável/);
    const sem = await estimarCustoMotor({ mensagens: 100 }, 'x', { BALDE_LLM: 'off' }, () => {});
    assert.equal(sem, 0);
  });
});
