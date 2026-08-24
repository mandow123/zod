export type QuicklinePaymentStatus = 'processing' | 'succeeded' | 'failed' | 'canceled';

export type QuicklinePayment = Readonly<{
  id: string;
  paymentAmount: string;
  creditAmount: string;
  status: QuicklinePaymentStatus;
  allowedActions: Array<'refresh' | 'view_balance' | 'create_new'>;
  createdAt: string;
  updatedAt: string;
}>;

export type QuicklineBalance = Readonly<{
  available: string;
  reserved: string;
}>;

export type QuicklinePaymentSource = Readonly<{
  source: 'formal' | 'staging';
  list: () => Promise<QuicklinePayment[]>;
  load: (id: string) => Promise<QuicklinePayment>;
  create: (amount: string) => Promise<QuicklinePayment>;
  recover: () => Promise<QuicklinePayment | null>;
  balance: () => Promise<QuicklineBalance>;
}>;

const unavailable = async (): Promise<never> => { throw new Error('当前构建未启用此支付数据源。'); };
const formalSource: QuicklinePaymentSource = {
  source: 'formal', list: unavailable, load: unavailable, create: unavailable, recover: unavailable,
  balance: unavailable,
};

export function useQuicklinePaymentSource(): QuicklinePaymentSource {
  return formalSource;
}
