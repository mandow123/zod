import { resolve } from 'node:path';
import { androidToolchainEnvironment, runGradle } from './android-toolchain.mjs';

const tasks = process.argv.slice(2);
if (tasks.length === 0 || tasks.some((task) => !/^[A-Za-z][A-Za-z0-9:]*$/u.test(task))) {
  throw new Error('Usage: run-android-gradle.mjs <GradleTask> [GradleTask...]');
}

const root = resolve(import.meta.dirname, '..');
const result = runGradle(root, tasks, {
  stdio: 'inherit',
  env: androidToolchainEnvironment(),
});
if (result.status !== 0) {
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  process.exit(result.status ?? 1);
}
