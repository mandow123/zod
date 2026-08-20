export type VerifiedResumeFailure = 'retain_pending' | 'require_reauthentication' | 'surface_error';

export function classifyVerifiedStageFailure(input: Readonly<{
  stage: 'identity' | 'platform';
  apiStatus?: number;
  apiCode?: string;
  definitiveInvalid: boolean;
}>): VerifiedResumeFailure {
  if (input.definitiveInvalid || input.apiStatus === 401) return 'require_reauthentication';
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
