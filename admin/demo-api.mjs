const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const DEMO_CSRF_TOKEN = 'kai-admin-local-demo-csrf';

const permissions = Object.freeze([
  'admin.overview.read',
  'admin.order.read',
  'admin.device-order.read',
  'admin.payout.read',
  'admin.topup.read',
]);

const computeOrders = Object.freeze([
  {
    id: 'demo-compute-001', orderNumber: 'KAI-C-20260820-001', status: 'active',
    quantity: '8', capacityUnit: 'H100', totalCreditMicros: '288000000',
    createdAt: '2026-08-20T01:20:00.000Z', updatedAt: '2026-08-20T02:15:00.000Z',
  },
  {
    id: 'demo-compute-002', orderNumber: 'KAI-C-20260819-014', status: 'fulfilled',
    quantity: '4', capacityUnit: 'H100', totalCreditMicros: '144000000',
    createdAt: '2026-08-19T06:40:00.000Z', updatedAt: '2026-08-20T00:30:00.000Z',
  },
]);

const deviceOrders = Object.freeze([
  {
    id: 'demo-device-001', orderNumber: 'KAI-D-20260820-006', status: 'processing',
    quantity: '2', grossCreditMicros: '196000000',
    createdAt: '2026-08-20T00:45:00.000Z', updatedAt: '2026-08-20T02:05:00.000Z',
  },
  {
    id: 'demo-device-002', orderNumber: 'KAI-D-20260818-021', status: 'shipped',
    quantity: '1', grossCreditMicros: '98000000',
    createdAt: '2026-08-18T04:10:00.000Z', updatedAt: '2026-08-19T09:00:00.000Z',
  },
]);

const payouts = Object.freeze([
  {
    id: 'demo-payout-001', payoutNumber: 'KAI-P-20260820-003', status: 'pending',
    creditMicros: '76000000', paymentAmountCents: '76000',
    createdAt: '2026-08-20T02:00:00.000Z', updatedAt: '2026-08-20T02:00:00.000Z',
  },
  {
    id: 'demo-payout-002', payoutNumber: 'KAI-P-20260819-011', status: 'paid',
    creditMicros: '52000000', paymentAmountCents: '52000',
    createdAt: '2026-08-19T03:30:00.000Z', updatedAt: '2026-08-19T08:20:00.000Z',
  },
]);

const topups = Object.freeze([
  {
    id: 'demo-topup-001', provider: 'stripe', status: 'succeeded', amountCents: '128000',
    currency: 'CNY', creditMicros: '128000000', reversedAmountCents: '0', reversedCreditMicros: '0',
    createdAt: '2026-08-20T01:50:00.000Z', updatedAt: '2026-08-20T01:52:00.000Z',
  },
  {
    id: 'demo-topup-002', provider: 'stripe', status: 'review', amountCents: '36000',
    currency: 'CNY', creditMicros: '36000000', reversedAmountCents: '0', reversedCreditMicros: '0',
    createdAt: '2026-08-19T10:15:00.000Z', updatedAt: '2026-08-20T01:10:00.000Z',
  },
]);

const pages = new Map([
  ['/admin/v1/compute-orders', computeOrders],
  ['/admin/v1/device-orders', deviceOrders],
  ['/admin/v1/payouts', payouts],
  ['/admin/v1/topups', topups],
]);

function setCommonHeaders(response) {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
}

function json(response, statusCode, body) {
  setCommonHeaders(response);
  response.statusCode = statusCode;
  response.setHeader('content-type', JSON_CONTENT_TYPE);
  response.end(JSON.stringify(body));
}

function empty(response, statusCode) {
  setCommonHeaders(response);
  response.statusCode = statusCode;
  response.end();
}

function normalizeReturnTo(value) {
  if (!value || !value.startsWith('/') || value.startsWith('//') || /[\u0000-\u001f\u007f]/u.test(value)) return '/';
  try {
    const parsed = new URL(value, 'https://admin.invalid');
    return parsed.origin === 'https://admin.invalid' ? `${parsed.pathname}${parsed.search}${parsed.hash}` : '/';
  } catch {
    return '/';
  }
}

function mePayload() {
  return {
    admin: {
      displayName: '本地演示管理员',
      email: 'demo@localhost.invalid',
      roles: ['support_viewer', 'finance_viewer'],
      permissions,
      authzVersion: 1,
    },
    session: {
      createdAt: '2026-08-20T00:00:00.000Z',
      idleExpiresAt: '2099-01-01T00:00:00.000Z',
      absoluteExpiresAt: '2099-01-01T00:00:00.000Z',
      reauthenticatedAt: '2026-08-20T00:00:00.000Z',
    },
    csrfToken: DEMO_CSRF_TOKEN,
  };
}

function dashboardPayload() {
  return {
    metrics: {
      computeOrders: { total: computeOrders.length, active: 1 },
      deviceOrders: { total: deviceOrders.length, active: 1 },
      payouts: { total: payouts.length, pending: 1 },
      topups: { total: topups.length, attentionRequired: 1 },
    },
    activity: [
      { id: 'activity-1', resource: 'payout', displayId: payouts[0].payoutNumber, status: payouts[0].status, occurredAt: payouts[0].updatedAt },
      { id: 'activity-2', resource: 'compute-order', displayId: computeOrders[0].orderNumber, status: computeOrders[0].status, occurredAt: computeOrders[0].updatedAt },
      { id: 'activity-3', resource: 'device-order', displayId: deviceOrders[0].orderNumber, status: deviceOrders[0].status, occurredAt: deviceOrders[0].updatedAt },
      { id: 'activity-4', resource: 'topup', displayId: topups[0].id, status: topups[0].status, occurredAt: topups[0].updatedAt },
    ],
  };
}

export function handleAdminDemoRequest(request, response, next) {
  const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (!requestUrl.pathname.startsWith('/admin/v1/')) {
    next();
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/admin/v1/auth/me') {
    json(response, 200, mePayload());
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/admin/v1/auth/login') {
    response.statusCode = 302;
    response.setHeader('cache-control', 'no-store');
    response.setHeader('location', normalizeReturnTo(requestUrl.searchParams.get('returnTo') ?? '/'));
    response.end();
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/admin/v1/auth/logout') {
    if (request.headers['x-admin-csrf'] !== DEMO_CSRF_TOKEN) {
      json(response, 403, { error: { code: 'ADMIN_CSRF_INVALID' } });
      return;
    }
    empty(response, 204);
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/admin/v1/dashboard') {
    json(response, 200, dashboardPayload());
    return;
  }

  const items = pages.get(requestUrl.pathname);
  if (request.method === 'GET' && items) {
    json(response, 200, { items, nextCursor: null });
    return;
  }

  json(response, 404, { error: { code: 'ADMIN_DEMO_ROUTE_NOT_FOUND' } });
}

export function createAdminDemoApi() {
  return {
    name: 'kai-admin-local-demo-api',
    apply: 'serve',
    configureServer(server) {
      server.config.logger.info('KAI administrator local demo API enabled (synthetic data only).');
      server.middlewares.use(handleAdminDemoRequest);
    },
  };
}
