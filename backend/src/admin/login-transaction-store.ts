import type { QueryResultRow } from 'pg';
import type { Database } from '../database.js';
import type { AdminLoginTransaction, AdminLoginTransactionStatus } from './types.js';

type LoginRow = QueryResultRow & {
  id: string; state_hash: string; browser_binding_hash: string; nonce_hash: string;
  pkce_verifier_ciphertext: string; return_path: string; status: AdminLoginTransactionStatus;
  expires_at: Date; consumed_at: Date | null; created_ip_hash: string; user_agent_hash: string;
  failure_code: string | null; created_at: Date;
};
const columns = `id, state_hash, browser_binding_hash, nonce_hash, pkce_verifier_ciphertext,
 return_path, status, expires_at, consumed_at, created_ip_hash, user_agent_hash, failure_code, created_at`;
function map(row: LoginRow): AdminLoginTransaction {
  return { id: row.id, stateHash: row.state_hash, browserBindingHash: row.browser_binding_hash,
    nonceHash: row.nonce_hash, pkceVerifierCiphertext: row.pkce_verifier_ciphertext,
    returnPath: row.return_path, status: row.status, expiresAt: row.expires_at,
    consumedAt: row.consumed_at, createdIpHash: row.created_ip_hash,
    userAgentHash: row.user_agent_hash, failureCode: row.failure_code, createdAt: row.created_at };
}
export type ConsumeAdminLoginTransactionResult =
  | Readonly<{ status: 'consumed'; transaction: AdminLoginTransaction }>
  | Readonly<{ status: 'invalid' | 'binding_mismatch' | 'expired' | 'unavailable' }>;
export interface AdminLoginTransactionStore {
  create(input: Readonly<Omit<AdminLoginTransaction, 'status' | 'consumedAt' | 'failureCode'>>): Promise<void>;
  consume(input: Readonly<{ stateHash: string; browserBindingHash: string; now: Date }>): Promise<ConsumeAdminLoginTransactionResult>;
  fail(input: Readonly<{ transactionId: string; failureCode: string; now: Date }>): Promise<boolean>;
}
export class PostgresAdminLoginTransactionStore implements AdminLoginTransactionStore {
  constructor(private readonly database: Database) {}
  async create(input: Parameters<AdminLoginTransactionStore['create']>[0]) {
    await this.database.query(
      `INSERT INTO admin_login_transactions(id,state_hash,browser_binding_hash,nonce_hash,
       pkce_verifier_ciphertext,return_path,status,expires_at,consumed_at,created_ip_hash,
       user_agent_hash,failure_code,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'started',$7,NULL,$8,$9,NULL,$10)`,
      [input.id,input.stateHash,input.browserBindingHash,input.nonceHash,input.pkceVerifierCiphertext,
        input.returnPath,input.expiresAt,input.createdIpHash,input.userAgentHash,input.createdAt],
    );
  }
  async consume(input: Parameters<AdminLoginTransactionStore['consume']>[0]) {
    return this.database.transaction(async (client): Promise<ConsumeAdminLoginTransactionResult> => {
      const result = await client.query<LoginRow>(
        `SELECT ${columns} FROM admin_login_transactions WHERE state_hash = $1 FOR UPDATE`, [input.stateHash],
      );
      const row = result.rows[0];
      if (!row) return { status: 'invalid' };
      if (row.browser_binding_hash !== input.browserBindingHash) return { status: 'binding_mismatch' };
      if (row.status !== 'started') return { status: 'unavailable' };
      if (new Date(row.expires_at) <= input.now) {
        await client.query(
          `UPDATE admin_login_transactions SET status = 'expired', failure_code = 'TRANSACTION_EXPIRED'
           WHERE id = $1`, [row.id],
        );
        return { status: 'expired' };
      }
      const consumed = await client.query<LoginRow>(
        `UPDATE admin_login_transactions SET status = 'consumed', consumed_at = $2
         WHERE id = $1 AND status = 'started' RETURNING ${columns}`, [row.id,input.now],
      );
      if (!consumed.rows[0]) return { status: 'unavailable' };
      return { status: 'consumed', transaction: map(consumed.rows[0]) };
    });
  }
  async fail(input: Parameters<AdminLoginTransactionStore['fail']>[0]) {
    if (!/^[A-Z0-9_]{1,80}$/u.test(input.failureCode)) throw new Error('ADMIN_LOGIN_FAILURE_CODE_INVALID');
    const result = await this.database.query(
      `UPDATE admin_login_transactions SET status = 'failed', failure_code = $2,
       consumed_at = COALESCE(consumed_at, $3)
       WHERE id = $1 AND status = 'consumed'`,
      [input.transactionId,input.failureCode,input.now],
    );
    return (result.rowCount ?? 0) === 1;
  }
}
