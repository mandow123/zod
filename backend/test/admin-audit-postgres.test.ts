import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PostgresAdminAuditStore } from '../src/admin/audit-store.js';
import { adminFixture, h64 } from './admin-test-database.js';

describe('admin audit store', () => {
  it('appends canonical permission snapshots and exposes no mutation API', { timeout: 120_000 }, async () => {
    const f = await adminFixture(); const store = new PostgresAdminAuditStore(f.database, 'a'.repeat(40));
    const event = await store.append({ occurredAt: new Date(), adminIdentityId: null, adminSessionId: null,
      effectivePermissions: ['admin.audit.read','admin.overview.read','admin.audit.read'],
      action: 'admin.audit.read', targetType: 'order', targetId: 'KC1',
      requestId: randomUUID(), ticketReference: null, reasonCode: null, reasonDigest: null,
      idempotencyKeyHash: null, beforeStateDigest: null, afterStateDigest: null,
      ipHash: h64('b'), userAgentHash: h64('c'), outcome: 'succeeded', errorCode: null,
      sensitiveAccess: false, metadata: { roleCodes: ['audit_viewer'], changed: false } });
    expect(event.effectivePermissions).toEqual(['admin.audit.read','admin.overview.read']);
    expect(event.metadata.roleCodes).toEqual(['audit_viewer']);
    expect((await store.forTarget('order','KC1',10))[0]?.id).toBe(event.id);
    expect((await store.recent(10))[0]?.id).toBe(event.id);
    expect('update' in store).toBe(false); expect('delete' in store).toBe(false);
    await expect(f.database.query('DELETE FROM admin_audit_events WHERE id=$1',[event.id])).rejects.toThrow();
    await expect(store.append({ ...event, id: randomUUID(), effectivePermissions: ['admin.root'] })).rejects.toThrow(
      'ADMIN_PERMISSION_UNKNOWN',
    );
    await expect(store.append({ ...event, id: randomUUID(), metadata: {
      secret: 'must-not-enter-audit',
    } as never })).rejects.toThrow('ADMIN_AUDIT_METADATA_UNKNOWN_FIELD');
    for (const metadata of [
      { status: 'x'.repeat(81) }, { status: '人工审核通过 because this is prose' },
      { failureCode: 'payment failed because the signature was invalid' },
      { failureCode: `E_${'X'.repeat(80)}` }, { roleCodes: ['unknown_role'] },
      { revokedSessionCount: -1 }, { revokedSessionCount: Number.MAX_SAFE_INTEGER + 1 },
    ]) await expect(store.append({ ...event, id: randomUUID(), metadata: metadata as never })).rejects.toThrow(
      'ADMIN_AUDIT_METADATA_INVALID',
    );
    const canonical = await store.append({ ...event, id: randomUUID(), metadata: {
      roleCodes: ['support_viewer','audit_viewer','support_viewer'], status: 'active',
      failureCode: 'OIDC_GROUP_SYNC_FAILED', revokedSessionCount: 0,
    } });
    expect(canonical.metadata.roleCodes).toEqual(['audit_viewer','support_viewer']);
    await f.database.close();
  });
});
