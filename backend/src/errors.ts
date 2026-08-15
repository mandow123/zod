import type { FastifyInstance } from 'fastify';

export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function installErrorHandling(app: FastifyInstance) {
  app.setNotFoundHandler((request, reply) => reply.status(404).send({
    ok: false,
    error: { code: 'NOT_FOUND', message: '请求的服务不存在。', requestId: request.id },
  }));

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        ok: false,
        error: { code: error.code, message: error.message, details: error.details, requestId: request.id },
      });
    }

    if (typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 429) {
      return reply.status(429).send({
        ok: false,
        error: { code: 'RATE_LIMITED', message: '操作太频繁，请稍后再试。', requestId: request.id },
      });
    }

    request.log.error({ err: error }, 'request failed');
    return reply.status(500).send({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用，请稍后重试。', requestId: request.id },
    });
  });
}
