export type FulfillmentStatus =
  | 'pending'
  | 'provisioning'
  | 'ready'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'failed';

export type SafeConnectionDescriptor = Readonly<{
  protocol: 'ssh' | 'https' | 'jupyter' | 'rdp' | 'custom';
  host: string;
  port: number;
  hostKeyFingerprint: string;
  knownHostsEntry: string;
  displayName: string;
}>;

export type FulfillmentAttestation = Readonly<{
  nonce: string;
  orderId: string;
  resourceId: string;
  bindingId: string;
  bindingGeneration: number;
  policyDigest: string;
  nodeId: string;
  capacityUnit: string;
  allocatedGpuUuids: string[];
  hardExpiresAt: string;
  hostKeyFingerprint: string;
  bootId: string;
  eventSequence: number;
  observedAt: string;
  heartbeatId: string;
  acceleratorModel: string;
  nodeAcceleratorCount: number;
  allocatedAcceleratorCount: number;
  driverVersion: string;
  memoryTotalMiB: number;
  migMode: 'Disabled';
  computeMode: 'Default';
  evidenceDigest: string;
  signature: string;
}>;

export type FulfillmentRecord = Readonly<{
  id: string;
  orderId: string;
  buyerSubjectId: string;
  supplierSubjectId: string;
  resourceId: string;
  providerKey: string;
  providerLeaseId: string | null;
  provisionalProviderLeaseId: string | null;
  status: FulfillmentStatus;
  connection: SafeConnectionDescriptor | null;
  attestationDigest: string | null;
  failureCode: string | null;
  failureRetryable: boolean | null;
  allocatedAcceleratorCount: number;
  resourceSlotLimit: number;
  provisioningDeadlineAt: Date;
  createdAt: Date;
  provisioningAt: Date | null;
  readyAt: Date | null;
  runningAt: Date | null;
  stoppingAt: Date | null;
  hardExpiresAt: Date | null;
  stoppedAt: Date | null;
  failedAt: Date | null;
  updatedAt: Date;
}>;

export const ENTER_COMPUTE_STATES: readonly FulfillmentStatus[] = ['ready', 'running'];

export function fulfillmentActions(status: FulfillmentStatus, side: 'buyer' | 'provider', canResolveMetering = false) {
  if (side === 'buyer') {
    return [
      ...(ENTER_COMPUTE_STATES.includes(status) ? ['create_access_session' as const] : []),
      ...(status === 'ready' || status === 'running' ? ['stop_fulfillment' as const] : []),
      ...(status === 'stopped' && canResolveMetering ? ['accept_fulfillment' as const] : []),
      ...(status === 'stopped' && canResolveMetering ? ['report_fulfillment_issue' as const] : []),
    ];
  }
  return status === 'pending' ? ['provision_fulfillment' as const] : [];
}
