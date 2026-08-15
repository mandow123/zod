import type { ResourceEvidenceChecklist } from './resource-evidence';

export function resourceEvidenceCopy(
  review: ResourceEvidenceChecklist['review']['status'] | undefined,
  correctionNote: string | null | undefined,
  readyToSubmit: boolean,
  completedCount: number,
  fallbackFailureReason?: string | null,
) {
  const headerTitle = review === 'passed' ? '资料核验结果'
    : review === 'under_review' ? '审核进度'
      : correctionNote || review === 'failed' ? '补充审核材料' : '准备审核材料';
  const reviewTitle = review === 'under_review' ? '平台审核中' : review === 'passed' ? '资料已核验'
    : correctionNote && readyToSubmit ? '已补齐，可以重新提交'
      : review === 'failed' || correctionNote ? '按审核意见补充' : readyToSubmit ? '材料已齐，可以提交' : `还需准备 ${3 - completedCount} 项`;
  const reviewText = review === 'under_review' ? '审核结果会通过消息通知。' : review === 'passed' ? '资料已通过。下一步请在“我的资产”接入执行节点，节点可交付后再填写上架方案。'
    : review === 'failed' || correctionNote ? (correctionNote ?? fallbackFailureReason ?? '请按审核意见补充后重新提交。')
      : '文件通过安全检查后，才能提交平台审核。';
  return { headerTitle, reviewTitle, reviewText, showFormatNote: review === 'collecting' } as const;
}

export function resourceCollectingCopy(failureReason: string | null | undefined) {
  const correction = failureReason?.trim() || null;
  return correction
    ? { summary: correction, action: '继续补充材料' } as const
    : { summary: '准备三类材料后提交平台审核。', action: '准备审核材料' } as const;
}
