export type VerifiedResumeFailure = 'retain_pending' | 'require_reauthentication' | 'surface_error';
export type PlatformPendingReason =
  | 'identity_confirmation_unavailable'
  | 'platform_network_unavailable'
  | 'platform_response_invalid'
  | 'platform_not_accepted'
  | 'platform_server_error'
  | 'platform_configuration_pending';

export function shouldClearPendingAfterKaiAuthStartFailure(input: Readonly<{
  callbackReceived: boolean;
  attemptId: string;
  currentAttemptId?: string;
  currentPhase?: string;
}>) {
  return !input.callbackReceived && input.currentAttemptId === input.attemptId
    && input.currentPhase === 'browser_open';
}

export function issuedKaiTokenRevocationCandidate(input: Readonly<{
  accessToken?: unknown;
  refreshToken?: unknown;
}>) {
  const accessToken = typeof input.accessToken === 'string' && input.accessToken.length >= 20
    ? input.accessToken : undefined;
  const refreshToken = typeof input.refreshToken === 'string' && input.refreshToken.length >= 20
    ? input.refreshToken : undefined;
  if (!accessToken && !refreshToken) return null;
  return {
    ...(accessToken ? { accessToken } : {}),
    ...(refreshToken ? { refreshToken } : {}),
  };
}

export type KaiOidcRevocationCandidate = Readonly<{
  accessToken?: string;
  refreshToken?: string;
}>;

export class KaiOidcExchangeValidationError extends Error {
  readonly name = 'KaiOidcExchangeValidationError';
  readonly revocationCandidate: KaiOidcRevocationCandidate | null;
  constructor(
    message: string,
    revocationCandidate: KaiOidcRevocationCandidate | null,
  ) {
    super(message);
    this.revocationCandidate = revocationCandidate;
  }
}

export function validateIssuedKaiOidcTokenSet(input: Readonly<{
  accessToken?: unknown;
  refreshToken?: unknown;
  idToken?: unknown;
  tokenType?: unknown;
  scope?: unknown;
  expiresIn?: unknown;
  requiredScopes: readonly string[];
  validateIdToken: (idToken: string) => Readonly<{ sub: string }>;
}>) {
  const revocationCandidate = issuedKaiTokenRevocationCandidate(input);
  try {
    if (typeof input.accessToken !== 'string' || input.accessToken.length < 20
      || String(input.tokenType).toLowerCase() !== 'bearer'
      || !Number.isInteger(input.expiresIn) || (input.expiresIn as number) < 30
      || (input.expiresIn as number) > 3_600) {
      throw new Error('统一身份返回的登录凭证不完整，请重新登录。');
    }
    if (typeof input.refreshToken !== 'string' || input.refreshToken.length < 20
      || typeof input.idToken !== 'string' || input.idToken.length < 40) {
      throw new Error('统一身份没有返回可续期的登录凭证，请重新登录。');
    }
    if (typeof input.scope !== 'string') {
      throw new Error('统一身份没有授予完整的账户权限，请重新登录。');
    }
    const grantedScopes = new Set(input.scope.split(/\s+/u).filter(Boolean));
    if (input.requiredScopes.some((scope) => !grantedScopes.has(scope))) {
      throw new Error('统一身份没有授予完整的账户权限，请重新登录。');
    }
    const claims = input.validateIdToken(input.idToken);
    return {
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      idToken: input.idToken,
      scope: input.scope,
      expiresInSeconds: input.expiresIn as number,
      subject: claims.sub,
    };
  } catch (error) {
    throw new KaiOidcExchangeValidationError(
      error instanceof Error ? error.message : '登录凭证未通过安全校验。',
      revocationCandidate,
    );
  }
}

export function platformPendingReason(input: Readonly<{
  apiStatus?: number;
  apiCode?: string;
  identityConfirmationUnavailable?: boolean;
}>): PlatformPendingReason {
  if (input.identityConfirmationUnavailable) return 'identity_confirmation_unavailable';
  if (input.apiCode === 'RESPONSE_INVALID') return 'platform_response_invalid';
  if (input.apiStatus === 0) return 'platform_network_unavailable';
  if (input.apiStatus === 401 || input.apiStatus === 403) return 'platform_not_accepted';
  if ((input.apiStatus ?? 0) >= 500) return 'platform_server_error';
  return 'platform_configuration_pending';
}

export async function resolvePlatformUnauthorized<Identity>(input: Readonly<{
  identity: Identity;
  confirmIdentity: (identity: Identity) => Promise<void>;
  definitiveInvalid: (error: unknown) => boolean;
  retire: (identity: Identity) => Promise<void>;
}>) {
  try {
    await input.confirmIdentity(input.identity);
    return 'retain_platform_not_accepted' as const;
  } catch (error) {
    if (!input.definitiveInvalid(error)) return 'retain_identity_confirmation_unavailable' as const;
    await input.retire(input.identity);
    return 'reauthenticate' as const;
  }
}

export function classifyAuthorizationExchangeFailure(input: Readonly<{
  retryableNetwork: boolean;
  definitiveInvalid: boolean;
  recoveryWindowValid: boolean;
}>) {
  if (input.retryableNetwork && input.recoveryWindowValid) return 'retain_encrypted_authorization' as const;
  if (input.definitiveInvalid) return 'restart_authorization' as const;
  return 'surface_error' as const;
}

export function classifyVerifiedStageFailure(input: Readonly<{
  stage: 'identity' | 'platform';
  apiStatus?: number;
  apiCode?: string;
  definitiveInvalid: boolean;
}>): VerifiedResumeFailure {
  if (input.definitiveInvalid) return 'require_reauthentication';
  if (input.stage === 'platform') return 'retain_pending';
  return classifyVerifiedResumeFailure(input);
}

export function classifyVerifiedResumeFailure(input: Readonly<{
  apiStatus?: number;
  apiCode?: string;
  definitiveInvalid: boolean;
}>): VerifiedResumeFailure {
  if (input.definitiveInvalid || input.apiStatus === 401) return 'require_reauthentication';
  if (input.apiCode === 'RESPONSE_INVALID' || input.apiStatus === 0
    || [502, 503, 504].includes(input.apiStatus ?? -1)) return 'retain_pending';
  return 'surface_error';
}

export async function runVerifiedBootstrap<Identity, Result>(input: Readonly<{
  stored: Identity;
  refresh: (stored: Identity) => Promise<Identity>;
  bootstrap: (active: Identity) => Promise<Result>;
  classify: (error: unknown) => VerifiedResumeFailure;
  retire: (active: Identity) => Promise<void>;
}>) {
  let active = input.stored;
  try {
    active = await input.refresh(active);
    return { kind: 'ready' as const, value: await input.bootstrap(active) };
  } catch (error) {
    const failure = input.classify(error);
    if (failure === 'retain_pending') return { kind: 'pending' as const };
    if (failure === 'require_reauthentication') {
      await input.retire(active);
      return { kind: 'reauthenticate' as const };
    }
    throw error;
  }
}

export function parsePreservingStoredValue<T>(raw: string, valid: (value: unknown) => value is T): T {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error('stored_value_integrity'); }
  if (!valid(value)) throw new Error('stored_value_integrity');
  return value;
}

export function sameAuthLegalDocuments(
  current: Readonly<{ terms: { version: string; url: string | null }; privacy: { version: string; url: string | null } }>,
  accepted: Readonly<{ terms: { version: string; url: string | null }; privacy: { version: string; url: string | null } }>,
) {
  return current.terms.version === accepted.terms.version
    && current.privacy.version === accepted.privacy.version
    && current.terms.url === accepted.terms.url
    && current.privacy.url === accepted.privacy.url;
}

export async function persistRotatedVerifiedIdentity<T>(input: Readonly<{
  save: () => Promise<T>;
  queueRevocation: () => Promise<void>;
}>) {
  try { return await input.save(); }
  catch {
    try { await input.queueRevocation(); }
    catch { throw new Error('新凭证暂时无法安全保存或撤销，本机保留原验证状态，请稍后重试。'); }
    throw new Error('新凭证无法安全保存，已安排撤销，请重新登录。');
  }
}

export async function retireVerifiedIdentityWithFallback(input: Readonly<{
  revoke: () => Promise<void>;
  queueRevocation: () => Promise<void>;
  clear: () => Promise<void>;
}>) {
  try { await input.revoke(); }
  catch {
    try { await input.queueRevocation(); }
    catch { throw new Error('账号验证取消尚未完成，本机仍保留待处理状态，请联网后重试。'); }
  }
  await input.clear();
}
