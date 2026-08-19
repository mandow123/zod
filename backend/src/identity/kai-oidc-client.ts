import type { JWTPayload } from 'jose';
import { AppError } from '../errors.js';
import { KAI_OIDC_TOKEN_ENDPOINT, KAI_OIDC_USERINFO_ENDPOINT } from './kai-oidc-constants.js';

export type KaiOidcTokenSet = Readonly<{ idToken: string; accessToken: string }>;
export type KaiOidcUserInfo = Readonly<{
  subject: string;
  displayName: string | null;
  email: string | null;
  emailVerified: boolean;
}>;
export type KaiOidcUserInfoWithClaims = Readonly<{
  profile: KaiOidcUserInfo;
  claims: Readonly<Record<string, unknown>>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeProfile(payload: JWTPayload): Omit<KaiOidcUserInfo, 'subject'> {
  const displayName = typeof payload.name === 'string' && payload.name.trim()
    && !/[\u0000-\u001f\u007f]/u.test(payload.name)
    ? payload.name.trim().slice(0, 80) : null;
  const trimmedEmail = typeof payload.email === 'string' ? payload.email.trim() : '';
  const email = trimmedEmail && trimmedEmail.length <= 320 && !/[\u0000-\u0020\u007f]/u.test(trimmedEmail)
    ? trimmedEmail : null;
  return { displayName, email, emailVerified: email !== null && payload.email_verified === true };
}

function validateRedirectUri(value: string): string {
  let redirect: URL;
  try {
    redirect = new URL(value);
  } catch {
    throw new Error('KAI_OIDC_REDIRECT_URI_INVALID');
  }
  if (!value || value !== value.trim() || redirect.protocol !== 'https:' || !redirect.hostname
    || redirect.username || redirect.password || value.includes('#')) {
    throw new Error('KAI_OIDC_REDIRECT_URI_INVALID');
  }
  return value;
}

export class KaiOidcClient {
  private readonly redirectUri: string;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    redirectUri: string,
    private readonly request: typeof fetch = fetch,
  ) {
    this.redirectUri = validateRedirectUri(redirectUri);
  }

  async exchange(code: string, pkceVerifier: string): Promise<KaiOidcTokenSet> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
      code_verifier: pkceVerifier,
    });
    const payload = await this.fetchJson(KAI_OIDC_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
      },
      body: body.toString(),
    }, 64 * 1_024);
    if (!isRecord(payload) || typeof payload.id_token !== 'string' || typeof payload.access_token !== 'string'
      || payload.id_token.length < 1 || payload.id_token.length > 32_768
      || payload.access_token.length < 1 || payload.access_token.length > 16_384
      || typeof payload.token_type !== 'string' || payload.token_type.toLowerCase() !== 'bearer') {
      throw new AppError('AUTH_KAI_TOKEN_RESPONSE_INVALID', 502, '统一身份暂时无法完成登录。');
    }
    return { idToken: payload.id_token, accessToken: payload.access_token };
  }

  async userInfo(accessToken: string): Promise<KaiOidcUserInfo> {
    return (await this.userInfoWithClaims(accessToken)).profile;
  }

  async userInfoWithClaims(accessToken: string): Promise<KaiOidcUserInfoWithClaims> {
    const payload = await this.fetchJson(KAI_OIDC_USERINFO_ENDPOINT, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
    }, 128 * 1_024);
    if (!isRecord(payload) || typeof payload.sub !== 'string'
      || payload.sub.length < 1 || payload.sub.length > 500) {
      throw new AppError('AUTH_KAI_USERINFO_INVALID', 502, '统一身份暂时无法确认账户资料。');
    }
    return {
      profile: Object.freeze({ subject: payload.sub, ...safeProfile(payload) }),
      // Administrative authorization reads one explicitly configured claim and
      // must never persist or log this short-lived upstream payload.
      claims: Object.freeze({ ...payload }),
    };
  }

  private async fetchJson(url: string, init: RequestInit, maximumBytes: number): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await this.request(url, { ...init, signal: controller.signal, redirect: 'error' });
      if (!response.ok) throw new Error(`upstream status ${response.status}`);
      const declaredLength = response.headers.get('content-length');
      if (declaredLength && (/^\d+$/u.test(declaredLength) === false
        || Number(declaredLength) > maximumBytes)) throw new Error('upstream body too large');
      if (!response.body) throw new Error('upstream body missing');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        total += part.value.byteLength;
        if (total > maximumBytes) {
          await reader.cancel();
          throw new Error('upstream body too large');
        }
        chunks.push(part.value);
      }
      return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')) as unknown;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('AUTH_KAI_UPSTREAM_UNAVAILABLE', 502, '统一身份服务暂时不可用，请稍后重试。');
    } finally {
      clearTimeout(timeout);
    }
  }
}
