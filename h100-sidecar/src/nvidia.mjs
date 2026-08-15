import { createHash } from 'node:crypto';
import { runCommand } from './command.mjs';

export function parseNvidiaSmiCsv(value) {
  const rows = value.trim().split(/\r?\n/u).filter(Boolean).map((line) => line.split(',').map((field) => field.trim()));
  if (!rows.length || rows.some((row) => row.length !== 6 || !/^GPU-[A-Fa-f0-9-]+$/u.test(row[0])
    || !/^\d+$/u.test(row[3]) || !['Enabled', 'Disabled'].includes(row[4])
    || !['Default', 'Exclusive_Process', 'Prohibited', 'Exclusive_Thread'].includes(row[5]))) {
    throw new Error('NVIDIA_SMI_OUTPUT_INVALID');
  }
  return rows.map(([uuid, model, driverVersion, memoryTotalMiB, migMode, computeMode], index) => ({
    index, uuid, model, driverVersion, memoryTotalMiB: Number(memoryTotalMiB), migMode, computeMode,
  }));
}

export async function inspectNvidia(run = runCommand) {
  const result = await run('nvidia-smi', [
    '--query-gpu=uuid,name,driver_version,memory.total,mig.mode.current,compute_mode',
    '--format=csv,noheader,nounits'], { timeoutMs: 10_000 });
  const gpus = parseNvidiaSmiCsv(result.stdout);
  const canonical = JSON.stringify(gpus.map(({ uuid, model, driverVersion, memoryTotalMiB, migMode, computeMode }) => (
    { uuid, model, driverVersion, memoryTotalMiB, migMode, computeMode })));
  return { gpus, evidenceDigest: `sha256:${createHash('sha256').update(canonical).digest('hex')}` };
}

export function parseCudaVersion(value) {
  const match = /CUDA Version:\s*([0-9]+(?:\.[0-9]+){1,2})/u.exec(value);
  if (!match?.[1]) throw new Error('NVIDIA_CUDA_VERSION_INVALID');
  return match[1];
}

export async function inspectNodeInventory(run = runCommand) {
  const hardware = await inspectNvidia(run);
  const overview = await run('nvidia-smi', [], { timeoutMs: 10_000 });
  const cudaVersion = parseCudaVersion(overview.stdout);
  return hardware.gpus.map(({ uuid, model, driverVersion, memoryTotalMiB, migMode, computeMode }) => (
    { uuid, model, memoryTotalMiB, driverVersion, cudaVersion, migMode, computeMode }));
}
