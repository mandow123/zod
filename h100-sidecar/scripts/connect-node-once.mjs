#!/usr/bin/env node
import { loadSidecarConfig } from '../src/config.mjs';
import { OutboundNodeClient } from '../src/node-client.mjs';

try {
  const client = new OutboundNodeClient(loadSidecarConfig());
  await client.connectOnce();
} catch (error) {
  process.stderr.write(`${JSON.stringify({ level: 'error', event: 'node_connect_failed',
    code: error?.code ?? 'NODE_CONNECT_CONFIGURATION_INVALID' })}\n`);
  process.exitCode = 1;
}
