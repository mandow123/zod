import type { ListingCursor } from '../market/cursor.js';

export type SupplierCatalogMode = 'off'|'read_only'|'inquiry';
export type SupplierCatalogKind = 'hourly_gpu'|'contract_monthly';
export type SupplierCatalogModel = 'A100'|'H100'|'H200'|'B200'|'B300';

export type SupplierCatalogSpecifications = Readonly<{
  gpu: Readonly<{model:SupplierCatalogModel;formFactor:'SXM4'|'SXM'|'NVL'|null;
    advertisedMemoryGb:number|null;environmentObservedMemoryGb:number|null;countPerInstance:number|null}>;
  cpu: Readonly<{description:string|null}>;
  memory: Readonly<{description:string|null}>;
  storage: Readonly<{description:string|null}>;
  software: Readonly<{cudaVersion:string|null;pythonVersion:string|null;
    pytorchStatus:'not_installed'|'installed'|'unknown'}>;
  notes: readonly string[];
}>;

export type SupplierCatalogItem = Readonly<{
  id:string;resourceId:string;version:number;catalogKind:SupplierCatalogKind;title:string;
  legalReviewRequired:boolean;supplierId:'supplier-shanghai-honghuan';supplierLegalName:'上海鸿欢网络科技有限公司';
  supplierDisplayName:'上海鸿欢';supplierDisclosureStatus:'platform_imported_unverified';logoHttpsUrl:string;logoVersion:string;
  specifications:SupplierCatalogSpecifications;quantityUnit:'instance'|'server';quantityMin:number;quantityMax:number;
  quantityAllowedValues:readonly number[]|null;billingMode:'hourly'|'monthly';billingUnit:'GPU_HOUR'|'SERVER_MONTH';
  referenceHourlyMinor:bigint|null;referenceDailyMinor:bigint|null;referenceMonthlyMinor:bigint|null;
  validUntil:Date;sourceObservedAt:string;deliveryLeadTimeValue:number|null;deliveryLeadTimeUnit:'month'|null;
  deliveryLeadTimeStatus:'supplier_declared'|'inquiry_confirmation_required';createdAt:Date;
}>;

export type SupplierCatalogFilters = Readonly<{kind?:SupplierCatalogKind;model?:SupplierCatalogModel;query?:string;
  cursor:ListingCursor|null;limit:number}>;

export type SupplierCatalogReadiness = Readonly<{ready:boolean;blockers:readonly string[]}>;
