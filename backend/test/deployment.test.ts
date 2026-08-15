import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function text(path: string) { return readFile(new URL(path, import.meta.url), 'utf8'); }

describe('production deployment baseline', () => {
  it('builds a pinned non-root runtime with health checks and PostgreSQL backup tools', async () => {
    const dockerfile = await text('../Dockerfile');
    expect(dockerfile.match(/^FROM node:24\.18\.0-bookworm-slim/gmu)).toHaveLength(2);
    expect(dockerfile).toContain('postgresql-client');
    expect(dockerfile).toContain('USER node');
    expect(dockerfile).toContain('HEALTHCHECK');
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/bin/tini", "--"]');
    expect(dockerfile).not.toMatch(/COPY\s+\.\s+\./u);
  });

  it('uses immutable images, guarded rollout, isolated metrics, and non-overlapping backup jobs', async () => {
    const app = await text('../deploy/kubernetes/app.yaml');
    const migration = await text('../deploy/kubernetes/migrate-job.yaml');
    const backup = await text('../deploy/kubernetes/backup-cronjob.yaml');
    const combined = `${app}\n${migration}\n${backup}`;
    expect(combined).not.toContain('kind: Secret');
    expect(combined).not.toMatch(/image:\s*[^\n]+:(?:latest|main)\b/u);
    expect(combined.match(/image:\s*[^\n]+@sha256:[a-f0-9]{64}/gu)).toHaveLength(3);
    expect(app).toContain('replicas: 3');
    expect(app).toContain('maxUnavailable: 0');
    expect(app).toContain('kind: PodDisruptionBudget');
    expect(app).toContain('kind: HorizontalPodAutoscaler');
    expect(app).toContain('maxReplicas: 10');
    expect(app).toContain('kind: NetworkPolicy');
    expect(app).toContain('readOnlyRootFilesystem: true');
    expect(app).toContain('runAsNonRoot: true');
    expect(app).toContain('automountServiceAccountToken: false');
    expect(app).toContain('path: /mobile/v1/readiness');
    expect(app).toContain('path: /account/delete');
    expect(app).toContain('path: /privacy');
    expect(app).toContain('path: /terms');
    expect(app).not.toContain('path: /internal/metrics');
    expect(migration).toContain('command: ["node", "dist/migrate.js"]');
    expect(migration).toContain('activeDeadlineSeconds: 900');
    expect(backup).toContain('concurrencyPolicy: Forbid');
    expect(backup).toContain('command: ["node", "dist/backups/backup.js"]');
    expect(backup).toContain('activeDeadlineSeconds: 3300');
    expect(backup).toContain('mountPath: /var/lib/cloudpay-backup');
  });
});
