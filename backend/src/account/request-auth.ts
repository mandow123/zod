import type { FastifyRequest } from 'fastify';
import type { AccountService } from './service.js';

export function authenticateMobileRequest(accounts: AccountService, request: FastifyRequest) {
  return accounts.authenticate(
    request.headers.authorization,
    request.headers['x-kai-id-token'],
    request.raw.rawHeaders,
  );
}

export function authenticateMobileBootstrapRequest(accounts: AccountService, request: FastifyRequest) {
  return accounts.authenticateBootstrap(
    request.headers.authorization,
    request.headers['x-kai-id-token'],
    request.raw.rawHeaders,
  );
}
