export function isExactQixiangRetiredKeyRejection(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'code,msg'
    && value.code === -3 && value.msg === '商户密钥错误');
}

export function isCurrentComplianceReview(value, nowMs, maximumAgeMs = 30 * 24 * 60 * 60_000) {
  const reviewedAt = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(reviewedAt) && reviewedAt <= nowMs + 60_000 && nowMs - reviewedAt <= maximumAgeMs;
}
