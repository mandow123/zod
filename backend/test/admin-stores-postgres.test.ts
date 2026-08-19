import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PostgresAdminIdentityStore } from '../src/admin/identity-store.js';
import { PostgresAdminLoginTransactionStore } from '../src/admin/login-transaction-store.js';
import { PostgresAdminRbacStore } from '../src/admin/rbac-store.js';
import { PostgresAdminSessionStore } from '../src/admin/session-store.js';
import { adminFixture, h128, h64 } from './admin-test-database.js';

describe('admin identity and RBAC stores', () => {
  it('gets duplicate identity and atomically revokes sessions when OIDC authorization changes', { timeout: 120_000 }, async () => {
    const f = await adminFixture(); const identities = new PostgresAdminIdentityStore(f.database);
    const rbac = new PostgresAdminRbacStore(f.database); const sessions = new PostgresAdminSessionStore(f.database);
    const now = new Date(); const identityId = randomUUID();
    const input = { id: identityId, issuer: 'https://auth.kai.com', subjectHash: h128('a'),
      linkedUserId: null, displayName: 'Reviewer', emailCiphertext: null, emailLookupHash: null, now };
    expect((await identities.createOrGet(input)).created).toBe(true);
    const duplicate = await identities.createOrGet({ ...input, id: randomUUID() });
    expect(duplicate).toMatchObject({ created: false, identity: { id: identityId, status: 'pending' } });
    await expect(rbac.syncOidcRoles({ adminIdentityId: identityId, roles: [],
      groupSnapshotDigest: h128('b'), now })).rejects.toThrow('ADMIN_IDENTITY_ADMISSION_ROLE_REQUIRED');
    expect((await identities.findById(identityId))?.status).toBe('pending');
    await expect(rbac.syncOidcRoles({ adminIdentityId: identityId, roles: [{
      roleCode: 'unknown', sourceReferenceDigest: h128('b'), expiresAt: null,
    }], groupSnapshotDigest: h128('c'), now })).rejects.toThrow('ADMIN_ROLE_UNKNOWN');
    await expect(rbac.syncOidcRoles({ adminIdentityId: identityId, roles: [{
      roleCode: 'resource_reviewer', sourceReferenceDigest: h128('b'), expiresAt: now,
    }], groupSnapshotDigest: h128('c'), now })).rejects.toThrow('ADMIN_OIDC_ROLE_ALREADY_EXPIRED');
    expect((await identities.findById(identityId))?.status).toBe('pending');
    const first = await rbac.syncOidcRoles({ adminIdentityId: identityId, roles: [{
      roleCode: 'resource_reviewer', sourceReferenceDigest: h128('d'), expiresAt: null,
    }], groupSnapshotDigest: h128('e'), now });
    expect(first).toMatchObject({ changed: true, authzVersion: 2, roles: ['resource_reviewer'] });
    expect(await identities.findById(identityId)).toMatchObject({
      status: 'active', authzVersion: 2, groupSnapshotDigest: h128('e'),
    });
    const created = await sessions.create({ id: randomUUID(), adminIdentityId: identityId,
      tokenHash: h128('f'), csrfTokenHash: h128('g'), authzVersionAtIssue: first.authzVersion,
      permissionDefinitionVersion: 'admin-permissions-v1', permissionSnapshotDigest: h128('h'),
      createdAt: now, lastSeenAt: now, idleExpiresAt: new Date(now.getTime()+60_000),
      absoluteExpiresAt: new Date(now.getTime()+600_000), reauthenticatedAt: null,
      createdIpHash: h64('i'), lastIpHash: h64('i'), userAgentHash: h64('j') });
    const changed = await rbac.syncOidcRoles({ adminIdentityId: identityId, roles: [{
      roleCode: 'price_reviewer', sourceReferenceDigest: h128('k'), expiresAt: null,
    }], groupSnapshotDigest: h128('l'), now: new Date(now.getTime()+1_000) });
    expect(changed).toMatchObject({ changed: true, authzVersion: 3,
      roles: ['price_reviewer'], revokedSessionCount: 1 });
    expect(await sessions.findActiveByTokenHash(created.tokenHash, new Date(now.getTime()+2_000))).toBeNull();
    const replacementTime = new Date(now.getTime()+2_000);
    const replacement = await sessions.create({ id: randomUUID(), adminIdentityId: identityId,
      tokenHash: h128('m'), csrfTokenHash: h128('n'), authzVersionAtIssue: 3,
      permissionDefinitionVersion: 'admin-permissions-v1', permissionSnapshotDigest: h128('h'),
      createdAt: replacementTime, lastSeenAt: replacementTime,
      idleExpiresAt: new Date(now.getTime()+60_000), absoluteExpiresAt: new Date(now.getTime()+600_000),
      reauthenticatedAt: null, createdIpHash: h64('i'), lastIpHash: h64('i'), userAgentHash: h64('j') });
    const removed = await rbac.syncOidcRoles({ adminIdentityId: identityId, roles: [],
      groupSnapshotDigest: h128('o'), now: new Date(now.getTime()+3_000) });
    expect(removed).toMatchObject({ changed: true, authzVersion: 4, roles: [], revokedSessionCount: 1 });
    expect((await identities.findById(identityId))?.status).toBe('active');
    expect(await sessions.findActiveByTokenHash(replacement.tokenHash, new Date(now.getTime()+4_000))).toBeNull();
    await f.database.close();
  });

  it('rolls back pending admission when snapshot persistence fails', { timeout: 120_000 }, async () => {
    const f = await adminFixture(); const identities = new PostgresAdminIdentityStore(f.database);
    const rbac = new PostgresAdminRbacStore(f.database); const now = new Date(); const identityId = randomUUID();
    await identities.createOrGet({ id: identityId, issuer: 'issuer', subjectHash: h128('p'), linkedUserId: null,
      displayName: 'Pending', emailCiphertext: null, emailLookupHash: null, now });
    await expect(rbac.syncOidcRoles({ adminIdentityId: identityId, roles: [{
      roleCode: 'audit_viewer', sourceReferenceDigest: h128('q'), expiresAt: null,
    }], groupSnapshotDigest: 'invalid-length', now })).rejects.toThrow();
    expect(await identities.findById(identityId)).toMatchObject({ status: 'pending', authzVersion: 1 });
    expect(await rbac.activeRoles(identityId, now)).toEqual([]);
    await f.database.close();
  });
});

describe('admin session store', () => {
  it('finds only hashes, rotates with a previous-token grace window, and revokes all', { timeout: 120_000 }, async () => {
    const f = await adminFixture(); const identities = new PostgresAdminIdentityStore(f.database);
    const rbac = new PostgresAdminRbacStore(f.database);
    const sessions = new PostgresAdminSessionStore(f.database, { previousTokenGraceMs: 10_000 });
    const now = new Date(); const identityId = randomUUID();
    await identities.createOrGet({ id: identityId, issuer: 'issuer', subjectHash: h128('a'), linkedUserId: null,
      displayName: 'Admin', emailCiphertext: null, emailLookupHash: null, now });
    const admission = await rbac.syncOidcRoles({ adminIdentityId: identityId, roles: [{
      roleCode: 'support_viewer', sourceReferenceDigest: h128('z'), expiresAt: null,
    }], groupSnapshotDigest: h128('y'), now });
    const absolute = new Date(now.getTime()+600_000); const originalHash = h128('b'); const nextHash = h128('c');
    const created = await sessions.create({ id: randomUUID(), adminIdentityId: identityId,
      tokenHash: originalHash, csrfTokenHash: h128('d'), authzVersionAtIssue: admission.authzVersion,
      permissionDefinitionVersion: 'v1', permissionSnapshotDigest: h128('e'), createdAt: now,
      lastSeenAt: now, idleExpiresAt: new Date(now.getTime()+60_000), absoluteExpiresAt: absolute,
      reauthenticatedAt: null, createdIpHash: h64('f'), lastIpHash: h64('f'), userAgentHash: h64('g') });
    expect((await sessions.findActiveByTokenHash(originalHash, new Date(now.getTime()+1_000)))?.id).toBe(created.id);
    const rotated = await sessions.rotate({ sessionId: created.id, currentTokenHash: originalHash,
      nextTokenHash: nextHash, nextCsrfTokenHash: h128('h'),
      lastSeenAt: new Date(now.getTime()+2_000), idleExpiresAt: new Date(now.getTime()+62_000),
      rotatedAt: new Date(now.getTime()+2_000), lastIpHash: h64('i') });
    expect(rotated).toMatchObject({ tokenHash: nextHash, previousTokenHash: originalHash });
    await expect(sessions.rotate({ sessionId: created.id, currentTokenHash: nextHash,
      nextTokenHash: h128('p'), nextCsrfTokenHash: h128('q'),
      lastSeenAt: new Date(now.getTime()+3_000), idleExpiresAt: new Date(now.getTime()+63_000),
      rotatedAt: new Date(now.getTime()+3_000), lastIpHash: h64('r') }))
      .rejects.toThrow('ADMIN_SESSION_ROTATION_GRACE_ACTIVE');
    expect(await sessions.findActiveByTokenHash(originalHash, new Date(now.getTime()+5_000))).not.toBeNull();
    const newerActivity = await sessions.updateActivity({ sessionId: created.id,
      lastSeenAt: new Date(now.getTime()+8_000), idleExpiresAt: new Date(now.getTime()+68_000),
      lastIpHash: h64('q') });
    const staleActivity = await sessions.updateActivity({ sessionId: created.id,
      lastSeenAt: new Date(now.getTime()+6_000), idleExpiresAt: new Date(now.getTime()+66_000),
      lastIpHash: h64('r') });
    expect(newerActivity?.lastSeenAt).toEqual(new Date(now.getTime()+8_000));
    expect(staleActivity?.lastSeenAt).toEqual(new Date(now.getTime()+8_000));
    expect(staleActivity?.idleExpiresAt).toEqual(new Date(now.getTime()+68_000));
    expect(staleActivity?.lastIpHash).toBe(h64('q'));
    expect(await sessions.findActiveByTokenHash(originalHash, new Date(now.getTime()+12_001))).toBeNull();
    expect(await sessions.cleanupExpiredTokenHashes(new Date(now.getTime()+12_001))).toBe(1);
    expect(await sessions.findActiveByTokenHash(nextHash, new Date(now.getTime()+12_001))).not.toBeNull();
    expect(await sessions.revokeAll({ adminIdentityId: identityId, reasonCode: 'LOGOUT_ALL',
      now: new Date(now.getTime()+13_000) })).toBe(1);
    expect((await f.database.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM admin_session_token_hashes WHERE admin_session_id=$1', [created.id],
    )).rows[0]?.count).toBe('1');
    expect(await sessions.findActiveByTokenHash(nextHash, new Date(now.getTime()+14_000))).toBeNull();
    const serialized = JSON.stringify(rotated);
    expect(serialized).not.toContain('raw-session-token');
    expect(serialized).not.toContain('raw-csrf-token');
    expect(serialized).not.toContain('raw-oidc-sub');
    expect(serialized).not.toContain('raw-group-claim');
    await f.database.close();
  });

  it('requires an active current role and bounds rotation grace by policy and absolute expiry', { timeout: 120_000 }, async () => {
    const f = await adminFixture(); const identities = new PostgresAdminIdentityStore(f.database);
    const rbac = new PostgresAdminRbacStore(f.database); const now = new Date(); const identityId = randomUUID();
    const base = { id: randomUUID(), adminIdentityId: identityId, tokenHash: h128('a'),
      csrfTokenHash: h128('b'), authzVersionAtIssue: 1, permissionDefinitionVersion: 'v1',
      permissionSnapshotDigest: h128('c'), createdAt: now, lastSeenAt: now,
      idleExpiresAt: new Date(now.getTime()+60_000), absoluteExpiresAt: new Date(now.getTime()+600_000),
      reauthenticatedAt: null, createdIpHash: h64('d'), lastIpHash: h64('d'), userAgentHash: h64('e') };
    await identities.createOrGet({ id: identityId, issuer: 'issuer', subjectHash: h128('f'), linkedUserId: null,
      displayName: 'Admin', emailCiphertext: null, emailLookupHash: null, now });
    const sessions = new PostgresAdminSessionStore(f.database);
    await expect(sessions.create(base)).rejects.toThrow('ADMIN_IDENTITY_AUTHZ_NOT_ACTIVE');
    const admitted = await rbac.syncOidcRoles({ adminIdentityId: identityId, roles: [{
      roleCode: 'support_viewer', sourceReferenceDigest: h128('g'), expiresAt: null,
    }], groupSnapshotDigest: h128('h'), now });
    const versioned = { ...base, authzVersionAtIssue: admitted.authzVersion };
    await f.database.query(`UPDATE admin_role_assignments SET status='revoked', revoked_at=$2,
      revocation_reason_code='TEST_SETUP' WHERE admin_identity_id=$1 AND status='active'`, [identityId,now]);
    await expect(sessions.create(versioned)).rejects.toThrow('ADMIN_IDENTITY_AUTHZ_NOT_ACTIVE');
    await f.database.query(`INSERT INTO admin_role_assignments(id,admin_identity_id,role_code,source,
      source_reference_digest,status,valid_from,created_at) VALUES ($1,$2,'support_viewer','oidc',$3,'active',$4,$5)`,
    [randomUUID(),identityId,h128('i'),new Date(now.getTime()+60_000),now]);
    await expect(sessions.create(versioned)).rejects.toThrow('ADMIN_IDENTITY_AUTHZ_NOT_ACTIVE');
    await f.database.query(`INSERT INTO admin_role_assignments(id,admin_identity_id,role_code,source,
      source_reference_digest,status,valid_from,expires_at,created_at)
      VALUES ($1,$2,'audit_viewer','oidc',$3,'active',$4,$5,$4)`,
    [randomUUID(),identityId,h128('j'),new Date(now.getTime()-120_000),new Date(now.getTime()-60_000)]);
    await expect(sessions.create(versioned)).rejects.toThrow('ADMIN_IDENTITY_AUTHZ_NOT_ACTIVE');
    await f.database.query(`INSERT INTO admin_role_assignments(id,admin_identity_id,role_code,source,
      source_reference_digest,status,valid_from,created_at) VALUES ($1,$2,'audit_viewer','oidc',$3,'active',$4,$4)`,
    [randomUUID(),identityId,h128('k'),now]);
    const shortAbsolute = new Date(now.getTime()+20_000);
    const created = await sessions.create({ ...versioned, id: randomUUID(), tokenHash: h128('l'),
      absoluteExpiresAt: shortAbsolute, idleExpiresAt: shortAbsolute });
    const rotatedAt = new Date(now.getTime()+5_000);
    const rotated = await sessions.rotate({ sessionId: created.id, currentTokenHash: created.tokenHash,
      nextTokenHash: h128('m'), nextCsrfTokenHash: h128('n'), lastSeenAt: rotatedAt,
      idleExpiresAt: shortAbsolute, rotatedAt, lastIpHash: h64('o') });
    expect(rotated?.previousTokenValidUntil).toEqual(shortAbsolute);
    for (const previousTokenGraceMs of [-1,0,30_001,Number.MAX_SAFE_INTEGER+1]) {
      expect(() => new PostgresAdminSessionStore(f.database, { previousTokenGraceMs })).toThrow(
        'ADMIN_SESSION_ROTATION_GRACE_INVALID',
      );
    }
    await f.database.close();
  });
});

describe('admin login transaction store', () => {
  it('does not consume on binding mismatch, consumes once, and rejects expiry', { timeout: 120_000 }, async () => {
    const f = await adminFixture(); const store = new PostgresAdminLoginTransactionStore(f.database);
    const now = new Date(); const stateHash = h128('a'); const bindingHash = h128('b');
    await store.create({ id: randomUUID(), stateHash, browserBindingHash: bindingHash, nonceHash: h128('c'),
      pkceVerifierCiphertext: 'encrypted-verifier', returnPath: '/orders',
      expiresAt: new Date(now.getTime()+60_000), createdIpHash: h64('d'), userAgentHash: h64('e'), createdAt: now });
    expect(await store.consume({ stateHash, browserBindingHash: h128('f'), now })).toEqual({ status: 'binding_mismatch' });
    expect((await store.consume({ stateHash, browserBindingHash: bindingHash, now })).status).toBe('consumed');
    expect(await store.consume({ stateHash, browserBindingHash: bindingHash, now })).toEqual({ status: 'unavailable' });
    expect(await store.fail({ transactionId: (await f.database.query<{ id: string }>(
      'SELECT id FROM admin_login_transactions WHERE state_hash=$1', [stateHash],
    )).rows[0]!.id, failureCode: 'OIDC_EXCHANGE_FAILED', now })).toBe(true);
    const expiredState = h128('g');
    await store.create({ id: randomUUID(), stateHash: expiredState, browserBindingHash: h128('h'), nonceHash: h128('i'),
      pkceVerifierCiphertext: 'encrypted-verifier', returnPath: '/', expiresAt: new Date(now.getTime()+1),
      createdIpHash: h64('j'), userAgentHash: h64('k'), createdAt: now });
    expect(await store.consume({ stateHash: expiredState, browserBindingHash: h128('h'),
      now: new Date(now.getTime()+2) })).toEqual({ status: 'expired' });
    await f.database.close();
  });
});
