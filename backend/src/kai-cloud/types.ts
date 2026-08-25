export type KaiCloudVerificationStatus = 'pending' | 'running' | 'passed' | 'failed' | 'revoked';

export type KaiCloudVerification = Readonly<{
  id: string;
  version: number;
  status: KaiCloudVerificationStatus;
  updatedAt: string;
  failure: null | Readonly<{ code: string; message: string }>;
}>;

export type KaiCloudDeviceStatus = Readonly<{
  id: string;
  status: 'registering' | 'checking' | 'ready' | 'offline' | 'revoked';
  lastHeartbeatAt: string | null;
  updatedAt: string;
}>;

export interface KaiCloudPublicApi {
  readonly available: boolean;
  createVerification(input: Readonly<{
    organizationReference: string;
    resourceReference: string;
    productCode: string;
    region: string;
    specifications: Record<string, unknown>;
    idempotencyKey: string;
  }>): Promise<KaiCloudVerification>;
  getVerification(id: string): Promise<KaiCloudVerification>;
  revokeVerification(id: string, idempotencyKey: string): Promise<KaiCloudVerification>;
  getDevice(id: string): Promise<KaiCloudDeviceStatus>;
}
