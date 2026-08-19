export function parseOwnedReferralToken(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  const customScheme = url.protocol === 'kaicloudpay:' && url.hostname === 'referral' && url.pathname === '';
  const universalLink = url.protocol === 'https:' && url.hostname === 'cloudpay.kai.com'
    && url.pathname.replace(/\/$/u, '') === '/referral';
  if ((!customScheme && !universalLink) || url.username || url.password || url.port || url.hash) return null;
  const token = url.searchParams.get('token')?.trim();
  return token && /^[A-Za-z0-9_-]{8,256}$/u.test(token) ? token : null;
}
