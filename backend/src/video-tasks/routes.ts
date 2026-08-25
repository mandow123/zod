import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors.js';
import type { AccountService } from '../account/service.js';
import { VideoTaskService } from './service.js';

const bodySchema = z.object({ prompt: z.string().trim().min(3).max(2_000) }).strict();
const paramsSchema = z.object({ taskId: z.string().trim().min(1).max(200) }).strict();
function parse<T>(schema: z.ZodType<T>, value: unknown): T { const parsed = schema.safeParse(value); if (!parsed.success) throw new AppError('VALIDATION_ERROR', 400, '提交的信息不完整或格式不正确。'); return parsed.data; }
async function userId(request: FastifyRequest, accounts: AccountService) { return (await accounts.authenticate(request.headers.authorization)).principal.userId; }

export async function registerVideoTaskRoutes(app: FastifyInstance, accounts: AccountService, service: VideoTaskService) {
  app.post('/mobile/v1/video-tasks', async (request, reply) => {
    const task = await service.create(await userId(request, accounts), parse(bodySchema, request.body).prompt);
    return reply.status(201).send({ ok: true, task: service.serialize(task) });
  });
  app.get('/mobile/v1/video-tasks/:taskId', async (request) => {
    const task = await service.refresh(await userId(request, accounts), parse(paramsSchema, request.params).taskId);
    return { ok: true, task: service.serialize(task) };
  });
}
