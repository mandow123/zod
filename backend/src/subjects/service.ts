import { randomUUID } from 'node:crypto';
import type { AccountStore } from '../account/store.js';
import { secretHash } from '../account/crypto.js';
import type { AccountPrincipal } from '../account/types.js';
import type { RuntimeConfig } from '../config.js';
import { AppError } from '../errors.js';
import type { ProviderWorkspace, SubjectStore } from './store.js';
import { permissionsFor, type SubjectAccess, type SubjectContext, type SubjectMembership, type SubjectPermission } from './types.js';

type Context = Readonly<{ requestId: string; ip: string }>;
type ProviderExpirySynchronizer = Readonly<{ synchronizeExpirations(subjectId: string): Promise<void> }>;

function required(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function serializeSubject(subject: SubjectMembership, selected: boolean) {
  return {
    id: subject.subjectId,
    kind: subject.kind,
    displayName: subject.displayName,
    role: subject.role,
    status: subject.subjectStatus,
    selected,
    permissions: permissionsFor(subject.role),
  };
}

export class SubjectService implements SubjectAccess {
  private readonly auditPepper: string;

  constructor(
    private readonly store: SubjectStore,
    private readonly accounts: AccountStore,
    config: RuntimeConfig,
    private readonly expirySynchronizer?: ProviderExpirySynchronizer,
  ) {
    this.auditPepper = required(config.AUDIT_PEPPER, 'AUDIT_PEPPER');
  }

  async list(principal: AccountPrincipal) {
    await this.store.ensurePersonal(principal.userId);
    let selected = await this.store.selected(principal.userId);
    if (!selected) {
      const personal = await this.store.ensurePersonal(principal.userId);
      selected = await this.store.select(principal.userId, personal.subjectId);
    }
    const subjects = await this.store.list(principal.userId);
    return {
      currentSubjectId: selected?.subjectId ?? null,
      subjects: subjects.map((subject) => serializeSubject(subject, subject.subjectId === selected?.subjectId)),
    };
  }

  async createOrganization(principal: AccountPrincipal, displayName: string, clientRequestId: string, context: Context) {
    this.assertRequestId(clientRequestId);
    const normalized = displayName.trim();
    const payloadDigest = this.digest({ displayName: normalized });
    const result = await this.store.createOrganization({
      id: randomUUID(), userId: principal.userId, displayName: normalized, clientRequestId, payloadDigest,
    });
    if (result.status === 'conflict') throw new AppError('IDEMPOTENCY_KEY_CONFLICT', 409, '同一请求标识对应了不同的组织。');
    if (result.status === 'created') await this.audit(principal, 'TRADING_SUBJECT_CREATED', result.membership.subjectId, context, { kind: 'organization' });
    return { replayed: result.status === 'replayed', subject: serializeSubject(result.membership, false) };
  }

  async select(principal: AccountPrincipal, subjectId: string, context: Context) {
    await this.store.ensurePersonal(principal.userId);
    const selected = await this.store.select(principal.userId, subjectId);
    if (!selected) throw new AppError('SUBJECT_ACCESS_DENIED', 403, '该交易主体不可用或不属于当前账号。');
    await this.audit(principal, 'TRADING_SUBJECT_SELECTED', subjectId, context, { kind: selected.kind, role: selected.role });
    return serializeSubject(selected, true);
  }

  async current(userId: string, permission: SubjectPermission): Promise<SubjectContext> {
    await this.store.ensurePersonal(userId);
    let selected = await this.store.selected(userId);
    if (!selected) {
      const personal = await this.store.ensurePersonal(userId);
      selected = await this.store.select(userId, personal.subjectId);
    }
    if (!selected) throw new AppError('SUBJECT_SELECTION_REQUIRED', 409, '请先选择交易主体。');
    const permissions = permissionsFor(selected.role);
    if (!permissions.includes(permission)) throw new AppError('SUBJECT_PERMISSION_DENIED', 403, '当前主体成员权限不足。');
    return { ...selected, userId, permissions };
  }

  async providerBootstrap(principal: AccountPrincipal) {
    const subject = await this.current(principal.userId, 'provider.read');
    await this.expirySynchronizer?.synchronizeExpirations(subject.subjectId);
    const workspace = await this.store.providerWorkspace(subject.subjectId);
    const nextAction = this.nextAction(subject, workspace);
    const canManage = subject.permissions.some((permission) => permission.endsWith('.manage') && permission !== 'subject.manage');
    const resume = workspace.resumeOffer && ['changes_requested', 'rejected'].includes(workspace.resumeOffer.status)
      ? { kind: 'offer' as const, ...workspace.resumeOffer, updatedAt: workspace.resumeOffer.updatedAt.toISOString() }
      : workspace.resumeDraft
        ? { kind: 'wizard_draft' as const, ...workspace.resumeDraft, submissionVersion: 0, updatedAt: workspace.resumeDraft.updatedAt.toISOString() }
        : workspace.resumeOffer
          ? { kind: 'offer' as const, ...workspace.resumeOffer, updatedAt: workspace.resumeOffer.updatedAt.toISOString() }
          : null;
    return {
      mode: 'provider',
      sameAccount: true,
      requiresRelogin: false,
      subject: serializeSubject(subject, true),
      canManage,
      supplier: workspace.supplier,
      resources: workspace.resources,
      offers: workspace.offers,
      listings: workspace.listings,
      resourceActions: canManage ? workspace.resourceActions : [],
      resume,
      nextAction,
    };
  }

  private nextAction(subject: SubjectContext, workspace: ProviderWorkspace) {
    const canManage = subject.permissions.some((permission) => permission.startsWith('provider.') && permission.endsWith('.manage'));
    if (!canManage) return { key: 'view_workspace', label: '查看提供工作区', route: 'provider_workspace', entityId: null };
    if (!workspace.supplier) return { key: 'start_provider_onboarding', label: '完善提供方资料', route: 'provider_onboarding', entityId: null };
    if (workspace.supplier.status === 'draft') return { key: 'complete_provider_onboarding', label: '继续完善提供方资料', route: 'provider_onboarding', entityId: workspace.supplier.id };
    if (workspace.supplier.status === 'submitted') return { key: 'track_provider_review', label: '查看主体审核进度', route: 'provider_review', entityId: workspace.supplier.id };
    if (workspace.supplier.status === 'rejected') return { key: 'revise_provider_profile', label: '按意见修改资料', route: 'provider_onboarding', entityId: workspace.supplier.id };
    if (workspace.supplier.status === 'suspended') return { key: 'review_provider_suspension', label: '查看资格暂停说明', route: 'provider_review', entityId: workspace.supplier.id };
    if (workspace.resumeOffer?.status === 'expired') return { key: 'reaudit_expired_offer', label: '重新提交双审', route: 'provider_offer_review', entityId: workspace.resumeOffer.id };
    if (workspace.resumeOffer?.status === 'changes_requested') return { key: 'resume_offer_changes', label: '继续修改上架方案', route: 'provider_offer_editor', entityId: workspace.resumeOffer.id };
    if (workspace.resumeOffer?.status === 'rejected') return { key: 'revise_rejected_offer', label: '按意见修改上架方案', route: 'provider_offer_editor', entityId: workspace.resumeOffer.id };
    if (workspace.resumeDraft) return { key: 'resume_wizard_draft', label: '继续上架方案', route: 'provider_offer_editor', entityId: workspace.resumeDraft.id };
    if (workspace.resumeOffer?.status === 'draft') return { key: 'resume_offer_draft', label: '继续编辑上架草稿', route: 'provider_offer_editor', entityId: workspace.resumeOffer.id };
    if (workspace.resumeOffer?.status === 'under_review') return { key: 'track_offer_audits', label: '查看双审进度', route: 'provider_offer_review', entityId: workspace.resumeOffer.id };
    if (workspace.resources.rejected > 0) return { key: 'revise_rejected_resource', label: '按意见补充资源材料', route: 'provider_resources', entityId: workspace.nextRejectedResourceId };
    if (workspace.resources.awaitingMaterials > 0) return { key: 'prepare_resource_evidence', label: '继续准备审核材料', route: 'provider_resources', entityId: workspace.nextAwaitingMaterialsResourceId };
    if (workspace.resources.underReview > 0) return { key: 'track_resource_audit', label: '查看资源验真进度', route: 'provider_resources', entityId: workspace.nextUnderReviewResourceId };
    const resourceTotal = Object.values(workspace.resources).reduce((sum, count) => sum + count, 0);
    if (resourceTotal === 0) return { key: 'add_resource', label: '添加第一份算力资源', route: 'provider_resource_editor', entityId: null };
    const offerTotal = Object.values(workspace.offers).reduce((sum, count) => sum + count, 0);
    if (workspace.resources.verified > 0 && offerTotal === 0) {
      const createAction = workspace.resourceActions.find((action) => action.key === 'create_offer');
      if (createAction) return { key: 'create_offer', label: '创建上架方案', route: 'provider_offer_create', entityId: createAction.entityId };
      const nodeAction = workspace.resourceActions.find((action) => [
        'connect_resource_node', 'track_node_readiness', 'restore_resource_node', 'reconnect_resource_node',
      ].includes(action.key));
      if (nodeAction) return {
        key: nodeAction.key, label: nodeAction.label, route: 'provider_resources', entityId: nodeAction.resourceId,
      };
    }
    if (workspace.resumeOffer?.status === 'approved') return { key: 'publish_capacity', label: '发布可售容量', route: 'provider_listing_editor', entityId: workspace.resumeOffer.id };
    if (workspace.latestManageableListingId) {
      if (workspace.listings.selling === 0 && workspace.listings.scheduled + workspace.listings.scheduledPaused > 0) {
        return { key: 'manage_scheduled_supply', label: '查看待生效挂牌', route: 'provider_listing_manager', entityId: workspace.latestManageableListingId };
      }
      return { key: 'manage_supply', label: '管理在售资源', route: 'provider_listing_manager', entityId: workspace.latestManageableListingId };
    }
    return { key: 'view_supply', label: '查看上架进度', route: 'provider_publish', entityId: null };
  }

  private assertRequestId(value: string) {
    if (!/^[A-Za-z0-9:_-]{16,120}$/u.test(value)) throw new AppError('IDEMPOTENCY_KEY_INVALID', 400, '请求缺少有效的幂等标识。');
  }

  private digest(value: unknown) {
    return secretHash(JSON.stringify(value), this.auditPepper);
  }

  private audit(principal: AccountPrincipal, action: string, entityId: string, context: Context, metadata: Record<string, unknown>) {
    return this.accounts.recordAudit({
      actorId: principal.userId, actorKind: 'user', action, entityType: 'TRADING_SUBJECT', entityId,
      requestId: context.requestId, ipHash: secretHash(context.ip || 'unknown', this.auditPepper),
      payloadDigest: this.digest(metadata), metadata,
    });
  }
}
