import { spawnSync } from 'node:child_process';

export const validProjectId = (value) => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);

export function optionalExpoProjectId(environment = process.env) {
  const projectId = environment.CLOUDPAY_EAS_PROJECT_ID?.trim();
  if (!projectId) return undefined;
  if (!validProjectId(projectId)) {
    throw new Error('CLOUDPAY_EAS_PROJECT_ID must be a real Expo project UUID when Expo push is enabled.');
  }
  return projectId;
}

export function androidVersionEvidence(candidateVersionCode, environment = process.env) {
  const publishedRaw = environment.CLOUDPAY_PUBLISHED_ANDROID_VERSION_CODE?.trim();
  const neverPublished = environment.CLOUDPAY_ANDROID_PACKAGE_NEVER_PUBLISHED?.trim() === '1';
  if (Boolean(publishedRaw) === neverPublished) {
    throw new Error('Set exactly one of CLOUDPAY_PUBLISHED_ANDROID_VERSION_CODE or CLOUDPAY_ANDROID_PACKAGE_NEVER_PUBLISHED=1.');
  }
  if (neverPublished) return { kind: 'never-published', candidateVersionCode };
  if (!/^\d+$/u.test(publishedRaw ?? '')) {
    throw new Error('CLOUDPAY_PUBLISHED_ANDROID_VERSION_CODE must be a non-negative integer.');
  }
  const publishedVersionCode = Number(publishedRaw);
  if (!Number.isSafeInteger(publishedVersionCode) || candidateVersionCode <= publishedVersionCode) {
    throw new Error(`Android versionCode ${candidateVersionCode} must be greater than published ${String(publishedVersionCode)}.`);
  }
  return { kind: 'published-version', candidateVersionCode, publishedVersionCode };
}

export function expoProjectBinding(projectId, root, environment = process.env) {
  if (!validProjectId(projectId)) return { ok: false, evidence: 'CLOUDPAY_EAS_PROJECT_ID is missing or invalid.' };
  const result = spawnSync('npx', ['--yes', 'eas-cli', 'project:info'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...environment, CLOUDPAY_EAS_PROJECT_ID: projectId },
    timeout: 60_000,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  const discoveredIds = [...output.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/giu)]
    .map((match) => match[0].toLowerCase());
  const matches = result.status === 0 && discoveredIds.includes(projectId.toLowerCase());
  return {
    ok: matches,
    evidence: matches ? `EAS project ${projectId}` : (output.split(/\r?\n/u).filter(Boolean).at(-1) ?? 'EAS project lookup failed.'),
  };
}
