export type QixiangEvidenceTrustEntry = Readonly<{
  publicKeySha256: string;
  authorityKind: 'government' | 'qualified_legal_counsel' | 'payment_provider'
    | 'device_acceptance_attestor' | 'independent_acceptance_attestor';
  issuerIdentifier: string;
  issuerLegalName: string;
  evidenceKinds: readonly string[];
}>;
export const QIXIANG_EVIDENCE_TRUST_POLICY: readonly QixiangEvidenceTrustEntry[];
export function authorizeQixiangEvidenceSigner(policy: readonly QixiangEvidenceTrustEntry[], input: Readonly<{
  publicKeySha256: string; authorityKind: string; issuerIdentifier: string; issuerLegalName: string;
  evidenceKind: string;
}>): boolean;
