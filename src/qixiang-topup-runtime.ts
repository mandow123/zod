import {
  createQixiangTopup, listQixiangTopups, loadQixiangTopup, recheckQixiangTopup,
} from './qixiang-topup-api';
import type { QixiangTopupFlowDependencies } from './qixiang-topup-flow.ts';
import { qixiangPendingPersistence } from './qixiang-topup-persistence';

export const qixiangTopupRuntime: QixiangTopupFlowDependencies = {
  pending: qixiangPendingPersistence,
  api: {
    create: createQixiangTopup,
    list: listQixiangTopups,
    detail: loadQixiangTopup,
    recheck: recheckQixiangTopup,
  },
};
