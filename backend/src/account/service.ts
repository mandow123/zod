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

type RequestContext = Readonly<{ requestId: string; ip: string; userAgent: string }>;

function required(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export class AccountService {
  private readonly tokenService: TokenService;
  private readonly accessSecret: string;
  private readonly refreshPepper: string;
  private readonly otpPepper: string;
  private readonly auditPepper: string;
  private readonly piiKey: string;
  private readonly refreshTtlMilliseconds = 30 * 24 * 60 * 60 * 1000;
  private readonly otpTtlMilliseconds = 5 * 60 * 1000;

  constructor(
    private readonly store: AccountStore,
    private readonly sms: SmsProvider,
    config: RuntimeConfig,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.accessSecret = required(config.ACCESS_TOKEN_SECRET, 'ACCESS_TOKEN_SECRET');
    this.refreshPepper = required(config.REFRESH_TOKEN_PEPPER, 'REFRESH_TOKEN_PEPPER');
    this.otpPepper = required(config.OTP_PEPPER, 'OTP_PEPPER');
    this.auditPepper = required(config.AUDIT_PEPPER, 'AUDIT_PEPPER');
    this.piiKey = required(config.PII_ENCRYPTION_KEY, 'PII_ENCRYPTION_KEY');
    this.tokenService = new TokenService(this.accessSecret);
  }

  legalDocuments(config: RuntimeConfig) {
    return {
      terms: { version: LEGAL_VERSIONS.terms, url: config.TERMS_URL ?? null },
      privacy: { version: LEGAL_VERSIONS.privacy, url: config.PRIVACY_POLICY_URL ?? null },
      inquiry: { version: LEGAL_VERSIONS.inquiry, url: config.INQUIRY_TERMS_URL ?? null },
    };
  }

  async requestOtp(input: { phone: string; purpose: OtpPurpose }, context: RequestContext) {
    const phone = normalizeMainlandPhone(input.phone);
    const destinationHash = lookupHash(phone, this.otpPepper);
    const recent = await this.store.countRecentOtp(destinationHash, new Date(this.now().getTime() - 10 * 60 * 1000));
    if (recent >= 3) throw new AppError('AUTH_OTP_RATE_LIMITED', 429, '验证码请求过于频繁，请稍后再试。');
    const challengeId = randomUUID();
    const code = generateOtp();
    const expiresAt = new Date(this.now().getTime() + this.otpTtlMilliseconds);
    await this.store.createOtpChallenge({
      id: challengeId, destinationHash, purpose: input.purpose,
      codeHash: otpHash(challengeId, code, this.otpPepper), expiresAt,
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
    const phone = normalizeMainlandPhone(input.phone);
    const phoneLookupHash = lookupHash(phone, this.otpPepper);
    const result = await this.store.consumeOtpChallenge({
      id: input.challengeId, destinationHash: phoneLookupHash, purpose: input.purpose,
      codeHash: otpHash(input.challengeId, input.code, this.otpPepper), now: this.now(),
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
      const reauthenticationToken = await this.tokenService.issueReauthenticationToken(user.id, 'delete_account');
      await this.audit(user.id, 'AUTH_REAUTHENTICATED', 'USER', user.id, context, { action: 'delete_account' });
      return { kind: 'reauthentication' as const, reauthenticationToken, expiresInSeconds: this.tokenService.reauthenticationTtlSeconds };
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
    const nextRefreshToken = generateOpaqueToken();
    const expiresAt = new Date(this.now().getTime() + this.refreshTtlMilliseconds);
    const rotation = await this.store.rotateRefreshToken({
      currentTokenHash: secretHash(refreshToken, this.refreshPepper), nextTokenId: randomUUID(),
      nextTokenHash: secretHash(nextRefreshToken, this.refreshPepper), deviceId, expiresAt, now: this.now(),
    });
    if (rotation.status === 'reused') throw new AppError('AUTH_REFRESH_TOKEN_REUSED', 401, '检测到登录凭证重复使用，相关设备已安全退出。');
    if (rotation.status === 'invalid') throw new AppError('AUTH_REFRESH_TOKEN_INVALID', 401, '登录已过期，请重新登录。');
    const principal = {
      userId: rotation.identity.user.id, sessionId: rotation.identity.sessionId, role: rotation.identity.user.role,
    } satisfies AccountPrincipal;
    await this.audit(principal.userId, 'SESSION_REFRESHED', 'SESSION', principal.sessionId, context, {});
    return {
      accessToken: await this.tokenService.issueAccessToken(principal), refreshToken: nextRefreshToken,
      accessExpiresInSeconds: this.tokenService.accessTokenTtlSeconds,
      refreshExpiresAt: expiresAt.toISOString(),
    };
  }

  async authenticate(authorization: string | undefined) {
    const match = /^Bearer\s+(.+)$/iu.exec(authorization ?? '');
    if (!match?.[1]) throw new AppError('AUTH_REQUIRED', 401, '请先登录。');
    const principal = await this.tokenService.verifyAccessToken(match[1]);
    const identity = await this.store.getSession(principal.sessionId);
    if (!identity || identity.user.id !== principal.userId || identity.revokedAt || identity.expiresAt <= this.now()) {
      throw new AppError('AUTH_SESSION_EXPIRED', 401, '登录状态已失效，请重新登录。');
    }
    if (identity.user.status === 'suspended' || identity.user.status === 'anonymized') {
      throw new AppError('AUTH_ACCOUNT_UNAVAILABLE', 403, '账户当前不可用。');
    }
    return { principal, identity };
  }

  async profile(principal: AccountPrincipal) {
    const identity = await this.store.getSession(principal.sessionId);
    if (!identity) throw new AppError('AUTH_SESSION_EXPIRED', 401, '登录状态已失效，请重新登录。');
    return {
      id: identity.user.id,
      displayName: identity.user.displayName,
      phone: identity.user.phoneCiphertext ? maskedPhone(decryptPii(identity.user.phoneCiphertext, this.piiKey)) : null,
      email: identity.user.emailCiphertext ? maskedEmail(decryptPii(identity.user.emailCiphertext, this.piiKey)) : null,
      role: identity.user.role,
      status: identity.user.status,
      createdAt: identity.user.createdAt.toISOString(),
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
    await this.tokenService.verifyReauthenticationToken(reauthenticationToken, principal.userId, 'delete_account');
    return this.createDeletion(principal.userId, reason, context, 'in_app');
  }

  async requestDeletionFromWeb(reauthenticationToken: string, reason: string | undefined, context: RequestContext) {
    const userId = await this.tokenService.verifyReauthenticationSubject(reauthenticationToken, 'delete_account');
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
    const refreshToken = generateOpaqueToken();
    const expiresAt = new Date(this.now().getTime() + this.refreshTtlMilliseconds);
    const identity = await this.store.createSession({
      sessionId: randomUUID(), tokenFamily: randomUUID(), userId, refreshTokenId: randomUUID(),
      refreshTokenHash: secretHash(refreshToken, this.refreshPepper), device, expiresAt,
    });
    const principal = { userId, sessionId: identity.sessionId, role } satisfies AccountPrincipal;
    await this.audit(userId, 'SESSION_CREATED', 'SESSION', identity.sessionId, context, { platform: device.platform, appVersion: device.appVersion });
    return {
      accessToken: await this.tokenService.issueAccessToken(principal), refreshToken,
      accessExpiresInSeconds: this.tokenService.accessTokenTtlSeconds,
      refreshExpiresAt: expiresAt.toISOString(),
      user: await this.profile(principal),
    };
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
