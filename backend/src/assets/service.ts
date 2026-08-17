import type { AccountPrincipal } from '../account/types.js';
import type { CreditOrderStore } from '../credit-orders/store.js';
import { formatCreditDisplayMicros } from '../credits/display.js';
import type { PostgresDeviceCommerceStore } from '../device-commerce/store.js';
import type { DeviceOrder } from '../device-commerce/types.js';
import type { MarketStore } from '../market/store.js';
import type { ProviderAsset } from '../market/types.js';
import type { SubjectAccess, SubjectContext } from '../subjects/types.js';

type Action = Readonly<{ key: string; label: string; method: 'GET' | 'POST'; href: string }>;

export class AssetPortfolioService {
  constructor(private readonly market: MarketStore, private readonly devices: PostgresDeviceCommerceStore,
    private readonly orders: CreditOrderStore, private readonly subjects: SubjectAccess) {}

  async summary(principal: AccountPrincipal, input: Readonly<{ limit?: number }> = {}) {
    const subject = await this.subjects.current(principal.userId, 'orders.read');
    const limit = Math.min(Math.max(input.limit ?? 30, 1), 100);
    const providerRead = subject.permissions.includes('provider.read');
    const [providedCompute, purchasedDeviceOrders, suppliedDeviceOrders, deviceAssets, purchasedCompute,
      computeCounts, deviceCounts, providerCount] = await Promise.all([
      providerRead ? this.market.listProviderAssets(subject.subjectId, limit) : Promise.resolve([]),
      this.devices.listOrders(subject.subjectId, 'buyer', limit),
      providerRead ? this.devices.listOrders(subject.subjectId, 'supplier', limit) : Promise.resolve([]),
      this.devices.listAssets(subject.subjectId, limit), this.orders.listForSubject(subject.subjectId, limit, 'buyer', null),
      this.orders.countForSubject(subject.subjectId, 'buyer'), this.devices.portfolioCounts(subject.subjectId),
      providerRead ? this.market.countProviderAssets(subject.subjectId) : Promise.resolve(0),
    ]);
    const computeItems = purchasedCompute.map((item) => {
      const snapshot = item.listingSnapshot as Record<string, unknown>;
      return { id: item.id, assetType: 'purchased_compute' as const, orderNumber: item.orderNumber,
        title: this.text(snapshot.title) ?? this.text(snapshot.productCode) ?? '算力资源', status: item.status,
        quantity: item.quantity, capacityUnit: item.capacityUnit,
        totalCredit: formatCreditDisplayMicros(item.totalCreditMicros), updatedAt: item.updatedAt.toISOString(),
        actions: this.computeBuyerActions(item.id, item.status, subject) };
    });
    const deviceOrderItems = purchasedDeviceOrders.map((item) => ({ id: item.id,
      assetType: 'purchased_device_order' as const, orderNumber: item.orderNumber, productId: item.productId,
      status: item.status, quantity: item.quantity, totalCredit: formatCreditDisplayMicros(item.grossCreditMicros),
      updatedAt: item.updatedAt.toISOString(), actions: this.deviceBuyerActions(item, subject) }));
    const ownedDeviceItems = deviceAssets.map((item) => ({ id: item.id, assetType: 'owned_device' as const,
      orderId: item.orderId, productId: item.productId, title: item.title, status: item.status,
      quantity: item.quantity, acquiredAt: item.acquiredAt.toISOString(), actions: [this.viewDeviceOrder(item.orderId)] }));
    const providerComputeItems = providedCompute.map((item) => this.providerCompute(item, subject));
    const suppliedDeviceItems = suppliedDeviceOrders.map((item) => ({ id: item.id,
      assetType: 'supplied_device_order' as const, orderNumber: item.orderNumber, productId: item.productId,
      status: item.status, quantity: item.quantity, grossCredit: formatCreditDisplayMicros(item.grossCreditMicros),
      supplierNetCredit: item.supplierNetCreditMicros === null ? null : formatCreditDisplayMicros(item.supplierNetCreditMicros),
      updatedAt: item.updatedAt.toISOString(), actions: this.deviceSupplierActions(item, subject) }));
    const providerActionRequiredInPage = [...providerComputeItems, ...suppliedDeviceItems]
      .filter((item) => item.actions.some((action) => !action.key.startsWith('view_'))).length;
    const actionRequired = (subject.permissions.includes('orders.buy') ? computeCounts.actionRequired + deviceCounts.buyerActions : 0)
      + (providerRead ? providerActionRequiredInPage : 0);
    const openProviderAssets = providedCompute.filter((item) => !item.views.includes('closed'));
    return { subject: { id: subject.subjectId, kind: subject.kind, displayName: subject.displayName },
      summary: { total: computeCounts.total + deviceCounts.buyerOrders + deviceCounts.ownedDevices
          + providerCount + (providerRead ? deviceCounts.supplierOrders : 0),
        actionRequired, purchasedCompute: computeCounts.total, purchasedDevices: deviceCounts.buyerOrders,
        ownedDevices: deviceCounts.ownedDevices, providedCompute: providerCount,
        suppliedDeviceOrders: providerRead ? deviceCounts.supplierOrders : 0,
        hosted: providedCompute.filter((item) => item.views.includes('hosted')).length,
        deploying: providedCompute.filter((item) => item.views.includes('deploying')).length,
        attention: providedCompute.filter((item) => item.views.includes('attention')).length,
        repurchased: providedCompute.filter((item) => item.views.includes('repurchased')).length,
        renewed: providedCompute.filter((item) => item.views.includes('renewed')).length,
        closed: providedCompute.length - openProviderAssets.length,
        operating: openProviderAssets.filter((item) => item.status === 'operating').length },
      pagination: { limit, truncated: { purchasedCompute: computeCounts.total > computeItems.length,
        purchasedDeviceOrders: deviceCounts.buyerOrders > deviceOrderItems.length,
        ownedDevices: deviceCounts.ownedDevices > ownedDeviceItems.length,
        providedCompute: providerCount > providerComputeItems.length,
        suppliedDeviceOrders: providerRead && deviceCounts.supplierOrders > suppliedDeviceItems.length } },
      groups: { purchasedCompute: computeItems, purchasedDeviceOrders: deviceOrderItems,
        ownedDevices: ownedDeviceItems, ...(providerRead ? { providedCompute: providerComputeItems,
          suppliedDeviceOrders: suppliedDeviceItems } : {}) } };
  }

  private providerCompute(item: ProviderAsset, subject: SubjectContext) {
    const actions: Action[] = [];
    if (item.nextAction) actions.push({ key: item.nextAction.key, label: item.nextAction.label, method: 'GET',
      href: `/mobile/v1/provider/assets/${item.id}` });
    if (item.nodeAction && subject.permissions.includes('provider.resource.manage')) actions.push({
      key: item.nodeAction.key, label: item.nodeAction.label, method: 'GET', href: `/mobile/v1/provider/assets/${item.id}` });
    return { id: item.id, assetType: 'provided_compute' as const, resourceId: item.resourceId, title: item.name,
      region: item.region, status: item.status, statusLabel: item.statusLabel, statusDetail: item.statusDetail,
      managementMode: item.managementMode, views: item.views, attention: item.attention,
      updatedAt: item.updatedAt.toISOString(), actions };
  }

  private computeBuyerActions(id: string, status: string, subject: SubjectContext): Action[] {
    if (status === 'reserved' && subject.permissions.includes('orders.buy')) return [{ key: 'cancel_order', label: '取消订单', method: 'POST', href: `/mobile/v1/orders/${id}/cancel` }];
    if (status === 'acceptance_pending') return [{ key: 'inspect_delivery', label: '验收算力', method: 'GET', href: `/mobile/v1/orders/${id}/delivery` }];
    if (['provisioning','ready','in_service'].includes(status)) return [{ key: 'view_fulfillment', label: '查看交付', method: 'GET', href: `/mobile/v1/orders/${id}/fulfillment` }];
    if (status === 'disputed') return [{ key: 'view_issue', label: '处理争议', method: 'GET', href: `/mobile/v1/orders/${id}/delivery/issue` }];
    return [{ key: 'view_order', label: '查看详情', method: 'GET', href: `/mobile/v1/orders/${id}` }];
  }
  private deviceBuyerActions(item: DeviceOrder, subject: SubjectContext): Action[] {
    if ((item.status === 'reserved' || item.status === 'confirmed') && subject.permissions.includes('orders.buy')) return [{ key: 'cancel_device_order', label: '取消订单', method: 'POST', href: `/mobile/v1/device-orders/${item.id}/cancel` }];
    if (item.status === 'shipping' && subject.permissions.includes('orders.buy')) return [{ key: 'confirm_device_receipt', label: '确认收货', method: 'POST', href: `/mobile/v1/device-orders/${item.id}/receive` }];
    return [this.viewDeviceOrder(item.id)];
  }
  private deviceSupplierActions(item: DeviceOrder, subject: SubjectContext): Action[] {
    if (item.status === 'reserved' && subject.permissions.includes('provider.order.manage')) return [{ key: 'confirm_device_order', label: '确认接单', method: 'POST', href: `/mobile/v1/provider/device-orders/${item.id}/confirm` }];
    if (item.status === 'confirmed' && subject.permissions.includes('provider.order.manage')) return [{ key: 'ship_device_order', label: '填写物流', method: 'POST', href: `/mobile/v1/provider/device-orders/${item.id}/ship` }];
    return [this.viewDeviceOrder(item.id)];
  }
  private viewDeviceOrder(id: string): Action { return { key: 'view_device_order', label: '查看详情', method: 'GET', href: `/mobile/v1/device-orders/${id}` }; }
  private text(value: unknown) { return typeof value === 'string' && value.trim() ? value : null; }
}
