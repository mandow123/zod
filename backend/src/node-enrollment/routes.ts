import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AccountService } from '../account/service.js';
import { AppError } from '../errors.js';
import type { NodeEnrollmentService } from './service.js';
import { authenticateMobileRequest } from '../account/request-auth.js';

const uuid = z.string().uuid(); const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const inventoryItem = z.object({ uuid: z.string().min(12).max(84), model: z.string().min(2).max(120),
  memoryTotalMiB: z.number().int().min(1).max(1_048_576), driverVersion: z.string().min(1).max(64),
  cudaVersion: z.string().min(1).max(64), migMode: z.enum(['Enabled', 'Disabled']),
  computeMode: z.enum(['Default', 'Exclusive_Process', 'Prohibited', 'Exclusive_Thread']) }).strict();
const evidence = { observedAt: z.string().datetime(), agentVersion: z.string().min(1).max(64),
  inventory: z.array(inventoryItem).min(1).max(64), inventoryDigest: digest, runtimeDigest: digest,
  policyDigest: digest, signature: z.string().regex(/^ed25519:[A-Za-z0-9+/=]{80,160}$/u) };

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError('VALIDATION_ERROR', 400, '提交的信息不完整或格式不正确。');
  return parsed.data;
}
function context(request: FastifyRequest) { return { requestId: request.id, ip: request.ip }; }
function noStore(reply: FastifyReply) { reply.header('Cache-Control', 'no-store, private').header('Pragma', 'no-cache'); return reply; }
function idempotencyKey(request: FastifyRequest) { return String(request.headers['idempotency-key'] ?? ''); }
function claimToken(request: FastifyRequest) {
  const match = /^NodeClaim ([A-Za-z0-9_-]{43,120})$/u.exec(String(request.headers.authorization ?? ''));
  if (!match?.[1]) throw new AppError('NODE_CLAIM_AUTH_REQUIRED', 401, '缺少节点认领凭证。');
  return match[1];
}

export async function registerNodeEnrollmentRoutes(
  app: FastifyInstance, accounts: AccountService, service: NodeEnrollmentService,
) {
  app.post('/mobile/v1/provider/assets/:assetId/node-claims', async (request, reply) => {
    noStore(reply); parse(z.undefined(), request.body);
    const { principal } = await authenticateMobileRequest(accounts, request);
    const { assetId } = parse(z.object({ assetId: uuid }).strict(), request.params);
    const result = await service.issueClaim(principal, assetId, idempotencyKey(request), context(request));
    return noStore(reply).status(result.replayed ? 200 : 201).send({ ok: true, claim: {
      ...result, protocolVersion: 1, consumePath: `/node/v1/claims/${result.claimId}/consume`,
    } });
  });
  app.delete('/mobile/v1/provider/assets/:assetId/node-enrollments/:deploymentId', async (request, reply) => {
    noStore(reply); parse(z.undefined(), request.body);
    const { principal } = await authenticateMobileRequest(accounts, request);
    const { assetId, deploymentId } = parse(z.object({ assetId: uuid, deploymentId: uuid }).strict(), request.params);
    return noStore(reply).send({ ok: true,
      ...(await service.revoke(principal, assetId, deploymentId, context(request))) });
  });
  app.post('/node/v1/claims/:claimId/consume', async (request, reply) => {
    noStore(reply);
    const { claimId } = parse(z.object({ claimId: uuid }).strict(), request.params);
    const body = parse(z.object({ publicKey: z.string().regex(/^ed25519:[A-Za-z0-9+/=]{40,120}$/u), ...evidence }).strict(), request.body);
    const node = await service.consume({ claimId, claimToken: claimToken(request), ...body }, context(request));
    return noStore(reply).send({ ok: true, node: {
      ...node, protocolVersion: 1, heartbeatPath: `/node/v1/nodes/${node.nodeId}/heartbeats`,
    } });
  });
  app.post('/node/v1/nodes/:nodeId/heartbeats', async (request, reply) => {
    noStore(reply);
    const { nodeId } = parse(z.object({ nodeId: uuid }).strict(), request.params);
    const body = parse(z.object({ bootId: uuid, sequence: z.string().regex(/^[1-9]\d{0,18}$/u), ...evidence }).strict(), request.body);
    const heartbeat = await service.heartbeat({ nodeId, ...body }, context(request));
    return noStore(reply).status(heartbeat.readiness === 'checking' && !heartbeat.replayed ? 202 : 200)
      .send({ ok: true, heartbeat });
  });
}
