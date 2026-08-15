import type { CloudPayFulfillmentIssue } from './api';

export function fulfillmentIssuePresentation(issue: CloudPayFulfillmentIssue, side: 'buyer' | 'provider') {
  if (issue.status === 'open') return {
    label: '平台核对中',
    title: side === 'buyer' ? '你提交的问题正在处理' : '买方提交的问题正在处理',
    description: side === 'buyer'
      ? '本单卡时保持冻结，处理结果会同步到订单和消息。'
      : '本单待结算卡时保持冻结，平台裁定后再按结果结算。',
    tone: 'waiting' as const,
  };
  const outcome = issue.outcome;
  if (outcome === 'full_refund') return {
    label: '全额退回',
    title: side === 'buyer' ? '平台支持全额退回' : '本单不向提供方结算',
    description: '平台已完成裁定，实际退款与结算拆分如下。',
    tone: 'refund' as const,
  };
  if (outcome === 'partial_refund') return {
    label: '部分补偿',
    title: side === 'buyer' ? '平台支持部分卡时补偿' : '本单按裁定金额结算',
    description: '未使用卡时和问题补偿分别计算，避免重复退款。',
    tone: 'partial' as const,
  };
  return {
    label: '按实耗结算',
    title: side === 'buyer' ? '平台维持计量结果' : '本单按实际用量结算',
    description: '本次未增加问题补偿，未使用卡时仍按计量结果退回。',
    tone: 'settled' as const,
  };
}

export function issueKindLabel(kind: CloudPayFulfillmentIssue['kind']) {
  return kind === 'access' ? '连接无法使用' : '计量结果有异议';
}
