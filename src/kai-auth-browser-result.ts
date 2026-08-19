import { isKaiAuthCallbackUrl } from './kai-auth-protocol.ts';

export type KaiAuthSessionResult =
  | Readonly<{ type: 'success'; url: string }>
  | Readonly<{ type: 'cancel' | 'dismiss' | 'locked' | 'opened' | 'timeout' }>;

export function interpretKaiAuthSessionResult(result: KaiAuthSessionResult) {
  if (result.type === 'success') {
    if (!isKaiAuthCallbackUrl(result.url)) throw new Error('统一身份登录返回了无效回调，请重试。');
    return result.url;
  }
  if (result.type === 'cancel' || result.type === 'dismiss') throw new Error('登录已取消。');
  if (result.type === 'timeout') throw new Error('登录已超时，请重新发起。');
  throw new Error('统一身份登录没有完成，请重试。');
}
