import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import type { Database } from '../database.js';
import type { SubjectMembership, SubjectRole } from './types.js';

type MembershipRow = QueryResultRow & {
  subject_id: string;
  kind: SubjectMembership['kind'];
  display_name: string;
  subject_status: SubjectMembership['subjectStatus'];
  role: SubjectRole;
};

export type ProviderWorkspace = Readonly<{
  supplier: null | Readonly<{
    id: string;
    legalName: string;
    status: 'draft' | 'submitted' | 'approved' | 'rejected' | 'suspended';
    rejectionReason: string | null;
  }>;
  resources: Record<'draft' | 'awaitingMaterials' | 'underReview' | 'verified' | 'rejected' | 'suspended' | 'retired', number>;
  offers: Record<'draft' | 'underReview' | 'changesRequested' | 'approved' | 'rejected' | 'suspended' | 'expired', number>;
  listings: Readonly<{ selling: number; scheduled: number; scheduledPaused: number; paused: number; soldOut: number }>;
  nextAwaitingMaterialsResourceId: string | null;
  nextUnderReviewResourceId: string | null;
  nextRejectedResourceId: string | null;
  latestManageableListingId: string | null;
  resourceActions: ProviderResourceAction[];
  resumeDraft: null | Readonly<{
    id: string;
    title: string;
    status: 'draft';
    version: number;
    currentStep: 'service' | 'terms' | 'price' | 'review';
    updatedAt: Date;
  }>;
  resumeOffer: null | Readonly<{
    id: string;
    title: string;
    status: 'draft' | 'under_review' | 'changes_requested' | 'approved' | 'rejected' | 'suspended' | 'expired';
    version: number;
    submissionVersion: number;
    updatedAt: Date;
  }>;
}>;

export type ProviderResourceAction = Readonly<{
  resourceId: string;
  key: 'resolve_offer_review' | 'reaudit_expired_offer' | 'resume_offer_draft' | 'publish_approved_offer'
    | 'track_offer_review' | 'view_offer_draft' | 'manage_listing' | 'create_offer'
    | 'connect_resource_node' | 'track_node_readiness' | 'restore_resource_node' | 'reconnect_resource_node';
  label: string;
  route: 'provider_offer_editor' | 'provider_offer_review' | 'provider_listing_editor'
    | 'provider_listing_manager' | 'provider_publish' | 'provider_resources';
  entityId: string;
  target: 'offer_revision' | 'wizard_draft' | 'offer_review' | 'offer_listing' | 'listing' | 'resource';
}>;

export type CreateOrganizationResult =
  | Readonly<{ status: 'created' | 'replayed'; membership: SubjectMembership }>
  | Readonly<{ status: 'conflict' }>;

export interface SubjectStore {
  ensurePersonal(userId: string): Promise<SubjectMembership>;
  list(userId: string): Promise<SubjectMembership[]>;
  selected(userId: string): Promise<SubjectMembership | null>;
  select(userId: string, subjectId: string): Promise<SubjectMembership | null>;
  createOrganization(input: Readonly<{
    id: string; userId: string; displayName: string; clientRequestId: string; payloadDigest: string;
  }>): Promise<CreateOrganizationResult>;
  providerWorkspace(subjectId: string): Promise<ProviderWorkspace>;
}

const membershipSelect = `s.id AS subject_id, s.kind, s.display_name, s.status AS subject_status, m.role`;

function mapMembership(row: MembershipRow): SubjectMembership {
  return {
    subjectId: row.subject_id,
    kind: row.kind,
    displayName: row.display_name,
    subjectStatus: row.subject_status,
    role: row.role,
  };
}

export class PostgresSubjectStore implements SubjectStore {
  constructor(private readonly database: Database) {}

  async ensurePersonal(userId: string) {
    return this.database.transaction(async (client) => {
      const user = await client.query<{ display_name: string }>(
        `SELECT display_name FROM users WHERE id = $1 AND status = 'active' FOR UPDATE`, [userId],
      );
      if (!user.rows[0]) throw new Error('ACTIVE_USER_REQUIRED');
      const existing = await client.query<MembershipRow>(
        `SELECT ${membershipSelect} FROM trading_subjects s
         JOIN subject_memberships m ON m.subject_id = s.id AND m.user_id = $1
         WHERE s.kind = 'personal' AND s.owner_user_id = $1 AND s.status <> 'closed' AND m.status = 'active'
         LIMIT 1 FOR UPDATE OF s`, [userId],
      );
      let membership = existing.rows[0] ? mapMembership(existing.rows[0]) : null;
      if (!membership) {
        const subjectId = randomUUID();
        await client.query(
          `INSERT INTO trading_subjects(id, kind, display_name, owner_user_id)
           VALUES ($1, 'personal', $2, $3)`, [subjectId, user.rows[0].display_name, userId],
        );
        await client.query(
          `INSERT INTO subject_memberships(subject_id, user_id, role, status)
           VALUES ($1, $2, 'owner', 'active')`, [subjectId, userId],
        );
        membership = { subjectId, kind: 'personal', displayName: user.rows[0].display_name, subjectStatus: 'active', role: 'owner' };
      }
      await client.query(
        `INSERT INTO subject_selections(user_id, subject_id) VALUES ($1, $2)
         ON CONFLICT (user_id) DO NOTHING`, [userId, membership.subjectId],
      );
      return membership;
    });
  }

  async list(userId: string) {
    const result = await this.database.query<MembershipRow>(
      `SELECT ${membershipSelect} FROM subject_memberships m JOIN trading_subjects s ON s.id = m.subject_id
       WHERE m.user_id = $1 AND m.status = 'active' AND s.status <> 'closed'
       ORDER BY CASE WHEN s.kind = 'personal' THEN 0 ELSE 1 END, s.created_at`, [userId],
    );
    return result.rows.map(mapMembership);
  }

  async selected(userId: string) {
    const result = await this.database.query<MembershipRow>(
      `SELECT ${membershipSelect} FROM subject_selections x
       JOIN subject_memberships m ON m.subject_id = x.subject_id AND m.user_id = x.user_id
       JOIN trading_subjects s ON s.id = x.subject_id
       WHERE x.user_id = $1 AND m.status = 'active' AND s.status = 'active'`, [userId],
    );
    return result.rows[0] ? mapMembership(result.rows[0]) : null;
  }

  async select(userId: string, subjectId: string) {
    return this.database.transaction(async (client) => {
      const result = await client.query<MembershipRow>(
        `SELECT ${membershipSelect} FROM subject_memberships m JOIN trading_subjects s ON s.id = m.subject_id
         WHERE m.user_id = $1 AND m.subject_id = $2 AND m.status = 'active' AND s.status = 'active'
         FOR UPDATE OF m, s`, [userId, subjectId],
      );
      if (!result.rows[0]) return null;
      await client.query(
        `INSERT INTO subject_selections(user_id, subject_id) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET subject_id = EXCLUDED.subject_id,
           selected_at = now(), version = subject_selections.version + 1`, [userId, subjectId],
      );
      return mapMembership(result.rows[0]);
    });
  }

  async createOrganization(input: Parameters<SubjectStore['createOrganization']>[0]): Promise<CreateOrganizationResult> {
    return this.database.transaction(async (client) => {
      await client.query(`SELECT id FROM users WHERE id = $1 AND status = 'active' FOR UPDATE`, [input.userId]);
      const replay = await client.query<MembershipRow & { payload_digest: string }>(
        `SELECT ${membershipSelect}, s.payload_digest FROM trading_subjects s
         JOIN subject_memberships m ON m.subject_id = s.id AND m.user_id = $1
         WHERE s.owner_user_id = $1 AND s.client_request_id = $2 FOR UPDATE OF s`,
        [input.userId, input.clientRequestId],
      );
      if (replay.rows[0]) return replay.rows[0].payload_digest === input.payloadDigest
        ? { status: 'replayed', membership: mapMembership(replay.rows[0]) }
        : { status: 'conflict' };
      await client.query(
        `INSERT INTO trading_subjects(id, kind, display_name, owner_user_id, client_request_id, payload_digest)
         VALUES ($1, 'organization', $2, $3, $4, $5)`,
        [input.id, input.displayName, input.userId, input.clientRequestId, input.payloadDigest],
      );
      await client.query(
        `INSERT INTO subject_memberships(subject_id, user_id, role, status)
         VALUES ($1, $2, 'owner', 'active')`, [input.id, input.userId],
      );
      return {
        status: 'created',
        membership: { subjectId: input.id, kind: 'organization', displayName: input.displayName, subjectStatus: 'active', role: 'owner' },
      };
    });
  }

  async providerWorkspace(subjectId: string): Promise<ProviderWorkspace> {
    const supplierResult = await this.database.query<{
      id: string; legal_name: string; status: NonNullable<ProviderWorkspace['supplier']>['status']; rejection_reason: string | null;
    }>(`SELECT id, legal_name, status, rejection_reason FROM supplier_profiles WHERE subject_id = $1`, [subjectId]);
    const supplier = supplierResult.rows[0];
    if (!supplier) return {
      supplier: null,
      resources: { draft: 0, awaitingMaterials: 0, underReview: 0, verified: 0, rejected: 0, suspended: 0, retired: 0 },
      offers: { draft: 0, underReview: 0, changesRequested: 0, approved: 0, rejected: 0, suspended: 0, expired: 0 },
      listings: { selling: 0, scheduled: 0, scheduledPaused: 0, paused: 0, soldOut: 0 },
      nextAwaitingMaterialsResourceId: null,
      nextUnderReviewResourceId: null,
      nextRejectedResourceId: null,
      latestManageableListingId: null,
      resourceActions: [],
      resumeDraft: null,
      resumeOffer: null,
    };
    const resourceCounts = await this.database.query<{ status: string; verification_status: string | null; count: string }>(
      `SELECT r.status, latest.status AS verification_status, count(*)::text AS count
       FROM compute_resources r
       LEFT JOIN LATERAL (
         SELECT status FROM resource_verification_runs
         WHERE resource_id = r.id ORDER BY requested_at DESC LIMIT 1
       ) latest ON r.status = 'pending_verification'
       WHERE r.supplier_id = $1 GROUP BY r.status, latest.status`, [supplier.id],
    );
    const resourceFollowUps = await this.database.query<{ id: string; status: string; verification_status: string | null }>(
      `SELECT r.id, r.status, latest.status AS verification_status
       FROM compute_resources r
       LEFT JOIN LATERAL (
         SELECT status FROM resource_verification_runs
         WHERE resource_id = r.id ORDER BY requested_at DESC LIMIT 1
       ) latest ON true
       WHERE r.supplier_id = $1 AND r.status IN ('pending_verification', 'rejected')
       ORDER BY r.updated_at DESC`, [supplier.id],
    );
    const offerCounts = await this.database.query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count FROM offer_templates WHERE supplier_id = $1 GROUP BY status`, [supplier.id],
    );
    const listingCounts = await this.database.query<{
      selling: string; scheduled: string; scheduled_paused: string; paused: string; sold_out: string;
    }>(
      `SELECT
         count(*) FILTER (WHERE status = 'active' AND starts_at <= now() AND expires_at > now())::text AS selling,
         count(*) FILTER (WHERE status = 'active' AND starts_at > now() AND expires_at > now())::text AS scheduled,
         count(*) FILTER (WHERE status = 'paused' AND starts_at > now() AND expires_at > now())::text AS scheduled_paused,
         count(*) FILTER (WHERE status = 'paused' AND starts_at <= now() AND expires_at > now())::text AS paused,
         count(*) FILTER (WHERE status = 'sold_out' AND expires_at > now())::text AS sold_out
       FROM credit_market_listings WHERE supplier_id = $1`, [supplier.id],
    );
    const latestManageableListing = await this.database.query<{ id: string }>(
      `SELECT id FROM credit_market_listings
       WHERE supplier_id = $1 AND status IN ('active', 'paused', 'sold_out') AND expires_at > now()
       ORDER BY CASE
         WHEN status = 'active' AND starts_at <= now() THEN 0
         WHEN status = 'active' AND starts_at > now() THEN 1
         WHEN status = 'paused' THEN 2 ELSE 3 END,
         updated_at DESC, created_at DESC LIMIT 1`, [supplier.id],
    );
    const resume = await this.database.query<{
      id: string; title: string; status: NonNullable<ProviderWorkspace['resumeOffer']>['status'];
      version: number; submission_version: number; updated_at: Date;
    }>(`SELECT id, title, status, version, submission_version, updated_at FROM offer_templates o
        WHERE supplier_id = $1 AND status IN ('expired', 'changes_requested', 'rejected', 'draft', 'under_review', 'approved')
          AND (status <> 'approved' OR NOT EXISTS (
            SELECT 1 FROM credit_market_listings l WHERE l.offer_id = o.id AND l.status IN ('active', 'paused', 'sold_out')
          ))
        ORDER BY CASE status WHEN 'expired' THEN 0 WHEN 'changes_requested' THEN 1 WHEN 'rejected' THEN 2
          WHEN 'draft' THEN 3 WHEN 'under_review' THEN 4 ELSE 5 END,
          updated_at DESC LIMIT 1`, [supplier.id]);
    const resumeDraft = await this.database.query<{
      id: string; title: string; version: number; current_step: NonNullable<ProviderWorkspace['resumeDraft']>['currentStep']; updated_at: Date;
    }>(`SELECT d.id, COALESCE(NULLIF(d.payload->>'title', ''), r.product_code) AS title,
          d.version, d.current_step, d.updated_at
        FROM offer_wizard_drafts d JOIN compute_resources r ON r.id = d.resource_id
        WHERE d.supplier_id = $1 AND d.status = 'active' ORDER BY d.updated_at DESC LIMIT 1`, [supplier.id]);
    const resourceActionRows = await this.database.query<{
      resource_id: string; key: ProviderResourceAction['key']; label: string; route: ProviderResourceAction['route'];
      entity_id: string; target: ProviderResourceAction['target'];
    }>(
      `WITH candidates AS (
        SELECT r.id AS resource_id, 'create_offer'::text AS key, '创建上架方案'::text AS label,
          'provider_offer_editor'::text AS route, r.id AS entity_id, 'resource'::text AS target,
          90 AS priority, r.updated_at AS changed_at
        FROM compute_resources r
        JOIN compute_resource_delivery_readiness dr ON dr.resource_id = r.id
        WHERE r.supplier_id = $1 AND r.status = 'verified' AND dr.status = 'ready'
        UNION ALL
        SELECT r.id,
          CASE dr.status WHEN 'unbound' THEN 'connect_resource_node'
            WHEN 'checking' THEN 'track_node_readiness'
            WHEN 'offline' THEN 'restore_resource_node'
            ELSE 'reconnect_resource_node' END,
          CASE dr.status WHEN 'unbound' THEN '接入执行节点'
            WHEN 'checking' THEN '查看节点接入进度'
            WHEN 'offline' THEN '恢复节点连接'
            ELSE '重新接入执行节点' END,
          'provider_resources', r.id, 'resource', 80, r.updated_at
        FROM compute_resources r
        JOIN compute_resource_delivery_readiness dr ON dr.resource_id = r.id
        WHERE r.supplier_id = $1 AND r.status = 'verified' AND dr.status <> 'ready'
        UNION ALL
        SELECT o.resource_id,
          CASE WHEN o.status IN ('changes_requested', 'rejected') THEN 'resolve_offer_review'
            WHEN o.status = 'expired' THEN 'reaudit_expired_offer'
            WHEN o.status = 'approved' THEN 'publish_approved_offer'
            WHEN o.status = 'under_review' THEN 'track_offer_review'
            ELSE 'view_offer_draft' END,
          CASE WHEN o.status = 'changes_requested' THEN '处理审核意见'
            WHEN o.status = 'rejected' THEN '修改后重新送审'
            WHEN o.status = 'expired' THEN '重新提交双审'
            WHEN o.status = 'approved' THEN '发布可售容量'
            WHEN o.status = 'under_review' THEN '查看双审进度'
            ELSE '查看上架草稿' END,
          CASE WHEN o.status IN ('changes_requested', 'rejected') THEN 'provider_offer_editor'
            WHEN o.status = 'approved' THEN 'provider_listing_editor'
            ELSE 'provider_offer_review' END,
          o.id,
          CASE WHEN o.status IN ('changes_requested', 'rejected') THEN 'offer_revision'
            WHEN o.status = 'approved' THEN 'offer_listing'
            ELSE 'offer_review' END,
          CASE WHEN o.status IN ('changes_requested', 'rejected') THEN 10
            WHEN o.status = 'expired' THEN 12
            WHEN o.status = 'approved' THEN 30
            WHEN o.status = 'under_review' THEN 40 ELSE 45 END,
          o.updated_at
        FROM offer_templates o
        WHERE o.supplier_id = $1 AND o.status IN ('changes_requested', 'rejected', 'expired', 'approved', 'under_review', 'draft')
          AND (o.status <> 'approved' OR NOT EXISTS (
            SELECT 1 FROM credit_market_listings listed
            WHERE listed.offer_id = o.id AND listed.status IN ('active', 'paused', 'sold_out') AND listed.expires_at > now()
          ))
        UNION ALL
        SELECT d.resource_id, 'resume_offer_draft', '继续上架方案', 'provider_offer_editor', d.id,
          'wizard_draft', 20, d.updated_at
        FROM offer_wizard_drafts d WHERE d.supplier_id = $1 AND d.status = 'active'
        UNION ALL
        SELECT l.resource_id, 'manage_listing',
          CASE WHEN l.status = 'active' AND l.starts_at <= now() THEN '管理销售中挂牌'
            WHEN l.status = 'active' THEN '查看待生效挂牌'
            WHEN l.status = 'paused' AND l.starts_at > now() THEN '恢复暂停的排期'
            WHEN l.status = 'paused' THEN '管理暂停挂牌'
            ELSE '查看已售罄挂牌' END,
          'provider_listing_manager', l.id, 'listing',
          50 + CASE WHEN l.status = 'active' AND l.starts_at <= now() THEN 0
            WHEN l.status = 'active' THEN 1 WHEN l.status = 'paused' AND l.starts_at <= now() THEN 2
            WHEN l.status = 'paused' THEN 3 ELSE 4 END,
          l.updated_at
        FROM credit_market_listings l
        WHERE l.supplier_id = $1 AND l.status IN ('active', 'paused', 'sold_out') AND l.expires_at > now()
      )
      SELECT DISTINCT ON (resource_id) resource_id, key, label, route, entity_id, target
      FROM candidates ORDER BY resource_id, priority, changed_at DESC`,
      [supplier.id],
    );
    const resources: ProviderWorkspace['resources'] = { draft: 0, awaitingMaterials: 0, underReview: 0, verified: 0, rejected: 0, suspended: 0, retired: 0 };
    const resourceKeys: Record<string, keyof typeof resources> = { draft: 'draft', verified: 'verified', rejected: 'rejected', suspended: 'suspended', retired: 'retired' };
    for (const row of resourceCounts.rows) {
      const key = row.status === 'pending_verification'
        ? (row.verification_status === 'running' ? 'underReview' : 'awaitingMaterials')
        : resourceKeys[row.status];
      if (key) resources[key] += Number(row.count);
    }
    const offers: ProviderWorkspace['offers'] = { draft: 0, underReview: 0, changesRequested: 0, approved: 0, rejected: 0, suspended: 0, expired: 0 };
    const offerKeys: Record<string, keyof typeof offers> = { under_review: 'underReview', changes_requested: 'changesRequested', draft: 'draft', approved: 'approved', rejected: 'rejected', suspended: 'suspended', expired: 'expired' };
    for (const row of offerCounts.rows) {
      const key = offerKeys[row.status]; if (key) offers[key] = Number(row.count);
    }
    return {
      supplier: { id: supplier.id, legalName: supplier.legal_name, status: supplier.status, rejectionReason: supplier.rejection_reason },
      resources,
      offers,
      listings: {
        selling: Number(listingCounts.rows[0]?.selling ?? 0),
        scheduled: Number(listingCounts.rows[0]?.scheduled ?? 0),
        scheduledPaused: Number(listingCounts.rows[0]?.scheduled_paused ?? 0),
        paused: Number(listingCounts.rows[0]?.paused ?? 0),
        soldOut: Number(listingCounts.rows[0]?.sold_out ?? 0),
      },
      nextAwaitingMaterialsResourceId: resourceFollowUps.rows.find((row) => row.status === 'pending_verification'
        && row.verification_status !== 'running')?.id ?? null,
      nextUnderReviewResourceId: resourceFollowUps.rows.find((row) => row.status === 'pending_verification'
        && row.verification_status === 'running')?.id ?? null,
      nextRejectedResourceId: resourceFollowUps.rows.find((row) => row.status === 'rejected')?.id ?? null,
      latestManageableListingId: latestManageableListing.rows[0]?.id ?? null,
      resourceActions: resourceActionRows.rows.map((row) => ({
        resourceId: row.resource_id, key: row.key, label: row.label, route: row.route,
        entityId: row.entity_id, target: row.target,
      })),
      resumeDraft: resumeDraft.rows[0] ? {
        id: resumeDraft.rows[0].id, title: resumeDraft.rows[0].title, status: 'draft',
        version: resumeDraft.rows[0].version, currentStep: resumeDraft.rows[0].current_step,
        updatedAt: new Date(resumeDraft.rows[0].updated_at),
      } : null,
      resumeOffer: resume.rows[0] ? {
        id: resume.rows[0].id, title: resume.rows[0].title, status: resume.rows[0].status,
        version: resume.rows[0].version, submissionVersion: resume.rows[0].submission_version,
        updatedAt: new Date(resume.rows[0].updated_at),
      } : null,
    };
  }
}
