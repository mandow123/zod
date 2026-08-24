import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

type Graph = Readonly<{
  singleWriter: Readonly<Record<string, string>>;
  releaseBlockers: string[];
  nodes: Array<Readonly<{ id: string; currentState: string; missing: string[] }>>;
  edges: Array<Readonly<{ from: string; to: string; gate: string }>>;
}>;

describe('U1 mobile unified-commerce missing graph', () => {
  it('covers the exact resource-to-settlement chain and stays fail closed', async () => {
    const graph = JSON.parse(await readFile(new URL('../../docs/U1_MOBILE_UNIFIED_COMMERCE_MISSING_GRAPH.json',
      import.meta.url), 'utf8')) as Graph;
    expect(graph.singleWriter).toMatchObject({ target: 'node_postgresql', legacyPythonWritesDuringCutover: 'forbidden',
      dualCallback: 'forbidden', dualLedger: 'forbidden' });
    expect(graph.releaseBlockers).toEqual(expect.arrayContaining([
      'QIXIANG_LOT_ACCOUNTING',
    ]));
    const ids = graph.nodes.map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(['resource_catalog', 'inquiry_to_order', 'qixiang_topup_create',
      'qixiang_confirmation', 'card_hour_grant', 'funding_lifecycle', 'manual_fulfillment', 'refunds',
      'supplier_settlement']));
    expect(graph.nodes.filter((node) => node.missing.length === 0)).toEqual([]);
    expect(graph.edges.every((edge) => ids.includes(edge.from) && ids.includes(edge.to) && edge.gate.length > 0)).toBe(true);
    const serialized = JSON.stringify(graph);
    for (const forbidden of ['merchantKey', 'checkoutKey', 'rawCallback', 'providerSecret', 'dual_write_allowed']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
