#!/usr/bin/env node
/** Sem --aplicar apenas lista IDs/motivos, sem instanciar store nem migrar dados. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidatasLimpeza } from '../lib/motor/triagem.mjs';
import { ESTADOS } from '../lib/tipos.mjs';
const args = process.argv.slice(2);
if (args.some(a => a !== '--aplicar')) throw new Error('Uso: node bin/limpar-tarefas.mjs [--aplicar]');
const dir = process.env.BALDE_DADOS || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dados');
const arquivo = path.join(dir, 'tarefas.json');
const tarefas = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
const mensagensPath = path.join(dir, 'mensagens.jsonl');
const mensagens = fs.existsSync(mensagensPath) ? fs.readFileSync(mensagensPath, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } }) : [];
const candidatas = candidatasLimpeza(tarefas, mensagens);
console.log(JSON.stringify({ modo: args.includes('--aplicar') ? 'aplicar' : 'somente-leitura', total: candidatas.length, candidatas }, null, 2));
if (args.includes('--aplicar') && candidatas.length) {
  const backup = `${arquivo}.antes-limpeza-${Date.now()}.bak`;
  fs.copyFileSync(arquivo, backup, fs.constants.COPYFILE_EXCL);
  const ids = new Set(candidatas.map(t => t.id));
  const resultado = tarefas.map(t => ids.has(t.id) ? { ...t, estado: ESTADOS.DESCARTADA, atualizadaEm: new Date().toISOString() } : t);
  const tmp = `${arquivo}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(resultado, null, 2) + '\n', { flag: 'wx' });
  fs.renameSync(tmp, arquivo);
}
