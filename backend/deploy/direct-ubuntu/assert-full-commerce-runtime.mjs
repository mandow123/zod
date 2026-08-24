import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import {
  loadQixiangCheckoutKey, loadQixiangGatePublicKey, loadQixiangGateReceipt, loadQixiangMerchantKey,
  qixiangCheckoutKeyPath, qixiangGatePublicKeyPath, qixiangMerchantKeyPath,
} from '../../dist/payment/qixiang-credential.js';
import { qixiangDatabaseGateState, QixiangProductionGate } from '../../dist/topups/qixiang-production-gate.js';

const directory = process.env.CREDENTIALS_DIRECTORY;
if (process.platform !== 'linux' || !directory) throw new Error('QIXIANG_RUNTIME_CREDENTIALS_UNAVAILABLE');
const merchantKey = loadQixiangMerchantKey(qixiangMerchantKeyPath({ credentialDirectory: directory }));
const checkoutKey = loadQixiangCheckoutKey(qixiangCheckoutKeyPath({ credentialDirectory: directory }));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5_000,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : false });
try {
  const gate = new QixiangProductionGate({
    receipt: loadQixiangGateReceipt('/var/lib/kai-cloudpay-public-gates/qixiang-production-gate.json'),
    verificationPublicKeyPem: loadQixiangGatePublicKey(qixiangGatePublicKeyPath(directory)),
    environment: process.env,
    merchantKey,
    checkoutKey,
    releaseManifestSha256: createHash('sha256').update(readFileSync(join(process.cwd(), 'RELEASE-MANIFEST.json'))).digest('hex'),
    receiptLoader: () => loadQixiangGateReceipt('/var/lib/kai-cloudpay-public-gates/qixiang-production-gate.json'),
    databaseStateLoader: () => qixiangDatabaseGateState((text, values) => pool.query(text, values)),
  });
  await gate.requireStartup();
  process.stdout.write('PASS qixiang_full_commerce_runtime_gate\n');
} finally { checkoutKey.fill(0); await pool.end(); }
