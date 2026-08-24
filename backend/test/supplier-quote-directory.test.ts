import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite, type Results, type Transaction } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Database } from '../src/database.js';
import { SupplierQuoteDirectoryService } from '../src/supplier-quote-directory/service.js';
import { PostgresSupplierQuoteDirectoryStore } from '../src/supplier-quote-directory/store.js';

function result<T>(value: Results<T>) {
  return { ...value, rowCount: value.rows.length || value.affectedRows || 0, command: '', oid: 0, rowAsArray: false };
}

function adapter(pglite: PGlite): Database {
  return {
    health: async () => true,
    schemaReadiness: async () => ({ ready: true, expected: null, applied: null, missing: [], mismatched: [] }),
    query: async <Row extends Record<string, unknown>>(text: string, values?: unknown[]) => result(await pglite.query<Row>(text, values)),
    transaction: async <T>(work: (client: PoolClient) => Promise<T>) => pglite.transaction(async (transaction: Transaction) => work({
      query: async (text: string, values?: unknown[]) => result(await transaction.query(text, values)),
    } as unknown as PoolClient)),
    close: () => pglite.close(),
  } as unknown as Database;
}

const environment = {
  NODE_ENV: 'test', PUBLIC_ORIGIN: 'https://cloudpay.kai.com', ACCESS_TOKEN_SECRET: 'a'.repeat(64),
  REFRESH_TOKEN_PEPPER: 'b'.repeat(32), OTP_PEPPER: 'c'.repeat(32), AUDIT_PEPPER: 'd'.repeat(32),
  CURSOR_SECRET: 'e'.repeat(32), PII_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString('base64'),
  TERMS_URL: 'https://cloudpay.kai.com/terms', PRIVACY_POLICY_URL: 'https://cloudpay.kai.com/privacy',
  INQUIRY_TERMS_URL: 'https://cloudpay.kai.com/inquiry-terms', MOBILE_API_PROFILE: 'inquiry_only',
};
const now = new Date('2026-08-23T00:00:00.000Z');

async function fixture() {
  const pglite = new PGlite();
  await pglite.exec(await readFile(fileURLToPath(new URL('../migrations/0064_supplier_quote_directory.sql', import.meta.url)), 'utf8'));
  const database = adapter(pglite);
  const service = new SupplierQuoteDirectoryService(new PostgresSupplierQuoteDirectoryStore(database), () => now);
  return { database, service };
}

describe('100-supplier quote directory', () => {
  it('publishes exactly 100 inquiry-only supplier rows without source CNY prices', { timeout: 30_000 }, async () => {
    const { database, service } = await fixture();
    expect(await service.readiness()).toEqual({ ready: true, blockers: [] });
    const response = await service.list({ limit: 100 });
    expect(response.totalPublished).toBe(100);
    expect(response.items).toHaveLength(100);
    expect(new Set(response.items.map((item) => item.supplierId)).size).toBe(100);
    expect(response.items[0]).toMatchObject({ sourceRow: 1, legalName: '阿里巴巴云计算有限公司',
      availability: { status: 'inquiry_required', quantity: null, inventoryCommitment: false },
      purchase: { purchasable: false, orderCreation: false, inquiryAvailable: true, cta: 'publish_directed_requirement' },
      source: { kind: 'USER_PROVIDED_SUPPLIER_WORKBOOK', verificationStatus: 'unverified' }, terms: 'inquiry-required' });
    expect(response.items[99]).toMatchObject({ sourceRow: 100, legalName: 'Exoscale' });
    const publicJson = JSON.stringify(response).toLowerCase();
    for (const forbidden of ['sourcecurrency', 'sourcehourlyminor', 'sourcemonthlyminor', '"cny"', '人民币']) {
      expect(publicJson).not.toContain(forbidden);
    }
    await database.close();
  });

  it('filters by declared model and registers a public inquiry-profile route', { timeout: 30_000 }, async () => {
    const { database, service } = await fixture();
    const b300 = await service.list({ model: 'B300', limit: 100 });
    expect(b300.items.length).toBeGreaterThan(0);
    expect(b300.items.every((item) => item.gpu.models.includes('B300'))).toBe(true);
    const app = await buildApp({ config: loadConfig(environment), database, supplierQuoteDirectoryService: service, logger: false });
    const response = await app.inject({ method: 'GET', url: '/mobile/v1/supplier-quote-directory?query=CoreWeave&limit=100' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, totalPublished: 100, items: [{ displayName: 'CoreWeave Inc' }] });
    await app.close(); await database.close();
  });

  it('fails closed after the source validity window', { timeout: 30_000 }, async () => {
    const pglite = new PGlite();
    await pglite.exec(await readFile(fileURLToPath(new URL('../migrations/0064_supplier_quote_directory.sql', import.meta.url)), 'utf8'));
    const database = adapter(pglite);
    const service = new SupplierQuoteDirectoryService(new PostgresSupplierQuoteDirectoryStore(database),
      () => new Date('2026-09-17T16:00:00.000Z'));
    expect(await service.readiness()).toEqual({ ready: false, blockers: ['SUPPLIER_QUOTE_DIRECTORY_EXPIRED'] });
    await expect(service.list({})).rejects.toMatchObject({ code: 'SUPPLIER_QUOTE_DIRECTORY_NOT_READY', statusCode: 503 });
    await database.close();
  });
});
