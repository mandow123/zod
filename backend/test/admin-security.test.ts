import { describe, expect, it } from 'vitest';
import { AppError } from '../src/errors.js';
import {
  ADMIN_SESSION_COOKIE,
  authoritativeGroups,
  canonicalGroupClaim,
  canonicalReturnPath,
  mappedOidcRoles,
  parseCookieHeader,
  serializeHostCookie,
} from '../src/admin/security.js';

describe('admin HTTP and OIDC security primitives', () => {
  it('accepts only same-site relative return paths', () => {
    expect(canonicalReturnPath('/compute-orders?status=paid')).toBe('/compute-orders?status=paid');
    expect(canonicalReturnPath(undefined)).toBe('/');
    for (const value of ['//attacker.test', '/safe#fragment', '/safe\\redirect', '/x\u0000y', 'https://attacker.test']) {
      expect(() => canonicalReturnPath(value)).toThrowError(AppError);
    }
  });

  it('requires canonical group arrays and agreement across verified OIDC sources', () => {
    expect(canonicalGroupClaim(['group-b', 'group-a', 'group-a'])).toEqual(['group-a', 'group-b']);
    expect(authoritativeGroups(['group-a'], undefined)).toEqual(['group-a']);
    expect(authoritativeGroups(undefined, ['group-a'])).toEqual(['group-a']);
    expect(authoritativeGroups(['group-a'], ['group-a'])).toEqual(['group-a']);
    for (const value of ['group-a', [' group-a'], ['group-a\n'], [42], new Array(129).fill('x')]) {
      expect(() => canonicalGroupClaim(value)).toThrowError(AppError);
    }
    for (const [idTokenClaim, userInfoClaim, code] of [
      [undefined, undefined, 'ADMIN_OIDC_GROUP_CLAIM_MISSING'],
      [['group-a'], ['group-b'], 'ADMIN_OIDC_GROUP_CLAIM_MISMATCH'],
    ] as const) {
      try {
        authoritativeGroups(idTokenClaim, userInfoClaim);
        throw new Error('expected authoritativeGroups to reject');
      } catch (error) {
        expect(error).toMatchObject({ code });
      }
    }
  });

  it('maps only exact allowlisted groups without exposing raw group values', () => {
    const roles = mappedOidcRoles(['alpha-support', 'unknown'], [
      { group: 'alpha-support', roleCode: 'support_viewer' },
      { group: 'finance', roleCode: 'finance_viewer' },
    ], 'g'.repeat(40));
    expect(roles).toHaveLength(1);
    expect(roles[0]).toMatchObject({ roleCode: 'support_viewer', expiresAt: null });
    expect(roles[0]?.sourceReferenceDigest).toMatch(/^[a-f0-9]{128}$/u);
    expect(JSON.stringify(roles)).not.toContain('alpha-support');
  });

  it('rejects ambiguous, whitespace-normalized, duplicate, or oversized cookies', () => {
    expect(parseCookieHeader('theme=dark; __Host-kai_admin_session=abc_DEF-123')).toMatchObject({
      [ADMIN_SESSION_COOKIE]: 'abc_DEF-123',
    });
    for (const header of [
      '__Host-kai_admin_session= value',
      '__Host-kai_admin_session=value ',
      '__Host-kai_admin_session=one; __Host-kai_admin_session=two',
      `a=${'x'.repeat(513)}`,
      new Array(34).fill('a=b').join(';'),
    ]) expect(() => parseCookieHeader(header)).toThrow('管理员登录信息无效');
  });

  it('serializes a host-only secure HttpOnly SameSite cookie', () => {
    const cookie = serializeHostCookie(ADMIN_SESSION_COOKIE, 'x'.repeat(64), 300);
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Domain=');
  });
});
