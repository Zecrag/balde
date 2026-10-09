/**
 * @file config-gb41.test.mjs — GB-41 no GRUPOS.md: tipo interno (projeto sem grupo), datas dd/mm/aa,
 * "Ganho total (R$)" (aceita o cabeçalho antigo) e coluna Status (ativo|arquivado).
 * Roda com: node --test test/config-gb41.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseDataBR, dataParaCelula, parseGruposMd, listarProjetos, processarGruposMd,
  definirStatusProjeto, montarGruposMd, validarLinhasProjetos, CABECALHO_TABELA,
} from '../lib/config.mjs';

const ANTIGO = `| Empresa | Projeto | Link do grupo | Ganho R$/mês | Início | Fim | Tipo |
|---|---|---|---|---|---|---|`;
const NOVO = `${CABECALHO_TABELA}
|---|---|---|---|---|---|---|---|`;

describe('GB-41 — datas dd/mm/aa', () => {
  it('lê dd/mm/aa (20aa) e dd/mm/aaaa; recusa data impossível', () => {
    assert.equal(parseDataBR('31/12/26'), '2026-12-31');
    assert.equal(parseDataBR('1/2/26'), '2026-02-01');
    assert.equal(parseDataBR('31/12/2026'), '2026-12-31');
    assert.equal(parseDataBR('29/02/27'), undefined);
    assert.equal(parseDataBR('31/12/026'), undefined);
    assert.equal(parseDataBR(''), null);
  });

  it('normaliza para dd/mm/aa ao gravar', () => {
    assert.equal(dataParaCelula('2026-12-31'), '31/12/26');
    assert.equal(dataParaCelula('1/2/2026'), '01/02/26');
    assert.equal(dataParaCelula('05/02/26'), '05/02/26');
    assert.equal(dataParaCelula('lixo'), 'lixo');
  });
});

describe('GB-41 — parse da tabela', () => {
  it('cabeçalho antigo (Ganho R$/mês, 7 colunas) continua valendo: status = ativo', () => {
    const { linhas, avisos } = parseGruposMd(`${ANTIGO}\n| Alfa | Site | 120363011111111111@g.us | 6.000,00 | 01/01/2026 | 31/12/26 | cliente |`);
    assert.deepEqual(avisos, []);
    assert.equal(linhas[0].status, 'ativo');
    assert.equal(linhas[0].ganho, 6000);
    assert.equal(linhas[0].fim, '2026-12-31');
  });

  it('interno: sem link é válido (jid null); com link vira aviso', () => {
    const { linhas, avisos } = parseGruposMd(`${NOVO}
| Alfa | Interno | | 100,00 | | | interno | ativo |
| Alfa | Errado | 120363011111111111@g.us | | | | interno | |
| | Sem empresa | | | | | interno | |`);
    assert.equal(linhas.length, 1);
    assert.equal(linhas[0].jid, null);
    assert.equal(linhas[0].tipo, 'interno');
    assert.equal(avisos.length, 2);
    assert.match(avisos[0], /interno não tem grupo/);
    assert.match(avisos[1], /empresa vazia/);
  });

  it('status inválido vira aviso; arquivado é lido', () => {
    const { linhas, avisos } = parseGruposMd(`${NOVO}
| Alfa | Site | 120363011111111111@g.us | | | | cliente | Arquivado |
| Alfa | App | 120363022222222222@g.us | | | | cliente | pausado |`);
    assert.equal(linhas.length, 1);
    assert.equal(linhas[0].status, 'arquivado');
    assert.match(avisos[0], /status "pausado"/);
  });
});

describe('GB-41 — listarProjetos e processamento', () => {
  const TEXTO = `${NOVO}
| Alfa | Site | 120363011111111111@g.us | 6.000,00 | | | cliente | ativo |
| Alfa | Interno | | 1.000,00 | | | interno | |
| Beta | Velho | 120363022222222222@g.us | 9.000,00 | | | cliente | arquivado |
| | | 120363099999999999@g.us | | | | despejo | |`;

  it('listarProjetos inclui interno (comGrupo false) e tira arquivado, salvo incluirArquivados', () => {
    const ps = listarProjetos({ texto: TEXTO });
    assert.deepEqual(ps.map(p => [p.empresa, p.projeto, p.comGrupo]), [['Alfa', 'Site', true], ['Alfa', 'Interno', false]]);
    assert.equal(listarProjetos({ texto: TEXTO, incluirArquivados: true }).length, 3);
    assert.deepEqual(listarProjetos({ mdPath: '/nao/existe/GRUPOS.md' }), []);
  });

  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'balde-gb41-')); });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('processarGruposMd: interno vira cliente sem grupo; arquivado não é lido nem vira cliente', async () => {
    const mdPath = join(dir, 'GRUPOS.md');
    writeFileSync(mdPath, TEXTO);
    const r = await processarGruposMd({ mdPath, configDir: join(dir, 'config'), resolver: async () => assert.fail('não resolve') });
    assert.deepEqual(r.avisos, []);
    assert.deepEqual(r.grupos.map(g => g.jid), ['120363011111111111@g.us', '120363099999999999@g.us']);
    assert.deepEqual(r.clientes.map(c => [c.projeto, c.grupos]), [['Site', ['120363011111111111@g.us']], ['Interno', []]]);
    const grupos = JSON.parse(readFileSync(join(dir, 'config', 'grupos.json'), 'utf8'));
    assert.equal(JSON.stringify(grupos).includes('120363022222222222'), false);
  });
});

describe('GB-41 — gravação', () => {
  it('definirStatusProjeto arquiva todas as linhas do projeto e devolve 0 quando não acha', () => {
    const texto = `${ANTIGO}
| Alfa | Site | 120363011111111111@g.us | | | | cliente |
| Alfa | Site | https://chat.whatsapp.com/X | | | | cliente |
| Beta | App | 120363022222222222@g.us | | | | cliente |`;
    const r = definirStatusProjeto(texto, 'Alfa', 'Site', 'arquivado');
    assert.equal(r.linhas, 2);
    assert.equal(parseGruposMd(r.texto).linhas.filter(l => l.status === 'arquivado').length, 2);
    assert.ok(r.texto.includes('| Beta | App | 120363022222222222@g.us | | | | cliente | ativo |'));
    assert.equal(definirStatusProjeto(texto, 'Gama', 'X', 'arquivado').linhas, 0);
    assert.throws(() => definirStatusProjeto(texto, 'Alfa', 'Site', 'apagado'), /ativo ou arquivado/);
  });

  it('montarGruposMd atualiza as instruções do exemplo antigo e mantém o resto do texto do dono', () => {
    const antes = `# Grupos do Balde

- **Ganho R$/mês**: formato BR, ex. \`6.000,00\`.
- **Início / Fim**: \`dd/mm/aaaa\`, opcionais.
- **Tipo**: \`cliente\` (grupo de um projeto) ou \`despejo\` (grupo onde você joga coisas soltas).
- Nota minha que fica.`;
    const { celulas, erros } = validarLinhasProjetos([{ empresa: 'A', projeto: 'B', link: '', ganho: '', inicio: '', fim: '', tipo: 'interno' }]);
    assert.deepEqual(erros, []);
    const novo = montarGruposMd(`${antes}\n\n${ANTIGO}\n`, celulas);
    assert.match(novo, /\*\*Ganho total \(R\$\)\*\*/);
    assert.match(novo, /`dd\/mm\/aa` \(ano 20aa\)/);
    assert.match(novo, /`interno` \(projeto sem grupo/);
    assert.match(novo, /\*\*Status\*\*/);
    assert.ok(novo.includes('- Nota minha que fica.'));
    assert.ok(novo.includes('| A | B | | | | | interno | ativo |'));
  });
});
