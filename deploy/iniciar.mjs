import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { lerAmbiente } from './ambiente.mjs';

const dir = resolve(process.argv[2]);
process.chdir(dir);
Object.assign(process.env, lerAmbiente(dir), { BALDE_EVOLUTION: '1' });
// O servidor reconhece a execução direta por argv[1]. Carregar antes do import
// também disponibiliza as variáveis aos módulos importados pelo servidor.
process.argv[1] = join(dir, 'server.mjs');
await import(pathToFileURL(process.argv[1]).href);
