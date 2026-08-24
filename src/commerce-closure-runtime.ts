import { createCommerceClosureOrder, loadCommerceClosureOrder } from './commerce-closure-api.ts';
import {
  createCommerceClosureRuntime, type CommerceClosureFlowDependencies,
} from './commerce-closure-flow.ts';
import { commerceClosurePendingPersistence } from './commerce-closure-persistence.ts';
import type { CommerceClosureGateInput } from './commerce-closure.ts';
import { loadQixiangTopup } from './qixiang-topup-api.ts';

const dependencies: CommerceClosureFlowDependencies = {
  pending: commerceClosurePendingPersistence,
  orders: {
    create: createCommerceClosureOrder,
    detail: loadCommerceClosureOrder,
  },
  topups: { detail: loadQixiangTopup },
};

export function createCommerceClosureAppRuntime(gate: CommerceClosureGateInput) {
  return createCommerceClosureRuntime(gate, () => dependencies);
}
