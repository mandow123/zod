import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
} from 'jose';
import { AppError } from '../errors.js';
import { KAI_OIDC_ISSUER, KAI_OIDC_JWKS_URI } from './kai-oidc-constants.js';

export type VerifiedKaiIdToken = Readonly<{
  subject: string;
  nonce: string;
  displayName: string | null;
  email: string | null;
  emailVerified: boolean;
}>;
export type VerifiedKaiIdTokenWithClaims = Readonly<{
  identity: VerifiedKaiIdToken;
  claims: Readonly<JWTPayload>;
}>;

function safeProfile(payload: JWTPayload): Omit<VerifiedKaiIdToken, 'subject' | 'nonce'> {
  const displayName = typeof payload.name === 'string' && payload.name.trim()
    && !/[\u0000-\u001f\u007f]/u.test(payload.name)
    ? payload.name.trim().slice(0, 80) : null;
  const trimmedEmail = typeof payload.email === 'string' ? payload.email.trim() : '';
  const email = trimmedEmail && trimmedEmail.length <= 320 && !/[\u0000-\u0020\u007f]/u.test(trimmedEmail)
    ? trimmedEmail : null;
  return { displayName, email, emailVerified: email !== null && payload.email_verified === true };
}

export class KaiIdTokenVerifier {
  private readonly key = createRemoteJWKSet(new URL(KAI_OIDC_JWKS_URI), {
    timeoutDuration: 5_000,
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60 * 1_000,
  });

  constructor(private readonly clientId: string) {}

  async verify(idToken: string): Promise<VerifiedKaiIdToken> {
    return (await this.verifyWithClaims(idToken)).identity;
  }

  async verifyWithClaims(idToken: string): Promise<VerifiedKaiIdTokenWithClaims> {
    try {
      if (idToken.length < 1 || idToken.length > 32_768) throw new Error('invalid token size');
      const { payload } = await jwtVerify(idToken, this.key, {
        issuer: KAI_OIDC_ISSUER,
        audience: this.clientId,
        algorithms: ['EdDSA'],
        requiredClaims: ['sub', 'nonce', 'iat', 'exp'],
        maxTokenAge: '10m',
        clockTolerance: 5,
      });
      if (typeof payload.sub !== 'string' || payload.sub.length < 1 || payload.sub.length > 500
        || typeof payload.nonce !== 'string' || payload.nonce.length < 32 || payload.nonce.length > 200) {
        throw new Error('invalid identity claims');
      }
      const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if ((audiences.length > 1 && payload.azp !== this.clientId)
        || (payload.azp !== undefined && payload.azp !== this.clientId)) {
        throw new Error('invalid authorized party');
      }
      return {
        identity: Object.freeze({ subject: payload.sub, nonce: payload.nonce, ...safeProfile(payload) }),
        // Only the configured administrative group claim is consumed from this
        // object. Callers must not persist or log the raw token claims.
        claims: Object.freeze({ ...payload }),
      };
    } catch {
      throw new AppError('AUTH_KAI_ID_TOKEN_INVALID', 401, '统一身份返回的登录凭证无效，请重新登录。');
    }
  }
}
