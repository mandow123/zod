export async function startKaiAuth() {
  throw new Error('本地验收版本请使用本机验证码。');
}

export function isKaiAuthCallback(_url: string) {
  return false;
}

export async function completeKaiAuth(_url: string) {
  return false;
}

export async function resumeVerifiedKaiAuth() {
  return null;
}

export async function loadKaiAuthProgress() {
  return null;
}

export function kaiAuthProgressMessage(_progress: never) {
  return '';
}

export function kaiAuthLastAttemptLabel(_progress: never) {
  return '';
}

export async function acceptVerifiedKaiConsents() {
  throw new Error('测试构建不使用正式 KAI 登录。');
}

export async function cancelVerifiedKaiAuth() {}

export class KaiLegalDocumentsChangedError extends Error {}

export type KaiAuthProgress = never;
