import fs from 'node:fs';
import { readFile, appendFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { adicionarAoGruposMd, listarGrupos } from './ingestao/grupos-evolution.mjs';
import { decodificarConvite, estadoConexao, qrDaInstancia } from './whatsapp/convite.mjs';

/** KEY=valor do .env (valor pode conter '='). */
function lerDotenv(filepath) {
  let content = '';
  try { content = fs.readFileSync(filepath, 'utf8'); } catch (e) {}
  const env = {};
  for (const bruta of content.split(/\r?\n/)) {
    const linha = bruta.trim();
    if (!linha || linha.startsWith('#') || !linha.includes('=')) continue;
    const i = linha.indexOf('=');
    env[linha.slice(0, i).trim()] = linha.slice(i + 1).trim();
  }
  return env;
}

function editDotenv(filepath, updates) {
  let content = '';
  try { content = fs.readFileSync(filepath, 'utf8'); } catch (e) {}
  let lines = content.split('\n');
  for (const [key, value] of Object.entries(updates)) {
    // Uma linha por chave: valor com quebra de linha injetaria outras variáveis no .env
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\r\n\0]/.test(String(value))) throw new Error(`valor inválido para ${key}`);
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith(`${key}=`)) {
        lines[i] = `${key}=${value}`;
        found = true;
        break;
      }
    }
    if (!found) lines.push(`${key}=${value}`);
  }
  const newContent = lines.join('\n').replace(/\n{2,}/g, '\n').trim() + '\n';
  fs.writeFileSync(filepath, newContent, { mode: 0o600 });
}

function recusarLoopbackOrigin(req, method) {
  const porta = req.socket?.localPort;
  const host = String(req.headers.host ?? '').toLowerCase();
  const hostsLocais = [`127.0.0.1:${porta}`, `localhost:${porta}`];
  if (!hostsLocais.includes(host)) return [403, 'Host não permitido (apenas localhost/127.0.0.1)'];

  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const tipo = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (tipo !== 'application/json') return [403, 'Content-Type deve ser application/json'];
    const origin = req.headers.origin;
    const origensOk = hostsLocais.map(h => `http://${h}`);
    if (origin !== undefined && !origensOk.includes(String(origin).toLowerCase())) {
      return [403, 'Origin não permitida'];
    }
  }
  return null;
}

async function lerCorpo(req) {
  const LIMITE_CORPO = 1024 * 1024;
  const declarado = Number(req.headers['content-length']);
  if (Number.isFinite(declarado) && declarado > LIMITE_CORPO) {
    req.resume();
    throw Object.assign(new Error('Corpo maior que 1 MB'), { status: 413 });
  }
  return new Promise((resolve, reject) => {
    const partes = [];
    let tamanho = 0;
    const aoDado = c => {
      tamanho += c.length;
      if (tamanho > LIMITE_CORPO) {
        req.off('data', aoDado);
        req.resume();
        reject(Object.assign(new Error('Corpo maior que 1 MB'), { status: 413 }));
        return;
      }
      partes.push(c);
    };
    req.on('data', aoDado);
    req.on('end', () => {
      if (tamanho > LIMITE_CORPO) return;
      const body = Buffer.concat(partes).toString('utf8');
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(Object.assign(new Error('JSON inválido'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function json(res, status, data) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}

function jsonError(res, status, msg) {
  json(res, status, { erro: msg });
}

export function criarSetup({ dir, conectores = {} }) {
  const fetchFn = conectores.fetch || global.fetch;
  const dotEnvPath = resolve(dir, '.env');
  let baileysMockState = null;

  return async (req, res) => {
    const method = req.method;
    // req.url is just the path if requested like that, so fallback to localhost
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = urlObj.pathname;

    const recusado = recusarLoopbackOrigin(req, method);
    if (recusado) {
      jsonError(res, recusado[0], recusado[1]);
      return;
    }

    if (pathname === '/api/setup/openai' && method === 'POST') {
      try {
        const body = await lerCorpo(req);
        if (!body.key) return jsonError(res, 400, 'Chave não fornecida');
        
        const resp = await fetchFn('https://api.openai.com/v1/models', {
          headers: { Authorization: `Bearer ${body.key}` }
        });
        if (!resp.ok) return jsonError(res, 401, 'Chave inválida');
        
        editDotenv(dotEnvPath, { OPENAI_API_KEY: body.key });
        return json(res, 200, { ok: true });
      } catch (e) {
        return jsonError(res, 500, e.message);
      }
    }

    if (pathname === '/api/setup/evolution' && method === 'POST') {
      try {
        const body = await lerCorpo(req);
        if (!body.url || !body.apikey || !body.instance) return jsonError(res, 400, 'Dados incompletos');
        
        const testUrl = `${body.url.replace(/\/+$/, '')}/instance/connectionState/${body.instance}`;
        const resp = await fetchFn(testUrl, {
          headers: { apikey: body.apikey }
        });
        if (!resp.ok) return jsonError(res, 400, 'Falha ao conectar na Evolution');
        const dados = await resp.json();
        if (dados.instance?.state !== 'open') return jsonError(res, 400, `Instância não está conectada: ${dados.instance?.state}`);
        
        editDotenv(dotEnvPath, { 
          BALDE_EVOLUTION_URL: body.url,
          BALDE_EVOLUTION_KEY: body.apikey,
          BALDE_EVOLUTION_INSTANCIA: body.instance
        });
        return json(res, 200, { ok: true });
      } catch (e) {
        return jsonError(res, 500, e.message);
      }
    }
    
    // GB-47: código de convite (instância exclusiva na Evolution do dono, token da instância).
    if (pathname === '/api/setup/convite' && method === 'POST') {
      try {
        const body = await lerCorpo(req);
        let convite;
        try { convite = decodificarConvite(body.codigo); }
        catch (e) { return jsonError(res, 400, 'Código de convite inválido. Confira se copiou o código inteiro.'); }

        const atual = lerDotenv(dotEnvPath);
        if (atual.BALDE_EVOLUTION_INSTANCIA && atual.BALDE_EVOLUTION_INSTANCIA !== convite.instancia) {
          return jsonError(res, 409, `Este Balde já está ligado à instância ${atual.BALDE_EVOLUTION_INSTANCIA}. Use o convite num Balde recém-instalado.`);
        }

        const conexao = { url: convite.url, key: convite.tokenInstancia, fetch: fetchFn };
        let estado;
        try { estado = await estadoConexao(conexao, convite.instancia); }
        catch (e) {
          if (e.status === 401 || e.status === 403 || e.status === 404) {
            return jsonError(res, 400, 'Este convite não vale mais (foi revogado ou está errado). Peça um novo a quem te convidou.');
          }
          return jsonError(res, 502, `Não consegui falar com o servidor do convite: ${e.message}`);
        }

        editDotenv(dotEnvPath, {
          BALDE_EVOLUTION_URL: convite.url,
          BALDE_EVOLUTION_INSTANCIA: convite.instancia,
          BALDE_EVOLUTION_KEY: convite.tokenInstancia,
        });
        baileysMockState = null;
        return json(res, 200, { ok: true, instancia: convite.instancia, estado });
      } catch (e) {
        return jsonError(res, e.status || 500, e.message);
      }
    }

    if (pathname === '/api/setup/convite/qr' && method === 'GET') {
      try {
        const env = lerDotenv(dotEnvPath);
        if (!env.BALDE_EVOLUTION_URL || !env.BALDE_EVOLUTION_KEY || !env.BALDE_EVOLUTION_INSTANCIA) {
          return jsonError(res, 400, 'Convite ainda não aplicado');
        }
        const conexao = { url: env.BALDE_EVOLUTION_URL, key: env.BALDE_EVOLUTION_KEY, fetch: fetchFn };
        return json(res, 200, await qrDaInstancia(conexao, env.BALDE_EVOLUTION_INSTANCIA));
      } catch (e) {
        return jsonError(res, 502, e.message);
      }
    }

    if (pathname === '/api/setup/baileys/start' && method === 'POST') {
      try {
        if (!conectores.baileys) return jsonError(res, 500, 'Conector baileys não injetado');
        baileysMockState = await conectores.baileys.iniciar();
        return json(res, 200, { ok: true });
      } catch (e) {
        return jsonError(res, 500, e.message);
      }
    }
    
    if (pathname === '/api/setup/qr' && method === 'GET') {
      try {
        if (!baileysMockState) return jsonError(res, 400, 'Baileys não iniciado');
        const state = await baileysMockState.obterEstado();
        if (state.status === 'connected') {
            editDotenv(dotEnvPath, { WHATSAPP_MODE: 'baileys' });
        }
        return json(res, 200, state);
      } catch(e) {
        return jsonError(res, 500, e.message);
      }
    }
    
    if (pathname === '/api/setup/grupos' && method === 'GET') {
      try {
          let grupos = [];
          if (baileysMockState) {
              grupos = await baileysMockState.listarGrupos();
          } else {
              const env = lerDotenv(dotEnvPath);
              if (env.BALDE_EVOLUTION_URL) {
                  const conexao = { 
                      url: env.BALDE_EVOLUTION_URL, 
                      key: env.BALDE_EVOLUTION_KEY, 
                      inst: env.BALDE_EVOLUTION_INSTANCIA,
                      fetch: fetchFn 
                  };
                  grupos = await listarGrupos(conexao);
              }
          }
          return json(res, 200, { grupos });
      } catch (e) {
          return jsonError(res, 500, e.message);
      }
    }
    
    if (pathname === '/api/setup/grupos' && method === 'POST') {
        try {
            const body = await lerCorpo(req);
            for (const g of (body.grupos || [])) {
                await adicionarAoGruposMd({
                    jid: g.id || g.jid,
                    empresa: g.empresa,
                    projeto: g.projeto,
                    tipo: g.tipo
                }, resolve(dir, 'GRUPOS.md'));
            }
            return json(res, 200, { ok: true });
        } catch(e) {
            return jsonError(res, 500, e.message);
        }
    }

    if (method === 'GET' && (pathname === '/setup' || pathname.startsWith('/setup/'))) {
        let rel = pathname.replace(/^\/setup\/?/, '') || 'setup.html';
        const validos = ['setup.html', 'setup.js', 'setup.css'];
        if (!validos.includes(rel)) rel = 'setup.html';
        
        const mimeTypes = {
            'setup.html': 'text/html; charset=utf-8',
            'setup.js': 'text/javascript; charset=utf-8',
            'setup.css': 'text/css; charset=utf-8'
        };
        try {
            const data = await readFile(resolve(dir, 'painel', rel));
            res.writeHead(200, { 'Content-Type': mimeTypes[rel] });
            res.end(data);
        } catch (e) {
            return jsonError(res, 404, 'Arquivo não encontrado');
        }
        return;
    }
    
    return jsonError(res, 404, 'Rota não encontrada (setup)');
  };
}
