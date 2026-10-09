/**
 * @file grupos-evolution.test.mjs — GB-27: buscar, adicionar e criar grupos pela Evolution.
 * Tudo com fetch mockado: nenhum teste toca a Evolution de verdade.
 * Roda com: node --test test/grupos-evolution.test.mjs
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizarBusca, separarTermos, buscarGrupos, sugerirEmpresaProjeto, linhaGruposMd, adicionarAoGruposMd,
} from '../lib/ingestao/grupos-evolution.mjs';
import { parseGruposMd } from '../lib/config.mjs';
import { main } from '../bin/grupos.mjs';
import { criarApi } from '../lib/api.mjs';

const CABECALHO = '| Empresa | Projeto | Link do grupo | Ganho R$/mês | Início | Fim | Tipo |\n|---|---|---|---|---|---|---|\n';

const GRUPOS = [
  { id: '111@g.us', subject: '🚀 Exemplo | Tráfego', size: 4 },
  { id: '222@g.us', subject: 'ACME - Site Novo', size: 3 },
  { id: '333@g.us', subject: 'Padaria São João 🥖', size: 2 },
  { id: '444@s.whatsapp.net', subject: 'não é grupo' },
];

const ENV = { BALDE_EVOLUTION_URL: 'https://evo.teste', BALDE_EVOLUTION_KEY: 'k', BALDE_EVOLUTION_INSTANCIA: 'inst' };

/** fetch falso: registra chamadas e responde por rota. */
function fetchFalso() {
  const chamadas = [];
  const f = async (url, init = {}) => {
    chamadas.push({ url, method: init.method ?? 'GET', body: init.body });
    const resp = body => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    if (url.includes('/group/fetchAllGroups/')) return resp(GRUPOS);
    if (url.includes('/group/create/')) return resp({ id: '999@g.us', subject: JSON.parse(init.body).subject });
    if (url.includes('/group/inviteCode/')) return resp({ inviteUrl: 'https://chat.whatsapp.com/ABC', inviteCode: 'ABC' });
    return { ok: false, status: 404, json: async () => ({}), text: async () => 'nao' };
  };
  f.chamadas = chamadas;
  return f;
}

function tmpGruposMd(conteudo = `# Grupos\n\n${CABECALHO}`) {
  const dir = mkdtempSync(join(tmpdir(), 'balde-gb27-'));
  const arquivo = join(dir, 'GRUPOS.md');
  writeFileSync(arquivo, conteudo);
  return { dir, arquivo };
}

describe('busca sem acento, caixa nem emoji', () => {
  const grupos = GRUPOS.filter(g => g.id.endsWith('@g.us')).map(g => ({ jid: g.id, nome: g.subject }));

  it('normaliza', () => {
    assert.equal(normalizarBusca('🚀 Exemplo | Tráfego'), 'exemplo trafego');
  });

  it('acha por termo sem acento e com caixa diferente; vírgula separa termos', () => {
    const { resultados, naoEncontrados } = buscarGrupos(grupos, separarTermos(['EXEMPLO', 'trafego,', 'sao', 'joao,', 'acme,', 'inexistente']));
    assert.deepEqual(resultados.map(r => [r.termo, r.grupos.map(g => g.jid)]), [
      ['EXEMPLO trafego', ['111@g.us']],
      ['sao joao', ['333@g.us']],
      ['acme', ['222@g.us']],
    ]);
    assert.deepEqual(naoEncontrados, ['inexistente']);
  });

  it('sugere empresa/projeto e monta linha aceita pelo GRUPOS.md', () => {
    const sug = sugerirEmpresaProjeto('🚀 Exemplo | Tráfego');
    assert.deepEqual(sug, { empresa: 'Exemplo', projeto: 'Tráfego' });
    const linha = linhaGruposMd({ ...sug, jid: '111@g.us', ganho: 3000 });
    assert.equal(linha, '| Exemplo | Tráfego | 111@g.us | 3.000,00 | | | cliente |');
    const { linhas, avisos } = parseGruposMd(CABECALHO + linha);
    assert.deepEqual(avisos, []);
    assert.equal(linhas[0].jid, '111@g.us');
    assert.equal(linhas[0].ganho, 3000);
  });
});

describe('CLI bin/grupos.mjs', () => {
  let tmp, f, saida;
  const deps = () => ({ fetch: f, env: ENV, gruposMd: tmp.arquivo, out: s => saida.push(s) });
  beforeEach(() => { tmp = tmpGruposMd(); f = fetchFalso(); saida = []; });

  it('buscar chama fetchAllGroups sem participantes e imprime linha pronta + não encontrados', async () => {
    await main(['buscar', 'exemplo,', 'nada'], deps());
    assert.equal(f.chamadas.length, 1);
    assert.equal(f.chamadas[0].url, 'https://evo.teste/group/fetchAllGroups/inst?getParticipants=false');
    const txt = saida.join('\n');
    assert.match(txt, /\| Exemplo \| Tráfego \| 111@g\.us \| \| \| \| cliente \|/);
    assert.match(txt, /"nada" — não encontrado: o número não está nesse grupo/);
    rmSync(tmp.dir, { recursive: true, force: true });
  });

  it('adicionar acrescenta no fim e não duplica jid', async () => {
    await main(['adicionar', 'acme', '--tipo', 'cliente', '--ganho', '3000'], deps());
    await main(['adicionar', 'acme', '--empresa', 'Outra'], deps());
    const texto = readFileSync(tmp.arquivo, 'utf8');
    assert.equal(texto.split('222@g.us').length - 1, 1, 'jid aparece uma vez só');
    assert.ok(texto.endsWith('| ACME | Site Novo | 222@g.us | 3.000,00 | | | cliente |\n'));
    assert.match(saida.join('\n'), /Já estava no GRUPOS\.md/);
    rmSync(tmp.dir, { recursive: true, force: true });
  });

  it('adicionar acerta arquivo sem quebra de linha no fim', async () => {
    writeFileSync(tmp.arquivo, CABECALHO + 'rascunho solto');
    await main(['adicionar', 'padaria', '--empresa', 'Padaria'], deps());
    assert.ok(readFileSync(tmp.arquivo, 'utf8').endsWith('rascunho solto\n| Padaria | São João | 333@g.us | | | | cliente |\n'));
    rmSync(tmp.dir, { recursive: true, force: true });
  });

  it('criar SEM --sim não chama a Evolution', async () => {
    const r = await main(['criar', 'Cliente Novo | Site', '--participantes', '+55 11 99999-0000, 5511888880000'], deps());
    assert.equal(f.chamadas.length, 0);
    assert.equal(r.criado, false);
    assert.deepEqual(r.corpo, { subject: 'Cliente Novo | Site', participants: ['5511999990000', '5511888880000'] });
    assert.match(saida.join('\n'), /nada foi criado/);
    rmSync(tmp.dir, { recursive: true, force: true });
  });

  it('criar --sim faz POST, busca convite e adiciona com --adicionar', async () => {
    const r = await main(['criar', 'Cliente Novo | Site', '--descricao', 'oi', '--sim', '--adicionar'], deps());
    assert.deepEqual(f.chamadas.map(c => [c.method, c.url]), [
      ['POST', 'https://evo.teste/group/create/inst'],
      ['GET', 'https://evo.teste/group/inviteCode/inst?groupJid=999%40g.us'],
    ]);
    assert.deepEqual(JSON.parse(f.chamadas[0].body), { subject: 'Cliente Novo | Site', participants: [], description: 'oi' });
    assert.equal(r.jid, '999@g.us');
    assert.match(saida.join('\n'), /convite: https:\/\/chat\.whatsapp\.com\/ABC/);
    assert.match(readFileSync(tmp.arquivo, 'utf8'), /\| Cliente Novo \| Site \| 999@g\.us \| \| \| \| cliente \|/);
    rmSync(tmp.dir, { recursive: true, force: true });
  });
});

describe('API /api/grupos', () => {
  let server, tmp;
  const listar = async () => GRUPOS.filter(g => g.id.endsWith('@g.us')).map(g => ({ jid: g.id, nome: g.subject, tamanho: g.size }));

  function req({ method = 'GET', path, headers = {}, corpo }) {
    return new Promise((resolve, reject) => {
      const port = server.address().port;
      const r = http.request({ hostname: '127.0.0.1', port, method, path, headers: { Host: `127.0.0.1:${port}`, ...headers } }, res => {
        let d = '';
        res.on('data', c => { d += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
      });
      r.on('error', reject);
      if (corpo !== undefined) r.write(corpo);
      r.end();
    });
  }

  before(async () => {
    tmp = tmpGruposMd(`${CABECALHO}| Exemplo | Ads | 111@g.us | | | | cliente |\n`);
    server = http.createServer(criarApi({
      store: {}, lerClientes: () => [], gruposMdPath: tmp.arquivo, abrirArquivo: () => {},
      destinosPath: join(tmp.dir, 'DESTINOS.md'), host: '127.0.0.1', listarGruposEvolution: listar,
    }));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
  });
  after(async () => {
    await new Promise(r => server.close(r));
    rmSync(tmp.dir, { recursive: true, force: true });
  });

  it('GET buscar devolve grupos com sugestão, linha e se já está no GRUPOS.md', async () => {
    const r = await req({ path: `/api/grupos/buscar?q=${encodeURIComponent('exemplo, sao joao, zzz')}` });
    assert.equal(r.status, 200);
    const [evo, pad] = r.body.resultados;
    assert.equal(evo.grupos[0].jaNoGruposMd, true);
    assert.equal(evo.grupos[0].empresa, 'Exemplo');  // empresa conhecida do GRUPOS.md
    assert.equal(pad.grupos[0].linha, '| Padaria São João | | 333@g.us | | | | cliente |');
    assert.deepEqual(r.body.naoEncontrados, ['zzz']);
  });

  it('GET buscar sem q → 400', async () => {
    assert.equal((await req({ path: '/api/grupos/buscar' })).status, 400);
  });

  it('POST adicionar grava; repetir → 409; Origin estranha → 403; jid inválido → 400', async () => {
    const ct = { 'Content-Type': 'application/json' };
    const corpo = JSON.stringify({ jid: '222@g.us', empresa: 'Acme', projeto: 'Site', tipo: 'cliente' });
    assert.equal((await req({ method: 'POST', path: '/api/grupos/adicionar', headers: { ...ct, Origin: 'http://evil.com' }, corpo })).status, 403);
    assert.equal((await req({ method: 'POST', path: '/api/grupos/adicionar', headers: { 'Content-Type': 'text/plain' }, corpo })).status, 403);
    assert.ok(!readFileSync(tmp.arquivo, 'utf8').includes('222@g.us'));

    const ok = await req({ method: 'POST', path: '/api/grupos/adicionar', headers: ct, corpo });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.linha, '| Acme | Site | 222@g.us | | | | cliente |');
    assert.equal((await req({ method: 'POST', path: '/api/grupos/adicionar', headers: ct, corpo })).status, 409);
    assert.equal(readFileSync(tmp.arquivo, 'utf8').split('222@g.us').length - 1, 1);

    const ruim = JSON.stringify({ jid: '../../etc', empresa: 'X' });
    assert.equal((await req({ method: 'POST', path: '/api/grupos/adicionar', headers: ct, corpo: ruim })).status, 400);
  });

  it('adicionarAoGruposMd recusa cliente sem empresa', async () => {
    await assert.rejects(adicionarAoGruposMd({ jid: '555@g.us', empresa: '' }, tmp.arquivo), /empresa obrigatória/);
  });
});
