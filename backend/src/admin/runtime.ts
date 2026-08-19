import type { RuntimeConfig } from '../config.js';
import type { AdminRoleCode } from './permissions.js';

export type AdminAuthRuntimeSettings = Readonly<{
  webOrigin: string;
  apiOrigin: string;
  oidcClientId: string;
  oidcClientSecret: string;
  oidcRedirectUri: string;
  oidcScopes: readonly string[];
  oidcGroupClaim: string;
  oidcGroupRoleMappings: readonly Readonly<{ group: string; roleCode: AdminRoleCode }>[];
  oidcFlowPepper: string;
  oidcSubjectPepper: string;
  oidcGroupPepper: string;
  oidcTransactionEncryptionKey: string;
  sessionTokenPepper: string;
  csrfTokenPepper: string;
  piiEncryptionKey: string;
  auditPepper: string;
  loginTransactionTtlSeconds: number;
  sessionIdleTtlSeconds: number;
  sessionAbsoluteTtlSeconds: number;
  sessionRotationSeconds: number;
  previousTokenGraceSeconds: number;
  reauthFreshnessSeconds: number;
}>;

function required(value: string | null | undefined, name: string): string {
  if (!value) throw new Error(`ADMIN_AUTH_RUNTIME_${name}_MISSING`);
  return value;
}

export function adminAuthRuntimeSettings(config: RuntimeConfig): AdminAuthRuntimeSettings | null {
  if (!config.adminAuthEnabled || !config.readiness.capabilities.adminAuth.available) return null;
  return Object.freeze({
    webOrigin: required(config.adminWebOrigin, 'WEB_ORIGIN'),
    apiOrigin: required(config.adminApiOrigin, 'API_ORIGIN'),
    oidcClientId: required(config.ADMIN_OIDC_CLIENT_ID, 'OIDC_CLIENT_ID'),
    oidcClientSecret: required(config.ADMIN_OIDC_CLIENT_SECRET, 'OIDC_CLIENT_SECRET'),
    oidcRedirectUri: required(config.adminOidcRedirectUri, 'OIDC_REDIRECT_URI'),
    oidcScopes: Object.freeze([...config.adminOidcScopes]),
    oidcGroupClaim: required(config.ADMIN_OIDC_GROUP_CLAIM, 'OIDC_GROUP_CLAIM'),
    oidcGroupRoleMappings: Object.freeze(config.adminOidcGroupRoleMappings.map((mapping) => Object.freeze({ ...mapping }))),
    oidcFlowPepper: required(config.ADMIN_OIDC_FLOW_PEPPER, 'OIDC_FLOW_PEPPER'),
    oidcSubjectPepper: required(config.ADMIN_OIDC_SUBJECT_PEPPER, 'OIDC_SUBJECT_PEPPER'),
    oidcGroupPepper: required(config.ADMIN_OIDC_GROUP_PEPPER, 'OIDC_GROUP_PEPPER'),
    oidcTransactionEncryptionKey: required(
      config.ADMIN_OIDC_TRANSACTION_ENCRYPTION_KEY,
      'OIDC_TRANSACTION_ENCRYPTION_KEY',
    ),
    sessionTokenPepper: required(config.ADMIN_SESSION_TOKEN_PEPPER, 'SESSION_TOKEN_PEPPER'),
    csrfTokenPepper: required(config.ADMIN_CSRF_TOKEN_PEPPER, 'CSRF_TOKEN_PEPPER'),
    piiEncryptionKey: required(config.ADMIN_PII_ENCRYPTION_KEY, 'PII_ENCRYPTION_KEY'),
    auditPepper: required(config.ADMIN_AUDIT_PEPPER, 'AUDIT_PEPPER'),
    loginTransactionTtlSeconds: config.adminAuthTtls.loginTransactionSeconds,
    sessionIdleTtlSeconds: config.adminAuthTtls.sessionIdleSeconds,
    sessionAbsoluteTtlSeconds: config.adminAuthTtls.sessionAbsoluteSeconds,
    sessionRotationSeconds: config.adminAuthTtls.sessionRotationSeconds,
    previousTokenGraceSeconds: config.adminAuthTtls.previousTokenGraceSeconds,
    reauthFreshnessSeconds: config.adminAuthTtls.reauthFreshnessSeconds,
  });
}
