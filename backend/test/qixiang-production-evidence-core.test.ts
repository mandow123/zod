import { describe, expect, it } from 'vitest';
import { authorizeQixiangEvidenceSigner } from '../deploy/direct-ubuntu/qixiang-evidence-trust-policy.mjs';
import { isCurrentComplianceReview, isExactQixiangRetiredKeyRejection }
  from '../deploy/direct-ubuntu/qixiang-production-evidence-core.mjs';

const signer={publicKeySha256:'a'.repeat(64),authorityKind:'payment_provider' as const,
  issuerIdentifier:'qixiang-provider-legal-id',issuerLegalName:'七相支付',evidenceKinds:['qixiang_refund_api_approval']};

describe('Qixiang executable production evidence rules',()=>{
  it('accepts only the exact provider response that proves an old key is invalid',()=>{
    expect(isExactQixiangRetiredKeyRejection({code:-3,msg:'商户密钥错误'})).toBe(true);
    for(const value of [{code:-3,msg:'限频'},{code:-4,msg:'商户密钥错误'},{code:-3,msg:'商户密钥错误',retry:true},
      {code:500,msg:'业务异常'},null])expect(isExactQixiangRetiredKeyRejection(value)).toBe(false);
  });
  it('pins a signer to its exact authority, legal identity and evidence kind',()=>{
    const policy=[signer];const valid={publicKeySha256:signer.publicKeySha256,authorityKind:signer.authorityKind,
      issuerIdentifier:signer.issuerIdentifier,issuerLegalName:signer.issuerLegalName,evidenceKind:'qixiang_refund_api_approval'};
    expect(authorizeQixiangEvidenceSigner(policy,valid)).toBe(true);
    expect(authorizeQixiangEvidenceSigner(policy,{...valid,authorityKind:'government'})).toBe(false);
    expect(authorizeQixiangEvidenceSigner(policy,{...valid,evidenceKind:'icp_filing_receipt'})).toBe(false);
    expect(authorizeQixiangEvidenceSigner(policy,{...valid,issuerLegalName:'伪造机构'})).toBe(false);
  });
  it('rejects future and stale compliance review timestamps',()=>{const now=Date.parse('2026-08-24T04:00:00.000Z');
    expect(isCurrentComplianceReview('2026-08-24T04:00:30.000Z',now)).toBe(true);
    expect(isCurrentComplianceReview('2026-08-24T04:02:00.000Z',now)).toBe(false);
    expect(isCurrentComplianceReview('2026-07-01T00:00:00.000Z',now)).toBe(false);
  });
});
