import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../dist/config.js';
import { createDatabase } from '../dist/database.js';
import { databaseFingerprint } from '../dist/backups/postgres.js';
import { probeEvidenceDigest } from '../dist/operations/probe-evidence.js';

const SCHEMA = '0066_compute_data_flywheel_v1.sql';
const PRODUCER = 'record-inquiry-readiness.mjs@2';
const HONGHUAN_RESOURCE_IDS = [
  'gpu-honghuan-a100-sxm4-80gb-1', 'gpu-honghuan-a100-sxm4-80gb-2',
  'gpu-honghuan-h100-sxm-80gb-1', 'gpu-honghuan-h100-sxm-80gb-2',
  'gpu-honghuan-h200-nvl-1', 'gpu-honghuan-h200-nvl-2',
  'gpu-honghuan-b200-179gb-1', 'gpu-honghuan-b200-179gb-2', 'gpu-honghuan-b200-179gb-4',
  'gpu-honghuan-b300-269gb-1', 'server-honghuan-b300-monthly-32plus',
];

function required(value, name) {
  if (!value?.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function safeOrigin(value, publicOrigin, scope) {
  const url = new URL(value);
  if (scope === 'private_sidecar') {
    if (url.href !== 'http://172.31.31.78:4154/') throw new Error('PRIVATE_INQUIRY_PROBE_ORIGIN_INVALID');
  } else if (url.protocol !== 'https:' || url.origin !== new URL(publicOrigin).origin) {
    throw new Error('INQUIRY_READINESS_PROBE_ORIGIN must exactly match the HTTPS PUBLIC_ORIGIN.');
  }
  return url.origin;
}

async function requestJson(origin, path, init = {}, accepted = [200]) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(new URL(path, origin), {
      ...init, redirect: 'error', signal: controller.signal,
      headers: { accept: 'application/json', ...(init.headers ?? {}) },
    });
    const text = await response.text();
    let value;
    try { value = JSON.parse(text); } catch { throw new Error(`READINESS_HTTP_INVALID_JSON:${path}:${response.status}`); }
    if (!accepted.includes(response.status) || value?.ok !== true) {
      throw new Error(`READINESS_HTTP_FAILED:${path}:${response.status}:${String(value?.error?.code ?? 'UNKNOWN').slice(0, 80)}`);
    }
    return value;
  } finally {
    clearTimeout(timeout);
  }
}

async function commerceSnapshot(database) {
  const result = await database.query(`SELECT
    (SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'' ORDER BY id),'')) FROM orders t) AS orders,
    (SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'' ORDER BY id),'')) FROM capacity_reservations t) AS reservations,
    (SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'' ORDER BY id),'')) FROM kai_credit_orders t) AS kai_orders,
    (SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'' ORDER BY id),'')) FROM kai_credit_order_reservations t) AS kai_order_reservations,
    (SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'' ORDER BY id),'')) FROM physical_device_orders t) AS device_orders,
    (SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'' ORDER BY id),'')) FROM vast_external_orders t) AS vast_orders,
    (SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'' ORDER BY id),'')) FROM kai_credit_accounts t) AS kai_accounts,
    (SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'' ORDER BY id),'')) FROM kai_credit_transactions t) AS kai_transactions,
    (SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'' ORDER BY id),'')) FROM kai_credit_entries t) AS kai_entries,
    (SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'' ORDER BY id),'')) FROM creator_commission_orders t) AS legacy_reward_orders,
    (SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'' ORDER BY id),'')) FROM creator_commission_accounts t) AS legacy_reward_accounts,
    (SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'' ORDER BY id),'')) FROM creator_commission_transactions t) AS legacy_reward_transactions,
    (SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'' ORDER BY id),'')) FROM creator_commission_entries t) AS legacy_reward_entries,
    (SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'' ORDER BY id),'')) FROM streamer_commission_orders t) AS streamer_reward_orders,
    (SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'' ORDER BY id),'')) FROM invite_reward_orders t) AS invite_reward_orders,
    (SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'' ORDER BY id),'')) FROM reward_accounts t) AS reward_accounts,
    (SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'' ORDER BY id),'')) FROM reward_transactions t) AS reward_transactions,
    (SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'' ORDER BY id),'')) FROM reward_entries t) AS reward_entries`);
  const row = result.rows[0];
  if (!row) throw new Error('COMMERCE_SNAPSHOT_EMPTY');
  return digest(JSON.stringify(row));
}

async function recordAudit(database, pepper, action, probeId, metadata) {
  await database.transaction(async (client) => {
    await client.query(
      `INSERT INTO audit_events(id,actor_id,actor_kind,action,entity_type,entity_id,payload_digest,metadata)
       VALUES($1,NULL,'system',$2,'PRODUCTION_READINESS_PROBE',$3,$4,$5::jsonb)`,
      [randomUUID(), action, probeId, probeEvidenceDigest(metadata, pepper), JSON.stringify(metadata)],
    );
  });
}

export async function runInquiryReadinessProbe(input) {
  const config = loadConfig(input.environment ?? process.env);
  if (config.NODE_ENV !== 'production' || config.mobileApiProfile !== 'inquiry_only') {
    throw new Error('Readiness evidence may only be recorded for production inquiry_only.');
  }
  const databaseUrl = required(config.DATABASE_URL, 'DATABASE_URL');
  const auditPepper = required(config.AUDIT_PEPPER, 'AUDIT_PEPPER');
  const accessToken = required(input.accessToken, 'accessToken');
  const idToken = required(input.idToken, 'idToken');
  const probeSubjectSha256 = required(input.probeSubjectSha256, 'probeSubjectSha256');
  if (!/^[0-9a-f]{64}$/u.test(probeSubjectSha256)) throw new Error('KAI_PROBE_SUBJECT_DIGEST_INVALID');
  const probeScope = input.probeScope === 'private_sidecar' ? 'private_sidecar' : 'public_origin';
  const origin = safeOrigin(required(input.probeOrigin, 'probeOrigin'), config.PUBLIC_ORIGIN, probeScope);
  const originHeaders = probeScope === 'private_sidecar'
    ? { host: 'cloudpay.kai.com', 'x-forwarded-host': 'cloudpay.kai.com', 'x-forwarded-proto': 'https' } : {};
  const request = (path, init = {}, accepted = [200]) => requestJson(origin, path, {
    ...init, headers: { ...originHeaders, ...(init.headers ?? {}) },
  }, accepted);
  const database = createDatabase(config);
  if (!database) throw new Error('Inquiry readiness database is incomplete.');
  const probeId = randomUUID();
  const dbFingerprint = databaseFingerprint(databaseUrl);
  const authHeaders = { authorization: `Bearer ${accessToken}`, 'x-kai-id-token': idToken };
  try {
  const schema = await database.schemaReadiness();
  if (!schema.ready || schema.applied !== SCHEMA || schema.expected !== SCHEMA) throw new Error('DATABASE_SCHEMA_0066_REQUIRED');

  const before = await commerceSnapshot(database);
  await request('/mobile/v1/me', { headers: authHeaders });
  const legal = await request('/mobile/v1/legal');
  const termsVersion = required(legal?.documents?.terms?.version, 'legal.documents.terms.version');
  const privacyVersion = required(legal?.documents?.privacy?.version, 'legal.documents.privacy.version');
  const inquiryVersion = required(legal?.documents?.inquiry?.version, 'legal.documents.inquiry.version');
  await request('/mobile/v1/auth/kai/consents', {
    method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ termsVersion, privacyVersion, attemptId: randomUUID() }),
  }, [200, 201]);
  const subjects = await request('/mobile/v1/subjects', { headers: authHeaders });
  const subjectId = subjects.currentSubjectId ?? subjects.subjects?.find((item) => item?.status === 'active')?.id;
  if (typeof subjectId !== 'string') throw new Error('READINESS_ACTIVE_SUBJECT_REQUIRED');
  await request('/mobile/v1/me/current-subject', {
    method: 'PUT', headers: { ...authHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ subjectId }),
  });
  const catalog = await request('/mobile/v1/supplier-inquiry-catalog?limit=50');
  if (!Array.isArray(catalog.items) || catalog.items.length !== 11 || catalog.nextCursor !== null
    || JSON.stringify(catalog.items.map((candidate) => candidate?.resourceId).sort())
      !== JSON.stringify([...HONGHUAN_RESOURCE_IDS].sort())
    || catalog.items.filter((candidate) => candidate?.catalogKind === 'hourly_gpu').length !== 10
    || catalog.items.filter((candidate) => candidate?.catalogKind === 'contract_monthly').length !== 1) {
    throw new Error('READINESS_FORMAL_CATALOG_MANIFEST_INVALID');
  }
  for (const catalogItem of catalog.items) {
    const detail = await request(
      `/mobile/v1/supplier-inquiry-catalog/${encodeURIComponent(catalogItem.resourceId)}`);
    if (detail?.item?.resourceId !== catalogItem.resourceId || detail?.item?.catalogKind !== catalogItem.catalogKind) {
      throw new Error('READINESS_FORMAL_CATALOG_DETAIL_MISMATCH');
    }
  }
  const item = catalog.items.find((candidate) => candidate.catalogKind === 'hourly_gpu');
  if (!item?.resourceId || !Number.isInteger(item.version) || item.catalogKind !== 'hourly_gpu') {
    throw new Error('READINESS_FORMAL_CATALOG_ITEM_REQUIRED');
  }
  const now = Date.now();
  const startsAt = new Date(now + 72 * 60 * 60_000).toISOString();
  const endsAt = new Date(now + 80 * 60 * 60_000).toISOString();
  const confirmBy = new Date(now + 24 * 60 * 60_000).toISOString();
  const created = await request('/mobile/v1/resource-inquiries', {
    method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json', 'idempotency-key': `readiness-create-${randomUUID()}` },
    body: JSON.stringify({
      supplierResourceId: item.resourceId, supplierResourceVersion: item.version, quantity: 1,
      startsAt, endsAt, timeZone: 'Asia/Shanghai', confirmBy, billingMode: 'hourly', allowSubstitutes: false,
      maxCreditAmount: '1000000.00', useCase: 'research',
      description: '生产就绪探针专用询期，完成统一身份、主体隔离及零交易写入验证后立即取消。',
      environment: 'container', network: 'private_network', storageGiB: 256, dataRegion: '中国大陆·华东',
      terms: { termsVersion, privacyVersion, inquiryVersion },
    }),
  }, [200, 201]);
  const inquiryId = created?.inquiry?.id;
  const inquiryVersionValue = created?.inquiry?.version;
  if (typeof inquiryId !== 'string' || !Number.isInteger(inquiryVersionValue)) throw new Error('READINESS_INQUIRY_RESPONSE_INVALID');
  await request(`/mobile/v1/resource-inquiries/${encodeURIComponent(inquiryId)}/cancel`, {
    method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json', 'idempotency-key': `readiness-cancel-${randomUUID()}` },
    body: JSON.stringify({ expectedVersion: inquiryVersionValue }),
  });
  const after = await commerceSnapshot(database);
  if (after !== before) throw new Error('INQUIRY_READINESS_COMMERCE_MUTATION_DETECTED');

  const kaiMetadata = {
    profile: 'inquiry_only', probeVersion: 1, producer: PRODUCER, schemaVersion: SCHEMA, probeScope,
    databaseFingerprint: dbFingerprint, publicOrigin: config.PUBLIC_ORIGIN, probeOrigin: origin,
    probeSubjectSha256,
    me: true, legal: true, consent: true, subjects: true, catalogSchema: SCHEMA,
    catalogCount: 11, hourlyCatalogCount: 10, contractCatalogCount: 1, catalogDetails: 11, jsonOnly: true,
    subjectSelection: true, formalInquiry: true, cancel: true, commerceUnchanged: true, commerceStateDigest: after,
  };
  await recordAudit(database, auditPepper, probeScope === 'private_sidecar'
    ? 'INQUIRY_ONLY_PRIVATE_SIDECAR_ACCEPTANCE_PASSED' : 'INQUIRY_ONLY_KAI_PAIRED_PROBE_PASSED', probeId, kaiMetadata);
    return { ok: true, profile: 'inquiry_only', probeId, schemaVersion: SCHEMA,
      kaiPaired: { ready: true }, commerceUnchanged: true, recordedAt: new Date().toISOString() };
  } finally { await database.close(); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const result = await runInquiryReadinessProbe({
    accessToken: process.env.INQUIRY_READINESS_ACCESS_TOKEN,
    idToken: process.env.INQUIRY_READINESS_ID_TOKEN,
    probeSubjectSha256: process.env.INQUIRY_READINESS_SUBJECT_SHA256,
    probeOrigin: process.env.INQUIRY_READINESS_PROBE_ORIGIN,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
