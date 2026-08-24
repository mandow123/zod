import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const protectedCalls: Record<string, number> = {
  'account/routes.ts': 6,
  'assets/routes.ts': 1,
  'creator-commissions/routes.ts': 6,
  'credit-orders/routes.ts': 27,
  'credits/routes.ts': 2,
  'device-commerce/routes.ts': 12,
  'disputes/routes.ts': 11,
  'fulfillment/routes.ts': 9,
  'invoices/routes.ts': 11,
  'listings/routes.ts': 19,
  'market/routes.ts': 12,
  'node-enrollment/routes.ts': 2,
  'notifications/routes.ts': 5,
  'operations/routes.ts': 1,
  'payouts/routes.ts': 10,
  'refunds/routes.ts': 6,
  'resource-evidence/routes.ts': 8,
  'shipping-addresses/routes.ts': 3,
  'subjects/routes.ts': 4,
  'topups/reversal-routes.ts': 2,
  'topups/routes.ts': 3,
  'vast-market/routes.ts': 4,
};

describe('production paired-auth route matrix', () => {
  it('routes every protected mobile handler through the shared request authenticator', async () => {
    let guarded = 0;
    for (const [relative, expected] of Object.entries(protectedCalls)) {
      const source = await readFile(new URL(`../src/${relative}`, import.meta.url), 'utf8');
      expect(source, relative).not.toMatch(/\.authenticate\([^)]*headers\.authorization/u);
      const count = source.match(/await authenticateMobileRequest/gu)?.length ?? 0;
      expect(count, relative).toBe(expected);
      guarded += count;
    }
    const accountRoutes = await readFile(new URL('../src/account/routes.ts', import.meta.url), 'utf8');
    expect(accountRoutes.match(/await authenticateMobileBootstrapRequest/gu)?.length).toBe(2);
    const inquiries = await readFile(new URL('../src/resource-inquiries/routes.ts', import.meta.url), 'utf8');
    expect(inquiries).toContain('return authenticateMobileRequest(accounts,request)');
    expect(inquiries.match(/await auth\(accounts,request\)/gu)?.length).toBe(13);
    expect(guarded + 13 + 2).toBe(179);
  });

  it('physically confines legacy local-token verification to explicit test E2E mode', async () => {
    const service = await readFile(new URL('../src/account/service.ts', import.meta.url), 'utf8');
    expect(service).toContain("config.NODE_ENV === 'test' && config.localE2E");
    expect(service).toContain("throw new AppError('AUTH_PAIRED_TOKEN_REQUIRED', 401");
    const routes = await readFile(new URL('../src/account/routes.ts', import.meta.url), 'utf8');
    expect(routes).toContain("if (config.NODE_ENV === 'test' && config.localE2E)");
    expect(routes).toContain("'AUTH_LOCAL_SESSION_RETIRED', 410");
  });
});
