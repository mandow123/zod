export function isDedicatedGpuHour(input: Readonly<{
  kind: string;
  capacityUnit: string;
  serviceMode?: string;
}>) {
  return input.kind === 'gpu' && input.capacityUnit === 'GPU时'
    && (input.serviceMode === undefined || input.serviceMode === 'dedicated');
}

export function dedicatedGpuServiceTitle(productCode: string) {
  const product = productCode.trim().replace(/^\d+\s*[×xX*]\s*/u, '').trim();
  if (!product) return 'GPU 单卡独享';
  return /(?:单卡|整卡).*独享/u.test(product) ? product : `${product} 单卡独享`;
}

export function gpuHourMeaning(quantity: string) {
  return `${quantity} GPU时 = 1 张 GPU × ${quantity} 小时`;
}

export function nodeGpuCount(specifications: Record<string, unknown>) {
  for (const key of ['gpuCount', 'nodeAcceleratorCount', 'acceleratorCount']) {
    const value = specifications[key];
    const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
    if (Number.isInteger(number) && number > 0 && number <= 64) return number;
  }
  return null;
}

export function memoryGiBPerGpu(specifications: Record<string, unknown>) {
  for (const key of ['memoryGiBPerGpu', 'gpuMemoryGiB', 'memoryPerGpuGiB']) {
    const value = specifications[key];
    const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
    if (Number.isFinite(number) && number > 0 && number <= 1_000_000) return number;
  }
  return null;
}

export function gpuNodeSummary(specifications: Record<string, unknown>) {
  const count = nodeGpuCount(specifications);
  const memory = memoryGiBPerGpu(specifications);
  const parts = [
    count ? `${count} 张 GPU` : null,
    memory ? `单卡 ${memory} GB` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}
