export async function startKaiAuth(_consents: Readonly<{ termsVersion: string; privacyVersion: string }>) {
  throw new Error('本地验收版本请使用本机验证码。');
}

export function isKaiAuthCallback(_url: string) {
  return false;
}

export async function completeKaiAuth(_url: string) {
  return false;
}
