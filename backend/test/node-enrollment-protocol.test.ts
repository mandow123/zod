import { createPrivateKey, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  canonicalClaimProof, canonicalHeartbeatProof, decryptClaimToken, encryptClaimToken, normalizeInventory,
  protocolPayloadDigest, verifyNodeProof, type RawGpuInventory,
} from '../src/node-enrollment/protocol.js';
import { inventoryMismatchForResource } from '../src/node-enrollment/store.js';

const vector = JSON.parse(await readFile(new URL('../../test/fixtures/node-protocol-v1.json', import.meta.url), 'utf8'));

describe('node enrollment protocol v1', () => {
  it('matches the shared canonicalization, digest, and Ed25519 vectors', () => {
    const inventory = normalizeInventory(vector.rawInventory as RawGpuInventory[]);
    expect(inventory).toEqual(vector.inventory);
    for (const proof of [
      { canonical: canonicalClaimProof(vector.claim.fields), vector: vector.claim },
      { canonical: canonicalHeartbeatProof(vector.heartbeat.fields), vector: vector.heartbeat },
    ]) {
      expect(proof.canonical).toBe(proof.vector.canonical);
      expect(protocolPayloadDigest(proof.canonical)).toBe(proof.vector.payloadDigest);
      expect(verifyNodeProof(vector.publicKey, proof.canonical, proof.vector.signature)).toBe(true);
      const privateKey = createPrivateKey({ key: vector.privateJwk, format: 'jwk' });
      expect(`ed25519:${sign(null, Buffer.from(proof.canonical), privateKey).toString('base64')}`).toBe(proof.vector.signature);
    }
  });

  it('uses audited GPU family, count, and versioned capacity bounds', () => {
    const inventory80 = normalizeInventory(vector.rawInventory as RawGpuInventory[]);
    expect(inventoryMismatchForResource(inventory80, 'H100-SXM-80G', { gpuCount: 2, memoryGiBPerGpu: 80 })).toBeNull();
    expect(inventoryMismatchForResource(inventory80, 'H100-SXM-80G', { gpuCount: 8, memoryGiBPerGpu: 80 })).toBe('GPU_COUNT_MISMATCH');
    expect(inventoryMismatchForResource(inventory80, 'A100-80G', { gpuCount: 2, memoryGiBPerGpu: 80 })).toBe('GPU_MODEL_MISMATCH');
    expect(inventoryMismatchForResource(inventory80, 'H100-SXM-98G', { gpuCount: 2, memoryGiBPerGpu: 98 })).toBe('GPU_MEMORY_MISMATCH');
    const inventory98 = normalizeInventory((vector.rawInventory as RawGpuInventory[]).map((gpu) => ({ ...gpu, memoryTotalMiB: 97_871 })));
    expect(inventoryMismatchForResource(inventory98, 'H100-SXM5-98G', { gpuCount: 2, memoryGiBPerGpu: 98 })).toBeNull();
    const inventoryTooSmall = normalizeInventory((vector.rawInventory as RawGpuInventory[]).map((gpu) => ({ ...gpu, memoryTotalMiB: 90_000 })));
    expect(inventoryMismatchForResource(inventoryTooSmall, 'H100-SXM5-98G', { gpuCount: 2, memoryGiBPerGpu: 98 }))
      .toBe('GPU_MEMORY_MISMATCH');
  });

  it('rejects signature replay across node and proof domains', () => {
    expect(verifyNodeProof(vector.publicKey, vector.heartbeat.canonical.replace(vector.heartbeat.fields.nodeId,
      '44444444-4444-4444-8444-444444444444'), vector.heartbeat.signature)).toBe(false);
    expect(verifyNodeProof(vector.publicKey, vector.claim.canonical, vector.heartbeat.signature)).toBe(false);
  });

  it('authenticates recoverable claim tokens with bound AAD', () => {
    const key = Buffer.alloc(32, 7).toString('base64'); const token = 'T'.repeat(43);
    const aad = { claimId: vector.claim.fields.claimId, deploymentId: '55555555-5555-4555-8555-555555555555',
      clientRequestId: 'claim-request-0001' };
    const envelope = encryptClaimToken(token, key, aad);
    const middle = Math.floor(envelope.ciphertext.length / 2); const original = envelope.ciphertext[middle]!;
    const tampered = `${envelope.ciphertext.slice(0, middle)}${original === 'A' ? 'B' : 'A'}${envelope.ciphertext.slice(middle + 1)}`;
    expect(decryptClaimToken(envelope.ciphertext, envelope.nonce, key, aad)).toBe(token);
    expect(() => decryptClaimToken(tampered, envelope.nonce, key, aad)).toThrow('CLAIM_TOKEN_RECOVERY_FAILED');
    expect(() => decryptClaimToken(envelope.ciphertext, envelope.nonce, key, { ...aad,
      clientRequestId: 'claim-request-0002' })).toThrow('CLAIM_TOKEN_RECOVERY_FAILED');
    expect(() => decryptClaimToken(envelope.ciphertext, envelope.nonce, Buffer.alloc(32, 8).toString('base64'), aad))
      .toThrow('CLAIM_TOKEN_RECOVERY_FAILED');
  });
});
