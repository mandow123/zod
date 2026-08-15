import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AccountService } from '../src/account/service.js';
import type { SmsProvider } from '../src/account/sms.js';
import type {
  AccountStore, OtpConsumeResult, RefreshRotationResult,
} from '../src/account/store.js';
import type {
  AccountDeletion, AccountUser, ConsentInput, DeviceDescriptor, OtpPurpose, SessionIdentity,
} from '../src/account/types.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';

class FakeSms implements SmsProvider {
  latest: { phone: string; code: string } | null = null;
  fail = false;
  async sendOtp(phone: string, code: string) {
    if (this.fail) throw new Error('provider unavailable');
    this.latest = { phone, code };
  }
}

type MutableSession = {
  sessionId: string;
  tokenFamily: string;
  user: AccountUser;
  device: DeviceDescriptor;
  expiresAt: Date;
  revokedAt: Date | null;
  lastSeenAt: Date;
};

class MemoryAccountStore implements AccountStore {
  challenges = new Map<string, {
    destinationHash: string; purpose: OtpPurpose; codeHash: string; expiresAt: Date; attempts: number; consumed: boolean; createdAt: Date;
  }>();
  users = new Map<string, AccountUser>();
  usersByPhone = new Map<string, string>();
  sessions = new Map<string, MutableSession>();
  refreshTokens = new Map<string, { sessionId: string; status: 'current' | 'used' | 'revoked'; expiresAt: Date }>();
  consents: Array<{ userId: string; consent: ConsentInput }> = [];
  audits: string[] = [];
  deletion: AccountDeletion | null = null;
  deletionBlocked = false;

  async countRecentOtp(destinationHash: string, since: Date) {
    return [...this.challenges.values()].filter((challenge) => challenge.destinationHash === destinationHash && challenge.createdAt >= since).length;
  }
  async createOtpChallenge(input: { id: string; destinationHash: string; purpose: OtpPurpose; codeHash: string; expiresAt: Date }) {
    this.challenges.set(input.id, { ...input, attempts: 0, consumed: false, createdAt: new Date() });
  }
  async invalidateOtpChallenge(id: string) {
    const challenge = this.challenges.get(id);
    if (challenge) { challenge.consumed = true; challenge.attempts = 10; }
  }
  async consumeOtpChallenge(input: { id: string; destinationHash: string; purpose: OtpPurpose; codeHash: string; now: Date }): Promise<OtpConsumeResult> {
    const challenge = this.challenges.get(input.id);
    if (!challenge || challenge.destinationHash !== input.destinationHash || challenge.purpose !== input.purpose) return 'invalid';
    if (challenge.consumed) return 'already_used';
    if (challenge.attempts >= 5) return 'locked';
    if (challenge.expiresAt <= input.now) return 'expired';
    if (challenge.codeHash !== input.codeHash) { challenge.attempts += 1; return challenge.attempts >= 5 ? 'locked' : 'invalid'; }
    challenge.consumed = true;
    return 'consumed';
  }
  async findUserByPhoneHash(phoneLookupHash: string) {
    const id = this.usersByPhone.get(phoneLookupHash);
    return id ? this.users.get(id) ?? null : null;
  }
  async findUserById(userId: string) { return this.users.get(userId) ?? null; }
  async createUser(input: { phoneCiphertext: string; phoneLookupHash: string; displayName: string }) {
    const existing = await this.findUserByPhoneHash(input.phoneLookupHash);
    if (existing) return existing;
    const user: AccountUser = {
      id: randomUUID(), phoneCiphertext: input.phoneCiphertext, phoneLookupHash: input.phoneLookupHash,
      displayName: input.displayName, role: 'member', status: 'active', createdAt: new Date(),
    };
    this.users.set(user.id, user);
    this.usersByPhone.set(user.phoneLookupHash!, user.id);
    return user;
  }
  async recordConsents(userId: string, consents: ConsentInput[]) {
    this.consents.push(...consents.map((consent) => ({ userId, consent })));
  }
  async createSession(input: {
    sessionId: string; tokenFamily: string; userId: string; refreshTokenId: string; refreshTokenHash: string;
    device: DeviceDescriptor; expiresAt: Date;
  }) {
    const user = this.users.get(input.userId)!;
    const identity = {
      sessionId: input.sessionId, tokenFamily: input.tokenFamily, user, device: input.device,
      expiresAt: input.expiresAt, revokedAt: null, lastSeenAt: new Date(),
    };
    this.sessions.set(identity.sessionId, identity);
    this.refreshTokens.set(input.refreshTokenHash, { sessionId: identity.sessionId, status: 'current', expiresAt: input.expiresAt });
    return identity;
  }
  async rotateRefreshToken(input: {
    currentTokenHash: string; nextTokenId: string; nextTokenHash: string; deviceId: string; expiresAt: Date; now: Date;
  }): Promise<RefreshRotationResult> {
    const token = this.refreshTokens.get(input.currentTokenHash);
    if (!token) return { status: 'invalid' };
    const session = this.sessions.get(token.sessionId);
    if (!session) return { status: 'invalid' };
    if (token.status !== 'current') {
      for (const item of this.sessions.values()) {
        if (item.tokenFamily === session.tokenFamily) item.revokedAt = input.now;
      }
      return { status: 'reused' };
    }
    if (session.revokedAt || session.device.deviceId !== input.deviceId || token.expiresAt <= input.now) return { status: 'invalid' };
    token.status = 'used';
    this.refreshTokens.set(input.nextTokenHash, { sessionId: session.sessionId, status: 'current', expiresAt: input.expiresAt });
    session.expiresAt = input.expiresAt;
    session.lastSeenAt = input.now;
    return { status: 'rotated', identity: session };
  }
  async getSession(sessionId: string) { return this.sessions.get(sessionId) ?? null; }
  async listSessions(userId: string) {
    return [...this.sessions.values()].filter((session) => session.user.id === userId && !session.revokedAt).map((session) => ({
      id: session.sessionId, device: session.device, lastSeenAt: session.lastSeenAt, expiresAt: session.expiresAt, current: false,
    }));
  }
  async revokeSession(userId: string, sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.user.id !== userId || session.revokedAt) return false;
    session.revokedAt = new Date();
    for (const token of this.refreshTokens.values()) if (token.sessionId === sessionId && token.status === 'current') token.status = 'revoked';
    return true;
  }
  async getActiveDeletion() { return this.deletion; }
  async hasDeletionBlockers() { return this.deletionBlocked; }
  async requestDeletion(_userId: string, _reason: string | undefined, blocked: boolean) {
    if (this.deletion) return this.deletion;
    this.deletion = {
      id: randomUUID(), status: blocked ? 'blocked_by_legal_hold' : 'cooling_off',
      coolingOffUntil: new Date(Date.now() + 7 * 86_400_000), requestedAt: new Date(),
      legalHoldReason: blocked ? '存在未完成交易。' : null,
    };
    return this.deletion;
  }
  async cancelDeletion() {
    if (!this.deletion) return false;
    this.deletion = null;
    return true;
  }
  async recordAudit(input: { action: string }) { this.audits.push(input.action); }
}

const config = loadConfig({
  NODE_ENV: 'test',
  PUBLIC_ORIGIN: 'https://api.cloudpay.kai.com',
  DATABASE_URL: 'postgresql://test/cloudpay',
  ACCESS_TOKEN_SECRET: 'a'.repeat(64),
  REFRESH_TOKEN_PEPPER: 'b'.repeat(32),
  OTP_PEPPER: 'c'.repeat(32),
  AUDIT_PEPPER: 'd'.repeat(32),
  CURSOR_SECRET: 'e'.repeat(32),
  PII_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString('base64'),
  TERMS_URL: 'https://cloudpay.kai.com/terms',
  PRIVACY_POLICY_URL: 'https://cloudpay.kai.com/privacy',
});
const device = { deviceId: 'android-device-0001', appVersion: '1.0.0', platform: 'android' as const };
const requestContext = { requestId: 'req-account-test', ip: '127.0.0.1', userAgent: 'vitest' };
const consents = [
  { kind: 'terms' as const, version: '2026-08-11' },
  { kind: 'privacy' as const, version: '2026-08-11' },
];

function harness() {
  const store = new MemoryAccountStore();
  const sms = new FakeSms();
  const service = new AccountService(store, sms, config);
  return { store, sms, service };
}

async function register(service: AccountService, sms: FakeSms) {
  const challenge = await service.requestOtp({ phone: '13800138000', purpose: 'register' }, requestContext);
  const result = await service.verifyOtp({
    phone: '13800138000', challengeId: challenge.challengeId, code: sms.latest!.code,
    purpose: 'register', displayName: 'KAI 用户', consents, device,
  }, requestContext);
  if (result.kind !== 'session') throw new Error('expected session');
  return result;
}

describe('mobile account lifecycle', () => {
  it('registers only with current legal consent and returns encrypted-account session data', async () => {
    const { store, sms, service } = harness();
    const challenge = await service.requestOtp({ phone: '+86 138 0013 8000', purpose: 'register' }, requestContext);
    await expect(service.verifyOtp({
      phone: '13800138000', challengeId: challenge.challengeId, code: sms.latest!.code,
      purpose: 'register', displayName: '未同意用户', consents: [], device,
    }, requestContext)).rejects.toMatchObject({ code: 'LEGAL_CONSENT_REQUIRED' });

    const session = await register(service, sms);
    expect(session.user.phone).toBe('+8613****8000');
    expect(session.user).not.toHaveProperty('phoneCiphertext');
    expect(store.users.values().next().value?.phoneCiphertext).not.toContain('13800138000');
    expect(store.consents).toHaveLength(2);
    expect(store.audits).toContain('ACCOUNT_CREATED');
  });

  it('rotates refresh tokens and revokes the token family when an old token is reused', async () => {
    const { sms, service } = harness();
    const session = await register(service, sms);
    const rotated = await service.refresh(session.refreshToken, device.deviceId, requestContext);
    expect(rotated.refreshToken).not.toBe(session.refreshToken);
    await expect(service.refresh(session.refreshToken, device.deviceId, requestContext))
      .rejects.toMatchObject({ code: 'AUTH_REFRESH_TOKEN_REUSED' });
    await expect(service.authenticate(`Bearer ${rotated.accessToken}`))
      .rejects.toMatchObject({ code: 'AUTH_SESSION_EXPIRED' });
  });

  it('fails closed when the SMS provider is unavailable', async () => {
    const { sms, service } = harness();
    sms.fail = true;
    await expect(service.requestOtp({ phone: '13800138000', purpose: 'login' }, requestContext))
      .rejects.toMatchObject({ code: 'SMS_PROVIDER_UNAVAILABLE', statusCode: 503 });
  });

  it('requires a fresh phone reauthentication before account deletion and supports cancellation', async () => {
    const { sms, service } = harness();
    const session = await register(service, sms);
    const authenticated = await service.authenticate(`Bearer ${session.accessToken}`);
    await expect(service.requestDeletion(authenticated.principal, 'invalid', undefined, requestContext))
      .rejects.toBeInstanceOf(AppError);

    const challenge = await service.requestOtp({ phone: '13800138000', purpose: 'delete_account' }, requestContext);
    const verified = await service.verifyOtp({
      phone: '13800138000', challengeId: challenge.challengeId, code: sms.latest!.code, purpose: 'delete_account',
    }, requestContext);
    if (verified.kind !== 'reauthentication') throw new Error('expected reauthentication');
    const deletion = await service.requestDeletion(authenticated.principal, verified.reauthenticationToken, '不再使用', requestContext);
    expect(deletion.status).toBe('cooling_off');
    expect(await service.cancelDeletion(authenticated.principal, requestContext)).toEqual({ cancelled: true });
  });

  it('exposes the account flow through stable mobile HTTP routes', async () => {
    const { sms, service } = harness();
    const app = await buildApp({ config, database: { health: async () => true }, accountService: service, logger: false });
    const requested = await app.inject({ method: 'POST', url: '/mobile/v1/auth/otp/request', payload: { phone: '13800138000', purpose: 'register' } });
    expect(requested.statusCode).toBe(202);
    const challengeId = requested.json().challenge.challengeId as string;
    const verified = await app.inject({
      method: 'POST', url: '/mobile/v1/auth/otp/verify',
      payload: { phone: '13800138000', challengeId, code: sms.latest!.code, purpose: 'register', displayName: 'HTTP 用户', consents, device },
    });
    expect(verified.statusCode).toBe(200);
    const accessToken = verified.json().result.accessToken as string;
    const me = await app.inject({ method: 'GET', url: '/mobile/v1/me', headers: { authorization: `Bearer ${accessToken}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.displayName).toBe('HTTP 用户');
    await app.close();
  });
});
