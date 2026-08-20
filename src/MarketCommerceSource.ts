export type MarketCommerceItem = Readonly<{
  id: string;
  title: string;
  productCode: string;
  region: string;
  capacityUnit: string;
  unitPriceCredits: string;
  capacityAvailable: string;
  purchasable: boolean;
  auditLabel: string;
  inventoryLabel: string;
}>;

export type MarketCommerceOrder = Readonly<{
  id: string;
  number: string;
}>;

export type MarketCommerceSource = Readonly<{
  source: 'formal' | 'staging';
  items: MarketCommerceItem[];
  availableBalance: string | null;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  pendingConfirmation: boolean;
  pendingMessage: string | null;
  reload: () => Promise<void>;
  createOrder: (listingId: string, quantity: string) => Promise<MarketCommerceOrder>;
}>;

const unavailable = async () => { throw new Error('当前构建未启用此数据源。'); };
const formalSource: MarketCommerceSource = {
  source: 'formal', items: [], availableBalance: null, loading: false, loaded: false, error: null,
  pendingConfirmation: false, pendingMessage: null,
  reload: async () => undefined, createOrder: unavailable,
};

export function useMarketCommerceSource(): MarketCommerceSource {
  return formalSource;
}
