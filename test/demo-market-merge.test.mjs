import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeLocalDemoListings } from '../src/demo-market.ts';

test('本地演示追加到真实市场，Spark置顶且真实H100购买挂牌不丢失', () => {
  const realH100 = { id: 'real-h100', title: 'H100', productKind: 'compute_capacity' };
  const spark = { id: 'demo-spark', title: 'Spark', productKind: 'hardware_device', demo: { mode: 'local_e2e' } };
  const demoGpu = { id: 'demo-gpu', title: '演示H200', productKind: 'compute_capacity', demo: { mode: 'local_e2e' } };
  const merged = mergeLocalDemoListings([realH100], [demoGpu, spark]);
  assert.deepEqual(merged.map((item) => item.id), ['demo-spark', 'real-h100', 'demo-gpu']);
  assert.equal(merged[1], realH100);
});

test('合并按挂牌ID去重，不用演示数据覆盖真实挂牌', () => {
  const real = { id: 'same', title: '真实挂牌', productKind: 'compute_capacity' };
  const demo = { id: 'same', title: '演示挂牌', productKind: 'compute_capacity', demo: { mode: 'local_e2e' } };
  assert.deepEqual(mergeLocalDemoListings([real], [demo]), [real]);
});
