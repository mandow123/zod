import { jwtVerify, SignJWT } from 'jose';
import { AppError } from '../errors.js';
import type { AccountPrincipal } from './types.js';

const issuer = 'https://api.kaicloudpay.com';
const audience = 'kai-cloudpay-mobile';
const encoder = new TextEncoder();

export class TokenService {
  readonly accessTokenTtlSeconds = 15 * 60;
  readonly reauthenticationTtlSeconds = 5 * 60;

  constructor(private readonly secret: string) {}

  async issueAccessToken(principal: AccountPrincipal) {
    return new SignJWT({ sid: principal.sessionId, role: principal.role, typ: 'access' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(principal.userId)
      .setIssuedAt()
      .setExpirationTime(`${this.accessTokenTtlSeconds}s`)
      .sign(encoder.encode(this.secret));
  }

  async verifyAccessToken(token: string): Promise<AccountPrincipal> {
    try {
      const { payload } = await jwtVerify(token, encoder.encode(this.secret), { issuer, audience, algorithms: ['HS256'] });
      if (payload.typ !== 'access' || typeof payload.sub !== 'string' || typeof payload.sid !== 'string') throw new Error('invalid claims');
      if (!['member', 'supplier', 'operator', 'admin'].includes(String(payload.role))) throw new Error('invalid role');
      return { userId: payload.sub, sessionId: payload.sid, role: payload.role as AccountPrincipal['role'] };
    } catch {
      throw new AppError('AUTH_ACCESS_TOKEN_INVALID', 401, '登录状态已失效，请重新登录。');
    }
  }

  async issueReauthenticationToken(userId: string, action: 'delete_account') {
    return new SignJWT({ action, typ: 'reauth' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime(`${this.reauthenticationTtlSeconds}s`)
      .sign(encoder.encode(this.secret));
  }

  async verifyReauthenticationToken(token: string, userId: string, action: 'delete_account') {
    const subject = await this.verifyReauthenticationSubject(token, action);
    if (subject !== userId) {
      throw new AppError('AUTH_REAUTHENTICATION_REQUIRED', 401, '请重新验证手机号后再执行此操作。');
    }
  }

  async verifyReauthenticationSubject(token: string, action: 'delete_account') {
    try {
      const { payload } = await jwtVerify(token, encoder.encode(this.secret), { issuer, audience, algorithms: ['HS256'] });
      if (payload.typ !== 'reauth' || typeof payload.sub !== 'string' || payload.action !== action) throw new Error('invalid claims');
      return payload.sub;
    } catch {
      throw new AppError('AUTH_REAUTHENTICATION_REQUIRED', 401, '请重新验证手机号后再执行此操作。');
    }
  }
}
