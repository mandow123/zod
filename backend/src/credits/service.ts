import type { AccountPrincipal } from '../account/types.js';
import type { SubjectAccess } from '../subjects/types.js';
import type { CreditLedgerStore, PostCreditTransactionInput } from './store.js';
import { formatCreditAmount } from './types.js';
import { formatCreditDisplayMicros } from './display.js';

export class CreditLedgerService {
  constructor(private readonly store: CreditLedgerStore, private readonly subjects: SubjectAccess) {}

  async balance(principal: AccountPrincipal) {
    const subject = await this.subjects.current(principal.userId, 'credits.read');
    const accounts = await this.store.ensureSubjectAccounts(subject.subjectId);
    const byKind = Object.fromEntries(accounts.map((account) => [account.kind, account])) as Record<string, typeof accounts[number]>;
    const available = byKind.available?.amountMicros ?? 0n;
    const reserved = byKind.reserved?.amountMicros ?? 0n;
    const receivable = byKind.supplier_receivable?.amountMicros ?? 0n;
    const payoutFrozen = byKind.payout_frozen?.amountMicros ?? 0n;
    const supplierEarnings = byKind.supplier_earnings_available?.amountMicros ?? 0n;
    return {
      subjectId: subject.subjectId,
      unit: 'KAI_CREDIT',
      precision: 6,
      available: formatCreditAmount(available),
      reserved: formatCreditAmount(reserved),
      supplierReceivable: formatCreditAmount(receivable),
      payoutFrozen: formatCreditAmount(payoutFrozen),
      redeemableSupplierEarnings: formatCreditAmount(supplierEarnings),
      total: formatCreditAmount(available + reserved + receivable + supplierEarnings + payoutFrozen),
      conversion: '1 KAI卡时 = ¥1.002',
    };
  }

  async entries(principal: AccountPrincipal, limit = 30) {
    const subject = await this.subjects.current(principal.userId, 'credits.read');
    return (await this.store.listEntries(subject.subjectId, limit)).map((entry) => ({
      id: entry.id, transactionId: entry.transactionId, accountKind: entry.accountKind,
      direction: entry.amountMicros > 0n ? 'credit' as const : 'debit' as const,
      amount: formatCreditDisplayMicros(entry.amountMicros < 0n ? -entry.amountMicros : entry.amountMicros),
      signedAmount: `${entry.amountMicros < 0n ? '-' : '+'}${formatCreditDisplayMicros(entry.amountMicros < 0n ? -entry.amountMicros : entry.amountMicros)}`,
      memo: entry.memo, scope: entry.scope, referenceType: entry.referenceType,
      referenceId: entry.referenceId, description: entry.description, postedAt: entry.postedAt.toISOString(),
    }));
  }

  async post(input: PostCreditTransactionInput) {
    if (input.entries.length < 2) throw new Error('KAI_CREDIT_TRANSACTION_REQUIRES_TWO_ENTRIES');
    if (input.entries.some((entry) => entry.amountMicros === 0n)) throw new Error('KAI_CREDIT_ZERO_ENTRY');
    if (new Set(input.entries.map((entry) => entry.accountId)).size !== input.entries.length) {
      throw new Error('KAI_CREDIT_DUPLICATE_ACCOUNT_ENTRY');
    }
    if (input.entries.reduce((sum, entry) => sum + entry.amountMicros, 0n) !== 0n) {
      throw new Error('KAI_CREDIT_TRANSACTION_UNBALANCED');
    }
    return this.store.post(input);
  }
}
