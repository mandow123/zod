export function localE2EOtpForPhone(
  requestedPhone: string,
  payload: unknown,
) {
  if (!payload || typeof payload !== 'object') return null;
  const { phone, code } = payload as { phone?: unknown; code?: unknown };
  if (typeof phone !== 'string' || typeof code !== 'string' || !/^\d{6}$/u.test(code)) return null;
  const requestedDigits = requestedPhone.replace(/\D/gu, '');
  const deliveredDigits = phone.replace(/\D/gu, '');
  return requestedDigits.length >= 11 && deliveredDigits.endsWith(requestedDigits) ? code : null;
}
