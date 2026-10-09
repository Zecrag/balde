#!/usr/bin/env node
/**
 * @file bin/convite.mjs — convida outra pessoa a conectar o WhatsApp dela pela
 * Evolution do dono (GB-47). Roda NO MAC DO DONO, com BALDE_EVOLUTION_URL e a
 * chave global (BALDE_EVOLUTION_GLOBAL_KEY, ou BALDE_EVOLUTION_KEY) no .env.
 *
 *   node bin/convite.mjs criar "Nome da Pessoa"         # só simula
 *   node bin/convite.mjs criar "Nome da Pessoa" --sim   # cria de verdade
 *   node bin/convite.mjs listar
 *   node bin/convite.mjs revogar "Nome da Pessoa"       # só simula
 *   node bin/convite.mjs revogar "Nome da Pessoa" --sim # desconecta e apaga
 *
 * Cada convite é uma instância nova balde-<slug>, sem webhook, só leitura. Nunca
 * toca a instância principal do dono (BALDE_EVOLUTION_INSTANCIA) nem o webhook
 * dela. O código entrega o token DA INSTÂNCIA, nunca a chave global.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  PREFIXO_INSTANCIA, nomeInstancia, ehInstanciaDeConvite, planejarConvite, criarInstancia,
  listarInstancias, revogarInstancia, codificarConvite, linkConvite,
} from '../lib/whatsapp/convite.mjs';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function lerEnv(arquivo, env = { ...process.env }) {
  let texto = '';
  try { texto = fs.readFileSync(arquivo, 'utf8'); } catch {}
  for (const bruta of texto.split(/\r?\n/)) {
    const linha = bruta.trim();
    if (!linha || linha.startsWith('#') || !linha.includes('=')) continue;
    const [k, ...v] = linha.split('=');
    if (env[k.trim()] === undefined) env[k.trim()] = v.join('=').trim();
  }
  return env;
}

function conexaoDono(env, fetchFn) {
  const url = String(env.BALDE_EVOLUTION_URL ?? '').replace(/\/+$/, '');
  const key = env.BALDE_EVOLUTION_GLOBAL_KEY || env.BALDE_EVOLUTION_KEY;
  if (!url || !key) throw new Error('Falta BALDE_EVOLUTION_URL e a chave global (BALDE_EVOLUTION_GLOBAL_KEY ou BALDE_EVOLUTION_KEY) no .env');
  return { url, key, fetch: fetchFn };
}

const USO = `Uso:
  node bin/convite.mjs criar "Nome da Pessoa" [--sim]
  node bin/convite.mjs listar
  node bin/convite.mjs revogar "Nome da Pessoa" [--sim]
Sem --sim, criar e revogar só mostram o que fariam.`;

/**
 * @param {string[]} argv
 * @param {{env?: object, fetch?: typeof fetch, log?: (s: string) => void}} [deps]
 * @returns {Promise<number>} código de saída
 */
export async function executar(argv, { env = lerEnv(path.join(RAIZ, '.env')), fetch: fetchFn = globalThis.fetch, log = console.log } = {}) {
  const [comando, ...resto] = argv;
  const confirmar = resto.includes('--sim');
  const nome = resto.filter(a => a !== '--sim').join(' ').trim();
  const instanciaDono = env.BALDE_EVOLUTION_INSTANCIA;

  if (comando === 'listar') {
    const conexao = conexaoDono(env, fetchFn);
    const convites = (await listarInstancias(conexao)).filter(i => ehInstanciaDeConvite(i.nome));
    if (!convites.length) { log(`Nenhum convite (instância ${PREFIXO_INSTANCIA}*) na Evolution.`); return 0; }
    log(`Convites na Evolution (${convites.length}):`);
    for (const i of convites) log(`  ${i.nome.padEnd(36)} ${i.estado.padEnd(12)} ${i.numero ?? '(sem número ainda)'}`);
    return 0;
  }

  if (comando === 'criar') {
    if (!nome) { log(USO); return 1; }
    const conexao = conexaoDono(env, fetchFn);
    const { instancia, totalInstancias } = await planejarConvite(conexao, nome, { instanciaDono });
    if (!confirmar) {
      log(`SIMULAÇÃO — nada foi criado.`);
      log(`  Evolution: ${conexao.url} (${totalInstancias} instância(s) hoje; o nome está livre)`);
      log(`  Criaria a instância: ${instancia} (sem webhook, só leitura, não lê mensagens como lidas)`);
      log(`  Não toca: ${instanciaDono || '(instância principal)'} nem o webhook dela`);
      log(`  Geraria um código com {url, ${instancia}, token próprio da instância} — nunca a chave global`);
      log(`Para criar de verdade: node bin/convite.mjs criar "${nome}" --sim`);
      return 0;
    }
    const { tokenInstancia } = await criarInstancia(conexao, instancia);
    const codigo = codificarConvite({ url: conexao.url, instancia, tokenInstancia });
    const link = linkConvite(codigo);
    log(`Convite criado para ${nome} — instância ${instancia}.`);
    log('');
    log('CÓDIGO DE CONVITE (é uma senha: mande só para essa pessoa):');
    log(codigo);
    log('');
    log('LINK (funciona depois que ela instalar o Balde no Mac dela):');
    log(link);
    log('');
    log('Como enviar (copie e cole no WhatsApp ou e-mail dela):');
    log('---');
    log(`Oi, ${nome.split(' ')[0]}! Para ligar o Balde no seu WhatsApp:`);
    log('1. Baixe o Balde e dê dois cliques em instalar.command.');
    log('2. Quando o navegador abrir, cole a chave da OpenAI.');
    log('3. No passo "Conectar WhatsApp", escolha "Tenho um código de convite" e cole:');
    log(codigo);
    log('   (ou, com o Balde já instalado, abra este link: ' + link + ')');
    log('4. Escaneie o QR code com o seu WhatsApp (Aparelhos conectados > Conectar aparelho).');
    log('5. Marque os grupos que o Balde deve ler. Pronto!');
    log('---');
    log(`Para desfazer: node bin/convite.mjs revogar "${nome}" --sim`);
    return 0;
  }

  if (comando === 'revogar') {
    if (!nome) { log(USO); return 1; }
    const instancia = nome.startsWith(PREFIXO_INSTANCIA) ? nome : nomeInstancia(nome);
    if (instanciaDono && instancia === instanciaDono) throw new Error(`Recusado: ${instancia} é a instância principal do dono`);
    if (!confirmar) {
      log(`SIMULAÇÃO — nada foi apagado.`);
      log(`  Desconectaria o WhatsApp (DELETE /instance/logout/${instancia}) e apagaria a instância (DELETE /instance/delete/${instancia}).`);
      log(`  O código de convite dela deixa de funcionar.`);
      log(`Para revogar de verdade: node bin/convite.mjs revogar "${nome}" --sim`);
      return 0;
    }
    const conexao = conexaoDono(env, fetchFn);
    const r = await revogarInstancia(conexao, instancia, { instanciaDono });
    log(`Revogado: ${r.instancia}${r.deslogou ? '' : ' (já estava desconectada)'} — instância apagada.`);
    return 0;
  }

  log(USO);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  executar(process.argv.slice(2))
    .then(code => process.exit(code))
    .catch(e => { console.error(`Erro: ${e.message}`); process.exit(1); });
}
