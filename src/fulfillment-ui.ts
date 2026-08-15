import type { CloudPayFulfillment, CloudPayFulfillmentAction } from './api';

export type FulfillmentPresentation = Readonly<{
  label: string;
  title: string;
  description: string;
  tone: 'waiting' | 'active' | 'success' | 'danger' | 'muted';
  icon: 'time-outline' | 'construct-outline' | 'checkmark-circle-outline' | 'pulse-outline'
    | 'pause-circle-outline' | 'stop-circle-outline' | 'alert-circle-outline';
}>;

export type AcceptancePresentation = Readonly<{
  title: string;
  deadline: string | null;
  description: string;
  tone: 'waiting' | 'success' | 'muted';
}>;

export function fulfillmentPresentation(
  fulfillment: CloudPayFulfillment | null,
  orderStatus?: string,
): FulfillmentPresentation {
  if (!fulfillment && orderStatus === 'reserved') return {
    label: '正在确认', title: '卡时已冻结，平台正在确认订单',
    description: '平台会自动锁定 GPU 席位并开始开通；如果没有可用席位，本次购买不会成立，卡时也不会被冻结。',
    tone: 'waiting', icon: 'time-outline',
  };
  if (!fulfillment) return {
    label: '等待开通', title: '卡时已冻结，算力尚未创建',
    description: '平台还没有收到真实实例，冻结卡时尚未结算，暂时不能进入。', tone: 'waiting', icon: 'time-outline',
  };
  const presentations: Record<CloudPayFulfillment['status'], FulfillmentPresentation> = {
    pending: {
      label: '等待开通', title: '卡时已冻结，正在排队',
      description: '平台正在准备算力；真实实例就绪后才会开放入口，当前不会结算卡时。', tone: 'waiting', icon: 'time-outline',
    },
    provisioning: {
      label: '开通中', title: '正在创建并检查算力',
      description: '卡时仍处于冻结状态；平台正在验证实例和连接，请稍后刷新。', tone: 'active', icon: 'construct-outline',
    },
    ready: {
      label: '算力可用', title: '算力已经准备好',
      description: '进入时会签发一次短期访问凭据，不会把长期密钥保存在手机里。', tone: 'success', icon: 'checkmark-circle-outline',
    },
    running: {
      label: '使用中', title: '算力正在运行',
      description: '可继续进入实例；停止前请先保存工作和数据。', tone: 'active', icon: 'pulse-outline',
    },
    stopping: {
      label: '停止中', title: '正在安全停止算力',
      description: '平台正在关闭连接并核对使用记录，完成前请勿重复操作。', tone: 'waiting', icon: 'pause-circle-outline',
    },
    stopped: {
      label: orderStatus === 'disputed' ? '核对中'
        : fulfillment.acceptanceMode === 'system' ? '系统已结算'
        : orderStatus === 'accepted' || orderStatus === 'closed' ? '已结算' : '已停止',
      title: orderStatus === 'disputed' ? '平台正在核对你提交的问题'
        : fulfillment.acceptanceMode === 'system' ? '系统按计量完成'
        : fulfillment.acceptanceMode === 'buyer' ? '你已确认本次用量'
        : fulfillment.acceptanceMode === 'operator' ? '平台已按核对结果完成结算'
        : orderStatus === 'accepted' || orderStatus === 'closed' ? '实际用量已经结算' : '本次算力使用已经结束',
      description: orderStatus === 'disputed' ? '核对完成前，本单卡时保持冻结；处理结果会同步到订单和消息。'
        : fulfillment.acceptanceMode === 'system'
        ? '验收期内没有收到异议，系统已按平台计量结算实际使用部分，并退回未使用卡时。'
        : fulfillment.acceptanceMode === 'buyer'
        ? '已按你确认的平台计量结算实际使用部分，未使用卡时已退回账户。'
        : fulfillment.acceptanceMode === 'operator'
        ? '平台完成核对后按处理结果结算，本单结果可在下方查看。'
        : orderStatus === 'accepted' || orderStatus === 'closed'
        ? '实际使用部分已结算，未使用卡时已退回账户。'
        : '连接入口已关闭，请在验收截止前核对平台计量，可确认用量或提交异议。',
      tone: orderStatus === 'disputed' ? 'waiting' : orderStatus === 'accepted' || orderStatus === 'closed' ? 'success' : 'muted', icon: 'stop-circle-outline',
    },
    failed: {
      label: orderStatus === 'refunded' ? '开通失败，已退款' : '开通失败',
      title: orderStatus === 'refunded' ? '卡时已退回账户' : '平台正在处理退款',
      description: orderStatus === 'refunded'
        ? '没有交付不可用的实例；本单冻结卡时已经全部退回。'
        : '实例没有通过开通检查，当前不能进入。请刷新订单查看退款结果。',
      tone: 'danger', icon: 'alert-circle-outline',
    },
  };
  return presentations[fulfillment.status];
}

export function acceptancePresentation(
  fulfillment: CloudPayFulfillment | null,
  now = Date.now(),
): AcceptancePresentation | null {
  if (!fulfillment || fulfillment.status !== 'stopped' || !fulfillment.acceptanceMode) return null;
  const dueAt = fulfillment.acceptanceDueAt;
  if (fulfillment.acceptanceMode === 'pending') {
    const due = dueAt ? Date.parse(dueAt) : Number.NaN;
    return Number.isFinite(due) && due <= now ? {
      title: '验收时间已到', deadline: dueAt,
      description: '系统正在按平台计量完成结算。若你已在截止前提交异议，本单会保持冻结并进入核对。',
      tone: 'waiting',
    } : {
      title: '请核对本次用量', deadline: dueAt,
      description: '停止后有 24 小时验收期。你可以确认用量，或在截止前提交异议；到期没有异议，系统会按平台计量结算实际使用部分，并退回未使用卡时。',
      tone: 'waiting',
    };
  }
  if (fulfillment.acceptanceMode === 'system') return {
    title: '系统按计量完成', deadline: dueAt,
    description: '验收期内没有收到异议，系统已完成结算；未使用卡时已退回。', tone: 'success',
  };
  if (fulfillment.acceptanceMode === 'buyer') return {
    title: '你已确认本次用量', deadline: dueAt,
    description: '系统已按平台计量结算，未使用卡时已退回。', tone: 'success',
  };
  if (fulfillment.acceptanceMode === 'operator') return {
    title: '平台已完成核对', deadline: dueAt,
    description: '本单已按平台核对结果完成结算。', tone: 'success',
  };
  return {
    title: '异议核对中', deadline: dueAt,
    description: '平台处理完成前，本单卡时保持冻结；处理结果会同步到订单和消息。', tone: 'muted',
  };
}

export function canEnterFulfillment(
  fulfillment: CloudPayFulfillment | null,
  accessAvailable: boolean,
  actions: readonly CloudPayFulfillmentAction[],
) {
  return Boolean(fulfillment
    && (fulfillment.status === 'ready' || fulfillment.status === 'running')
    && accessAvailable
    && actions.includes('create_access_session')
    && fulfillment.connection);
}

export function accessExpiryCopy(expiresAt: string, now = Date.now()) {
  const remaining = Math.max(0, Date.parse(expiresAt) - now);
  if (!Number.isFinite(remaining) || remaining <= 0) return '访问凭据已失效';
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1_000);
  return `访问凭据剩余 ${minutes}:${String(seconds).padStart(2, '0')}`;
}
