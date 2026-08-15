import type { FastifyRequest } from 'fastify';
import { AppError } from './errors.js';

const restrictedChannels = new Set(['google-play', 'app-store']);

export function assertDirectCommerceChannel(request: FastifyRequest) {
  const channel = request.headers['x-kai-distribution-channel'];
  const value = Array.isArray(channel) ? channel[0] : channel;
  if (value && restrictedChannels.has(value)) {
    throw new AppError('DISTRIBUTION_CHANNEL_RESTRICTED', 403, '此版本不提供充值或新增购买。');
  }
}
