export type ResourceKind = 'gpu' | 'token_capacity' | 'token_usage' | 'rack' | 'storage' | 'apple_silicon';

export type PublicResource = Readonly<{
  id: string;
  productCode: string;
  kind: ResourceKind;
  region: string;
  specifications: Record<string, unknown>;
  capacityTotal: string;
  capacityUnit: string;
  createdAt: Date;
}>;

export type MarketListing = Readonly<{
  id: string;
  productCode: string;
  kind: ResourceKind;
  region: string;
  specifications: Record<string, unknown>;
  availableQuantity: string;
  capacityUnit: string;
  unitPriceCents: number;
  currency: 'CNY';
  minimumQuantity: string;
  sla: Record<string, unknown>;
  expiresAt: Date;
  createdAt: Date;
}>;

export type SupplierProfile = Readonly<{
  id: string;
  subjectId: string;
  legalName: string;
  creditCode: string;
  contactName: string;
  status: 'draft' | 'submitted' | 'approved' | 'rejected' | 'suspended';
  rejectionReason: string | null;
}>;

export type ComputeResource = Readonly<{
  id: string;
  supplierId: string;
  kind: ResourceKind;
  productCode: string;
  region: string;
  specifications: Record<string, unknown>;
  capacityTotal: string;
  capacityUnit: string;
  status: 'draft' | 'pending_verification' | 'verified' | 'rejected' | 'suspended' | 'retired';
  deliveryReadiness: Readonly<{
    status: 'unbound' | 'checking' | 'ready' | 'offline' | 'revoked';
    label: string;
    nodeLastSeenAt: Date | null;
  }>;
}>;

export type SupplierResource = ComputeResource & Readonly<{
  verification: null | Readonly<{
    status: 'pending' | 'running' | 'passed' | 'failed';
    requestedAt: Date;
    completedAt: Date | null;
    failureReason: string | null;
  }>;
}>;

export type ProviderAssetStatus = 'pending_connection' | 'standby' | 'operating' | 'operating_issue';

export type ProviderAssetView = 'hosted' | 'deploying' | 'attention' | 'repurchased' | 'renewed' | 'closed' | 'operating';

export type ProviderNodeEnrollmentStatus = 'unbound' | 'claim_issued' | 'checking' | 'ready' | 'offline' | 'revoked';

export type ProviderAsset = Readonly<{
  id: string;
  resourceId: string;
  name: string;
  productCode: string;
  region: string;
  specifications: Record<string, unknown>;
  managementMode: 'self_managed' | 'platform_hosted';
  status: ProviderAssetStatus;
  statusLabel: string;
  statusDetail: string;
  materialStatus: ComputeResource['status'];
  deliveryReadiness: ComputeResource['deliveryReadiness'];
  nodeEnrollment: Readonly<{
    deploymentId: string | null;
    generation: number | null;
    status: ProviderNodeEnrollmentStatus;
  }>;
  nodeAction: null | Readonly<{
    key: 'issue_node_claim' | 'revoke_node_enrollment';
    label: string;
    deploymentId: string | null;
  }>;
  lifecycle: 'registered' | 'active' | 'retired';
  lifecycleFacts: Readonly<{
    renewedAt: Date | null;
    repurchasedAt: Date | null;
    closedAt: Date | null;
  }>;
  views: readonly ProviderAssetView[];
  attention: null | Readonly<{
    title: string;
    detail: string;
    severity: 'info' | 'warning' | 'critical';
  }>;
  nextAction: null | Readonly<{
    key: 'view_resource' | 'resubmit_resource' | 'create_offer' | 'manage_listing' | 'view_fulfillment'
      | 'resume_offer_draft' | 'resolve_offer_review' | 'reaudit_expired_offer'
      | 'publish_approved_offer' | 'track_offer_review' | 'view_offer_draft';
    label: string;
    route: 'provider_resources' | 'provider_offer_create' | 'provider_listing_manager' | 'provider_order'
      | 'provider_offer_editor' | 'provider_offer_review' | 'provider_listing_editor';
    entityId: string;
    target: 'resource' | 'listing' | 'fulfillment' | 'wizard_draft' | 'offer_revision' | 'offer_review' | 'offer_listing';
  }>;
  updatedAt: Date;
}>;

export type ProviderAssetSummary = Readonly<{
  total: number;
  pendingConnection: number;
  standby: number;
  operating: number;
  operatingIssue: number;
  attention: number;
  hosted: number;
  deploying: number;
  repurchased: number;
  renewed: number;
  closed: number;
}>;

export type SupplierListing = Readonly<{
  id: string;
  resourceId: string;
  productCode: string;
  region: string;
  totalQuantity: string;
  reservedQuantity: string;
  soldQuantity: string;
  capacityUnit: string;
  unitPriceCents: number;
  currency: 'CNY';
  minimumQuantity: string;
  status: 'draft' | 'active' | 'paused' | 'sold_out' | 'expired' | 'withdrawn';
  startsAt: Date;
  expiresAt: Date;
  createdAt: Date;
}>;

export type ComputeDemand = Readonly<{
  id: string;
  buyerId: string;
  kind: ResourceKind;
  title: string;
  productHint: string;
  region: string;
  quantity: string;
  capacityUnit: string;
  budgetMaxCents: number | null;
  currency: 'CNY';
  desiredStartAt: Date;
  deadlineAt: Date;
  description: string;
  status: 'open' | 'matched' | 'cancelled' | 'expired' | 'closed';
  createdAt: Date;
  updatedAt: Date;
}>;

export type OrderRecord = Readonly<{
  id: string;
  orderNumber: string;
  buyerId: string;
  supplierId: string;
  listingId: string;
  status: 'reserved' | 'payment_pending' | 'paid' | 'delivery_pending' | 'delivering' | 'acceptance_pending' | 'accepted' | 'cancelled' | 'refund_pending' | 'refunded' | 'disputed' | 'closed';
  quantity: string;
  capacityUnit: string;
  unitPriceCents: number;
  subtotalCents: number;
  feeCents: number;
  totalCents: number;
  currency: 'CNY';
  reservationExpiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}>;
