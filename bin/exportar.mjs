import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJETO_ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const destinoIdx = args.indexOf('--destino');
if (destinoIdx === -1 || !args[destinoIdx + 1]) {
  console.error("Uso: node exportar.mjs --destino <caminho> [--simular]");
  process.exit(1);
}
const destino = path.resolve(args[destinoIdx + 1]);
const simular = args.includes('--simular');

// 1. Excluir dados sensíveis e pastas não versionadas
const EXCLUIR = [
  'dados',
  '.env',
  'GRUPOS.md',
  'DESTINOS.md',
  'config/clientes.json',
  'config/grupos.json',
  'link-cache',
  'logs',
  'node_modules',
  'conectores/baileys/node_modules',
  '.git',
  '.overclock-app',
  '.exportar-proibidos'
];

function deveCopiar(srcPath, destPath) {
  const relPath = path.relative(PROJETO_ROOT, srcPath);
  if (!relPath) return true;
  for (const exc of EXCLUIR) {
    if (relPath === exc || relPath.startsWith(exc + path.sep)) {
      return false;
    }
  }
  // Remove também a sessão do Baileys, que fica dentro da pasta dele
  if (relPath.includes('auth_info_baileys')) {
    return false;
  }
  return true;
}

if (!simular) {
  if (fs.existsSync(destino)) {
    console.error(`Erro: O destino ${destino} já existe. Para exportar, especifique uma pasta nova.`);
    process.exit(1);
  }
  fs.mkdirSync(destino, { recursive: true });
}

console.log(`Copiando arquivos para ${destino}...`);
if (!simular) {
  fs.cpSync(PROJETO_ROOT, destino, { recursive: true, filter: deveCopiar });
}

// 2. Movendo distribuição
if (!simular) {
  const distDir = path.join(destino, 'distribuicao');
  if (fs.existsSync(distDir)) {
    const files = fs.readdirSync(distDir);
    for (const f of files) {
      const src = path.join(distDir, f);
      const dst = path.join(destino, f === 'README-PUBLICO.md' ? 'README.md' : f);
      fs.renameSync(src, dst);
    }
    fs.rmSync(distDir, { recursive: true, force: true });
  }
}

// 3. Montar lista de termos proibidos
const termosProibidos = new Set();
const envPath = path.join(PROJETO_ROOT, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    if (line.startsWith('BALDE_EVOLUTION_URL=')) {
      try {
        const urlStr = line.split('=', 2)[1].trim();
        const url = new URL(urlStr);
        termosProibidos.add(url.host.toLowerCase());
      } catch(e) {}
    }
  }
}

const probPath = path.join(PROJETO_ROOT, '.exportar-proibidos');
if (fs.existsSync(probPath)) {
  const probContent = fs.readFileSync(probPath, 'utf8');
  for (const line of probContent.split('\n')) {
    const term = line.trim();
    if (term) termosProibidos.add(term.toLowerCase());
  }
}

const gruposPath = path.join(PROJETO_ROOT, 'GRUPOS.md');
if (fs.existsSync(gruposPath)) {
  const gruposContent = fs.readFileSync(gruposPath, 'utf8');
  for (const line of gruposContent.split('\n')) {
    if (!line.startsWith('|')) continue;
    const p = line.split('|').map(s => s.trim());
    if (p.length > 2 && p[1] && p[1] !== 'Empresa' && p[1] !== '---') {
      termosProibidos.add(p[1].toLowerCase());
    }
    // Jids e códigos de convite dos grupos reais também não podem sair.
    for (const cel of p) {
      const jid = cel.match(/\d{10,}@g\.us/);
      if (jid) termosProibidos.add(jid[0].toLowerCase());
      const convite = cel.match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)/);
      if (convite) termosProibidos.add(convite[1].toLowerCase());
    }
  }
}

// 4. Varredura final
console.log("Realizando varredura final...");
let foundLeak = false;

function scanDirectory(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.git') continue;
      scanDirectory(fullPath);
    } else {
      const ext = path.extname(fullPath).toLowerCase();
      if (['.pdf', '.png', '.jpg', '.jpeg', '.zip'].includes(ext)) continue;
      
      let content;
      try { content = fs.readFileSync(fullPath, 'utf8'); } catch(e) { continue; }
      const lines = content.split('\n');
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const term of termosProibidos) {
          // Exceção: desenvolvedor no LICENSE
          if (term === 'gar' + 'cez' && entry.name === 'LICENSE') continue;
          
          const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const regex = new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i');
          if (regex.test(line)) {
            console.error(`ERRO DE VAZAMENTO: Termo '${term}' encontrado em ${fullPath}:${i + 1}`);
            foundLeak = true;
          }
        }
      }
    }
  }
}

if (!simular) {
  scanDirectory(destino);
  if (foundLeak) {
    console.error("Varredura falhou! Foram encontrados dados sensíveis no destino.");
    process.exit(1);
  } else {
    console.log("Nenhum vazamento detectado.");
  }
}

// 5. Git Init
if (!simular) {
  console.log("Inicializando repositório Git...");
  execSync('git init', { cwd: destino, stdio: 'ignore' });
  execSync('git add .', { cwd: destino, stdio: 'ignore' });
  execSync('git commit -m "Initial commit"', { cwd: destino, stdio: 'ignore' });
  console.log(`Exportação limpa finalizada em ${destino}`);
}
