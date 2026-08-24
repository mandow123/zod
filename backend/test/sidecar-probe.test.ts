import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { honghuanCanonicalResourceIds, probeInquiryOrigin } from '../deploy/direct-ubuntu/probe-inquiry.mjs';

const servers: Server[] = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

async function fixtureOrigin(readiness:'technical'|'expected'|'technical_blocked'|'extra_blocker'|'bad' = 'technical',
detailHtml = false) {
  const server = createServer((request, response) => {
    const path = request.url ?? '/';
    if (path === '/mobile/v1/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, service: 'kai-cloudpay-backend', apiVersion: 'mobile/v1' }));
      return;
    }
    if (path === '/mobile/v1/readiness') {
      const technicalReady=readiness==='technical';
      const expectedBlockers=['UNIFIED_IDENTITY','APP_STORED_SESSION','INQUIRY_OPERATIONAL_EVIDENCE',
        'KAI_PAIRED_PROBE_30M','APP_STORED_SESSION_PROBE_24H','ICP_FILING_NOT_APPROVED',
        'APP_FILING_NOT_APPROVED','INTERNET_SERVICE_CLASSIFICATION_REQUIRED'];
      const legalBlockers=['ICP_FILING_NOT_APPROVED','APP_FILING_NOT_APPROVED','INTERNET_SERVICE_CLASSIFICATION_REQUIRED'];
      const blockers=technicalReady?legalBlockers:readiness==='expected'?expectedBlockers:
        readiness==='technical_blocked'?[...legalBlockers,'KAI_PAIRED_PROBE_30M']:
          readiness==='extra_blocker'?[...legalBlockers,'DATABASE']:['DATABASE'];
      const technicalEvidenceReady=!['expected','technical_blocked','bad'].includes(readiness);
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, service: 'kai-cloudpay-backend',
        profile: { id: 'inquiry_only', routePolicy: 'allowlist-v1' },
        deployment: { ready: false, blockers },
        release: { ready: false, profile: 'inquiry_only', scope: 'supplier_inquiry',
          blockers },
        capabilities: { services: { ready: true },database:true,authentication:true,backup:true,legal:true,
          observability:true,publicHttps:true,honghuanSupplierCatalog:{ready:true},appSessionProbe:{ready:technicalEvidenceReady},
          kaiPairedProbe: { ready: technicalEvidenceReady },durability:{mode:'local_only',riskAccepted:true,offsiteBackup:false,
            highAvailability:false,disasterRecovery:false},
          backupRecovery: { backup: { ready: true }, restore: { ready: true } } },
        commerce: { enabled: false, ready: false, reason: 'PROFILE_DISABLED', releaseBlocking: false } }));
      return;
    }
    const legal = { '/privacy': '隐私政策', '/terms': '用户协议', '/inquiry-terms': '资源询期规则',
      '/account/delete': '删除 CloudPay 账户' }[path];
    if (legal) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<html>KAI CloudPay ${legal}</html>`);
      return;
    }
    if (path === '/mobile/v1/supplier-inquiry-catalog?limit=50') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, items: honghuanCanonicalResourceIds.map((resourceId, index) => ({
        resourceId, catalogKind: index === honghuanCanonicalResourceIds.length - 1 ? 'contract_monthly' : 'hourly_gpu',
      })) }));
      return;
    }
    if (path.startsWith('/mobile/v1/supplier-inquiry-catalog/')) {
      const resourceId = decodeURIComponent(path.slice('/mobile/v1/supplier-inquiry-catalog/'.length));
      const index = honghuanCanonicalResourceIds.indexOf(resourceId);
      if (detailHtml && index === 0) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><html>legacy shell</html>');
        return;
      }
      response.writeHead(index >= 0 ? 200 : 404, { 'content-type': 'application/json' });
      response.end(index >= 0 ? JSON.stringify({ ok: true, item: { resourceId,
        catalogKind: index === honghuanCanonicalResourceIds.length - 1 ? 'contract_monthly' : 'hourly_gpu' } })
        : JSON.stringify({ ok: false, error: { code: 'NOT_FOUND' } }));
      return;
    }
    if (path === '/mobile/v1/me' || path === '/mobile/v1/resource-inquiries') {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: { code: 'AUTH_REQUIRED' } }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND' } }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not bind');
  return `http://127.0.0.1:${address.port}`;
}

describe('private sidecar inquiry-only cutover probe', () => {
  it('accepts Stage B only when technical evidence is ready and exactly three legal blockers remain', async () => {
    const probe = await probeInquiryOrigin(await fixtureOrigin());
    expect(probe.ok).toBe(true);
    expect(probe.records).toHaveLength(29);
    expect(probe.failures).toEqual([]);
  });

  it('rejects a healthy process whose release readiness is still closed', async () => {
    const probe = await probeInquiryOrigin(await fixtureOrigin('bad'), {allowExpectedPublicProofBlockers:true});
    expect(probe.ok).toBe(false);
    expect(probe.failures).toContain('/mobile/v1/readiness: inquiry-only release is not ready');
  });

  it('permits exactly the five public-proof and three legal blockers before route activation', async () => {
    const probe = await probeInquiryOrigin(await fixtureOrigin('expected'), {allowExpectedPublicProofBlockers:true});
    expect(probe.ok).toBe(true);
    expect(probe.failures).toEqual([]);
  });

  it.each(['technical_blocked','extra_blocker'] as const)(
    'rejects Stage B when a technical or extra blocker remains: %s', async (readiness) => {
      const probe = await probeInquiryOrigin(await fixtureOrigin(readiness));
      expect(probe.ok).toBe(false);
      expect(probe.failures).toContain('/mobile/v1/readiness: inquiry-only release is not ready');
    },
  );

  it('rejects an old HTML shell returned in place of a formal catalog detail', async () => {
    const probe = await probeInquiryOrigin(await fixtureOrigin('technical', true));
    expect(probe.ok).toBe(false);
    expect(probe.failures.some((failure) => failure.includes('mismatched, or HTML'))).toBe(true);
  });
});
