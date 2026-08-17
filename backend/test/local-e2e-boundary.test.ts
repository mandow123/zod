import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const scriptPath = resolve(import.meta.dirname, '../scripts/resource-evidence-e2e-server.ts');

describe('local E2E control boundary', () => {
  it('guards every control route with one random session token and disables real topups', async () => {
    const source = await readFile(scriptPath, 'utf8');
    expect(source).toMatch(/randomBytes\(32\)\.toString\('base64url'\)/u);
    expect(source).toMatch(/request\.url\.startsWith\('\/__e2e\/'\)/u);
    expect(source).toMatch(/validE2ESession\(request\.headers\['x-kai-e2e-session'\]\)/u);
    expect(source).toMatch(/E2E_REAL_PAYMENT_DISABLED/u);
    expect(source).toMatch(/new Map\(\)/u);
  });

  it('keeps closed-loop settlement and aftercare fixtures on the two-decimal card-hour contract', async () => {
    const source = await readFile(scriptPath, 'utf8');
    expect(source).toContain("accepted.settlement.capturedCredits !== '18.69'");
    expect(source).toContain("accepted.settlement.refundedCredits !== '12.45'");
    expect(source).toContain("'20.00',");
    expect(source).not.toMatch(/accepted\.settlement\.(?:captured|refunded)Credits !== '\d+\.\d{3,}'/u);
    expect(source).not.toContain("'20.000000'");
  });
});
