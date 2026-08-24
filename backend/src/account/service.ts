import { randomUUID } from 'node:crypto';
import type { RuntimeConfig } from '../config.js';
import { AppError } from '../errors.js';
import {
  decryptPii, encryptPii, generateOpaqueToken, generateOtp, lookupHash, maskedEmail, maskedPhone, normalizeMainlandPhone,
  otpHash, secretHash,
} from './crypto.js';
import type { SmsProvider } from './sms.js';
import type { AccountStore } from './store.js';
import { TokenService } from './tokens.js';
import { LEGAL_VERSIONS, type AccountPrincipal, type ConsentInput, type DeviceDescriptor, type OtpPurpose } from './types.js';
import type { ResourceAccessAuthenticator } from './kai-access.js';

type RequestContext = Readonly<{ requestId: string; ip: string; userAgent: string }>;

function required(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export class AccountService {
  private readonly tokenService: TokenService | undefined;
  private readonly refreshPepper: string | undefined;
  private readonly otpPepper: string | undefined;
  private readonly auditPepper: string;
  private readonly piiKey: string;
  private readonly refreshTtlMilliseconds = 30 * 24 * 60 * 60 * 1000;
  private readonly otpTtlMilliseconds = 5 * 60 * 1000;
  private readonly production: boolean;
  private readonly allowLegacyLocalAuth: boolean;

  constructor(
    private readonly store: AccountStore,
    private readonly sms: SmsProvider,
    config: RuntimeConfig,
    private readonly now: () => Date = () => new Date(),
    private readonly resourceAccessAuthenticator?: ResourceAccessAuthenticator,
  ) {
    this.allowLegacyLocalAuth = config.NODE_ENV === 'test' && config.localE2E;
    if (this.allowLegacyLocalAuth) {
      const accessSecret = required(config.ACCESS_TOKEN_SECRET, 'ACCESS_TOKEN_SECRET');
      this.refreshPepper = required(config.REFRESH_TOKEN_PEPPER, 'REFRESH_TOKEN_PEPPER');
      this.otpPepper = required(config.OTP_PEPPER, 'OTP_PEPPER');
      this.tokenService = new TokenService(accessSecret);
    }
    this.auditPepper = required(config.AUDIT_PEPPER, 'AUDIT_PEPPER');
    this.piiKey = required(config.PII_ENCRYPTION_KEY, 'PII_ENCRYPTION_KEY');
    this.production = config.NODE_ENV === 'production';
  }

  legalDocuments(config: RuntimeConfig) {
    return {
      terms: { version: LEGAL_VERSIONS.terms, url: config.TERMS_URL ?? null },
      privacy: { version: LEGAL_VERSIONS.privacy, url: config.PRIVACY_POLICY_URL ?? null },
      inquiry: { version: LEGAL_VERSIONS.inquiry, url: config.INQUIRY_TERMS_URL ?? null },
    };
  }

  async acceptKaiConsents(
    principal: AccountPrincipal,
    input: Readonly<{ termsVersion: string; privacyVersion: string; attemptId: string }>,
    context: RequestContext,
  ) {
    if (input.termsVersion !== LEGAL_VERSIONS.terms || input.privacyVersion !== LEGAL_VERSIONS.privacy) {
      throw new AppError('LEGAL_CONSENT_VERSION_MISMATCH', 409, '请确认最新的用户协议与隐私政策。', {
        current: { termsVersion: LEGAL_VERSIONS.terms, privacyVersion: LEGAL_VERSIONS.privacy },
      });
    }
    if (!this.store.recordKaiConsents) {
      throw new AppError('AUTH_CONSENT_STORE_NOT_READY', 503, '协议确认服务尚未就绪。');
    }
    const payloadDigest = secretHash(JSON.stringify({
      termsVersion: input.termsVersion, privacyVersion: input.privacyVersion,
    }), this.auditPepper);
    const result = await this.store.recordKaiConsents({
      userId: principal.userId,
      attemptId: input.attemptId,
      payloadDigest,
      termsVersion: input.termsVersion,
      privacyVersion: input.privacyVersion,
      requestId: context.requestId,
      ipHash: this.contextHash(context.ip),
      userAgentHash: this.contextHash(context.userAgent),
    });
    if (result.status === 'conflict') {
      throw new AppError('AUTH_CONSENT_IDEMPOTENCY_CONFLICT', 409, '本次协议确认请求与原请求不一致。');
    }
    return {
      accepted: { termsVersion: input.termsVersion, privacyVersion: input.privacyVersion },
      replayed: result.status === 'replayed',
    };
  }

  async requestOtp(input: { phone: string; purpose: OtpPurpose }, context: RequestContext) {
    const otpPepper = this.legacyOtpPepper();
    const phone = normalizeMainlandPhone(input.phone);
    const destinationHash = lookupHash(phone, otpPepper);
    const recent = await this.store.countRecentOtp(destinationHash, new Date(this.now().getTime() - 10 * 60 * 1000));
    if (recent >= 3) throw new AppError('AUTH_OTP_RATE_LIMITED', 429, '验证码请求过于频繁，请稍后再试。');
    const challengeId = randomUUID();
    const code = generateOtp();
    const expiresAt = new Date(this.now().getTime() + this.otpTtlMilliseconds);
    await this.store.createOtpChallenge({
      id: challengeId, destinationHash, purpose: input.purpose,
      codeHash: otpHash(challengeId, code, otpPepper), expiresAt,
    });
    try {
      await this.sms.sendOtp(phone, code);
    } catch {
      await this.store.invalidateOtpChallenge(challengeId);
      throw new AppError('SMS_PROVIDER_UNAVAILABLE', 503, '短信服务暂时不可用，请稍后重试。');
    }
    await this.audit(null, 'AUTH_OTP_REQUESTED', 'OTP_CHALLENGE', challengeId, context, { purpose: input.purpose, destinationHash });
    return { challengeId, expiresInSeconds: this.otpTtlMilliseconds / 1000, resendAfterSeconds: 60 };
  }

  async verifyOtp(input: {
    phone: string; challengeId: string; code: string; purpose: OtpPurpose; displayName?: string;
    consents?: ConsentInput[]; device?: DeviceDescriptor;
  }, context: RequestContext) {
    const otpPepper = this.legacyOtpPepper();
    const tokenService = this.legacyTokenService();
    const phone = normalizeMainlandPhone(input.phone);
    const phoneLookupHash = lookupHash(phone, otpPepper);
    const result = await this.store.consumeOtpChallenge({
      id: input.challengeId, destinationHash: phoneLookupHash, purpose: input.purpose,
      codeHash: otpHash(input.challengeId, input.code, otpPepper), now: this.now(),
    });
    if (result !== 'consumed') {
      const mapping = {
        invalid: ['AUTH_OTP_INVALID', 400, '验证码错误。'],
        expired: ['AUTH_OTP_EXPIRED', 410, '验证码已过期，请重新获取。'],
        locked: ['AUTH_OTP_LOCKED', 429, '验证码错误次数过多，请重新获取。'],
        already_used: ['AUTH_OTP_ALREADY_USED', 409, '验证码已经使用，请重新获取。'],
      } as const;
      const [code, status, message] = mapping[result];
      throw new AppError(code, status, message);
    }

    let user = await this.store.findUserByPhoneHash(phoneLookupHash);
    if (input.purpose === 'delete_account') {
      if (!user || user.status === 'anonymized') throw new AppError('AUTH_ACCOUNT_NOT_FOUND', 404, '账户不存在。');
      const reauthenticationToken = await tokenService.issueReauthenticationToken(user.id, 'delete_account');
      await this.audit(user.id, 'AUTH_REAUTHENTICATED', 'USER', user.id, context, { action: 'delete_account' });
      return { kind: 'reauthentication' as const, reauthenticationToken, expiresInSeconds: tokenService.reauthenticationTtlSeconds };
    }

    if (!user && input.purpose === 'login') throw new AppError('AUTH_ACCOUNT_NOT_FOUND', 404, '账户不存在，请先注册。');
    if (!user) {
      const displayName = input.displayName?.trim();
      if (!displayName || displayName.length > 80) throw new AppError('AUTH_DISPLAY_NAME_INVALID', 400, '请输入 1 至 80 个字符的名称。');
      this.assertRequiredConsents(input.consents ?? []);
      user = await this.store.createUser({
        phoneCiphertext: encryptPii(phone, this.piiKey), phoneLookupHash, displayName,
      });
      await this.store.recordConsents(
        user.id, input.consents ?? [], this.contextHash(context.ip), this.contextHash(context.userAgent),
      );
      await this.audit(user.id, 'ACCOUNT_CREATED', 'USER', user.id, context, { consentVersions: input.consents });
    }
    if (user.status === 'suspended') throw new AppError('AUTH_ACCOUNT_SUSPENDED', 403, '账户已暂停，请联系支持人员。');
    if (!input.device) throw new AppError('AUTH_DEVICE_REQUIRED', 400, '缺少设备信息。');
    return { kind: 'session' as const, ...(await this.createSession(user.id, user.role, input.device, context)) };
  }

  async refresh(refreshToken: string, deviceId: string, context: RequestContext) {
    const tokenService = this.legacyTokenService();
    const refreshPepper = this.legacyRefreshPepper();
    const nextRefreshToken = generateOpaqueToken();
    const expiresAt = new Date(this.now().getTime() + this.refreshTtlMilliseconds);
    const rotation = await this.store.rotateRefreshToken({
      currentTokenHash: secretHash(refreshToken, refreshPepper), nextTokenId: randomUUID(),
      nextTokenHash: secretHash(nextRefreshToken, refreshPepper), deviceId, expiresAt, now: this.now(),
    });
    if (rotation.status === 'reused') throw new AppError('AUTH_REFRESH_TOKEN_REUSED', 401, '检测到登录凭证重复使用，相关设备已安全退出。');
    if (rotation.status === 'invalid') throw new AppError('AUTH_REFRESH_TOKEN_INVALID', 401, '登录已过期，请重新登录。');
    const principal = {
      userId: rotation.identity.user.id, sessionId: rotation.identity.sessionId, role: rotation.identity.user.role,
    } satisfies AccountPrincipal;
    await this.audit(principal.userId, 'SESSION_REFRESHED', 'SESSION', principal.sessionId, context, {});
    return {
      accessToken: await tokenService.issueAccessToken(principal), refreshToken: nextRefreshToken,
      accessExpiresInSeconds: tokenService.accessTokenTtlSeconds,
      refreshExpiresAt: expiresAt.toISOString(),
    };
  }

  async authenticate(
    authorization: string | string[] | undefined,
    idToken?: string | string[],
    rawHeaders?: readonly string[],
  ) {
    if (this.resourceAccessAuthenticator && (this.production || idToken !== undefined)) {
      return this.resourceAccessAuthenticator.authenticate(authorization, idToken, rawHeaders);
    }
    if (!this.allowLegacyLocalAuth) {
      throw new AppError('AUTH_PAIRED_TOKEN_REQUIRED', 401, '请使用 KAI 统一身份重新登录。');
    }
    if (typeof authorization !== 'string') throw new AppError('AUTH_REQUIRED', 401, '请先登录。');
    const match = /^Bearer\s+(.+)$/iu.exec(authorization ?? '');
    if (!match?.[1]) throw new AppError('AUTH_REQUIRED', 401, '请先登录。');
    const principal = await this.legacyTokenService().verifyAccessToken(match[1]);
    const identity = await this.store.getSession(principal.sessionId);
    if (!identity || identity.user.id !== principal.userId || identity.revokedAt || identity.expiresAt <= this.now()) {
      throw new AppError('AUTH_SESSION_EXPIRED', 401, '登录状态已失效，请重新登录。');
    }
    if (identity.user.status === 'suspended' || identity.user.status === 'anonymized') {
      throw new AppError('AUTH_ACCOUNT_UNAVAILABLE', 403, '账户当前不可用。');
    }
    return { principal, identity };
  }

  async authenticateBootstrap(
    authorization: string | string[] | undefined,
    idToken?: string | string[],
    rawHeaders?: readonly string[],
  ) {
    if (!this.resourceAccessAuthenticator) {
      if (this.allowLegacyLocalAuth) return this.authenticate(authorization, idToken, rawHeaders);
      throw new AppError('AUTH_PAIRED_TOKEN_REQUIRED', 401, '请使用 KAI 统一身份重新登录。');
    }
    return this.resourceAccessAuthenticator.authenticate(authorization, idToken, rawHeaders, {
      allowWithoutCurrentLegalConsents: true,
    });
  }

  async profile(principal: AccountPrincipal) {
    const user = await this.store.findUserById(principal.userId);
    if (!user) throw new AppError('AUTH_ACCOUNT_NOT_FOUND', 404, '账户不存在。');
    return {
      id: user.id,
      displayName: user.displayName,
      phone: user.phoneCiphertext ? maskedPhone(decryptPii(user.phoneCiphertext, this.piiKey)) : null,
      email: user.emailCiphertext ? maskedEmail(decryptPii(user.emailCiphertext, this.piiKey)) : null,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt.toISOString(),
    };
  }

  async createFederatedSession(userId: string, device: DeviceDescriptor, context: RequestContext) {
    const user = await this.store.findUserById(userId);
    if (!user || user.status === 'anonymized') throw new AppError('AUTH_ACCOUNT_NOT_FOUND', 404, '账户不存在。');
    if (user.status === 'suspended') throw new AppError('AUTH_ACCOUNT_SUSPENDED', 403, '账户已暂停，请联系支持人员。');
    return { kind: 'session' as const, ...(await this.createSession(user.id, user.role, device, context)) };
  }

  async sessions(principal: AccountPrincipal) {
    const sessions = await this.store.listSessions(principal.userId);
    return sessions.map((session) => ({ ...session, current: session.id === principal.sessionId }));
  }

  async logout(principal: AccountPrincipal, sessionId: string | undefined, context: RequestContext) {
    const target = sessionId ?? principal.sessionId;
    const revoked = await this.store.revokeSession(principal.userId, target, 'user_logout');
    if (revoked) await this.audit(principal.userId, 'SESSION_REVOKED', 'SESSION', target, context, {});
    return { revoked };
  }

  async deletionStatus(principal: AccountPrincipal) {
    const deletion = await this.store.getActiveDeletion(principal.userId);
    return deletion ? this.serializeDeletion(deletion) : null;
  }

  async requestDeletion(principal: AccountPrincipal, reauthenticationToken: string, reason: string | undefined, context: RequestContext) {
    await this.legacyTokenService().verifyReauthenticationToken(reauthenticationToken, principal.userId, 'delete_account');
    return this.createDeletion(principal.userId, reason, context, 'in_app');
  }

  async requestDeletionFromWeb(reauthenticationToken: string, reason: string | undefined, context: RequestContext) {
    const userId = await this.legacyTokenService().verifyReauthenticationSubject(reauthenticationToken, 'delete_account');
    return this.createDeletion(userId, reason, context, 'public_web');
  }

  private async createDeletion(
    userId: string, reason: string | undefined, context: RequestContext, source: 'in_app' | 'public_web',
  ) {
    const blocked = await this.store.hasDeletionBlockers(userId);
    const deletion = await this.store.requestDeletion(userId, reason?.trim() || undefined, blocked);
    await this.audit(userId, 'ACCOUNT_DELETION_REQUESTED', 'ACCOUNT_DELETION', deletion.id, context, { blocked, source });
    return this.serializeDeletion(deletion);
  }

  async cancelDeletion(principal: AccountPrincipal, context: RequestContext) {
    const cancelled = await this.store.cancelDeletion(principal.userId);
    if (cancelled) await this.audit(principal.userId, 'ACCOUNT_DELETION_CANCELLED', 'USER', principal.userId, context, {});
    return { cancelled };
  }

  private async createSession(userId: string, role: AccountPrincipal['role'], device: DeviceDescriptor, context: RequestContext) {
    const tokenService = this.legacyTokenService();
    const refreshPepper = this.legacyRefreshPepper();
    const refreshToken = generateOpaqueToken();
    const expiresAt = new Date(this.now().getTime() + this.refreshTtlMilliseconds);
    const identity = await this.store.createSession({
      sessionId: randomUUID(), tokenFamily: randomUUID(), userId, refreshTokenId: randomUUID(),
      refreshTokenHash: secretHash(refreshToken, refreshPepper), device, expiresAt,
    });
    const principal = { userId, sessionId: identity.sessionId, role } satisfies AccountPrincipal;
    await this.audit(userId, 'SESSION_CREATED', 'SESSION', identity.sessionId, context, { platform: device.platform, appVersion: device.appVersion });
    return {
      accessToken: await tokenService.issueAccessToken(principal), refreshToken,
      accessExpiresInSeconds: tokenService.accessTokenTtlSeconds,
      refreshExpiresAt: expiresAt.toISOString(),
      user: await this.profile(principal),
    };
  }

  private legacyTokenService(): TokenService {
    if (!this.allowLegacyLocalAuth || !this.tokenService) {
      throw new AppError('AUTH_LOCAL_SESSION_RETIRED', 410, '本地登录会话已停用。');
    }
    return this.tokenService;
  }

  private legacyRefreshPepper(): string {
    if (!this.allowLegacyLocalAuth || !this.refreshPepper) {
      throw new AppError('AUTH_LOCAL_SESSION_RETIRED', 410, '本地登录会话已停用。');
    }
    return this.refreshPepper;
  }

  private legacyOtpPepper(): string {
    if (!this.allowLegacyLocalAuth || !this.otpPepper) {
      throw new AppError('AUTH_LOCAL_SESSION_RETIRED', 410, '本地登录会话已停用。');
    }
    return this.otpPepper;
  }

  private assertRequiredConsents(consents: ConsentInput[]) {
    const accepted = new Map(consents.map((consent) => [consent.kind, consent.version]));
    if (accepted.get('terms') !== LEGAL_VERSIONS.terms || accepted.get('privacy') !== LEGAL_VERSIONS.privacy) {
      throw new AppError('LEGAL_CONSENT_REQUIRED', 400, '请阅读并同意当前版本的用户协议和隐私政策。');
    }
  }

  private contextHash(value: string) {
    return lookupHash(value || 'unknown', this.auditPepper);
  }

  private async audit(
    actorId: string | null, action: string, entityType: string, entityId: string,
    context: RequestContext, metadata: Record<string, unknown>,
  ) {
    await this.store.recordAudit({
      actorId, actorKind: actorId ? 'user' : 'system', action, entityType, entityId,
      requestId: context.requestId, ipHash: this.contextHash(context.ip),
      payloadDigest: secretHash(JSON.stringify(metadata), this.auditPepper), metadata,
    });
  }

  private serializeDeletion(deletion: Awaited<ReturnType<AccountStore['requestDeletion']>>) {
    return {
      id: deletion.id, status: deletion.status, coolingOffUntil: deletion.coolingOffUntil.toISOString(),
      requestedAt: deletion.requestedAt.toISOString(), legalHoldReason: deletion.legalHoldReason,
    };
  }
}
