import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { formatCreditDisplayMicros } from '../src/credits/display.js';

describe('human-visible KAI credit copy', () => {
  it('formats only cent-aligned card-hours and rejects hidden precision', () => {
    expect(formatCreditDisplayMicros(26_027_940_000n)).toBe('26027.94');
    expect(formatCreditDisplayMicros(5_205_588_820_000n)).toBe('5205588.82');
    expect(formatCreditDisplayMicros(10_000n)).toBe('0.01');
    expect(formatCreditDisplayMicros(-18_690_000n)).toBe('-18.69');
    expect(() => formatCreditDisplayMicros(1n)).toThrow('KAI_CREDIT_CENT_ALIGNMENT_REQUIRED');
  });

  it('routes top-up, refund notifications and validation errors through the display formatter', async () => {
    const [orders, service, topups] = await Promise.all([
      readFile(new URL('../src/credit-orders/store.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/credit-orders/service.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/topups/store.ts', import.meta.url), 'utf8'),
    ]);
    expect(orders).toContain('formatCreditDisplayMicros(BigInt(refund.credit_micros))');
    expect(service).toContain('formatCreditDisplayMicros(order.totalCreditMicros)');
    expect(topups).toContain('formatCreditDisplayMicros(topup.creditMicros)');
  });
});
