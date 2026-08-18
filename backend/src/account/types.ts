export const LEGAL_VERSIONS = {
  terms: '2026-08-11',
  privacy: '2026-08-11',
  inquiry: '2026-08-18',
} as const;

export type OtpPurpose = 'register' | 'login' | 'delete_account';

export type DeviceDescriptor = Readonly<{
  deviceId: string;
  appVersion: string;
  platform: 'android' | 'ios';
}>;

export type AccountUser = Readonly<{
  id: string;
  phoneCiphertext: string | null;
  phoneLookupHash: string | null;
  emailCiphertext?: string | null;
  displayName: string;
  role: 'member' | 'supplier' | 'operator' | 'admin';
  status: 'pending' | 'active' | 'suspended' | 'deletion_pending' | 'anonymized';
  createdAt: Date;
}>;

export type SessionIdentity = Readonly<{
  sessionId: string;
  tokenFamily: string;
  user: AccountUser;
  device: DeviceDescriptor;
  expiresAt: Date;
  revokedAt: Date | null;
}>;

export type AccountPrincipal = Readonly<{
  userId: string;
  sessionId: string;
  role: AccountUser['role'];
}>;

export type ConsentInput = Readonly<{
  kind: 'terms' | 'privacy';
  version: string;
}>;

export type AccountDeletion = Readonly<{
  id: string;
  status: 'requested' | 'cooling_off' | 'blocked_by_legal_hold' | 'processing' | 'completed' | 'cancelled';
  coolingOffUntil: Date;
  requestedAt: Date;
  legalHoldReason: string | null;
}>;
