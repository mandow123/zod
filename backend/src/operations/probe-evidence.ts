import { createHmac } from 'node:crypto';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

export function probeEvidenceDigest(metadata: Record<string, unknown>, auditPepper: string) {
  return createHmac('sha256', auditPepper).update(JSON.stringify(canonical(metadata))).digest('hex');
}
