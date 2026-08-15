import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import type { RuntimeConfig } from './config.js';
import { verifySchema } from './schema.js';

export interface Database {
  health(): Promise<boolean>;
  schemaReadiness(): Promise<Awaited<ReturnType<typeof verifySchema>>>;
  query<Row extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>;
  transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function createDatabase(config: RuntimeConfig): Database | null {
  if (!config.DATABASE_URL) return null;
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: config.databaseSsl ? { rejectUnauthorized: true } : false,
  });

  return {
    async health() {
      try {
        await pool.query('SELECT 1');
        return true;
      } catch {
        return false;
      }
    },
    schemaReadiness() { return verifySchema((text, values) => pool.query(text, values)); },
    query(text, values) {
      return pool.query(text, values);
    },
    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}
