import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatarPrazoProjeto,
  formatarPiorTag,
  calcularPiorPrazo,
} from './util.js';

test('GB-60: formatarPrazoProjeto formata prazos atrasados, hoje e próximos', () => {
  const agora = new Date(2026, 9, 14, 12, 0); // 14/10/2026

  // Atrasada (vermelho: classe atrasado)
  const atrasada = formatarPrazoProjeto('2026-10-12', 3, agora);
  assert.deepEqual(atrasada, {
    tipo: 'atrasada',
    dias: 2,
    texto: 'atrasada 2 d',
    classe: 'atrasado',
  });

  // Vence hoje (laranja: classe laranja)
  const hoje = formatarPrazoProjeto('2026-10-14', 3, agora);
  assert.deepEqual(hoje, {
    tipo: 'hoje',
    dias: 0,
    texto: 'vence hoje',
    classe: 'laranja',
  });

  // Próxima dentro da janela de 3 dias (amarelo: classe amarelo)
  const prox = formatarPrazoProjeto('2026-10-16', 3, agora);
  assert.deepEqual(prox, {
    tipo: 'proxima',
    dias: 2,
    texto: 'faltam 2 d',
    classe: 'amarelo',
  });

  // Fora da janela (> 3 dias): nada (null)
  assert.equal(formatarPrazoProjeto('2026-10-20', 3, agora), null);

  // Sem prazo ou inválido
  assert.equal(formatarPrazoProjeto(null, 3, agora), null);
  assert.equal(formatarPrazoProjeto('data-invalida', 3, agora), null);
});

test('GB-60: formatarPiorTag formata objeto pior vindo de /api/alertas', () => {
  // Atrasada
  assert.deepEqual(formatarPiorTag({ tipo: 'atrasada', dias: 3 }, 3), {
    tipo: 'atrasada',
    dias: 3,
    texto: 'atrasada 3 d',
    classe: 'atrasado',
  });
  assert.deepEqual(formatarPiorTag({ tipo: 'atrasado', dias: 1 }, 3), {
    tipo: 'atrasada',
    dias: 1,
    texto: 'atrasada 1 d',
    classe: 'atrasado',
  });

  // Vence hoje
  assert.deepEqual(formatarPiorTag({ tipo: 'hoje', dias: 0 }, 3), {
    tipo: 'hoje',
    dias: 0,
    texto: 'vence hoje',
    classe: 'laranja',
  });

  // Próxima dentro da janela
  assert.deepEqual(formatarPiorTag({ tipo: 'proxima', dias: 2 }, 3), {
    tipo: 'proxima',
    dias: 2,
    texto: 'faltam 2 d',
    classe: 'amarelo',
  });

  // Próxima fora da janela: nada (null)
  assert.equal(formatarPiorTag({ tipo: 'proxima', dias: 5 }, 3), null);

  // Inválido / nulo
  assert.equal(formatarPiorTag(null, 3), null);
  assert.equal(formatarPiorTag({}, 3), null);
});

test('GB-60: calcularPiorPrazo prioriza atrasada > hoje > faltam N d', () => {
  const agora = new Date(2026, 9, 14, 12, 0); // 14/10/2026

  // Atrasada ganha de hoje e de próxima
  const prazos1 = ['2026-10-12', '2026-10-14', '2026-10-16'];
  const res1 = calcularPiorPrazo(prazos1, 3, agora);
  assert.deepEqual(res1, {
    tipo: 'atrasada',
    dias: 2,
    texto: 'atrasada 2 d',
    classe: 'atrasado',
  });

  // Entre várias atrasadas, pega o maior atraso
  const prazosAtraso = ['2026-10-13', '2026-10-10'];
  const resAtraso = calcularPiorPrazo(prazosAtraso, 3, agora);
  assert.deepEqual(resAtraso, {
    tipo: 'atrasada',
    dias: 4,
    texto: 'atrasada 4 d',
    classe: 'atrasado',
  });

  // Hoje ganha de próxima
  const prazos2 = ['2026-10-14', '2026-10-15'];
  const res2 = calcularPiorPrazo(prazos2, 3, agora);
  assert.deepEqual(res2, {
    tipo: 'hoje',
    dias: 0,
    texto: 'vence hoje',
    classe: 'laranja',
  });

  // Próximas: pega a mais próxima (menor dias)
  const prazos3 = ['2026-10-17', '2026-10-15'];
  const res3 = calcularPiorPrazo(prazos3, 3, agora);
  assert.deepEqual(res3, {
    tipo: 'proxima',
    dias: 1,
    texto: 'faltam 1 d',
    classe: 'amarelo',
  });

  // Fora da janela: null
  const prazosLonge = ['2026-10-25'];
  assert.equal(calcularPiorPrazo(prazosLonge, 3, agora), null);

  // Lista vazia
  assert.equal(calcularPiorPrazo([], 3, agora), null);
});
