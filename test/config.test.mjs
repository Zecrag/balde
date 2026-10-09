/**
 * @file config.test.mjs — GRUPOS.md → config/clientes.json + config/grupos.json
 * Tudo em diretório temporário; o resolver da Evolution é sempre injetado (nunca há rede).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseGanhoBR, parseDataBR, parseLinkGrupo, parseGruposMd,
  processarGruposMd, iniciarWatcher,
  lerTabelaGruposMd, validarLinhasProjetos, montarGruposMd, gravarAtomico,
} from '../lib/config.mjs';

const CABECALHO = `| Empresa | Projeto | Link do grupo | Ganho total (R$) | Início | Fim | Tipo | Status |
|---|---|---|---|---|---|---|---|`;

const lerJson = p => JSON.parse(readFileSync(p, 'utf8'));
const esperar = ms => new Promise(r => setTimeout(r, ms));

describe('GRUPOS.md — parsers', () => {
  it('ganho em formato BR', () => {
    assert.equal(parseGanhoBR('6.000,00'), 6000);
    assert.equal(parseGanhoBR('R$ 1.250,50'), 1250.5);
    assert.equal(parseGanhoBR('900'), 900);
    assert.equal(parseGanhoBR('12.000'), 12000);
    assert.equal(parseGanhoBR(''), 0);
    assert.equal(parseGanhoBR('muito'), null);
  });

  it('datas dd/mm/aaaa opcionais', () => {
    assert.equal(parseDataBR('01/02/2026'), '2026-02-01');
    assert.equal(parseDataBR(''), null);
    assert.equal(parseDataBR('31/02/2026'), undefined);
    assert.equal(parseDataBR('2026-01-01'), undefined);
  });

  it('link de convite ou jid', () => {
    assert.deepEqual(parseLinkGrupo('https://chat.whatsapp.com/AbC123xyz'), { inviteCode: 'AbC123xyz' });
    assert.deepEqual(parseLinkGrupo('120363011111111111@g.us'), { jid: '120363011111111111@g.us' });
    assert.equal(parseLinkGrupo('https://evil.com/AbC'), null);
    assert.equal(parseLinkGrupo('5511999999999@s.whatsapp.net'), null);
  });

  it('linha inválida vira aviso e não derruba as outras', () => {
    const { linhas, avisos } = parseGruposMd(`${CABECALHO}
| Alfa | Site | 120363011111111111@g.us | 6.000,00 | 01/01/2026 | 31/12/2026 | cliente |
| Beta | App | link-quebrado | 1,00 | | | cliente |
| Gama | API | 120363022222222222@g.us | 10,00 | | | parceiro |
| Delta | X | 120363033333333333@g.us | 10,00 | 99/99/2026 | | cliente |
| Eps | Y | 120363044444444444@g.us | caro | | | cliente |
| | | 120363099999999999@g.us | | | | despejo |`);
    assert.equal(linhas.length, 2);
    assert.equal(avisos.length, 4);
    assert.deepEqual(
      { ...linhas[0], linha: undefined },
      { linha: undefined, empresa: 'Alfa', projeto: 'Site', link: '120363011111111111@g.us', jid: '120363011111111111@g.us',
        ganho: 6000, inicio: '2026-01-01', fim: '2026-12-31', tipo: 'cliente', status: 'ativo' },
    );
    assert.equal(linhas[1].tipo, 'despejo');
  });
});

describe('GRUPOS.md — processamento', () => {
  let dir, mdPath, configDir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'balde-grupos-'));
    mdPath = join(dir, 'GRUPOS.md');
    configDir = join(dir, 'config');
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('sem GRUPOS.md não mexe em nada', async () => {
    const r = await processarGruposMd({ mdPath, configDir, resolver: async () => assert.fail('não deveria resolver') });
    assert.equal(r.existe, false);
    assert.equal(existsSync(join(configDir, 'clientes.json')), false);
  });

  it('gera clientes.json (receitaMensal = ganho) e grupos.json; resolve link com cache', async () => {
    writeFileSync(mdPath, `${CABECALHO}
| Alfa Tech | Web | 120363011111111111@g.us | 6.000,00 | 01/01/2026 | 31/12/2026 | cliente |
| Alfa Tech | Web | https://chat.whatsapp.com/Conv1 | 6.000,00 | | | cliente |
| Beta | App | https://chat.whatsapp.com/Falha | 900,00 | | | cliente |
| | | 120363099999999999@g.us | | | | despejo |`);
    const chamadas = [];
    const resolver = async code => {
      chamadas.push(code);
      if (code === 'Falha') throw new Error('convite expirado');
      return '120363055555555555@g.us';
    };

    const r = await processarGruposMd({ mdPath, configDir, resolver });
    assert.equal(r.avisos.length, 1);
    assert.match(r.avisos[0], /Falha/);

    const clientes = lerJson(join(configDir, 'clientes.json'));
    assert.equal(clientes.length, 1);
    assert.equal(clientes[0].empresa, 'Alfa Tech');
    assert.equal(clientes[0].projeto, 'Web');
    assert.equal(clientes[0].receitaMensal, 6000);
    assert.equal(clientes[0].inicio, '2026-01-01');
    assert.equal(clientes[0].fim, '2026-12-31');
    assert.deepEqual(clientes[0].grupos, ['120363011111111111@g.us', '120363055555555555@g.us']);

    const grupos = lerJson(join(configDir, 'grupos.json'));
    assert.deepEqual(grupos.map(g => g.jid), ['120363011111111111@g.us', '120363055555555555@g.us', '120363099999999999@g.us']);
    assert.equal(grupos[2].tipo, 'despejo');

    // Segunda passada: link já resolvido vem do cache.
    chamadas.length = 0;
    await processarGruposMd({ mdPath, configDir, resolver });
    assert.deepEqual(chamadas, ['Falha']);
  });

  it('recarrega ao salvar o arquivo', async () => {
    writeFileSync(mdPath, `${CABECALHO}
| Um | P | 120363011111111111@g.us | 1,00 | | | cliente |`);
    const w = iniciarWatcher({ mdPath, configDir, debounceMs: 20, resolver: async () => assert.fail('sem rede') });
    try {
      await w.pronto;
      assert.equal(lerJson(join(configDir, 'clientes.json'))[0].empresa, 'Um');

      writeFileSync(mdPath, `${CABECALHO}
| Dois | P | 120363011111111111@g.us | 2.500,00 | | | cliente |`);
      let clientes;
      for (let i = 0; i < 50; i++) {
        await esperar(30);
        clientes = lerJson(join(configDir, 'clientes.json'));
        if (clientes[0]?.empresa === 'Dois') break;
      }
      assert.equal(clientes[0].empresa, 'Dois');
      assert.equal(clientes[0].receitaMensal, 2500);
    } finally {
      w.close();
    }
  });
});

// ── GB-29: tabela editável pelo painel ──────────────────────────────────────
describe('GRUPOS.md — tabela editável (GB-29)', () => {
  const INSTRUCOES = '# Grupos do Balde\n\nTexto de instrução que não pode sumir.';
  const md = `${INSTRUCOES}\n\n${CABECALHO}\n| Alfa | Site | 120363011111111111@g.us | 6.000,00 | 01/01/2026 | 31/12/2026 | cliente |\n| Beta | App | nada | x | | | cliente |\n\nNota final.\n`;

  it('lê a tabela crua (inclusive linha inválida) e separa instruções', () => {
    const t = lerTabelaGruposMd(md);
    assert.equal(t.antes, INSTRUCOES);
    assert.equal(t.depois, 'Nota final.');
    assert.equal(t.linhas.length, 2);
    assert.deepEqual(t.linhas[1], { empresa: 'Beta', projeto: 'App', link: 'nada', ganho: 'x', inicio: '', fim: '', tipo: 'cliente', status: '' });
  });

  it('valida: obrigatórios, grupo, ganho, datas, tipo e jid repetido', () => {
    const { erros } = validarLinhasProjetos([
      { empresa: '', projeto: '', link: 'nada', ganho: 'muito', inicio: '31/02/2026', fim: '2026', tipo: 'outro' },
      { empresa: 'A', projeto: 'P', link: '1203@g.us', ganho: '1.000,00' },
      { empresa: 'A', projeto: 'Q', link: '1203@g.us', ganho: '' },
      { empresa: 'A', projeto: 'R', link: 'https://chat.whatsapp.com/Abc', inicio: '10/10/2026', fim: '01/10/2026' },
    ]);
    const campos = erros.map(e => `${e.linha}:${e.campo}`);
    assert.deepEqual(campos, ['1:empresa', '1:projeto', '1:link', '1:ganho', '1:inicio', '1:fim', '1:tipo', '3:link', '4:fim']);
  });

  it('normaliza ganho e datas e regrava preservando instruções e o que vem depois', () => {
    const { erros, celulas } = validarLinhasProjetos([
      { empresa: 'Alfa', projeto: 'Site', link: '120363011111111111@g.us', ganho: 6000, inicio: '2026-01-01', fim: '1/2/2026', tipo: 'Cliente' },
      { empresa: 'Alice', projeto: 'Balde', link: 'https://chat.whatsapp.com/AbC', ganho: '', inicio: '', fim: '', tipo: 'despejo' },
    ]);
    assert.deepEqual(erros, []);
    const novo = montarGruposMd(md, celulas);
    assert.ok(novo.startsWith(INSTRUCOES + '\n\n' + CABECALHO.split('\n')[0]));
    assert.ok(novo.includes('| Alfa | Site | 120363011111111111@g.us | 6.000,00 | 01/01/26 | 01/02/26 | cliente | ativo |'));
    assert.ok(novo.includes('| Alice | Balde | https://chat.whatsapp.com/AbC | | | | despejo | ativo |'));
    assert.ok(novo.trimEnd().endsWith('Nota final.'));
    // relido pelo parser oficial, vale igual
    const { linhas, avisos } = parseGruposMd(novo);
    assert.deepEqual(avisos, []);
    assert.equal(linhas.length, 2);
    assert.equal(linhas[0].ganho, 6000);
    assert.equal(linhas[0].fim, '2026-02-01');
  });

  it('arquivo sem tabela usa as instruções do exemplo', () => {
    const novo = montarGruposMd('', [['A', 'P', '1@g.us', '', '', '', 'cliente']], md);
    assert.ok(novo.startsWith(INSTRUCOES));
  });

  it('gravarAtomico substitui o arquivo sem deixar temporário', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'balde-atomico-'));
    try {
      const alvo = join(dir, 'GRUPOS.md');
      writeFileSync(alvo, 'velho');
      await gravarAtomico(alvo, 'novo');
      assert.equal(readFileSync(alvo, 'utf8'), 'novo');
      const { readdirSync } = await import('node:fs');
      assert.deepEqual(readdirSync(dir), ['GRUPOS.md']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mesma empresa, projetos em grupos diferentes → um cliente por projeto', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'balde-multi-'));
    try {
      const mdPath = join(dir, 'GRUPOS.md');
      writeFileSync(mdPath, `${CABECALHO}
| Alfa | Site | 120363011111111111@g.us | 6.000,00 | | 31/12/2026 | cliente |
| Alfa | Ads | 120363022222222222@g.us | 2.000,00 | 01/01/2026 | | cliente |`);
      const r = await processarGruposMd({ mdPath, configDir: join(dir, 'config'), resolver: async () => { throw new Error('sem rede'); } });
      assert.deepEqual(r.clientes.map(c => [c.empresa, c.projeto, c.receitaMensal, c.grupos]), [
        ['Alfa', 'Site', 6000, ['120363011111111111@g.us']],
        ['Alfa', 'Ads', 2000, ['120363022222222222@g.us']],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
