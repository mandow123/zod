import { createHash } from 'node:crypto';
import { generateOpaqueToken, secretHash } from '../account/crypto.js';
import { AppError } from '../errors.js';
import { isAdminRoleCode, type AdminRoleCode } from './permissions.js';

export const ADMIN_SESSION_COOKIE = '__Host-kai_admin_session';
export const ADMIN_LOGIN_BINDING_COOKIE = '__Host-kai_admin_login';
export const ADMIN_PERMISSION_DEFINITION_VERSION = 'admin-permissions-v1';

const controlCharacters = /[\u0000-\u001f\u007f]/u;
const cookieNamePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const cookieValuePattern = /^[A-Za-z0-9_-]{32,256}$/u;

export function canonicalReturnPath(value: unknown): string {
  const candidate = typeof value === 'string' && value ? value : '/';
  if (candidate.length > 500 || !candidate.startsWith('/') || candidate.startsWith('//')
    || candidate.includes('\\') || candidate.includes('#') || controlCharacters.test(candidate)) {
    throw new AppError('ADMIN_RETURN_PATH_INVALID', 400, '管理员返回地址无效。');
  }
  return candidate;
}

export function parseCookieHeader(header: string | undefined): Readonly<Record<string, string>> {
  if (!header) return Object.freeze({});
  if (header.length > 8_192) throw new AppError('ADMIN_COOKIE_INVALID', 400, '管理员登录信息无效。');
  const result: Record<string, string> = {};
  const entries = header.split(';');
  if (entries.length > 32) throw new AppError('ADMIN_COOKIE_INVALID', 400, '管理员登录信息无效。');
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    if (separator < 1) continue;
    const name = entry.slice(0, separator).trim();
    const rawValue = entry.slice(separator + 1);
    const value = rawValue;
    if (!cookieNamePattern.test(name) || value.length > 512 || value !== value.trim()
      || controlCharacters.test(value) || result[name] !== undefined) {
      throw new AppError('ADMIN_COOKIE_INVALID', 400, '管理员登录信息无效。');
    }
    result[name] = value;
  }
  return Object.freeze(result);
}

export function requireOpaqueCookie(value: string | undefined): string {
  if (!value || !cookieValuePattern.test(value)) {
    throw new AppError('ADMIN_AUTH_REQUIRED', 401, '请先登录管理员后台。');
  }
  return value;
}

export function serializeHostCookie(name: string, value: string, maxAgeSeconds: number): string {
  if (![ADMIN_SESSION_COOKIE, ADMIN_LOGIN_BINDING_COOKIE].includes(name)
    || !cookieValuePattern.test(value) || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 1) {
    throw new Error('ADMIN_COOKIE_SERIALIZATION_INVALID');
  }
  return `${name}=${value}; Path=/; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=Lax`;
}

export function clearHostCookie(name: string): string {
  if (![ADMIN_SESSION_COOKIE, ADMIN_LOGIN_BINDING_COOKIE].includes(name)) {
    throw new Error('ADMIN_COOKIE_SERIALIZATION_INVALID');
  }
  return `${name}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
}

export function newPkce(): Readonly<{ verifier: string; challenge: string }> {
  const verifier = generateOpaqueToken();
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return Object.freeze({ verifier, challenge });
}

export function canonicalGroupClaim(value: unknown): readonly string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > 128) {
    throw new AppError('ADMIN_OIDC_GROUP_CLAIM_INVALID', 403, '管理员账户未获得授权。');
  }
  const groups = value.map((group) => {
    if (typeof group !== 'string' || group.length < 1 || group.length > 256
      || group !== group.trim() || controlCharacters.test(group)) {
      throw new AppError('ADMIN_OIDC_GROUP_CLAIM_INVALID', 403, '管理员账户未获得授权。');
    }
    return group;
  });
  return Object.freeze([...new Set(groups)].sort());
}

export function authoritativeGroups(
  idTokenClaim: unknown,
  userInfoClaim: unknown,
): readonly string[] {
  const idTokenGroups = canonicalGroupClaim(idTokenClaim);
  const userInfoGroups = canonicalGroupClaim(userInfoClaim);
  if (!idTokenGroups && !userInfoGroups) {
    throw new AppError('ADMIN_OIDC_GROUP_CLAIM_MISSING', 403, '管理员账户未获得授权。');
  }
  if (idTokenGroups && userInfoGroups
    && (idTokenGroups.length !== userInfoGroups.length
      || idTokenGroups.some((group, index) => group !== userInfoGroups[index]))) {
    throw new AppError('ADMIN_OIDC_GROUP_CLAIM_MISMATCH', 403, '管理员账户未获得授权。');
  }
  return idTokenGroups ?? userInfoGroups!;
}

type VerifiedEmailSource = Readonly<{
  email: string | null;
  emailVerified: boolean;
}>;

function canonicalVerifiedEmail(source: VerifiedEmailSource): string | null {
  if (!source.emailVerified || !source.email) return null;
  const email = source.email.toLowerCase();
  if (email !== source.email || email.length > 320 || controlCharacters.test(email)
    || !/^[^\s@]+@[^\s@]+$/u.test(email)) {
    throw new AppError('ADMIN_OIDC_EMAIL_CLAIM_INVALID', 403, '管理员账户未获得授权。');
  }
  return email;
}

/**
 * KAI Auth does not currently publish an application-specific Group claim.
 * An operator may explicitly select the standard `email` claim instead, but
 * only as a verified, exact, lower-case allowlist. The normal Group contract
 * remains unchanged for every other configured claim name.
 */
export function authoritativeOidcAuthorizationValues(
  claimName: string,
  idTokenClaim: unknown,
  userInfoClaim: unknown,
  idTokenIdentity: VerifiedEmailSource,
  userInfoProfile: VerifiedEmailSource,
): readonly string[] {
  if (claimName !== 'email') return authoritativeGroups(idTokenClaim, userInfoClaim);
  const idTokenEmail = canonicalVerifiedEmail(idTokenIdentity);
  const userInfoEmail = canonicalVerifiedEmail(userInfoProfile);
  if (!idTokenEmail || !userInfoEmail) {
    throw new AppError('ADMIN_OIDC_EMAIL_NOT_VERIFIED', 403, '管理员账户未获得授权。');
  }
  if (idTokenClaim !== idTokenIdentity.email || userInfoClaim !== userInfoProfile.email
    || idTokenEmail !== userInfoEmail) {
    throw new AppError('ADMIN_OIDC_EMAIL_CLAIM_MISMATCH', 403, '管理员账户未获得授权。');
  }
  return Object.freeze([idTokenEmail]);
}

export function mappedOidcRoles(
  groups: readonly string[],
  mappings: readonly Readonly<{ group: string; roleCode: AdminRoleCode }>[],
  groupPepper: string,
): readonly Readonly<{ roleCode: AdminRoleCode; sourceReferenceDigest: string; expiresAt: null }>[] {
  const groupSet = new Set(groups);
  return Object.freeze(mappings.filter((mapping) => groupSet.has(mapping.group)).map((mapping) => {
    if (!isAdminRoleCode(mapping.roleCode)) throw new Error('ADMIN_ROLE_UNKNOWN');
    return Object.freeze({
      roleCode: mapping.roleCode,
      sourceReferenceDigest: secretHash(`oidc-group:${mapping.group}`, groupPepper),
      expiresAt: null,
    });
  }));
}

export function stableGroupSnapshotDigest(groups: readonly string[], groupPepper: string): string {
  return secretHash(JSON.stringify([...new Set(groups)].sort()), groupPepper);
}
