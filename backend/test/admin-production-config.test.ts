import { describe, expect, it } from 'vitest';
import { adminProductionConfigurationIssues } from '../src/config.js';

const completeDisabledAdminEnvironment = {
  NODE_ENV: 'production',
  PUBLIC_ORIGIN: 'https://cloudpay.example.test',
  ADMIN_AUTH_ENABLED: 'false',
  ADMIN_WEB_ORIGIN: 'https://admin.example.test/',
  ADMIN_API_ORIGIN: 'https://admin-api.example.test/',
  ADMIN_OIDC_CLIENT_ID: 'cloudpay-admin-broker',
  ADMIN_OIDC_CLIENT_SECRET: 'admin-client-secret-unique-value-0123456789',
  ADMIN_OIDC_REDIRECT_URI: 'https://admin-api.example.test/admin/v1/auth/callback',
  ADMIN_OIDC_SCOPE: 'openid profile email kai_admin',
  ADMIN_OIDC_GROUP_CLAIM: 'kai_admin_groups',
  ADMIN_OIDC_GROUP_ROLE_MAPPING_JSON: JSON.stringify({
    'support-reviewers': 'support_viewer',
  }),
  ADMIN_OIDC_FLOW_PEPPER: 'F'.repeat(40),
  ADMIN_OIDC_SUBJECT_PEPPER: 'S'.repeat(40),
  ADMIN_OIDC_GROUP_PEPPER: 'G'.repeat(40),
  ADMIN_OIDC_TRANSACTION_ENCRYPTION_KEY: Buffer.alloc(32, 17).toString('base64'),
  ADMIN_SESSION_TOKEN_PEPPER: 'T'.repeat(40),
  ADMIN_CSRF_TOKEN_PEPPER: 'C'.repeat(40),
  ADMIN_PII_ENCRYPTION_KEY: Buffer.alloc(32, 18).toString('base64'),
  ADMIN_AUDIT_PEPPER: 'U'.repeat(40),
};

describe('administrator production configuration preflight', () => {
  it('validates a complete production configuration while authentication remains disabled', () => {
    expect(adminProductionConfigurationIssues(completeDisabledAdminEnvironment)).toEqual([]);
  });

  it('reports missing administrator inputs by stable variable name only', () => {
    const issues = adminProductionConfigurationIssues({ ADMIN_AUTH_ENABLED: 'false' });

    expect(issues).toEqual(expect.arrayContaining([
      'ADMIN_WEB_ORIGIN',
      'ADMIN_API_ORIGIN',
      'ADMIN_OIDC_CLIENT_ID',
      'ADMIN_OIDC_CLIENT_SECRET',
      'ADMIN_OIDC_REDIRECT_URI',
      'ADMIN_OIDC_GROUP_ROLE_MAPPING_JSON',
      'ADMIN_SESSION_TOKEN_PEPPER',
    ]));
    expect(issues.every((issue) => /^ADMIN_[A-Z0-9_]+$/u.test(issue))).toBe(true);
  });

  it('never returns rejected secrets, origins, groups, mappings, or validation descriptions', () => {
    const secret = 'DISTINCTIVE_ADMIN_SECRET_VALUE_123456789';
    const origin = 'http://admin-private.example.test/private?debug=1';
    const group = 'DISTINCTIVE_PRIVATE_GROUP';
    const mapping = JSON.stringify({ [group]: 'unknown_role' });
    const issues = adminProductionConfigurationIssues({
      ...completeDisabledAdminEnvironment,
      ADMIN_WEB_ORIGIN: origin,
      ADMIN_OIDC_CLIENT_SECRET: secret,
      ADMIN_SESSION_TOKEN_PEPPER: secret,
      ADMIN_OIDC_GROUP_ROLE_MAPPING_JSON: mapping,
      ADMIN_LOGIN_TRANSACTION_TTL_SECONDS: 'not-a-number',
    });
    const output = JSON.stringify(issues);

    expect(issues).toEqual(expect.arrayContaining([
      'ADMIN_WEB_ORIGIN',
      'ADMIN_OIDC_CLIENT_SECRET',
      'ADMIN_SESSION_TOKEN_PEPPER',
      'ADMIN_OIDC_GROUP_ROLE_MAPPING_JSON',
      'ADMIN_LOGIN_TRANSACTION_TTL_SECONDS',
    ]));
    expect(issues.every((issue) => /^ADMIN_[A-Z0-9_]+$/u.test(issue))).toBe(true);
    for (const sensitive of [secret, origin, group, mapping, 'secure origin', 'independent']) {
      expect(output).not.toContain(sensitive);
    }
  });
});
