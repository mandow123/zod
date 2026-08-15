export type ResourceDeliveryReadiness = Readonly<{
  status: 'unbound' | 'checking' | 'ready' | 'offline' | 'revoked';
  label: string;
  nodeLastSeenAt: string | null;
}>;

export type ResourceNodeUiState = 'unbound' | 'checking' | 'ready' | 'offline' | 'revoked';

export function resourceNodeUiState(readiness: ResourceDeliveryReadiness | null | undefined): ResourceNodeUiState {
  if (!readiness) return 'unbound';
  return readiness.status;
}

export function resourceNodeCopy(readiness: ResourceDeliveryReadiness | null | undefined) {
  const state = resourceNodeUiState(readiness);
  const copy = {
    unbound: { label: '待接入', detail: '还没有绑定可交付的节点。' },
    checking: { label: '检查中', detail: '平台正在确认节点配置和在线状态。' },
    ready: { label: '可交付', detail: '节点在线，已具备自动交付条件。' },
    offline: { label: '离线', detail: '节点已断开，恢复并通过检查后才能上架。' },
    revoked: { label: '已撤销', detail: '这个节点的交付资格已撤销，暂时不能上架。' },
  } as const;
  return { state, ...copy[state] };
}

export function resourceIsDeliverable(readiness: ResourceDeliveryReadiness | null | undefined) {
  return resourceNodeUiState(readiness) === 'ready';
}
