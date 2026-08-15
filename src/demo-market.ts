import type { MarketCreditListing } from './api';

export function mergeLocalDemoListings(
  real: readonly MarketCreditListing[],
  demo: readonly MarketCreditListing[],
) {
  const realIds = new Set(real.map((item) => item.id));
  const uniqueDemo = demo.filter((item) => !realIds.has(item.id));
  const spark = uniqueDemo.filter((item) => item.productKind === 'hardware_device');
  const remainingDemo = uniqueDemo.filter((item) => item.productKind !== 'hardware_device');
  const seen = new Set<string>();
  return [...spark, ...real, ...remainingDemo].filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}
