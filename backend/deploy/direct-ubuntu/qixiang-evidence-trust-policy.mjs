// This release intentionally contains no trust anchors. A signer is enabled only
// by a reviewed source change that pins its public-key fingerprint, legal identity,
// authority role, and exact evidence kinds. Runtime files cannot grant authority.
export const QIXIANG_EVIDENCE_TRUST_POLICY = Object.freeze([]);

export function authorizeQixiangEvidenceSigner(policy, input) {
  if (!Array.isArray(policy) || !input || typeof input !== 'object') return false;
  return policy.some((entry) => entry && Object.keys(entry).sort().join(',') ===
      'authorityKind,evidenceKinds,issuerIdentifier,issuerLegalName,publicKeySha256'
    && /^[0-9a-f]{64}$/u.test(entry.publicKeySha256)
    && entry.publicKeySha256 === input.publicKeySha256
    && entry.authorityKind === input.authorityKind
    && entry.issuerIdentifier === input.issuerIdentifier
    && entry.issuerLegalName === input.issuerLegalName
    && Array.isArray(entry.evidenceKinds) && entry.evidenceKinds.includes(input.evidenceKind));
}
