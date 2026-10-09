/**
 * @file config-gb46.test.mjs — GB-46: grupo OPCIONAL para qualquer tipo de projeto.
 * Cliente sem grupo existe como projeto (recebe tarefas pelo despejo) mas não é lido.
 * Roda com: node --test test/config-gb46.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseGruposMd, listarProjetos, processarGruposMd, validarLinhasProjetos, CABECALHO_TABELA } from '../lib/config.mjs';

const TABELA = `${CABECALHO_TABELA}
|---|---|---|---|---|---|---|---|
| Alfa | Site | 120363011111111111@g.us | 1.000,00 | | | cliente | ativo |
| Beta | Ads | | 2.000,00 | | | cliente | ativo |
| Gama | Solto | | | | | despejo | ativo |`;

const linha = extra => ({ empresa: 'Beta', projeto: 'Ads', link: '', ganho: '', inicio: '', fim: '', tipo: 'cliente', status: 'ativo', ...extra });

describe('GB-46 — grupo opcional', () => {
  it('validarLinhasProjetos: cliente e despejo sem grupo são válidos', () => {
    const { erros, celulas } = validarLinhasProjetos([linha(), linha({ empresa: 'Gama', tipo: 'despejo' })]);
    assert.deepEqual(erros, []);
    assert.equal(celulas[0][2], '');
  });

  it('validarLinhasProjetos: grupo preenchido continua validado (formato e repetido)', () => {
    const r1 = validarLinhasProjetos([linha({ link: 'qualquer coisa' })]);
    assert.equal(r1.erros[0].campo, 'link');
    assert.match(r1.erros[0].msg, /jid/);
    const r2 = validarLinhasProjetos([linha({ link: '1@g.us' }), linha({ empresa: 'X', link: '1@g.us' })]);
    assert.match(r2.erros[0].msg, /repetido/);
    const r3 = validarLinhasProjetos([linha({ tipo: 'interno', link: '1@g.us' })]);
    assert.match(r3.erros[0].msg, /interno não tem grupo/);
  });

  it('parseGruposMd: cliente sem link vira projeto sem grupo, sem aviso', () => {
    const { linhas, avisos } = parseGruposMd(TABELA);
    assert.deepEqual(avisos, []);
    assert.equal(linhas.length, 3);
    assert.equal(linhas[1].jid, null);
    assert.equal(linhas[1].tipo, 'cliente');
  });

  it('listarProjetos: comGrupo segue o link, não o tipo', () => {
    const ps = listarProjetos({ texto: TABELA });
    assert.deepEqual(ps.map(p => [p.empresa, p.comGrupo]), [['Alfa', true], ['Beta', false], ['Gama', false]]);
  });

  describe('processarGruposMd', () => {
    let tmp;
    before(() => { tmp = mkdtempSync(join(tmpdir(), 'balde-gb46-')); });
    after(() => rmSync(tmp, { recursive: true, force: true }));

    it('cliente sem grupo vira cliente (sem jid) e fica fora de grupos.json; resolver nunca é chamado', async () => {
      const md = join(tmp, 'GRUPOS.md');
      writeFileSync(md, TABELA);
      let chamadas = 0;
      const r = await processarGruposMd({ mdPath: md, configDir: tmp, resolver: async () => { chamadas++; return 'x@g.us'; } });
      assert.equal(chamadas, 0);
      assert.deepEqual(r.avisos, []);
      const grupos = JSON.parse(readFileSync(join(tmp, 'grupos.json'), 'utf8'));
      assert.deepEqual(grupos.map(g => g.jid), ['120363011111111111@g.us']);
      const clientes = JSON.parse(readFileSync(join(tmp, 'clientes.json'), 'utf8'));
      const beta = clientes.find(c => c.empresa === 'Beta');
      assert.deepEqual(beta.grupos, []);
      assert.equal(beta.receitaMensal, 2000);
    });
  });
});
