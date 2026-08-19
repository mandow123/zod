import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import type { Database } from '../database.js';
import { secretHash } from '../account/crypto.js';
import { isAdminRoleCode, stableAdminPermissionSnapshot } from './permissions.js';
import type { AdminAuditEvent, AdminAuditMetadata, AdminAuditOutcome } from './types.js';

type AuditRow = QueryResultRow & {
  id: string; occurred_at: Date; admin_identity_id: string | null; admin_session_id: string | null;
  effective_permissions: unknown; permission_snapshot_digest: string; action: string;
  target_type: string | null; target_id: string | null; request_id: string;
  ticket_reference: string | null; reason_code: string | null; reason_digest: string | null;
  idempotency_key_hash: string | null; before_state_digest: string | null; after_state_digest: string | null;
  ip_hash: string | null; user_agent_hash: string | null; outcome: AdminAuditOutcome;
  error_code: string | null; sensitive_access: boolean; metadata: unknown;
};
const columns = `id, occurred_at, admin_identity_id, admin_session_id, effective_permissions,
 permission_snapshot_digest, action, target_type, target_id, request_id, ticket_reference,
 reason_code, reason_digest, idempotency_key_hash, before_state_digest, after_state_digest,
 ip_hash, user_agent_hash, outcome, error_code, sensitive_access, metadata`;
function jsonValue(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) as unknown : value;
}
const metadataKeys = new Set(['roleCodes','revokedSessionCount','status','failureCode','source','changed']);
const statusCodePattern = /^[a-z0-9][a-z0-9_.:-]{0,79}$/u;
const failureCodePattern = /^[A-Z0-9_]{1,80}$/u;
function checkedMetadata(value: unknown): AdminAuditMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ADMIN_AUDIT_METADATA_INVALID');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !metadataKeys.has(key))) throw new Error('ADMIN_AUDIT_METADATA_UNKNOWN_FIELD');
  if (record.roleCodes !== undefined && (!Array.isArray(record.roleCodes)
      || !record.roleCodes.every((role) => typeof role === 'string'))) throw new Error('ADMIN_AUDIT_METADATA_INVALID');
  if (record.revokedSessionCount !== undefined && (!Number.isSafeInteger(record.revokedSessionCount)
      || (record.revokedSessionCount as number) < 0)) throw new Error('ADMIN_AUDIT_METADATA_INVALID');
  if (record.status !== undefined && (typeof record.status !== 'string'
      || !statusCodePattern.test(record.status))) throw new Error('ADMIN_AUDIT_METADATA_INVALID');
  if (record.failureCode !== undefined && (typeof record.failureCode !== 'string'
      || !failureCodePattern.test(record.failureCode))) throw new Error('ADMIN_AUDIT_METADATA_INVALID');
  if (record.source !== undefined && !['oidc','manual','system'].includes(String(record.source))) {
    throw new Error('ADMIN_AUDIT_METADATA_INVALID');
  }
  if (record.changed !== undefined && typeof record.changed !== 'boolean') throw new Error('ADMIN_AUDIT_METADATA_INVALID');
  return Object.freeze({
    ...(record.roleCodes === undefined ? {} : {
      roleCodes: Object.freeze([...new Set(record.roleCodes.map((role) => requireRoleMetadata(role)))].sort()),
    }),
    ...(record.revokedSessionCount === undefined ? {} : { revokedSessionCount: record.revokedSessionCount as number }),
    ...(record.status === undefined ? {} : { status: record.status as string }),
    ...(record.failureCode === undefined ? {} : { failureCode: record.failureCode as string }),
    ...(record.source === undefined ? {} : { source: record.source as 'oidc' | 'manual' | 'system' }),
    ...(record.changed === undefined ? {} : { changed: record.changed as boolean }),
  });
}
function requireRoleMetadata(value: unknown) {
  if (!isAdminRoleCode(value)) throw new Error('ADMIN_AUDIT_METADATA_INVALID');
  return value;
}
function map(row: AuditRow): AdminAuditEvent {
  const permissions = jsonValue(row.effective_permissions);
  if (!Array.isArray(permissions) || !permissions.every((item) => typeof item === 'string')) {
    throw new Error('ADMIN_AUDIT_PERMISSION_SNAPSHOT_INVALID');
  }
  const metadata = checkedMetadata(jsonValue(row.metadata));
  return { id: row.id, occurredAt: row.occurred_at, adminIdentityId: row.admin_identity_id,
    adminSessionId: row.admin_session_id, effectivePermissions: stableAdminPermissionSnapshot(permissions),
    permissionSnapshotDigest: row.permission_snapshot_digest, action: row.action,
    targetType: row.target_type, targetId: row.target_id, requestId: row.request_id,
    ticketReference: row.ticket_reference, reasonCode: row.reason_code, reasonDigest: row.reason_digest,
    idempotencyKeyHash: row.idempotency_key_hash, beforeStateDigest: row.before_state_digest,
    afterStateDigest: row.after_state_digest, ipHash: row.ip_hash, userAgentHash: row.user_agent_hash,
    outcome: row.outcome, errorCode: row.error_code, sensitiveAccess: row.sensitive_access,
    metadata };
}
export type AppendAdminAuditEvent = Readonly<Omit<AdminAuditEvent,
  'id' | 'effectivePermissions' | 'permissionSnapshotDigest'> & {
  id?: string; effectivePermissions: readonly string[];
}>;
export interface AdminAuditStore {
  append(input: AppendAdminAuditEvent): Promise<AdminAuditEvent>;
  recent(limit: number): Promise<readonly AdminAuditEvent[]>;
  forTarget(targetType: string, targetId: string, limit: number): Promise<readonly AdminAuditEvent[]>;
}
function checkedLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('ADMIN_AUDIT_LIMIT_INVALID');
  return limit;
}
export class PostgresAdminAuditStore implements AdminAuditStore {
  constructor(private readonly database: Database, private readonly auditPepper: string) {
    if (auditPepper.length < 32) throw new Error('ADMIN_AUDIT_PEPPER_INVALID');
  }
  async append(input: AppendAdminAuditEvent) {
    const permissions = stableAdminPermissionSnapshot(input.effectivePermissions);
    const permissionSnapshotDigest = secretHash(JSON.stringify(permissions), this.auditPepper);
    const metadata = checkedMetadata(input.metadata);
    const result = await this.database.query<AuditRow>(
      `INSERT INTO admin_audit_events(${columns}) VALUES
       ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb)
       RETURNING ${columns}`,
      [input.id ?? randomUUID(),input.occurredAt,input.adminIdentityId,input.adminSessionId,
        JSON.stringify(permissions),permissionSnapshotDigest,input.action,input.targetType,input.targetId,
        input.requestId,input.ticketReference,input.reasonCode,input.reasonDigest,input.idempotencyKeyHash,
        input.beforeStateDigest,input.afterStateDigest,input.ipHash,input.userAgentHash,input.outcome,
        input.errorCode,input.sensitiveAccess,JSON.stringify(metadata)],
    );
    return map(result.rows[0]!);
  }
  async recent(limit: number) {
    const result = await this.database.query<AuditRow>(
      `SELECT ${columns} FROM admin_audit_events ORDER BY occurred_at DESC, id DESC LIMIT $1`,
      [checkedLimit(limit)],
    );
    return result.rows.map(map);
  }
  async forTarget(targetType: string, targetId: string, limit: number) {
    const result = await this.database.query<AuditRow>(
      `SELECT ${columns} FROM admin_audit_events WHERE target_type = $1 AND target_id = $2
       ORDER BY occurred_at DESC, id DESC LIMIT $3`, [targetType,targetId,checkedLimit(limit)],
    );
    return result.rows.map(map);
  }
}
