import * as Crypto from 'expo-crypto';
import { useCallback, useEffect, useState } from 'react';
import type { MarketCommerceItem, MarketCommerceOrder, MarketCommerceSource } from './MarketCommerceSource';
import {
  createStagingOrder, loadStagingBalance, loadStagingCatalog,
} from './staging-sandbox-api';
import {
  clearConfirmedStagingOrder, loadPendingStagingOrder, savePendingStagingOrder,
} from './staging-order-recovery';
import { replayPendingStagingOrder } from './staging-order-recovery-core';
import { loadStagingPrincipalFingerprint } from './staging-principal';

function itemFromServer(item: Awaited<ReturnType<typeof loadStagingCatalog>>[number]): MarketCommerceItem {
  return {
    id: item.id, title: '测试资源', productCode: item.productCode, region: item.region,
    capacityUnit: item.capacityUnit, unitPriceCredits: item.unitPriceCredits,
    capacityAvailable: item.capacityAvailable, purchasable: item.purchasable,
    auditLabel: '测试审核已通过', inventoryLabel: '测试容量',
  };
}

export function useMarketCommerceSource(): MarketCommerceSource {
  const [items, setItems] = useState<MarketCommerceItem[]>([]);
  const [availableBalance, setAvailableBalance] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState(false);
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);

  const replayOrder = useCallback(async (pending: NonNullable<Awaited<ReturnType<typeof loadPendingStagingOrder>>>) => replayPendingStagingOrder(
    pending,
    await loadStagingPrincipalFingerprint(),
    (request) => createStagingOrder(request.listingId, request.quantity, request.idempotencyKey),
    clearConfirmedStagingOrder,
  ), []);

  const reload = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const pending = await loadPendingStagingOrder();
      if (pending) {
        setPendingConfirmation(true);
        setPendingMessage('上一笔预留结果待确认，正在使用原请求标识恢复。');
        await replayOrder(pending);
      }
      setPendingConfirmation(false); setPendingMessage(null);
    } catch (reason) {
      setPendingConfirmation(true);
      setPendingMessage(`预留结果待确认：${reason instanceof Error ? reason.message : '确认前不能新建。'}`);
    }
    try {
      const [catalog, balance] = await Promise.all([loadStagingCatalog(), loadStagingBalance()]);
      setItems(catalog.map(itemFromServer));
      setAvailableBalance(balance.available);
      setLoaded(true);
    } catch (reason) {
      setItems([]); setAvailableBalance(null); setLoaded(true);
      setError(reason instanceof Error ? reason.message : '市场数据暂时无法读取。');
    } finally { setLoading(false); }
  }, [replayOrder]);

  useEffect(() => { void reload(); }, [reload]);

  const createOrder = useCallback(async (listingId: string, quantity: string): Promise<MarketCommerceOrder> => {
    if (pendingConfirmation) throw new Error(pendingMessage ?? '上一笔预留结果待确认，确认前不能新建。');
    setPendingConfirmation(true);
    setPendingMessage('预留结果待确认，确认前不能新建。');
    try {
      const pending = await savePendingStagingOrder({
        signature: `${listingId}:${quantity}`,
        listingId,
        quantity,
        idempotencyKey: `staging-order:${Crypto.randomUUID()}`,
      });
      const response = await replayOrder(pending);
      setPendingConfirmation(false); setPendingMessage(null);
      setAvailableBalance(response.balance.available);
      await reload();
      return { id: response.order.id, number: response.order.number };
    } catch (reason) {
      setPendingConfirmation(true);
      setPendingMessage(`预留结果待确认：${reason instanceof Error ? reason.message : '确认前不能新建。'}`);
      throw reason;
    }
  }, [pendingConfirmation, pendingMessage, reload, replayOrder]);

  return { source: 'staging', items, availableBalance, loading, loaded, error,
    pendingConfirmation, pendingMessage, reload, createOrder };
}
