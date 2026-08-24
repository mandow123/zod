const forbiddenMobilePaths = [
  '/mobile/v1/provider/bootstrap', '/mobile/v1/provider/resources', '/mobile/v1/provider/offer-drafts',
  '/mobile/v1/provider/offers', '/mobile/v1/provider/listings', '/mobile/v1/market/resources',
  '/mobile/v1/credits/balance', '/mobile/v1/orders', '/mobile/v1/operator/resource-inquiries',
];

export const inquiryProbePaths = [
  '/mobile/v1/health', '/mobile/v1/readiness', '/privacy', '/terms', '/inquiry-terms', '/account/delete',
  '/mobile/v1/supplier-inquiry-catalog?limit=50', '/mobile/v1/me', '/mobile/v1/resource-inquiries',
  ...forbiddenMobilePaths,
];

export const honghuanCanonicalResourceIds = [
  'gpu-honghuan-a100-sxm4-80gb-1', 'gpu-honghuan-a100-sxm4-80gb-2',
  'gpu-honghuan-h100-sxm-80gb-1', 'gpu-honghuan-h100-sxm-80gb-2',
  'gpu-honghuan-h200-nvl-1', 'gpu-honghuan-h200-nvl-2',
  'gpu-honghuan-b200-179gb-1', 'gpu-honghuan-b200-179gb-2', 'gpu-honghuan-b200-179gb-4',
  'gpu-honghuan-b300-269gb-1', 'server-honghuan-b300-monthly-32plus',
];

function mediaType(response) {
  return ((response.headers.get('content-type') ?? '').split(';')[0] ?? '').trim().toLowerCase();
}

async function fetchRecord(origin, path) {
  const response = await fetch(new URL(path, origin), {
    redirect: 'manual', signal: AbortSignal.timeout(8_000),
    headers: { accept: path.startsWith('/mobile/v1') ? 'application/json' : 'text/html',
      host: 'cloudpay.kai.com', 'x-forwarded-host': 'cloudpay.kai.com', 'x-forwarded-proto': 'https' },
  });
  const body = Buffer.from(await response.arrayBuffer());
  return { path, status: response.status, contentType: mediaType(response), cacheControl: response.headers.get('cache-control'),
    bytes: body.length, body };
}

function json(record) {
  try { return JSON.parse(record.body.toString('utf8')); } catch { return null; }
}

export async function probeInquiryOrigin(rawOrigin, options = {}) {
  const origin = new URL(rawOrigin);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('Inquiry probes require a canonical HTTP(S) origin.');
  }
  const records = [];
  for (const path of inquiryProbePaths) records.push(await fetchRecord(origin, path));
  const catalogPath = '/mobile/v1/supplier-inquiry-catalog?limit=50';
  const initialByPath = Object.fromEntries(records.map((record) => [record.path, record]));
  const initialCatalogBody = json(initialByPath[catalogPath]);
  if (Array.isArray(initialCatalogBody?.items)) {
    for (const item of initialCatalogBody.items) {
      if (typeof item?.resourceId === 'string') records.push(await fetchRecord(origin,
        `/mobile/v1/supplier-inquiry-catalog/${encodeURIComponent(item.resourceId)}`));
    }
  }
  const byPath = Object.fromEntries(records.map((record) => [record.path, record]));
  const failures = [];
  const health = byPath['/mobile/v1/health'];
  const healthBody = json(health);
  if (health.status !== 200 || health.contentType !== 'application/json' || healthBody?.ok !== true
    || healthBody?.service !== 'kai-cloudpay-backend' || healthBody?.apiVersion !== 'mobile/v1') {
    failures.push('/mobile/v1/health: invalid service identity');
  }
  const readiness = byPath['/mobile/v1/readiness'];
  const readinessBody = json(readiness);
  const sharedReadinessReady = readinessBody?.profile?.id === 'inquiry_only'
    && readinessBody?.profile?.routePolicy === 'allowlist-v1' && readinessBody?.release?.scope === 'supplier_inquiry'
    && readinessBody?.commerce?.enabled === false && readinessBody?.commerce?.reason === 'PROFILE_DISABLED'
    && readinessBody?.capabilities?.services?.ready === true
    && readinessBody?.capabilities?.durability?.mode === 'local_only'
    && readinessBody?.capabilities?.durability?.riskAccepted === true
    && readinessBody?.capabilities?.durability?.offsiteBackup === false
    && readinessBody?.capabilities?.durability?.highAvailability === false
    && readinessBody?.capabilities?.durability?.disasterRecovery === false
    && readinessBody?.capabilities?.backupRecovery?.backup?.ready === true
    && readinessBody?.capabilities?.backupRecovery?.restore?.ready === true;
  const exactBlockers = (actual, expected) => Array.isArray(actual) && actual.length === expected.size
    && new Set(actual).size === expected.size && actual.every((item) => expected.has(item));
  const expectedLegalBlockers = new Set(['ICP_FILING_NOT_APPROVED', 'APP_FILING_NOT_APPROVED',
    'INTERNET_SERVICE_CLASSIFICATION_REQUIRED']);
  const technicalAcceptanceReady = readiness.status === 503 && readiness.contentType === 'application/json'
    && readinessBody?.ok === false && sharedReadinessReady
    && readinessBody?.deployment?.ready === false && readinessBody?.release?.ready === false
    && readinessBody?.capabilities?.database === true && readinessBody?.capabilities?.authentication === true
    && readinessBody?.capabilities?.backup === true && readinessBody?.capabilities?.legal === true
    && readinessBody?.capabilities?.observability === true && readinessBody?.capabilities?.publicHttps === true
    && readinessBody?.capabilities?.honghuanSupplierCatalog?.ready === true
    && readinessBody?.capabilities?.kaiPairedProbe?.ready === true
    && readinessBody?.capabilities?.appSessionProbe?.ready === true
    && exactBlockers(readinessBody?.deployment?.blockers, expectedLegalBlockers)
    && exactBlockers(readinessBody?.release?.blockers, expectedLegalBlockers);
  const expectedPreCutoverBlockers = new Set(['UNIFIED_IDENTITY', 'APP_STORED_SESSION', 'INQUIRY_OPERATIONAL_EVIDENCE',
    'KAI_PAIRED_PROBE_30M', 'APP_STORED_SESSION_PROBE_24H', 'ICP_FILING_NOT_APPROVED',
    'APP_FILING_NOT_APPROVED', 'INTERNET_SERVICE_CLASSIFICATION_REQUIRED']);
  const actualPreCutoverBlockers = new Set(readinessBody?.release?.blockers ?? []);
  const preCutoverReady = readiness.status === 503 && readiness.contentType === 'application/json'
    && readinessBody?.ok === false && sharedReadinessReady
    && readinessBody?.capabilities?.services?.ready === true && readinessBody?.capabilities?.database === true
    && readinessBody?.capabilities?.authentication === true && readinessBody?.capabilities?.backup === true
    && readinessBody?.capabilities?.legal === true && readinessBody?.capabilities?.observability === true
    && readinessBody?.capabilities?.publicHttps === true
    && readinessBody?.capabilities?.backupRecovery?.backup?.ready === true
    && readinessBody?.capabilities?.backupRecovery?.restore?.ready === true
    && readinessBody?.capabilities?.honghuanSupplierCatalog?.ready === true
    && exactBlockers(readinessBody?.release?.blockers, expectedPreCutoverBlockers)
    && actualPreCutoverBlockers.size === expectedPreCutoverBlockers.size
    && JSON.stringify(readinessBody?.deployment?.blockers) === JSON.stringify(readinessBody?.release?.blockers);
  if (options.allowExpectedPublicProofBlockers === true ? !preCutoverReady : !technicalAcceptanceReady) {
    failures.push('/mobile/v1/readiness: inquiry-only release is not ready');
  }
  for (const [path, marker] of [['/privacy', '隐私政策'], ['/terms', '用户协议'],
    ['/inquiry-terms', '资源询期规则'], ['/account/delete', '删除 CloudPay 账户']]) {
    const record = byPath[path];
    const html = record.body.toString('utf8');
    if (record.status !== 200 || record.contentType !== 'text/html' || !html.includes('KAI CloudPay') || !html.includes(marker)) {
      failures.push(`${path}: legal page missing`);
    }
  }
  const catalog = byPath[catalogPath];
  const catalogBody = json(catalog);
  if (catalog.status !== 200 || catalog.contentType !== 'application/json'
    || catalogBody?.ok !== true || catalogBody?.items?.length !== 11) {
    failures.push('/mobile/v1/supplier-inquiry-catalog: exact 11-item catalog missing');
  } else {
    const ids = catalogBody.items.map((item) => item?.resourceId).sort();
    const kinds = catalogBody.items.map((item) => item?.catalogKind);
    if (JSON.stringify(ids) !== JSON.stringify([...honghuanCanonicalResourceIds].sort())
      || kinds.filter((kind) => kind === 'hourly_gpu').length !== 10
      || kinds.filter((kind) => kind === 'contract_monthly').length !== 1) {
      failures.push('/mobile/v1/supplier-inquiry-catalog: canonical 10 hourly + 1 contract manifest mismatch');
    }
    for (const item of catalogBody.items) {
      const detailPath = `/mobile/v1/supplier-inquiry-catalog/${encodeURIComponent(item.resourceId)}`;
      const detailRecord = byPath[detailPath];
      const detail = detailRecord ? json(detailRecord) : null;
      if (!detailRecord || detailRecord.status !== 200 || detailRecord.contentType !== 'application/json'
        || detail?.ok !== true || detail?.item?.resourceId !== item.resourceId
        || detail?.item?.catalogKind !== item.catalogKind
        || /<!doctype\s+html|<html\b/iu.test(detailRecord.body.toString('utf8'))) {
        failures.push(`${detailPath}: catalog detail is missing, mismatched, or HTML`);
      }
    }
  }
  for (const path of ['/mobile/v1/me', '/mobile/v1/resource-inquiries']) {
    const record = byPath[path];
    const body = json(record);
    if (record.status !== 401 || record.contentType !== 'application/json'
      || body?.ok !== false || typeof body?.error?.code !== 'string') failures.push(`${path}: paired KAI protection missing`);
  }
  for (const path of forbiddenMobilePaths) {
    const record = byPath[path];
    const body = json(record);
    if (record.status !== 404 || record.contentType !== 'application/json'
      || body?.ok !== false || body?.error?.code !== 'NOT_FOUND') failures.push(`${path}: route must be physically absent`);
  }
  return {
    origin: origin.origin, ok: failures.length === 0, failures,
    records: records.map(({ body: _body, ...record }) => record),
    signatures: Object.fromEntries(records.map((record) => {
      const body = json(record);
      return [record.path, { status: record.status, contentType: record.contentType,
        service: body?.service ?? null, apiVersion: body?.apiVersion ?? null, errorCode: body?.error?.code ?? null }];
    })),
  };
}
