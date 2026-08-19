import { randomUUID } from 'node:crypto';
import { constantTimeEqual, decryptPii, encryptPii, generateOpaqueToken, lookupHash, secretHash } from '../account/crypto.js';
import { AppError } from '../errors.js';
import {
  KAI_OIDC_AUTHORIZATION_ENDPOINT,
  KAI_OIDC_ISSUER,
} from '../identity/kai-oidc-constants.js';
import type { KaiOidcClient } from '../identity/kai-oidc-client.js';
import type { KaiIdTokenVerifier } from '../identity/kai-id-token-verifier.js';
import type { AdminAuditStore } from './audit-store.js';
import type { AdminIdentityStore } from './identity-store.js';
import type { AdminLoginTransactionStore } from './login-transaction-store.js';
import {
  permissionsForAdminRoles,
  stableAdminPermissionDigestInput,
  type AdminPermission,
  type AdminRoleCode,
} from './permissions.js';
import type { AdminRbacStore } from './rbac-store.js';
import type { AdminAuthRuntimeSettings } from './runtime.js';
import {
  ADMIN_PERMISSION_DEFINITION_VERSION,
  authoritativeGroups,
  canonicalReturnPath,
  mappedOidcRoles,
  newPkce,
  stableGroupSnapshotDigest,
} from './security.js';
import type { AdminSessionStore } from './session-store.js';
import type { AdminIdentity, AdminSession } from './types.js';

type AdminOidcClient = Pick<KaiOidcClient, 'exchange' | 'userInfoWithClaims'>;
type AdminIdTokenVerifier = Pick<KaiIdTokenVerifier, 'verifyWithClaims'>;

export type AdminRequestContext = Readonly<{
  requestId: string;
  ip: string;
  userAgent: string;
  now?: Date;
}>;

export type AdminPrincipal = Readonly<{
  identityId: string;
  sessionId: string;
  displayName: string;
  roles: readonly AdminRoleCode[];
  permissions: readonly AdminPermission[];
  authzVersion: number;
  sessionCreatedAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  reauthenticatedAt: Date | null;
}>;

export type AuthenticatedAdmin = Readonly<{
  principal: AdminPrincipal;
  session: AdminSession;
  csrfToken: string | null;
  rotatedSessionToken?: string;
  staleSession?: true;
}>;

export type AdminLoginStart = Readonly<{
  authorizationUrl: string;
  browserBindingToken: string;
}>;

export type AdminLoginCompleted = Readonly<{
  sessionToken: string;
  returnPath: string;
  principal: AdminPrincipal;
}>;

export type AdminReadAuditAction =
  | 'admin.dashboard.read'
  | 'admin.compute_order.list'
  | 'admin.device_order.list'
  | 'admin.payout.list'
  | 'admin.topup.list';

function nowFrom(context: AdminRequestContext): Date {
  return context.now ? new Date(context.now) : new Date();
}

function safeContextValue(value: string, maximum: number, fallback: string): string {
  return value && value.length <= maximum ? value : fallback;
}

function stableFailureCode(error: unknown): string {
  const candidate = error instanceof AppError ? error.code
    : error instanceof Error ? error.message : '';
  return /^[A-Z0-9_]{1,80}$/u.test(candidate) ? candidate : 'ADMIN_LOGIN_FAILED';
}

function loginFailure(error: unknown): AppError {
  if (error instanceof AppError && error.code.startsWith('ADMIN_')) return error;
  return new AppError('ADMIN_LOGIN_FAILED', 401, '管理员登录失败，请重新尝试。');
}

function minDate(left: Date, right: Date): Date {
  return left <= right ? left : right;
}

export class AdminAuthService {
  constructor(
    private readonly identities: AdminIdentityStore,
    private readonly rbac: AdminRbacStore,
    private readonly sessions: AdminSessionStore,
    private readonly transactions: AdminLoginTransactionStore,
    private readonly audit: AdminAuditStore,
    private readonly oidc: AdminOidcClient,
    private readonly verifier: AdminIdTokenVerifier,
    private readonly settings: AdminAuthRuntimeSettings,
  ) {}

  async startLogin(returnPathInput: unknown, context: AdminRequestContext): Promise<AdminLoginStart> {
    const now = nowFrom(context);
    const returnPath = canonicalReturnPath(returnPathInput);
    const state = generateOpaqueToken();
    const nonce = generateOpaqueToken();
    const browserBindingToken = generateOpaqueToken();
    const pkce = newPkce();
    await this.transactions.create({
      id: randomUUID(),
      stateHash: secretHash(state, this.settings.oidcFlowPepper),
      browserBindingHash: secretHash(browserBindingToken, this.settings.oidcFlowPepper),
      nonceHash: secretHash(nonce, this.settings.oidcFlowPepper),
      pkceVerifierCiphertext: encryptPii(pkce.verifier, this.settings.oidcTransactionEncryptionKey),
      returnPath,
      expiresAt: new Date(now.getTime() + this.settings.loginTransactionTtlSeconds * 1_000),
      createdIpHash: this.ipHash(context.ip),
      userAgentHash: this.userAgentHash(context.userAgent),
      createdAt: now,
    });
    const authorization = new URL(KAI_OIDC_AUTHORIZATION_ENDPOINT);
    authorization.search = new URLSearchParams({
      client_id: this.settings.oidcClientId,
      redirect_uri: this.settings.oidcRedirectUri,
      response_type: 'code',
      scope: this.settings.oidcScopes.join(' '),
      state,
      nonce,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
    }).toString();
    await this.appendAudit({
      context, now, identity: null, session: null, permissions: [], action: 'admin.auth.login.started',
      outcome: 'succeeded', errorCode: null, metadata: { status: 'started' },
    });
    return Object.freeze({ authorizationUrl: authorization.toString(), browserBindingToken });
  }

  async completeLogin(input: Readonly<{
    state: string | undefined;
    code: string | undefined;
    issuer: string | undefined;
    providerError: string | undefined;
    browserBindingToken: string | undefined;
  }>, context: AdminRequestContext): Promise<AdminLoginCompleted> {
    const now = nowFrom(context);
    let identity: AdminIdentity | null = null;
    let roles: readonly AdminRoleCode[] = [];
    let transactionId: string | null = null;
    try {
      if (!input.state || input.state.length > 256 || !input.browserBindingToken
        || input.browserBindingToken.length > 256) {
        throw new AppError('ADMIN_LOGIN_TRANSACTION_INVALID', 401, '管理员登录已失效，请重新尝试。');
      }
      if (input.issuer !== KAI_OIDC_ISSUER) {
        throw new AppError('ADMIN_OIDC_ISSUER_INVALID', 401, '管理员登录已失效，请重新尝试。');
      }
      const consumed = await this.transactions.consume({
        stateHash: secretHash(input.state, this.settings.oidcFlowPepper),
        browserBindingHash: secretHash(input.browserBindingToken, this.settings.oidcFlowPepper),
        now,
      });
      if (consumed.status !== 'consumed') {
        throw new AppError(`ADMIN_LOGIN_TRANSACTION_${consumed.status.toUpperCase()}`, 401,
          '管理员登录已失效，请重新尝试。');
      }
      transactionId = consumed.transaction.id;
      if (input.providerError) {
        throw new AppError('ADMIN_OIDC_PROVIDER_DENIED', 401, '管理员登录未完成。');
      }
      if (!input.code || input.code.length > 2_048) {
        throw new AppError('ADMIN_OIDC_CODE_INVALID', 401, '管理员登录已失效，请重新尝试。');
      }
      const pkceVerifier = decryptPii(
        consumed.transaction.pkceVerifierCiphertext,
        this.settings.oidcTransactionEncryptionKey,
      );
      const tokenSet = await this.oidc.exchange(input.code, pkceVerifier);
      const verified = await this.verifier.verifyWithClaims(tokenSet.idToken);
      const expectedNonceHash = secretHash(verified.identity.nonce, this.settings.oidcFlowPepper);
      if (!constantTimeEqual(consumed.transaction.nonceHash, expectedNonceHash)) {
        throw new AppError('ADMIN_OIDC_NONCE_INVALID', 401, '管理员登录已失效，请重新尝试。');
      }
      const userInfo = await this.oidc.userInfoWithClaims(tokenSet.accessToken);
      if (!constantTimeEqual(verified.identity.subject, userInfo.profile.subject)) {
        throw new AppError('ADMIN_OIDC_SUBJECT_MISMATCH', 401, '管理员登录已失效，请重新尝试。');
      }
      const groups = authoritativeGroups(
        verified.claims[this.settings.oidcGroupClaim],
        userInfo.claims[this.settings.oidcGroupClaim],
      );
      const desiredRoles = mappedOidcRoles(
        groups,
        this.settings.oidcGroupRoleMappings,
        this.settings.oidcGroupPepper,
      );
      if (desiredRoles.length === 0) {
        throw new AppError('ADMIN_OIDC_ROLE_REQUIRED', 403, '管理员账户未获得授权。');
      }
      const verifiedEmail = userInfo.profile.emailVerified ? userInfo.profile.email
        : verified.identity.emailVerified ? verified.identity.email : null;
      const identityResult = await this.identities.createOrGet({
        id: randomUUID(),
        issuer: KAI_OIDC_ISSUER,
        subjectHash: secretHash(verified.identity.subject, this.settings.oidcSubjectPepper),
        linkedUserId: null,
        displayName: userInfo.profile.displayName ?? verified.identity.displayName ?? 'KAI Administrator',
        emailCiphertext: verifiedEmail ? encryptPii(verifiedEmail, this.settings.piiEncryptionKey) : null,
        emailLookupHash: verifiedEmail
          ? lookupHash(verifiedEmail.toLowerCase(), this.settings.oidcSubjectPepper) : null,
        now,
      });
      identity = identityResult.identity;
      if (!['pending', 'active'].includes(identity.status)) {
        throw new AppError('ADMIN_IDENTITY_DISABLED', 403, '管理员账户不可用。');
      }
      const synchronized = await this.rbac.syncOidcRoles({
        adminIdentityId: identity.id,
        roles: desiredRoles,
        groupSnapshotDigest: stableGroupSnapshotDigest(groups, this.settings.oidcGroupPepper),
        now,
      });
      roles = synchronized.roles;
      const permissions = permissionsForAdminRoles(roles);
      const sessionToken = generateOpaqueToken();
      const csrfToken = this.csrfForSessionToken(sessionToken);
      const absoluteExpiresAt = new Date(now.getTime() + this.settings.sessionAbsoluteTtlSeconds * 1_000);
      const idleExpiresAt = minDate(
        new Date(now.getTime() + this.settings.sessionIdleTtlSeconds * 1_000),
        absoluteExpiresAt,
      );
      const session = await this.sessions.create({
        id: randomUUID(),
        adminIdentityId: identity.id,
        tokenHash: this.sessionHash(sessionToken),
        csrfTokenHash: this.csrfHash(csrfToken),
        authzVersionAtIssue: synchronized.authzVersion,
        permissionDefinitionVersion: ADMIN_PERMISSION_DEFINITION_VERSION,
        permissionSnapshotDigest: this.permissionDigest(permissions),
        createdAt: now,
        lastSeenAt: now,
        idleExpiresAt,
        absoluteExpiresAt,
        reauthenticatedAt: now,
        createdIpHash: this.ipHash(context.ip),
        lastIpHash: this.ipHash(context.ip),
        userAgentHash: this.userAgentHash(context.userAgent),
      });
      const currentIdentity = await this.requireActiveIdentity(identity.id);
      const principal = this.principal(currentIdentity, session, roles, permissions);
      try {
        await this.appendAudit({
          context, now, identity: currentIdentity, session, permissions, action: 'admin.auth.login.succeeded',
          outcome: 'succeeded', errorCode: null,
          metadata: { roleCodes: roles, source: 'oidc', changed: synchronized.changed },
        });
      } catch {
        await this.sessions.revoke({ sessionId: session.id, adminIdentityId: currentIdentity.id,
          reasonCode: 'AUDIT_WRITE_FAILED', now });
        throw new AppError('ADMIN_AUDIT_UNAVAILABLE', 503, '管理员登录暂时不可用。');
      }
      return Object.freeze({ sessionToken, returnPath: consumed.transaction.returnPath, principal });
    } catch (error) {
      const failureCode = stableFailureCode(error);
      if (transactionId) {
        try { await this.transactions.fail({ transactionId, failureCode, now }); } catch { /* fail closed */ }
      }
      try {
        await this.appendAudit({
          context, now, identity, session: null, permissions: permissionsForAdminRoles(roles),
          action: 'admin.auth.login.failed', outcome: 'denied', errorCode: failureCode,
          metadata: { failureCode },
        });
      } catch { /* Authentication remains fail-closed when the audit sink is unavailable. */ }
      throw loginFailure(error);
    }
  }

  async authenticate(sessionToken: string, context: AdminRequestContext,
    options: Readonly<{ allowRotation?: boolean }> = {}): Promise<AuthenticatedAdmin> {
    const now = nowFrom(context);
    const suppliedTokenHash = this.sessionHash(sessionToken);
    let session = await this.sessions.findActiveByTokenHash(suppliedTokenHash, now);
    if (!session) throw new AppError('ADMIN_AUTH_REQUIRED', 401, '请先登录管理员后台。');
    if (!constantTimeEqual(session.userAgentHash, this.userAgentHash(context.userAgent))) {
      await this.sessions.revoke({ sessionId: session.id, adminIdentityId: session.adminIdentityId,
        reasonCode: 'USER_AGENT_CHANGED', now });
      throw new AppError('ADMIN_SESSION_BINDING_INVALID', 401, '管理员会话已失效，请重新登录。');
    }
    const usingPreviousToken = !constantTimeEqual(session.tokenHash, suppliedTokenHash);
    const identity = await this.requireActiveIdentity(session.adminIdentityId);
    const roles = await this.rbac.activeRoles(identity.id, now);
    const permissions = permissionsForAdminRoles(roles);
    const expectedPermissionDigest = this.permissionDigest(permissions);
    if (roles.length === 0 || session.authzVersionAtIssue !== identity.authzVersion
      || session.permissionDefinitionVersion !== ADMIN_PERMISSION_DEFINITION_VERSION
      || !constantTimeEqual(session.permissionSnapshotDigest, expectedPermissionDigest)) {
      await this.sessions.revoke({ sessionId: session.id, adminIdentityId: identity.id,
        reasonCode: 'AUTHORIZATION_STALE', now });
      throw new AppError('ADMIN_AUTHORIZATION_STALE', 401, '管理员权限已变化，请重新登录。');
    }
    if (usingPreviousToken) {
      return Object.freeze({
        principal: this.principal(identity, session, roles, permissions),
        session,
        csrfToken: null,
        staleSession: true,
      });
    }
    const idleExpiresAt = minDate(
      new Date(now.getTime() + this.settings.sessionIdleTtlSeconds * 1_000),
      session.absoluteExpiresAt,
    );
    const rotationBase = session.rotatedAt ?? session.createdAt;
    let rotatedSessionToken: string | undefined;
    if (options.allowRotation !== false
      && now.getTime() - rotationBase.getTime() >= this.settings.sessionRotationSeconds * 1_000) {
      rotatedSessionToken = generateOpaqueToken();
      const rotatedCsrfToken = this.csrfForSessionToken(rotatedSessionToken);
      const rotated = await this.sessions.rotate({
        sessionId: session.id,
        currentTokenHash: suppliedTokenHash,
        nextTokenHash: this.sessionHash(rotatedSessionToken),
        nextCsrfTokenHash: this.csrfHash(rotatedCsrfToken),
        lastSeenAt: now,
        idleExpiresAt,
        rotatedAt: now,
        lastIpHash: this.ipHash(context.ip),
      });
      if (rotated) {
        session = rotated;
      } else {
        const raced = await this.sessions.findActiveByTokenHash(suppliedTokenHash, now);
        if (!raced || constantTimeEqual(raced.tokenHash, suppliedTokenHash)) {
          throw new AppError('ADMIN_AUTH_REQUIRED', 401, '请先登录管理员后台。');
        }
        return Object.freeze({
          principal: this.principal(identity, raced, roles, permissions),
          session: raced,
          csrfToken: null,
          staleSession: true,
        });
      }
    } else {
      const updated = await this.sessions.updateActivity({
        sessionId: session.id,
        lastSeenAt: now,
        idleExpiresAt,
        lastIpHash: this.ipHash(context.ip),
      });
      if (!updated) throw new AppError('ADMIN_AUTH_REQUIRED', 401, '请先登录管理员后台。');
      session = updated;
    }
    const effectiveToken = rotatedSessionToken ?? sessionToken;
    const csrfToken = this.csrfForSessionToken(effectiveToken);
    if (!constantTimeEqual(session.csrfTokenHash, this.csrfHash(csrfToken))) {
      await this.sessions.revoke({ sessionId: session.id, adminIdentityId: identity.id,
        reasonCode: 'CSRF_STATE_INVALID', now });
      throw new AppError('ADMIN_SESSION_INVALID', 401, '管理员会话已失效，请重新登录。');
    }
    return Object.freeze({
      principal: this.principal(identity, session, roles, permissions),
      session,
      csrfToken,
      ...(rotatedSessionToken ? { rotatedSessionToken } : {}),
    });
  }

  requireCsrf(authenticated: AuthenticatedAdmin, suppliedToken: string | undefined): void {
    if (!authenticated.csrfToken || !suppliedToken || suppliedToken.length > 256
      || !constantTimeEqual(authenticated.csrfToken, suppliedToken)) {
      throw new AppError('ADMIN_CSRF_INVALID', 403, '请求安全校验失败。');
    }
  }

  requireRecentReauthentication(
    authenticated: AuthenticatedAdmin,
    context: AdminRequestContext,
  ): void {
    const reauthenticatedAt = authenticated.principal.reauthenticatedAt;
    const now = nowFrom(context);
    const ageMilliseconds = reauthenticatedAt
      ? now.getTime() - reauthenticatedAt.getTime()
      : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(ageMilliseconds) || ageMilliseconds < 0
      || ageMilliseconds > this.settings.reauthFreshnessSeconds * 1_000) {
      throw new AppError(
        'ADMIN_REAUTHENTICATION_REQUIRED',
        403,
        '请重新验证管理员身份后继续。',
      );
    }
  }

  requirePermission(authenticated: AuthenticatedAdmin, permission: AdminPermission): void {
    if (!authenticated.principal.permissions.includes(permission)) {
      throw new AppError('ADMIN_PERMISSION_DENIED', 403, '当前管理员没有此操作权限。');
    }
  }

  async logout(authenticated: AuthenticatedAdmin, allSessions: boolean, context: AdminRequestContext): Promise<number> {
    const now = nowFrom(context);
    const revokedSessionCount = allSessions
      ? await this.sessions.revokeAll({ adminIdentityId: authenticated.principal.identityId,
        reasonCode: 'LOGOUT_ALL', now })
      : Number(await this.sessions.revoke({ sessionId: authenticated.principal.sessionId,
        adminIdentityId: authenticated.principal.identityId, reasonCode: 'LOGOUT', now }));
    const identity = await this.requireActiveIdentity(authenticated.principal.identityId);
    await this.appendAudit({
      context, now, identity, session: authenticated.session,
      permissions: authenticated.principal.permissions,
      action: allSessions ? 'admin.auth.logout_all' : 'admin.auth.logout',
      outcome: 'succeeded', errorCode: null, metadata: { revokedSessionCount },
    });
    return revokedSessionCount;
  }

  async recordRejectedCallback(failureCode: string, context: AdminRequestContext): Promise<void> {
    const stableCode = /^[A-Z0-9_]{1,80}$/u.test(failureCode) ? failureCode : 'ADMIN_CALLBACK_INVALID';
    await this.appendAudit({
      context,
      now: nowFrom(context),
      identity: null,
      session: null,
      permissions: [],
      action: 'admin.auth.login.failed',
      outcome: 'denied',
      errorCode: stableCode,
      metadata: { failureCode: stableCode },
    });
  }

  async recordSecurityDenial(
    kind: 'origin' | 'session' | 'csrf' | 'permission',
    failureCode: string,
    context: AdminRequestContext,
    authenticated: AuthenticatedAdmin | null = null,
  ): Promise<void> {
    const stableCode = /^[A-Z0-9_]{1,80}$/u.test(failureCode) ? failureCode : 'ADMIN_REQUEST_DENIED';
    let identity: AdminIdentity | null = null;
    if (authenticated) {
      try { identity = await this.requireActiveIdentity(authenticated.principal.identityId); } catch { /* denial stays auditable */ }
    }
    await this.appendAudit({
      context,
      now: nowFrom(context),
      identity,
      session: authenticated?.session ?? null,
      permissions: authenticated?.principal.permissions ?? [],
      action: `admin.auth.${kind}.denied`,
      outcome: 'denied',
      errorCode: stableCode,
      metadata: { failureCode: stableCode },
    });
  }

  async recordAuthorizedRead(
    authenticated: AuthenticatedAdmin,
    action: AdminReadAuditAction,
    context: AdminRequestContext,
  ): Promise<void> {
    const identity = await this.requireActiveIdentity(authenticated.principal.identityId);
    await this.appendAudit({
      context,
      now: nowFrom(context),
      identity,
      session: authenticated.session,
      permissions: authenticated.principal.permissions,
      action,
      outcome: 'succeeded',
      errorCode: null,
      metadata: {},
    });
  }

  private async requireActiveIdentity(identityId: string): Promise<AdminIdentity> {
    const identity = await this.identities.findById(identityId);
    if (!identity || identity.status !== 'active') {
      throw new AppError('ADMIN_IDENTITY_DISABLED', 401, '管理员账户不可用。');
    }
    return identity;
  }

  private principal(identity: AdminIdentity, session: AdminSession, roles: readonly AdminRoleCode[],
    permissions: readonly AdminPermission[]): AdminPrincipal {
    return Object.freeze({
      identityId: identity.id,
      sessionId: session.id,
      displayName: identity.displayName,
      roles: Object.freeze([...roles]),
      permissions: Object.freeze([...permissions]),
      authzVersion: identity.authzVersion,
      sessionCreatedAt: session.createdAt,
      idleExpiresAt: session.idleExpiresAt,
      absoluteExpiresAt: session.absoluteExpiresAt,
      reauthenticatedAt: session.reauthenticatedAt,
    });
  }

  private sessionHash(value: string): string {
    return secretHash(value, this.settings.sessionTokenPepper);
  }

  private csrfForSessionToken(value: string): string {
    return secretHash(`csrf:${value}`, this.settings.csrfTokenPepper);
  }

  private csrfHash(value: string): string {
    return secretHash(value, this.settings.csrfTokenPepper);
  }

  private permissionDigest(permissions: readonly string[]): string {
    return secretHash(stableAdminPermissionDigestInput(permissions), this.settings.sessionTokenPepper);
  }

  private ipHash(value: string): string {
    return lookupHash(safeContextValue(value, 200, 'unknown'), this.settings.auditPepper);
  }

  private userAgentHash(value: string): string {
    return lookupHash(safeContextValue(value, 1_000, 'unknown'), this.settings.auditPepper);
  }

  private async appendAudit(input: Readonly<{
    context: AdminRequestContext;
    now: Date;
    identity: AdminIdentity | null;
    session: AdminSession | null;
    permissions: readonly string[];
    action: string;
    outcome: 'succeeded' | 'denied' | 'failed';
    errorCode: string | null;
    metadata: Readonly<Record<string, unknown>>;
  }>): Promise<void> {
    await this.audit.append({
      occurredAt: input.now,
      adminIdentityId: input.identity?.id ?? null,
      adminSessionId: input.session?.id ?? null,
      effectivePermissions: input.permissions,
      action: input.action,
      targetType: null,
      targetId: null,
      requestId: randomUUID(),
      ticketReference: null,
      reasonCode: null,
      reasonDigest: null,
      idempotencyKeyHash: null,
      beforeStateDigest: null,
      afterStateDigest: null,
      ipHash: this.ipHash(input.context.ip),
      userAgentHash: this.userAgentHash(input.context.userAgent),
      outcome: input.outcome,
      errorCode: input.errorCode,
      sensitiveAccess: false,
      metadata: input.metadata,
    });
  }
}
