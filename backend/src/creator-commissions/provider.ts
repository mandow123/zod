import { createHmac,randomBytes,timingSafeEqual } from 'node:crypto';
import type { ReferralProviderSource } from './types.js';

export type VerifiedAttribution = Readonly<{
  providerSource: ReferralProviderSource;
  code: string;
  linkId: string;
  expiresAt: Date;
}>;

export interface AttributionProviderAdapter {
  readonly source: ReferralProviderSource;
  verify(token: string,now: Date): Promise<VerifiedAttribution>;
}

export class FirstPartyAttributionProvider implements AttributionProviderAdapter {
  readonly source='first_party' as const;
  constructor(private readonly secret:string) {}
  issue(input:Readonly<{ code:string;linkId:string;expiresAt:Date }>) {
    const payload=Buffer.from(JSON.stringify({ v:1,code:input.code,eventId:input.linkId,exp:input.expiresAt.getTime() }))
      .toString('base64url');
    return `${payload}.${this.signature(payload)}`;
  }
  async verify(token:string,now:Date):Promise<VerifiedAttribution> {
    if(token.length>2_048)throw new Error('REFERRAL_TOKEN_INVALID');
    const [payload,signature,...extra]=token.split('.');
    if (!payload || !signature || extra.length || !safeEqual(signature,this.signature(payload))) throw new Error('REFERRAL_SIGNATURE_INVALID');
    let value:unknown;
    try { value=JSON.parse(Buffer.from(payload,'base64url').toString('utf8')); } catch { throw new Error('REFERRAL_TOKEN_INVALID'); }
    if (!isObject(value) || value.v!==1 || typeof value.code!=='string' || !/^[A-Z0-9]{8,24}$/u.test(value.code)
      || typeof value.eventId!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.eventId)
      || typeof value.exp!=='number' || !Number.isSafeInteger(value.exp)) throw new Error('REFERRAL_TOKEN_INVALID');
    const expiresAt=new Date(value.exp);
    if (expiresAt<=now) throw new Error('REFERRAL_TOKEN_EXPIRED');
    return { providerSource:this.source,code:value.code,linkId:value.eventId,expiresAt };
  }
  private signature(payload:string) { return createHmac('sha256',this.secret).update(payload).digest('base64url'); }
}

export interface ExternalAttributionProviderAdapter extends AttributionProviderAdapter {
  readonly source:'douyin'|'tiktok';
  // Reserved boundary: implementations must verify the provider signature and
  // return its immutable event id. No provider secrets are configured today.
}

export function referralCode() {
  return randomBytes(8).toString('base64url').replace(/[-_]/gu,'').toUpperCase().slice(0,12).padEnd(12,'K');
}
function safeEqual(left:string,right:string) {
  const a=Buffer.from(left); const b=Buffer.from(right); return a.length===b.length&&timingSafeEqual(a,b);
}
function isObject(value:unknown):value is Record<string,unknown> { return typeof value==='object'&&value!==null&&!Array.isArray(value); }
