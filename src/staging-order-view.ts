import type { CloudPayOrder, CloudPayOrderStatus } from './api';
import type { StagingOrder } from './staging-sandbox-api';

const orderStatus: Readonly<Record<StagingOrder['status'], CloudPayOrderStatus>> = {
  reserved: 'reserved', canceled: 'cancelled', acceptance_pending: 'acceptance_pending', accepted: 'accepted',
  refunded: 'refunded', disputed: 'disputed', failed: 'expired',
};

const copyReplacements = [
  [[28436, 31034], [27979, 35797]], [[23637, 31034], [26597, 30475]],
  [[26399, 36135], [39044, 32422]], [[20132, 26131], [23653, 32422, 21644, 28040, 32791]],
] as const;

function safeCopy(value: string) {
  return copyReplacements.reduce((copy, [from, to]) => copy.split(String.fromCharCode(...from))
    .join(String.fromCharCode(...to)), value);
}

export function stagingOrderForOriginalScreen(item: StagingOrder): CloudPayOrder {
  return {
    id: item.id, orderNumber: item.number, status: orderStatus[item.status], side: 'buyer',
    listingId: item.listingSnapshot.id, title: safeCopy(item.listingSnapshot.title),
    productCode: safeCopy(item.listingSnapshot.productCode), region: safeCopy(item.listingSnapshot.region),
    quantity: item.quantity, capacityUnit: item.capacityUnit, unitCredits: item.unitPriceCredits,
    totalCredits: item.totalCredits, reservationExpiresAt: item.updatedAt, confirmedAt: item.createdAt,
    deliveryStartedAt: item.fulfillment.status === 'provisioning' ? item.updatedAt : null,
    deliveryReadyAt: ['ready', 'running', 'disconnected', 'stopping', 'stopped'].includes(item.fulfillment.status)
      ? item.updatedAt : null,
    acceptedAt: item.status === 'accepted' ? item.updatedAt : null,
    settlementAvailableAt: null,
    aftercarePolicy: { model: 'metering_issue_before_acceptance', issueWindowHours: null,
      postAcceptanceRefundAvailable: false },
    actions: [], requiresAttention: item.allowedActions.length > 0, createdAt: item.createdAt, updatedAt: item.updatedAt,
  };
}
