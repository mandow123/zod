import { loadPendingStagingTopup } from './QuicklinePaymentSource.staging';
import { loadPendingStagingOrderAction } from './staging-order-action-recovery';
import { loadPendingStagingOrder } from './staging-order-recovery';
import { loadPendingStagingProfileMutation } from './staging-profile-mutation-recovery';
import { loadPendingStagingSupplierDraft } from './staging-supplier-draft-recovery';

export async function assertNoPendingStagingMutationBeforePrincipalChange() {
  const records = await Promise.allSettled([
    loadPendingStagingOrder(),
    loadPendingStagingTopup(),
    loadPendingStagingOrderAction(),
    loadPendingStagingProfileMutation(),
    loadPendingStagingSupplierDraft(),
  ]);
  if (records.some((record) => record.status === 'rejected')) {
    throw new Error('待确认操作无法安全核对，已保留旧测试身份和原记录，请先恢复对应操作。');
  }
  if (records.some((record) => record.status === 'fulfilled' && record.value !== null)) {
    throw new Error('仍有订单、支付、履约、安全资料或资源草稿结果待确认，已保留旧测试身份。请先回到对应页面恢复完成。');
  }
}
