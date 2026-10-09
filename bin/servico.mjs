#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { lerAmbiente } from '../deploy/ambiente.mjs';

/** Label do launchd: BALDE_SERVICO_LABEL (ambiente ou .env da pasta), senão um genérico. */
export function labelServico(dir, env = process.env) {
  const label = env.BALDE_SERVICO_LABEL || lerAmbiente(dir).BALDE_SERVICO_LABEL || 'com.balde.servico';
  if (!/^[\w.-]+$/.test(label)) throw new Error(`BALDE_SERVICO_LABEL inválido: ${label}`);
  return label;
}
const uso = 'Uso: node bin/servico.mjs instalar|desinstalar|status|logs [--dir <pasta balde>] [--destino <pasta de teste>]';
const xml = valor => String(valor).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

async function main() {
  const { positionals, values } = parseArgs({ options: { destino: { type: 'string' }, dir: { type: 'string' } }, allowPositionals: true });
  const [comando] = positionals;
  if (positionals.length !== 1 || !['instalar', 'desinstalar', 'status', 'logs'].includes(comando)) throw new Error(uso);
  const dir = path.resolve(values.dir || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const label = labelServico(dir);
  const logsDir = path.join(os.homedir(), 'Library', 'Logs', 'balde');
  const plist = path.join(values.destino ? path.resolve(values.destino) : path.join(os.homedir(), 'Library', 'LaunchAgents'), `${label}.plist`);
  const dominio = `gui/${process.getuid?.()}`;
  const alvo = `${dominio}/${label}`;
  const launch = (...args) => spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
  const exigir = resultado => {
    if (resultado.error || resultado.status !== 0) throw new Error(resultado.error?.message || resultado.stderr?.trim() || `launchctl falhou (${resultado.status})`);
  };
  const verificarMac = () => { if (process.platform !== 'darwin') throw new Error('Este serviço requer macOS. Use --destino para gerar o plist sem instalar.'); };

  if (comando === 'instalar') {
    for (const arquivo of ['server.mjs', 'deploy/iniciar.mjs', 'deploy/ambiente.mjs']) {
      if (!fs.statSync(path.join(dir, arquivo)).isFile()) throw new Error(`Arquivo inválido: ${arquivo}`);
    }
    const string = valor => `<string>${xml(valor)}</string>`;
    const conteudo = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key>${string(label)}
<key>ProgramArguments</key><array>${[process.execPath, path.join(dir, 'deploy/iniciar.mjs'), dir].map(string).join('')}</array>
<key>WorkingDirectory</key>${string(dir)}
<key>EnvironmentVariables</key><dict><key>BALDE_EVOLUTION</key><string>1</string></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key>${string(path.join(logsDir, 'out.log'))}
<key>StandardErrorPath</key>${string(path.join(logsDir, 'err.log'))}
</dict></plist>\n`;
    if (!values.destino) verificarMac();
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, conteudo, { mode: 0o600 });
    console.log(`Plist gerado: ${plist}`);
    if (values.destino) { console.log('Modo de teste: launchd e diretório de logs não foram alterados.'); return; }
    fs.mkdirSync(logsDir, { recursive: true, mode: 0o700 });
    if (launch('print', alvo).status === 0) exigir(launch('bootout', alvo));
    exigir(launch('enable', alvo));
    exigir(launch('bootstrap', dominio, plist));
    console.log('Serviço carregado. Execute status para verificar processo e API.');
  } else if (comando === 'desinstalar') {
    if (!values.destino) {
      verificarMac();
      if (launch('print', alvo).status === 0) exigir(launch('bootout', alvo));
    }
    fs.rmSync(plist, { force: true });
    console.log(`Plist removido (se existia): ${plist}. Logs preservados.`);
  } else if (comando === 'status') {
    const resultado = launch('print', alvo);
    const vivo = resultado.status === 0 && /\bstate = running\b/.test(resultado.stdout) && /\bpid = \d+/.test(resultado.stdout);
    console.log(`Processo launchd: ${vivo ? 'em execução' : resultado.status === 0 ? 'registrado, mas sem processo em execução' : 'não encontrado ou launchd indisponível'}.`);
    const env = lerAmbiente(dir);
    let host = env.BALDE_HOST || '127.0.0.1';
    if (host === '0.0.0.0') host = '127.0.0.1';
    if (host === '::') host = '::1';
    if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
    const url = `http://${host}:${env.BALDE_PORT || 7391}/api/tarefas`;
    let api = false;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'error' });
      api = res.ok;
      console.log(`API GET ${url}: HTTP ${res.status}${api ? ' — acessível' : ' — falhou'}.`);
      await res.body?.cancel();
    } catch { console.log(`API GET ${url}: sem resposta (limite de 3 segundos).`); }
    if (!vivo || !api) process.exitCode = 1;
  } else {
    console.log(`Logs: ${logsDir}`);
    for (const nome of ['out.log', 'err.log']) {
      const arquivo = path.join(logsDir, nome);
      console.log(`${arquivo}${fs.existsSync(arquivo) ? '' : ' (ainda não criado)'}`);
    }
  }
}
main().catch(erro => { console.error(`Erro: ${erro.message}`); process.exitCode = 1; });
