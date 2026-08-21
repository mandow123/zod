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

  it('ships an isolated and fail-closed administrator Kubernetes boundary', async () => {
    const app = await text('../deploy/kubernetes/app.yaml');
    const admin = await text('../deploy/kubernetes/admin-app.yaml');
    const canary = await text('../deploy/kubernetes/admin-api-canary.yaml');
    const routing = JSON.parse(await text('../deploy/kubernetes/admin-routing-contract.json')) as {
      web: { host: string; path: string; pathType: string; service: string; tlsSecret: string };
      api: { host: string; path: string; pathType: string; service: string; tlsSecret: string };
      canary: {
        manifest: string; deployment: string; service: string; replicas: number;
        adminAuthEnabled: boolean; imageMustMatchDeployment: string; mainService: string; ingress: string;
      };
      transitions: { stageC: string[]; stageD: string[]; emergencyDisable: string[] };
      rollback: { removeOnly: string[]; preserve: string[] };
    };

    expect(app).toContain('ADMIN_AUTH_ENABLED: "false"');
    expect(app).toContain('ADMIN_WEB_ORIGIN: https://admin.kai.com');
    expect(app).toContain('ADMIN_API_ORIGIN: https://admin-api.kai.com');
    expect(app).toContain('ADMIN_OIDC_REDIRECT_URI: https://admin-api.kai.com/admin/v1/auth/callback');
    expect(app).toMatch(/name: cloudpay-admin-auth-secrets\s+optional: true/u);
    expect(app).not.toMatch(/^  ADMIN_(?:OIDC_CLIENT_SECRET|SESSION_TOKEN_PEPPER|PII_ENCRYPTION_KEY):/mu);

    expect(admin).not.toContain('kind: Secret');
    expect(admin.match(/image:\s*[^\n]+@sha256:[a-f0-9]{64}/gu)).toHaveLength(1);
    expect(admin).toContain('replicas: 2');
    expect(admin).toContain('maxUnavailable: 0');
    expect(admin).toContain('kind: PodDisruptionBudget');
    expect(admin).toContain('runAsNonRoot: true');
    expect(admin).toContain('runAsUser: 101');
    expect(admin).toContain('fsGroup: 101');
    expect(admin).toContain('readOnlyRootFilesystem: true');
    expect(admin).toContain('allowPrivilegeEscalation: false');
    expect(admin).toContain('mountPath: /etc/nginx/conf.d');
    expect(admin.match(/path: \/healthz/gu)).toHaveLength(3);
    expect(admin).toContain('host: admin.kai.com');
    expect(admin).toContain('host: admin-api.kai.com');
    expect(admin).toContain('path: /admin/v1');
    expect(admin).toContain('secretName: cloudpay-admin-kai-com-tls');
    expect(admin).toContain('secretName: cloudpay-admin-api-kai-com-tls');
    expect(admin).not.toContain('host: cloudpay.kai.com');
    expect(admin).not.toContain('path: /mobile/v1');

    const mainImage = app.match(/image:\s*(\S+@sha256:[a-f0-9]{64})/u)?.[1];
    const canaryImage = canary.match(/image:\s*(\S+@sha256:[a-f0-9]{64})/u)?.[1];
    expect(canaryImage).toBe(mainImage);
    expect(canary).not.toContain('kind: Secret');
    expect(canary).toContain('name: cloudpay-admin-api-canary');
    expect(canary).toContain('replicas: 1');
    expect(canary).toContain('type: Recreate');
    expect(canary).toMatch(/name: ADMIN_AUTH_ENABLED\s*\n\s+value: "true"/u);
    expect(canary).toContain('name: cloudpay-backend-config');
    expect(canary).toContain('name: cloudpay-backend-secrets');
    expect(canary).toContain('name: cloudpay-admin-auth-secrets');
    expect(canary).not.toMatch(/name: cloudpay-admin-auth-secrets\s*\n\s+optional: true/u);
    expect(canary).toContain('runAsNonRoot: true');
    expect(canary).toContain('readOnlyRootFilesystem: true');
    expect(canary).toContain('allowPrivilegeEscalation: false');
    expect(canary.match(/path: \/mobile\/v1\/health/gu)).toHaveLength(2);
    expect(canary.match(/path: \/mobile\/v1\/readiness/gu)).toHaveLength(1);
    expect(canary.match(/kind: Service/gu)).toHaveLength(1);
    expect(canary.match(/kind: NetworkPolicy/gu)).toHaveLength(1);
    expect(canary).not.toMatch(/^\s+app\.kubernetes\.io\/name: cloudpay-backend\s*$/mu);

    expect(routing.web).toEqual({
      host: 'admin.kai.com', path: '/', service: 'cloudpay-admin-web',
      pathType: 'Prefix', tlsSecret: 'cloudpay-admin-kai-com-tls',
    });
    expect(routing.api).toEqual({
      host: 'admin-api.kai.com', path: '/admin/v1', service: 'cloudpay-backend',
      pathType: 'Prefix', tlsSecret: 'cloudpay-admin-api-kai-com-tls',
    });
    expect(routing.canary).toEqual({
      manifest: 'admin-api-canary.yaml', deployment: 'cloudpay-admin-api-canary',
      service: 'cloudpay-admin-api-canary', replicas: 1, adminAuthEnabled: true,
      imageMustMatchDeployment: 'cloudpay-backend', mainService: 'cloudpay-backend',
      ingress: 'cloudpay-admin-api',
    });
    expect(routing.transitions.stageC).toEqual([
      'apply_canary_manifest', 'wait_canary_ready', 'verify_canary_admin_environment',
      'switch_admin_api_ingress_main_to_canary', 'verify_enabled_admin_routes',
    ]);
    expect(routing.transitions.stageD).toEqual([
      'set_main_admin_auth_enabled_true', 'restart_main_backend', 'wait_main_backend_rollout',
      'verify_every_main_pod_admin_environment', 'switch_admin_api_ingress_canary_to_main',
      'verify_enabled_admin_routes', 'delete_canary_manifest',
    ]);
    expect(routing.transitions.emergencyDisable).toEqual([
      'set_main_admin_auth_enabled_false', 'restart_main_backend', 'wait_main_backend_rollout',
      'verify_every_main_pod_admin_auth_disabled', 'remove_admin_ingresses', 'delete_canary_manifest',
    ]);
    expect(routing.rollback.removeOnly).toEqual([
      'ingress/cloudpay-admin-web', 'ingress/cloudpay-admin-api',
    ]);
    expect(routing.rollback.preserve).toEqual(expect.arrayContaining([
      'ingress/cloudpay-mobile-api', 'deployment/cloudpay-backend',
      'database migrations', 'admin audit data',
    ]));
  });

  it('alerts only on exported low-cardinality administrator metrics', async () => {
    const monitoring = await text('../deploy/kubernetes/admin-monitoring.yaml');
    expect(monitoring).toContain('apiVersion: monitoring.coreos.com/v1');
    expect(monitoring).toContain('kind: PrometheusRule');
    for (const metric of [
      'cloudpay_admin_login_events_24h', 'cloudpay_admin_security_denials_24h',
      'cloudpay_admin_operation_failures_24h', 'cloudpay_admin_audit_append_failures_total',
      'cloudpay_admin_http_5xx_total',
      'cloudpay_admin_active_sessions',
      'cloudpay_admin_revoked_sessions_24h',
    ]) expect(monitoring).toContain(metric);
    for (const alert of [
      'KAIAdminAuditAppendFailures', 'KAIAdminHttp5xxResponses', 'KAIAdminOperationFailures',
      'KAIAdminLoginDeniedOrFailedSpike',
      'KAIAdminSecurityDenialSpike', 'KAIAdminActiveSessionsHigh', 'KAIAdminRevokedSessionsHigh',
    ]) expect(monitoring).toContain(`alert: ${alert}`);
    expect(monitoring).toContain('max(cloudpay_admin_active_sessions) > 100');
    expect(monitoring).toContain('sum(increase(cloudpay_admin_audit_append_failures_total[5m])) > 0');
    expect(monitoring).toContain('sum(increase(cloudpay_admin_http_5xx_total[5m])) > 0');
    expect(monitoring).not.toMatch(/(?:email|group|request_?id|session_?id|request_?url)\s*[=~]/iu);
    expect(monitoring).not.toContain('http_requests');
  });
});
