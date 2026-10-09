/**
 * @file lib/whatsapp/index.mjs — Ponto de entrada do módulo WhatsApp
 *
 * Re-exporta o conector Baileys para que outros módulos do balde possam
 * importar de um caminho estável.
 *
 * Uso:
 *   import { iniciarBaileys } from '../lib/whatsapp/index.mjs';
 */

export { iniciarBaileys } from './baileys.mjs';
