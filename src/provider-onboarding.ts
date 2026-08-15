export function supplierOnboardingFormReady(input: Readonly<{
  legalName: string;
  creditCode: string;
  contactName: string;
}>) {
  return input.legalName.trim().length >= 2
    && /^[0-9A-Z]{18}$/u.test(input.creditCode.trim().toUpperCase())
    && input.contactName.trim().length >= 1;
}

export function providerResourceFormReady(input: Readonly<{
  assetReference: string;
  productCode: string;
  region: string;
  capacityTotal: string;
  capacityUnit: string;
}>) {
  const capacity = Number(input.capacityTotal);
  return input.assetReference.trim().length >= 4
    && input.productCode.trim().length >= 2
    && input.region.trim().length >= 2
    && Number.isFinite(capacity)
    && capacity > 0
    && input.capacityUnit.trim().length >= 1;
}

export function resourceStatusOpensEvidence(status: 'draft' | 'pending_verification' | 'verified' | 'rejected' | 'suspended' | 'retired') {
  return status === 'draft' || status === 'pending_verification' || status === 'rejected';
}
