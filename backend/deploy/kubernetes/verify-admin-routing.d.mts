export type AdminAuthState = 'disabled' | 'enabled';

export type AdminRoutingReport = {
  schemaVersion: 1;
  checkedAt: string;
  authState: AdminAuthState;
  ok: boolean;
  decision: 'keep_admin_routes' | 'remove_admin_routes';
  rollback: null | { removeOnly: string[]; preserve: string[]; reason: string };
  checks: Array<{ name: string; pass: boolean; detail: string }>;
  probes: {
    web: Array<{ path: string; status: number; contentType: string } | null>;
    api: Array<{ path?: string; status?: number; contentType?: string; errorCode: string | null }>;
  };
  failures: string[];
};

export function parseAdminRoutingArguments(values: string[]): Record<'web-origin' | 'api-origin' | 'auth-state' | 'report', string>;
export function verifyAdminRouting(options: {
  webOrigin: string;
  apiOrigin: string;
  authState: AdminAuthState;
  fetchImplementation?: typeof fetch;
  routingContract?: unknown;
}): Promise<AdminRoutingReport>;
export function writeImmutableAdminRoutingReport(path: string, report: AdminRoutingReport): Promise<string>;
