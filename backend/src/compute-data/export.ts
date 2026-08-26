import { createDatabase } from '../database.js';
import { loadConfig } from '../config.js';
import { ComputeDataFlywheelService } from './service.js';
import { PostgresComputeDataFlywheelStore } from './store.js';

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredDate(name: string) {
  const raw = argument(name);
  const parsed = raw ? new Date(raw) : new Date(Number.NaN);
  if (!raw || !Number.isFinite(parsed.getTime())) throw new Error(`${name} requires an ISO-8601 timestamp`);
  return parsed;
}

const config = loadConfig(process.env);
const database = createDatabase(config);
if (!database) throw new Error('DATABASE_URL is required to export compute data.');

try {
  const key = process.env.COMPUTE_DATA_EXPORT_PEPPER ?? '';
  const rawLimit = argument('--limit');
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  if (limit !== undefined && !Number.isSafeInteger(limit)) throw new Error('--limit must be an integer');
  const service = new ComputeDataFlywheelService(new PostgresComputeDataFlywheelStore(database));
  const exported = await service.exportDataset({
    from: requiredDate('--from'), to: requiredDate('--to'),
    ...(limit === undefined ? {} : { limit }), anonymizationKey: key,
  });
  if (exported.hasMore) {
    throw new Error('EXPORT_RANGE_TOO_LARGE: narrow the time range; no rows were written');
  }
  for (const row of exported.rows) process.stdout.write(`${JSON.stringify(row)}\n`);
  process.stderr.write(JSON.stringify({ datasetVersion: exported.datasetVersion,
    asOf: exported.asOf, rowCount: exported.rows.length }) + '\n');
} finally {
  await database.close();
}
