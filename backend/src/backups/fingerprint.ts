import { loadConfig } from '../config.js';
import { databaseFingerprint } from './postgres.js';

const config = loadConfig(process.env);
if (!config.DATABASE_URL) throw new Error('DATABASE_URL is required.');
process.stdout.write(`${JSON.stringify({ targetFingerprint: databaseFingerprint(config.DATABASE_URL) })}\n`);
