import type { LegalDocuments } from './api';
import type { CloudPayUser } from './session';

export class KaiPlatformResponseError extends Error {
  readonly name = 'KaiPlatformResponseError';
  constructor() { super('Zod 平台返回的账号数据无法安全确认，请稍后重试。'); }
}

export type KaiLegalBootstrap = Readonly<{
  operator: Readonly<{ legalEntityName: string }>;
  documents: LegalDocuments;
}>;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new KaiPlatformResponseError();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort(); const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    throw new KaiPlatformResponseError();
  }
}

function nullableText(value: unknown, maximum: number) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > maximum) throw new KaiPlatformResponseError();
  return value;
}

function legalDocument(value: unknown, requireUrl: boolean) {
  const document = record(value);
  exactKeys(document, ['version', 'url']);
  if (typeof document.version !== 'string' || !document.version.trim()
    || document.version !== document.version.trim() || document.version.length > 40) {
    throw new KaiPlatformResponseError();
  }
  if (document.url === null && !requireUrl) return { version: document.version, url: null };
  if (typeof document.url !== 'string' || document.url.length > 2_048) throw new KaiPlatformResponseError();
  try {
    const url = new URL(document.url);
    if (url.protocol !== 'https:' || url.username || url.password) throw new KaiPlatformResponseError();
  } catch { throw new KaiPlatformResponseError(); }
  return { version: document.version, url: document.url };
}

export function decodeKaiPlatformProfile(value: unknown): CloudPayUser {
  const response = record(value); exactKeys(response, ['ok', 'user']);
  const user = record(response.user); exactKeys(user, ['id', 'displayName', 'phone', 'email', 'role', 'status', 'createdAt']);
  if (response.ok !== true || typeof user.id !== 'string' || !user.id.trim() || user.id.length > 200
    || typeof user.displayName !== 'string' || !user.displayName.trim() || user.displayName.length > 100
    || typeof user.role !== 'string' || !['member', 'supplier', 'operator', 'admin'].includes(user.role)
    || typeof user.status !== 'string'
    || !['pending', 'active', 'suspended', 'deletion_pending', 'anonymized'].includes(user.status)
    || typeof user.createdAt !== 'string' || !Number.isFinite(Date.parse(user.createdAt))) {
    throw new KaiPlatformResponseError();
  }
  return {
    id: user.id, displayName: user.displayName, phone: nullableText(user.phone, 100),
    email: nullableText(user.email, 320), role: user.role as CloudPayUser['role'],
    status: user.status as CloudPayUser['status'], createdAt: user.createdAt,
  };
}

export function decodeKaiPlatformLegalBootstrap(value: unknown): KaiLegalBootstrap {
  const response = record(value); exactKeys(response, ['ok', 'operator', 'documents']);
  const operator = record(response.operator); exactKeys(operator, ['legalEntityName']);
  const documents = record(response.documents); exactKeys(documents, ['terms', 'privacy', 'inquiry']);
  if (response.ok !== true || typeof operator.legalEntityName !== 'string'
    || !operator.legalEntityName || operator.legalEntityName !== operator.legalEntityName.trim()
    || operator.legalEntityName.length > 200
    || /[\u0000-\u001f\u007f-\u009f]/u.test(operator.legalEntityName)) {
    throw new KaiPlatformResponseError();
  }
  return { operator: { legalEntityName: operator.legalEntityName }, documents: {
    terms: legalDocument(documents.terms, true),
    privacy: legalDocument(documents.privacy, true),
    inquiry: legalDocument(documents.inquiry, false),
  } };
}

export function decodeKaiPlatformLegal(value: unknown): LegalDocuments {
  return decodeKaiPlatformLegalBootstrap(value).documents;
}

export function decodeKaiPlatformConsent(value: unknown, documents: LegalDocuments) {
  const response = record(value); exactKeys(response, ['ok', 'accepted', 'replayed']);
  const accepted = record(response.accepted); exactKeys(accepted, ['termsVersion', 'privacyVersion']);
  if (response.ok !== true || typeof response.replayed !== 'boolean'
    || accepted.termsVersion !== documents.terms.version
    || accepted.privacyVersion !== documents.privacy.version) throw new KaiPlatformResponseError();
  return { replayed: response.replayed };
}
