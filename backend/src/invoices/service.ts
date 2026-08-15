import { createHash, randomUUID } from 'node:crypto';
import { decryptPii, encryptPii, lookupHash, secretHash } from '../account/crypto.js';
import type { AccountStore } from '../account/store.js';
import type { AccountPrincipal } from '../account/types.js';
import type { RuntimeConfig } from '../config.js';
import type { MalwareScanner } from '../evidence/scanner.js';
import { AppError } from '../errors.js';
import type { PrivateObjectStore } from '../storage/object-store.js';
import type { InvoiceStore } from './store.js';
import type { InvoiceRecord, InvoiceStatus, InvoiceType } from './types.js';

type RequestContext = Readonly<{ requestId: string; ip: string }>;

function required(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function cleanText(value: string) {
  return value.trim().replace(/[\u0000-\u001f\u007f]/gu, '');
}

function maskedEmail(value: string) {
  const [local = '', domain = ''] = value.split('@');
  const prefix = local.length < 2 ? '*' : `${local.slice(0, 2)}***`;
  return `${prefix}@${domain}`;
}

function isPdf(bytes: Uint8Array) {
  if (bytes.byteLength < 8) return false;
  const buffer = Buffer.from(bytes);
  return buffer.subarray(0, 5).toString('ascii') === '%PDF-' && buffer.subarray(Math.max(0, buffer.length - 1024)).includes(Buffer.from('%%EOF'));
}

export class InvoiceService {
  private readonly piiKey: string;
  private readonly auditPepper: string;

  constructor(
    private readonly store: InvoiceStore,
    private readonly accounts: AccountStore,
    private readonly objects: PrivateObjectStore | null,
    private readonly scanner: MalwareScanner | null,
    config: RuntimeConfig,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.piiKey = required(config.PII_ENCRYPTION_KEY, 'PII_ENCRYPTION_KEY');
    this.auditPepper = required(config.AUDIT_PEPPER, 'AUDIT_PEPPER');
  }

  async request(
    principal: AccountPrincipal,
    input: { orderId: string; invoiceType: InvoiceType; title: string; taxId?: string; email: string; idempotencyKey: string },
    context: RequestContext,
  ) {
    const title = cleanText(input.title);
    const email = input.email.trim().toLowerCase();
    const taxId = input.taxId?.replace(/\s/gu, '').toUpperCase();
    if (title.length < 2 || title.length > 100) throw new AppError('INVOICE_TITLE_INVALID', 400, '发票抬头需为 2 至 100 个字符。');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) || email.length > 254) throw new AppError('INVOICE_EMAIL_INVALID', 400, '请输入有效的发票接收邮箱。');
    if (input.invoiceType === 'business' && (!taxId || !/^[0-9A-HJ-NPQRTUWXY]{18}$/u.test(taxId))) {
      throw new AppError('INVOICE_TAX_ID_INVALID', 400, '企业发票需填写有效的 18 位统一社会信用代码。');
    }
    if (!/^[A-Za-z0-9:_-]{16,120}$/u.test(input.idempotencyKey)) throw new AppError('IDEMPOTENCY_KEY_INVALID', 400, '发票申请缺少有效的幂等标识。');
    const normalized = { orderId: input.orderId, invoiceType: input.invoiceType, title, taxId: input.invoiceType === 'business' ? taxId : null, email };
    const result = await this.store.request({
      id: randomUUID(), userId: principal.userId, orderId: input.orderId, invoiceType: input.invoiceType,
      titleCiphertext: encryptPii(title, this.piiKey),
      taxIdCiphertext: input.invoiceType === 'business' ? encryptPii(taxId!, this.piiKey) : null,
      emailCiphertext: encryptPii(email, this.piiKey), emailLookupHash: lookupHash(email, this.auditPepper),
      idempotencyKey: input.idempotencyKey, payloadDigest: secretHash(JSON.stringify(normalized), this.auditPepper),
    });
    if (result.status === 'idempotency_conflict') throw new AppError('IDEMPOTENCY_KEY_CONFLICT', 409, '同一幂等标识对应了不同的发票内容。');
    if (result.status === 'order_not_found') throw new AppError('ORDER_NOT_FOUND', 404, '订单不存在或不属于当前账户。');
    if (result.status === 'order_not_invoiceable') throw new AppError('ORDER_NOT_INVOICEABLE', 409, '该订单当前没有可开票的实付金额。');
    if (result.status === 'invoice_exists') throw new AppError('INVOICE_ALREADY_ACTIVE', 409, '该订单已有发票正在处理，请勿重复申请。');
    if (result.status === 'created') await this.audit(principal, 'INVOICE_REQUESTED', result.invoice.id, context, { orderId: input.orderId, invoiceType: input.invoiceType });
    return { replayed: result.status === 'replayed', invoice: this.serialize(result.invoice, false) };
  }

  async list(principal: AccountPrincipal, status?: InvoiceStatus) {
    const operator = this.isOperator(principal);
    return (await this.store.list(principal.userId, operator, status)).map((invoice) => this.serialize(invoice, operator));
  }

  async detail(principal: AccountPrincipal, invoiceId: string) {
    const operator = this.isOperator(principal);
    const invoice = await this.store.get(principal.userId, invoiceId, operator);
    if (!invoice) throw new AppError('INVOICE_NOT_FOUND', 404, '发票记录不存在。');
    return this.serialize(invoice, operator);
  }

  async cancel(principal: AccountPrincipal, invoiceId: string, context: RequestContext) {
    const invoice = await this.store.cancel(principal.userId, invoiceId);
    if (!invoice) throw new AppError('INVOICE_NOT_CANCELLABLE', 409, '发票已进入处理或不属于当前账户，无法取消。');
    await this.audit(principal, 'INVOICE_CANCELLED', invoice.id, context, { orderId: invoice.orderId });
    return this.serialize(invoice, false);
  }

  async start(principal: AccountPrincipal, invoiceId: string, context: RequestContext) {
    this.requireOperator(principal);
    const result = await this.store.start(invoiceId, principal.userId);
    if (result.status === 'invalid_state') throw new AppError('INVOICE_STATE_INVALID', 409, '发票当前状态不能开始开具。');
    if (result.status === 'order_incomplete') throw new AppError('INVOICE_ORDER_INCOMPLETE', 409, '订单尚未验收完成，不能正式开票。');
    if (result.status === 'transaction_unsettled') throw new AppError('INVOICE_TRANSACTION_UNSETTLED', 409, '订单仍有退款或争议未结清，不能正式开票。');
    await this.audit(principal, 'INVOICE_PROCESSING_STARTED', result.invoice.id, context, { orderId: result.invoice.orderId, amountCents: result.invoice.amountCents });
    return this.serialize(result.invoice, true);
  }

  async issuanceData(principal: AccountPrincipal, invoiceId: string, context: RequestContext) {
    this.requireOperator(principal);
    const invoice = await this.store.get(principal.userId, invoiceId, true);
    if (!invoice || !['processing', 'red_pending'].includes(invoice.status)) throw new AppError('INVOICE_NOT_FOUND', 404, '待处理发票不存在。');
    await this.audit(principal, 'INVOICE_PII_ACCESSED', invoice.id, context, { orderId: invoice.orderId, status: invoice.status });
    return {
      id: invoice.id, orderId: invoice.orderId, orderNumber: invoice.orderNumber, invoiceType: invoice.invoiceType,
      title: decryptPii(invoice.titleCiphertext, this.piiKey),
      taxId: invoice.taxIdCiphertext ? decryptPii(invoice.taxIdCiphertext, this.piiKey) : null,
      email: decryptPii(invoice.emailCiphertext, this.piiKey), amountCents: invoice.amountCents, currency: invoice.currency,
      status: invoice.status,
    };
  }

  async createDocumentUpload(
    principal: AccountPrincipal,
    input: { invoiceId: string; kind: 'blue' | 'red'; sizeBytes: number; sha256Digest: string },
    context: RequestContext,
  ) {
    this.requireOperator(principal);
    const objects = this.requireDocuments();
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 8 || input.sizeBytes > 10 * 1024 * 1024) {
      throw new AppError('INVOICE_DOCUMENT_SIZE_INVALID', 400, '发票 PDF 大小需在 8 字节至 10MB 之间。');
    }
    if (!/^sha256:[a-f0-9]{64}$/u.test(input.sha256Digest)) throw new AppError('INVOICE_DOCUMENT_DIGEST_INVALID', 400, '发票文件摘要格式无效。');
    const uploadId = randomUUID();
    const objectKey = `quarantine/invoices/${input.invoiceId}/${uploadId}-${input.kind}.pdf`;
    const expiresAt = new Date(this.now().getTime() + 10 * 60_000);
    const record = await this.store.createDocumentUpload({
      id: uploadId, invoiceId: input.invoiceId, operatorId: principal.userId, kind: input.kind,
      objectKey, sizeBytes: input.sizeBytes, sha256Digest: input.sha256Digest, expiresAt,
    });
    if (!record) throw new AppError('INVOICE_DOCUMENT_STATE_INVALID', 409, '发票状态与上传文件类型不匹配。');
    const upload = await objects.objects.createUploadGrant({
      objectKey, mimeType: 'application/pdf', sizeBytes: input.sizeBytes,
      sha256Hex: input.sha256Digest.slice(7), expiresAt,
    });
    await this.audit(principal, 'INVOICE_DOCUMENT_UPLOAD_CREATED', input.invoiceId, context, { uploadId, kind: input.kind, sizeBytes: input.sizeBytes });
    return { uploadId, kind: input.kind, upload: { ...upload, expiresAt: upload.expiresAt.toISOString() } };
  }

  async completeDocument(
    principal: AccountPrincipal,
    input: { invoiceId: string; uploadId: string; invoiceCode: string; invoiceNumber: string },
    context: RequestContext,
  ) {
    this.requireOperator(principal);
    const { objects, scanner } = this.requireDocuments();
    const upload = await this.store.getDocumentUpload(input.invoiceId, input.uploadId);
    if (!upload) throw new AppError('INVOICE_DOCUMENT_UPLOAD_NOT_FOUND', 404, '发票文件上传记录不存在。');
    if (upload.status !== 'pending_upload') throw new AppError('INVOICE_DOCUMENT_ALREADY_COMPLETED', 409, '该发票文件已经完成处理。');
    const metadata = await objects.head(upload.objectKey);
    const expectedHex = upload.sha256Digest.slice(7);
    const expectedBase64 = Buffer.from(expectedHex, 'hex').toString('base64');
    if (metadata.sizeBytes !== upload.sizeBytes || metadata.mimeType !== upload.mimeType
      || metadata.metadataSha256 !== expectedHex || (metadata.sha256Base64 !== null && metadata.sha256Base64 !== expectedBase64)) {
      await this.rejectUpload(upload.invoiceId, upload.id, upload.objectKey);
      throw new AppError('INVOICE_DOCUMENT_OBJECT_MISMATCH', 409, '上传的发票文件与登记的大小、类型或摘要不一致。');
    }
    const bytes = await objects.readBytes(upload.objectKey);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (bytes.byteLength !== upload.sizeBytes || digest !== expectedHex || !isPdf(bytes)) {
      await this.rejectUpload(upload.invoiceId, upload.id, upload.objectKey);
      throw new AppError('INVOICE_DOCUMENT_INVALID', 409, '文件内容不是完整且摘要一致的 PDF。');
    }
    let scan;
    try { scan = await scanner.scan(bytes); } catch {
      throw new AppError('MALWARE_SCANNER_UNAVAILABLE', 503, '文件安全检查暂时不可用，请稍后重试。');
    }
    if (!scan.clean) {
      await this.rejectUpload(upload.invoiceId, upload.id, upload.objectKey);
      if (upload.kind === 'blue') await this.store.markFailed(upload.invoiceId, principal.userId, '发票文件未通过安全检查');
      await this.audit(principal, 'INVOICE_DOCUMENT_REJECTED', upload.invoiceId, context, { uploadId: upload.id, kind: upload.kind });
      throw new AppError('INVOICE_DOCUMENT_REJECTED', 409, '发票文件未通过安全检查，已拒绝并删除。');
    }
    const issuedAt = this.now();
    const issueInput = {
      invoiceId: upload.invoiceId, uploadId: upload.id, operatorId: principal.userId,
      invoiceCode: input.invoiceCode, invoiceNumber: input.invoiceNumber, objectKey: upload.objectKey,
      documentSha256Digest: upload.sha256Digest, documentSizeBytes: upload.sizeBytes, issuedAt,
    };
    const invoice = upload.kind === 'blue' ? await this.store.issue(issueInput) : await this.store.issueRed(issueInput);
    if (!invoice) throw new AppError('INVOICE_DOCUMENT_STATE_INVALID', 409, '发票状态已经变化，请刷新后重试。');
    await this.audit(principal, upload.kind === 'blue' ? 'INVOICE_ISSUED' : 'INVOICE_RED_ISSUED', invoice.id, context, {
      uploadId: upload.id, orderId: invoice.orderId, documentDigest: upload.sha256Digest,
    });
    return this.serialize(invoice, true);
  }

  async markFailed(principal: AccountPrincipal, invoiceId: string, reason: string, context: RequestContext) {
    this.requireOperator(principal);
    const invoice = await this.store.markFailed(invoiceId, principal.userId, cleanText(reason));
    if (!invoice) throw new AppError('INVOICE_STATE_INVALID', 409, '发票当前状态不能标记为失败。');
    await this.audit(principal, 'INVOICE_FAILED', invoice.id, context, { orderId: invoice.orderId });
    return this.serialize(invoice, true);
  }

  async download(principal: AccountPrincipal, invoiceId: string, kind: 'blue' | 'red') {
    const invoice = await this.store.get(principal.userId, invoiceId, this.isOperator(principal));
    if (!invoice) throw new AppError('INVOICE_NOT_FOUND', 404, '发票记录不存在。');
    const key = kind === 'blue' ? invoice.documentObjectKey : invoice.redDocumentObjectKey;
    const available = kind === 'blue' ? ['issued', 'red_pending', 'red_issued'].includes(invoice.status) : invoice.status === 'red_issued';
    if (!key || !available) throw new AppError('INVOICE_DOCUMENT_NOT_AVAILABLE', 409, '发票文件尚不可下载。');
    const expiresAt = new Date(this.now().getTime() + 5 * 60_000);
    const prefix = kind === 'blue' ? '电子发票' : '红字发票';
    return {
      url: await this.requireDocuments().objects.createDownloadUrl(key, `${prefix}-${invoice.orderNumber}.pdf`, expiresAt),
      expiresAt: expiresAt.toISOString(),
    };
  }

  private serialize(invoice: InvoiceRecord, operator: boolean) {
    const email = operator ? null : decryptPii(invoice.emailCiphertext, this.piiKey);
    const taxId = operator || !invoice.taxIdCiphertext ? null : decryptPii(invoice.taxIdCiphertext, this.piiKey);
    return {
      id: invoice.id, orderId: invoice.orderId, orderNumber: invoice.orderNumber, invoiceType: invoice.invoiceType,
      title: operator ? null : decryptPii(invoice.titleCiphertext, this.piiKey),
      emailMasked: email ? maskedEmail(email) : null,
      taxIdMasked: taxId ? `${'*'.repeat(Math.max(0, taxId.length - 4))}${taxId.slice(-4)}` : null,
      amountCents: invoice.amountCents, currency: invoice.currency, status: invoice.status,
      failureReason: invoice.failureReason, invoiceCode: invoice.invoiceCode, invoiceNumber: invoice.invoiceNumber,
      blueDocumentAvailable: Boolean(invoice.documentObjectKey) && ['issued', 'red_pending', 'red_issued'].includes(invoice.status),
      redDocumentAvailable: Boolean(invoice.redDocumentObjectKey) && invoice.status === 'red_issued',
      issuedAt: invoice.issuedAt?.toISOString() ?? null, redIssuedAt: invoice.redIssuedAt?.toISOString() ?? null,
      createdAt: invoice.createdAt.toISOString(), updatedAt: invoice.updatedAt.toISOString(),
    };
  }

  private async rejectUpload(invoiceId: string, uploadId: string, objectKey: string) {
    await this.objects?.delete(objectKey).catch(() => undefined);
    await this.store.rejectDocumentUpload(invoiceId, uploadId);
  }

  private requireDocuments() {
    if (!this.objects || !this.scanner) throw new AppError('INVOICE_DOCUMENT_SERVICE_UNAVAILABLE', 503, '发票文件服务暂时不可用。');
    return { objects: this.objects, scanner: this.scanner };
  }

  private isOperator(principal: AccountPrincipal) { return principal.role === 'operator' || principal.role === 'admin'; }

  private requireOperator(principal: AccountPrincipal) {
    if (!this.isOperator(principal)) throw new AppError('OPERATOR_REQUIRED', 403, '该操作需要运营审核权限。');
  }

  private async audit(principal: AccountPrincipal, action: string, invoiceId: string, context: RequestContext, metadata: Record<string, unknown>) {
    await this.accounts.recordAudit({
      actorId: principal.userId, actorKind: 'user', action, entityType: 'INVOICE', entityId: invoiceId,
      requestId: context.requestId, ipHash: secretHash(context.ip || 'unknown', this.auditPepper),
      payloadDigest: secretHash(JSON.stringify(metadata), this.auditPepper), metadata,
    });
  }
}
