export const VAST_PROVIDER_SOURCE = 'vast_ai' as const;

export type VastOffer = Readonly<{
  offerId: string;
  gpuName: string;
  gpuCount: number;
  gpuMemoryMb: number;
  region: string;
  reliability: number;
  providerCostMicrosPerHour: bigint;
  updatedAt: Date;
}>;

export type VastInstance = Readonly<{
  contractId: string;
  label: string | null;
  offerId: string | null;
  status: string | null;
}>;

export type VastLaunchConfiguration = Readonly<{
  image: string;
  diskGb: number;
  runtype: 'ssh' | 'ssh_direct' | 'jupyter' | 'jupyter_direct';
}>;

export type VastPricingPolicy = Readonly<{
  version: string;
  cardHourMicrosPerProviderUsd: bigint;
  markupBasisPoints: number;
  quoteTtlSeconds: number;
  reconciliationGraceSeconds: number;
  defaultImage: string;
  defaultDiskGb: number;
  defaultRuntype: VastLaunchConfiguration['runtype'];
}>;

export type VastExternalOrderStatus = 'reserved' | 'pending_reconciliation' | 'provisioning' | 'failed';
