import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { parseOpenSshPublicKey } from './ssh-public-key.js';

export const STAGING_POLICY = Object.freeze({
  version: 'staging-demo-v1', commissionBasisPoints: 100, observationDays: 7,
});
export const SEEDED = Object.freeze({
  buyer: '70000000-0000-4000-8000-000000000001',
  creator: '70000000-0000-4000-8000-000000000002',
  operator: '70000000-0000-4000-8000-000000000003',
  supplier: '70000000-0000-4000-8000-000000000004',
  listing: '71000000-0000-4000-8000-000000000001',
});

export type SandboxPrincipal = Readonly<{ subjectId: string; handle: string; role: 'member'|'operator'|'admin'|'supplier' }>;
type Queryable = Pick<PGlite, 'query'> | Pick<Transaction, 'query'>;

export type SupplierDraftResource = Readonly<{
  name: string|null; gpuModel: string|null; gpuCardType: 'SXM'|'PCIe'|'other'|null;
  gpuCount: number|null; gpuMemoryGb: number|null;
  regionCode: 'CN-SH'|'CN-BJ'|'CN-GD'|'CN-ZJ'|'CN-JS'|'CN-SC'|'CN-OTHER'|null;
  city: string|null; machineType: 'bare_metal'|'virtualized'|null; cpuModel: string|null;
  cpuCores: number|null; memoryGb: number|null; storageGb: number|null; networkMbps: number|null;
  operatingSystem: 'ubuntu_22_04'|'ubuntu_24_04'|'other'|null;
  capacityGpuHours: string|null; fulfillmentNotes: string|null;
}>;
export type SupplierDraftDeliveryPlan = Readonly<{
  mode: 'scheduled_window'; startsAt: string; endsAt: string; timezone: string; leadTimeHours: null;
}> | Readonly<{
  mode: 'preparation_lead_time'; startsAt: null; endsAt: null; timezone: null; leadTimeHours: number;
}> | null;
export type SupplierDraftInput = Readonly<{
  clientDraftId: string;
  resource: SupplierDraftResource;
  deliveryPlan: SupplierDraftDeliveryPlan;
  pricing: Readonly<{ unit: 'KAI_CARD_HOUR_PER_GPU_HOUR'; amount: string|null }>;
  acknowledgements: Readonly<{ ownershipConfirmed: boolean; remoteAccessSafetyAcknowledged: boolean }>;
}>;
export type SupplierDraftPatch = Readonly<{
  resource?: Partial<SupplierDraftResource>;
  deliveryPlan?: SupplierDraftDeliveryPlan;
  pricing?: Readonly<{ unit?: 'KAI_CARD_HOUR_PER_GPU_HOUR'; amount?: string|null }>;
  acknowledgements?: Partial<SupplierDraftInput['acknowledgements']>;
}>;

function sha(value: string) { return createHash('sha256').update(value).digest('hex'); }
function digest(value: unknown) { return sha(JSON.stringify(value)); }
function cents(value: string) {
  if (!/^(?:0|[1-9]\d{0,5})\.\d{2}$/u.test(value)) throw Object.assign(new Error('VALIDATION_ERROR'), { code: 'VALIDATION_ERROR', statusCode: 400 });
  const [major = '0', minor = '0'] = value.split('.');
  const amount = BigInt(major) * 100n + BigInt(minor);
  if (amount < 100n || amount > 10_000_000n) throw Object.assign(new Error('VALIDATION_ERROR'), { code: 'VALIDATION_ERROR', statusCode: 400 });
  return amount;
}
export function parseCredit(value: string, options: Readonly<{ positive?: boolean }> = {}) {
  if (!/^(?:0|[1-9]\d*)\.\d{2}$/u.test(value)) throw Object.assign(new Error('INVALID_CREDIT_PRECISION'), { code: 'INVALID_CREDIT_PRECISION', statusCode: 400 });
  const [major = '0', minor = '0'] = value.split('.');
  const micros = (BigInt(major) * 100n + BigInt(minor)) * 10_000n;
  if (options.positive && micros <= 0n) throw Object.assign(new Error('INVALID_CREDIT_PRECISION'), { code: 'INVALID_CREDIT_PRECISION', statusCode: 400 });
  return micros;
}
export function formatCredit(micros: bigint) {
  if (micros % 10_000n !== 0n) throw new Error('INVALID_CREDIT_PRECISION');
  const minor = micros / 10_000n;
  return `${minor / 100n}.${(minor % 100n).toString().padStart(2, '0')}`;
}
function formatCents(value: bigint) { return `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`; }
function fail(code: string, statusCode = 409): never { throw Object.assign(new Error(code), { code, statusCode }); }
function iso(value: unknown) { return new Date(String(value)).toISOString(); }

type IdempotentResult<T> = Readonly<{ status: 200|201; body: T; replayed: boolean }>;

export class StagingSandboxStore {
  constructor(readonly db: PGlite) {}

  async initialize(tokens: Readonly<{ buyer: string; creator: string; operator: string; supplier: string }>) {
    await this.db.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
    const principals = [
      [SEEDED.buyer, 'buyer', 'member', tokens.buyer], [SEEDED.creator, 'creator', 'member', tokens.creator],
      [SEEDED.operator, 'operator', 'operator', tokens.operator], [SEEDED.supplier, 'supplier', 'supplier', tokens.supplier],
    ] as const;
    for (const [id, handle, role, token] of principals) await this.db.query(
      `INSERT INTO sandbox_subjects(id,handle,role,token_hash,simulation,environment)
       VALUES($1,$2,$3,$4,true,'staging') ON CONFLICT(id) DO UPDATE SET token_hash=excluded.token_hash`,
      [id, handle, role, sha(token)],
    );
    for (const [subjectId, kind, initial] of [
      [SEEDED.buyer, 'available', 100_000_000n], [SEEDED.buyer, 'reserved', 0n],
      [SEEDED.creator, 'available', 0n], [SEEDED.creator, 'reserved', 0n],
      [SEEDED.creator, 'creator_available', 0n], [SEEDED.creator, 'creator_transferred', 0n],
      [SEEDED.supplier, 'supplier_earned', 0n],
    ] as const) await this.db.query(
      `INSERT INTO sandbox_accounts(id,subject_id,kind,balance_micros,simulation,environment)
       VALUES($1,$2,$3,$4,true,'staging') ON CONFLICT(subject_id,kind) DO NOTHING`,
      [randomUUID(), subjectId, kind, initial],
    );
    await this.db.query(
      `INSERT INTO sandbox_accounts(id,subject_id,kind,balance_micros,simulation,environment)
       SELECT $1,NULL,'demo_funding',$2,true,'staging'
       WHERE NOT EXISTS (SELECT 1 FROM sandbox_accounts WHERE subject_id IS NULL AND kind='demo_funding')`,
      [randomUUID(), 1_000_000_000_000n],
    );
    await this.db.query(
      `INSERT INTO sandbox_listings(id,supplier_subject_id,title,product_code,region,specifications,unit_price_micros,
         capacity_total_minor,simulation,environment)
       VALUES($1,$2,'演示 H100 80GB 独享算力','DEMO-H100-SXM-01','华东',
         '{"gpuModel":"H100","gpuMemory":"80GB","gpuCount":1,"mode":"dedicated"}'::jsonb,
         10000000,20000,true,'staging') ON CONFLICT(id) DO NOTHING`, [SEEDED.listing, SEEDED.supplier],
    );
    await this.db.query(`INSERT INTO sandbox_clock(singleton,current_at,simulation,environment)
      VALUES(true,now(),true,'staging') ON CONFLICT(singleton) DO NOTHING`);
  }

  async principal(token: string): Promise<SandboxPrincipal | null> {
    const result = await this.db.query<{id:string;handle:string;role:SandboxPrincipal['role']}>(
      `SELECT id,handle,role FROM sandbox_subjects WHERE token_hash=$1 AND environment='staging' AND simulation`, [sha(token)],
    );
    const row = result.rows[0];
    return row ? { subjectId: row.id, handle: row.handle, role: row.role } : null;
  }

  private async idempotent<T>(actor: string, operation: string, key: string, payload: unknown,
    work: (tx: Transaction) => Promise<Readonly<{ status?: 200|201; body: T }>>): Promise<IdempotentResult<T>> {
    if (!/^[A-Za-z0-9:_-]{16,120}$/u.test(key)) fail('IDEMPOTENCY_KEY_REQUIRED', 400);
    const payloadHash = digest(payload);
    return this.db.transaction(async (tx) => {
      // Claim the key before any domain write. In PostgreSQL, a concurrent
      // INSERT on the same primary key waits for the winner to commit, so the
      // loser can replay the completed response instead of leaking a unique
      // violation or observing a half-written state.
      const claimed = await tx.query<{payload_hash:string}>(
        `INSERT INTO sandbox_idempotency(actor_subject_id,operation,idempotency_key,payload_hash,response_status,response_body,simulation,environment)
         VALUES($1,$2,$3,$4,NULL,NULL,true,'staging')
         ON CONFLICT(actor_subject_id,operation,idempotency_key) DO NOTHING
         RETURNING payload_hash`,
        [actor, operation, key, payloadHash],
      );
      if (claimed.rows.length === 0) {
        const existing = await tx.query<{payload_hash:string;response_status:number|null;response_body:T|null}>(
          'SELECT payload_hash,response_status,response_body FROM sandbox_idempotency WHERE actor_subject_id=$1 AND operation=$2 AND idempotency_key=$3 FOR UPDATE',
          [actor, operation, key],
        );
        const saved = existing.rows[0];
        if (!saved || saved.response_status === null || saved.response_body === null) throw new Error('SANDBOX_IDEMPOTENCY_INCOMPLETE');
        if (saved.payload_hash !== payloadHash) fail('IDEMPOTENCY_CONFLICT');
        return { status: saved.response_status as 200|201, body: saved.response_body, replayed: true };
      }
      const result = await work(tx);
      const status = result.status ?? 201;
      await tx.query(
        `UPDATE sandbox_idempotency SET response_status=$4,response_body=$5
         WHERE actor_subject_id=$1 AND operation=$2 AND idempotency_key=$3`,
        [actor, operation, key, status, JSON.stringify(result.body)],
      );
      return { status, body: result.body, replayed: false };
    });
  }

  private async account(query: Queryable, subjectId: string|null, kind: string) {
    const result = await query.query<{id:string;balance_micros:string}>(
      `SELECT id,balance_micros::text FROM sandbox_accounts WHERE subject_id IS NOT DISTINCT FROM $1 AND kind=$2 FOR UPDATE`,
      [subjectId, kind],
    );
    const row = result.rows[0]; if (!row) throw new Error(`SANDBOX_ACCOUNT_MISSING:${kind}`);
    return { id: row.id, balance: BigInt(row.balance_micros) };
  }

  private async post(tx: Transaction, input: Readonly<{ reason:string;entityType:string;entityId:string; lines:Array<{subjectId:string|null;kind:string;delta:bigint}> }>) {
    if (input.lines.some((line) => line.delta % 10_000n !== 0n) || input.lines.reduce((sum,line)=>sum+line.delta,0n)!==0n) throw new Error('SANDBOX_LEDGER_NOT_BALANCED');
    const transactionId = randomUUID();
    for (const line of input.lines) {
      const account = await this.account(tx, line.subjectId, line.kind);
      if (account.balance + line.delta < 0n) fail('INSUFFICIENT_DEMO_CREDITS');
      await tx.query('UPDATE sandbox_accounts SET balance_micros=balance_micros+$2,version=version+1 WHERE id=$1',[account.id,line.delta]);
      await tx.query(
        `INSERT INTO sandbox_ledger_entries(id,transaction_id,account_id,delta_micros,reason,entity_type,entity_id,simulation,environment)
         VALUES($1,$2,$3,$4,$5,$6,$7,true,'staging')`,
        [randomUUID(), transactionId, account.id, line.delta, input.reason, input.entityType, input.entityId],
      );
    }
  }

  private async event(tx: Transaction, actor: string|null, action: string, entityType: string, entityId: string, payload: unknown, priority='normal') {
    await tx.query(`INSERT INTO sandbox_audit(id,actor_subject_id,action,entity_type,entity_id,payload,priority,simulation,environment)
      VALUES($1,$2,$3,$4,$5,$6,$7,true,'staging')`,[randomUUID(),actor,action,entityType,entityId,JSON.stringify(payload),priority]);
    await tx.query(`INSERT INTO sandbox_outbox(id,topic,entity_id,payload,simulation,environment)
      VALUES($1,$2,$3,$4,true,'staging')`,[randomUUID(),`staging.${action.toLowerCase()}`,entityId,JSON.stringify(payload)]);
  }

  private async supplierDraftEvent(tx: Transaction, actor: string, event: 'created'|'updated', entityId: string,
    payload: Readonly<{ changedFields: string[]; version: number; requestId: string }>) {
    await tx.query(`INSERT INTO sandbox_audit(id,actor_subject_id,action,entity_type,entity_id,payload,priority,simulation,environment)
      VALUES($1,$2,$3,'supplier_resource_draft',$4,$5,'normal',true,'staging')`,
      [randomUUID(),actor,`SUPPLIER_RESOURCE_DRAFT_${event.toUpperCase()}`,entityId,JSON.stringify(payload)]);
    await tx.query(`INSERT INTO sandbox_outbox(id,topic,entity_id,payload,simulation,environment)
      VALUES($1,$2,$3,$4,true,'staging')`,
      [randomUUID(),`staging.supplier_resource_draft.${event}`,entityId,JSON.stringify(payload)]);
  }

  private async safeDomainEvent(tx:Transaction,actor:string,topic:string,action:string,entityType:string,entityId:string,payload:unknown){
    await tx.query(`INSERT INTO sandbox_audit(id,actor_subject_id,action,entity_type,entity_id,payload,priority,simulation,environment)
      VALUES($1,$2,$3,$4,$5,$6,'normal',true,'staging')`,[randomUUID(),actor,action,entityType,entityId,JSON.stringify(payload)]);
    await tx.query(`INSERT INTO sandbox_outbox(id,topic,entity_id,payload,simulation,environment)
      VALUES($1,$2,$3,$4,true,'staging')`,[randomUUID(),topic,entityId,JSON.stringify(payload)]);
  }

  private sshKeyView(row:Record<string,unknown>){const status=String(row.status);return{id:String(row.id),clientKeyId:String(row.client_key_id),label:String(row.label),algorithm:String(row.algorithm),fingerprint:String(row.fingerprint),status,version:Number(row.version),allowedActions:status==='active'?['rename','revoke']:[],createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),lastUsedAt:row.last_used_at?iso(row.last_used_at):null,simulation:true};}
  async createSshPublicKey(subjectId:string,input:{clientKeyId:string;label:string;publicKey:string;ownershipAttested:true},key:string,requestId='internal-test'){
    const parsed=parseOpenSshPublicKey(input.publicKey);const payload={clientKeyId:input.clientKeyId,label:input.label,algorithm:parsed.algorithm,fingerprint:parsed.fingerprint,ownershipAttested:true};
    return this.idempotent(subjectId,'ssh_public_key.create',key,payload,async tx=>{
      const existing=(await tx.query<Record<string,unknown>>('SELECT * FROM sandbox_ssh_public_keys WHERE subject_id=$1 AND client_key_id=$2 FOR UPDATE',[subjectId,input.clientKeyId])).rows[0];
      if(existing){if(String(existing.fingerprint)!==parsed.fingerprint||String(existing.label)!==input.label)fail('IDEMPOTENCY_CONFLICT');return{status:200,body:{sshPublicKey:this.sshKeyView(existing)}};}
      const duplicate=(await tx.query<Record<string,unknown>>('SELECT * FROM sandbox_ssh_public_keys WHERE subject_id=$1 AND fingerprint=$2 FOR UPDATE',[subjectId,parsed.fingerprint])).rows[0];if(duplicate)fail('IDEMPOTENCY_CONFLICT');
      const activeKeys=await tx.query<{id:string}>(`SELECT id FROM sandbox_ssh_public_keys WHERE subject_id=$1 AND status='active' FOR UPDATE`,[subjectId]);if(activeKeys.rows.length>=10)fail('INVALID_STATE');
      const id=randomUUID();await tx.query(`INSERT INTO sandbox_ssh_public_keys(id,subject_id,client_key_id,label,algorithm,fingerprint,normalized_public_key,status,simulation,environment)
        VALUES($1,$2,$3,$4,$5,$6,$7,'active',true,'staging')`,[id,subjectId,input.clientKeyId,input.label,parsed.algorithm,parsed.fingerprint,parsed.normalized]);
      await this.safeDomainEvent(tx,subjectId,'staging.ssh_public_key.created','SSH_PUBLIC_KEY_CREATED','ssh_public_key',id,{subjectId,keyId:id,algorithm:parsed.algorithm,fingerprint:parsed.fingerprint,version:1,requestId});
      return{body:{sshPublicKey:this.sshKeyView((await tx.query<Record<string,unknown>>('SELECT * FROM sandbox_ssh_public_keys WHERE id=$1',[id])).rows[0]!)}};
    });
  }
  async sshPublicKey(subjectId:string,id:string,query:Queryable=this.db){const row=(await query.query<Record<string,unknown>>('SELECT * FROM sandbox_ssh_public_keys WHERE id=$1 AND subject_id=$2',[id,subjectId])).rows[0];if(!row)fail('NOT_FOUND',404);return this.sshKeyView(row);}
  async sshPublicKeys(subjectId:string,limit:number,start:number){const rows=await this.db.query<Record<string,unknown>>('SELECT * FROM sandbox_ssh_public_keys WHERE subject_id=$1 ORDER BY updated_at DESC,id DESC LIMIT $2 OFFSET $3',[subjectId,limit,start]);return rows.rows.map(row=>this.sshKeyView(row));}
  async renameSshPublicKey(subjectId:string,id:string,expectedVersion:number,label:string,key:string,requestId='internal-test'){return this.idempotent(subjectId,'ssh_public_key.rename',key,{id,expectedVersion,label},async tx=>{const row=(await tx.query<Record<string,unknown>>('SELECT * FROM sandbox_ssh_public_keys WHERE id=$1 AND subject_id=$2 FOR UPDATE',[id,subjectId])).rows[0];if(!row)fail('NOT_FOUND',404);if(Number(row.version)!==expectedVersion)throw Object.assign(new Error('VERSION_CONFLICT'),{code:'VERSION_CONFLICT',statusCode:409,currentVersion:Number(row.version)});if(row.status!=='active')fail('INVALID_STATE');await tx.query('UPDATE sandbox_ssh_public_keys SET label=$2,version=version+1,updated_at=now() WHERE id=$1',[id,label]);await this.safeDomainEvent(tx,subjectId,'staging.ssh_public_key.renamed','SSH_PUBLIC_KEY_RENAMED','ssh_public_key',id,{subjectId,keyId:id,algorithm:row.algorithm,fingerprint:row.fingerprint,version:expectedVersion+1,requestId});return{status:200,body:{sshPublicKey:await this.sshPublicKey(subjectId,id,tx)}};});}
  async revokeSshPublicKey(subjectId:string,id:string,expectedVersion:number,key:string,requestId='internal-test'){return this.idempotent(subjectId,'ssh_public_key.revoke',key,{id,expectedVersion},async tx=>{const row=(await tx.query<Record<string,unknown>>('SELECT * FROM sandbox_ssh_public_keys WHERE id=$1 AND subject_id=$2 FOR UPDATE',[id,subjectId])).rows[0];if(!row)fail('NOT_FOUND',404);if(Number(row.version)!==expectedVersion)throw Object.assign(new Error('VERSION_CONFLICT'),{code:'VERSION_CONFLICT',statusCode:409,currentVersion:Number(row.version)});if(row.status!=='active')fail('INVALID_STATE');const used=(await tx.query<{id:string}>(`SELECT r.id FROM sandbox_manual_delivery_requests r JOIN sandbox_orders o ON o.id=r.order_id WHERE r.ssh_public_key_id=$1 AND (r.status IN('submitted','key_verified','provisioning') OR (r.status='ready' AND o.status NOT IN('accepted','refunded','canceled','failed'))) FOR UPDATE`,[id])).rows;if(used.length!==0)fail('SSH_KEY_IN_USE');await tx.query(`UPDATE sandbox_ssh_public_keys SET status='revoked',version=version+1,updated_at=now() WHERE id=$1`,[id]);await this.safeDomainEvent(tx,subjectId,'staging.ssh_public_key.revoked','SSH_PUBLIC_KEY_REVOKED','ssh_public_key',id,{subjectId,keyId:id,algorithm:row.algorithm,fingerprint:row.fingerprint,version:expectedVersion+1,requestId});return{status:200,body:{sshPublicKey:await this.sshPublicKey(subjectId,id,tx)}};});}

  private manualDeliveryView(row:Record<string,unknown>){return{id:String(row.id),status:String(row.status),version:Number(row.version),key:{id:String(row.ssh_public_key_id),label:String(row.key_label),algorithm:String(row.key_algorithm),fingerprint:String(row.key_fingerprint)},allowedActions:[],createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),simulation:true};}
  private async manualDeliveryForOrder(orderId:string,buyer:string,query:Queryable=this.db){const row=(await query.query<Record<string,unknown>>(`SELECT r.*,k.label key_label,k.algorithm key_algorithm,k.fingerprint key_fingerprint FROM sandbox_manual_delivery_requests r JOIN sandbox_ssh_public_keys k ON k.id=r.ssh_public_key_id WHERE r.order_id=$1 AND r.buyer_subject_id=$2 ORDER BY r.created_at DESC,r.id DESC LIMIT 1`,[orderId,buyer])).rows[0];return row?this.manualDeliveryView(row):null;}
  async submitManualDelivery(subjectId:string,orderId:string,input:{expectedOrderVersion:number;sshPublicKeyId:string;termsVersion:'staging-manual-delivery-v1'},key:string,requestId='internal-test'){return this.idempotent(subjectId,'manual_delivery.submit',key,{orderId,...input},async tx=>{const order=await this.lockedBuyerOrder(tx,orderId,subjectId,input.expectedOrderVersion);if(order.status!=='reserved'||order.fulfillment_status!=='queued')fail('INVALID_STATE');const active=await tx.query<{id:string}>(`SELECT id FROM sandbox_manual_delivery_requests WHERE order_id=$1 AND status IN('submitted','key_verified','provisioning','ready') FOR UPDATE`,[orderId]);if(active.rows.length!==0)fail('INVALID_STATE');const ssh=(await tx.query<Record<string,unknown>>(`SELECT * FROM sandbox_ssh_public_keys WHERE id=$1 AND subject_id=$2 FOR UPDATE`,[input.sshPublicKeyId,subjectId])).rows[0];if(!ssh)fail('NOT_FOUND',404);if(ssh.status!=='active')fail('INVALID_STATE');const id=randomUUID();await tx.query(`INSERT INTO sandbox_manual_delivery_requests(id,order_id,buyer_subject_id,ssh_public_key_id,terms_version,status,simulation,environment) VALUES($1,$2,$3,$4,$5,'submitted',true,'staging')`,[id,orderId,subjectId,input.sshPublicKeyId,input.termsVersion]);await tx.query('UPDATE sandbox_orders SET version=version+1,updated_at=now() WHERE id=$1',[orderId]);await this.safeDomainEvent(tx,subjectId,'staging.manual_delivery_request.submitted','MANUAL_DELIVERY_REQUEST_SUBMITTED','manual_delivery_request',id,{subjectId,orderId,deliveryRequestId:id,keyId:input.sshPublicKeyId,algorithm:ssh.algorithm,fingerprint:ssh.fingerprint,version:1,requestId});return{body:{manualDeliveryRequest:(await this.operatorManualDelivery(id,tx)).safe,order:await this.order(orderId,subjectId,tx)}};});}
  async operatorManualDelivery(id:string,query:Queryable=this.db){const row=(await query.query<Record<string,unknown>>(`SELECT r.*,k.label key_label,k.algorithm key_algorithm,k.fingerprint key_fingerprint,k.normalized_public_key,o.version order_version,o.fulfillment_status FROM sandbox_manual_delivery_requests r JOIN sandbox_ssh_public_keys k ON k.id=r.ssh_public_key_id JOIN sandbox_orders o ON o.id=r.order_id WHERE r.id=$1`,[id])).rows[0];if(!row)fail('NOT_FOUND',404);return{safe:this.manualDeliveryView(row),orderId:String(row.order_id),buyerSubjectId:String(row.buyer_subject_id),normalizedPublicKey:String(row.normalized_public_key),orderVersion:Number(row.order_version),fulfillmentStatus:String(row.fulfillment_status)};}
  async transitionManualDelivery(operator:string,id:string,input:{event:'verify_key'|'start_provisioning'|'mark_ready'|'reject';expectedVersion:number;evidenceRef:string;reasonCode?:string},key:string,requestId='internal-test'){return this.idempotent(operator,'manual_delivery.transition',key,{id,...input},async tx=>{const row=(await tx.query<Record<string,unknown>>(`SELECT r.*,k.algorithm,k.fingerprint,k.normalized_public_key,o.fulfillment_status,o.status order_status FROM sandbox_manual_delivery_requests r JOIN sandbox_ssh_public_keys k ON k.id=r.ssh_public_key_id JOIN sandbox_orders o ON o.id=r.order_id WHERE r.id=$1 FOR UPDATE`,[id])).rows[0];if(!row)fail('NOT_FOUND',404);if(Number(row.version)!==input.expectedVersion)throw Object.assign(new Error('VERSION_CONFLICT'),{code:'VERSION_CONFLICT',statusCode:409,currentVersion:Number(row.version)});const current=String(row.status);const edges:Record<string,[string[],string]>={verify_key:[['submitted'],'key_verified'],start_provisioning:[['key_verified'],'provisioning'],mark_ready:[['provisioning'],'ready'],reject:[['submitted','key_verified','provisioning'],'rejected']};const edge=edges[input.event];if(!edge||!edge[0].includes(current)||row.order_status!=='reserved')fail('INVALID_STATE');if(input.event==='verify_key'){const parsed=parseOpenSshPublicKey(String(row.normalized_public_key));if(parsed.algorithm!==row.algorithm||parsed.fingerprint!==row.fingerprint)fail('INVALID_STATE');}const next=edge[1];if(input.event==='start_provisioning'&&row.fulfillment_status!=='queued')fail('INVALID_STATE');if(input.event==='mark_ready'&&row.fulfillment_status!=='provisioning')fail('INVALID_STATE');if(input.event==='reject'&&current==='provisioning'&&row.fulfillment_status!=='provisioning')fail('INVALID_STATE');if(input.event==='start_provisioning')await tx.query(`UPDATE sandbox_orders SET fulfillment_status='provisioning',version=version+1,updated_at=now() WHERE id=$1`,[row.order_id]);else if(input.event==='mark_ready')await tx.query(`UPDATE sandbox_orders SET fulfillment_status='ready',connection_status='ready',version=version+1,updated_at=now() WHERE id=$1`,[row.order_id]);else if(input.event==='reject')await tx.query(`UPDATE sandbox_orders SET fulfillment_status='queued',connection_status='not_available',version=version+1,updated_at=now() WHERE id=$1`,[row.order_id]);await tx.query(`UPDATE sandbox_manual_delivery_requests SET status=$2,evidence_ref=$3,reason_code=$4,version=version+1,updated_at=now() WHERE id=$1`,[id,next,input.evidenceRef,input.reasonCode??null]);if(input.event==='mark_ready')await tx.query('UPDATE sandbox_ssh_public_keys SET last_used_at=now(),updated_at=now() WHERE id=$1',[row.ssh_public_key_id]);await this.safeDomainEvent(tx,operator,`staging.manual_delivery_request.${next}`,`MANUAL_DELIVERY_REQUEST_${next.toUpperCase()}`,'manual_delivery_request',id,{subjectId:row.buyer_subject_id,orderId:row.order_id,keyId:row.ssh_public_key_id,algorithm:row.algorithm,fingerprint:row.fingerprint,version:input.expectedVersion+1,reasonCode:input.reasonCode??null,requestId});const detail=await this.operatorManualDelivery(id,tx);return{status:200,body:{manualDeliveryRequest:detail.safe,order:this.orderView(await this.orderForOperator(detail.orderId,tx))}};});}

  private supplierDraftCompleteness(resource: SupplierDraftResource, deliveryPlan: SupplierDraftDeliveryPlan,
    pricing: SupplierDraftInput['pricing'], acknowledgements: SupplierDraftInput['acknowledgements']) {
    const checks: Array<readonly [string, boolean]> = [
      ['resource.name', resource.name !== null], ['resource.gpuModel', resource.gpuModel !== null],
      ['resource.gpuCardType', resource.gpuCardType !== null], ['resource.gpuCount', resource.gpuCount !== null],
      ['resource.gpuMemoryGb', resource.gpuMemoryGb !== null], ['resource.regionCode', resource.regionCode !== null],
      ['resource.networkMbps', resource.networkMbps !== null], ['resource.capacityGpuHours', resource.capacityGpuHours !== null],
      ['pricing.amount', pricing.amount !== null], ['deliveryPlan', deliveryPlan !== null],
      ['acknowledgements.ownershipConfirmed', acknowledgements.ownershipConfirmed],
      ['acknowledgements.remoteAccessSafetyAcknowledged', acknowledgements.remoteAccessSafetyAcknowledged],
    ];
    const missingFields=checks.filter(([,present])=>!present).map(([field])=>field);
    return { complete: missingFields.length===0, missingFields };
  }

  private supplierDraftView(row: Record<string, unknown>) {
    const resource=row.resource as SupplierDraftResource;
    const deliveryPlan=(row.delivery_plan??null) as SupplierDraftDeliveryPlan;
    const pricing=row.pricing as SupplierDraftInput['pricing'];
    const acknowledgements=row.acknowledgements as SupplierDraftInput['acknowledgements'];
    return {
      id:String(row.id),clientDraftId:String(row.client_draft_id),status:'draft' as const,version:Number(row.version),
      visibility:'private' as const,purchasable:false as const,resource,deliveryPlan,pricing,acknowledgements,
      completeness:this.supplierDraftCompleteness(resource,deliveryPlan,pricing,acknowledgements),
      allowedActions:['edit'] as const,createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),simulation:true as const,
    };
  }

  async createSupplierResourceDraft(subjectId:string,input:SupplierDraftInput,key:string,requestId='internal-test') {
    const payloadHash=digest(input);
    return this.idempotent(subjectId,'supplier_resource_draft.create',key,input,async tx=>{
      const existing=await tx.query<Record<string,unknown>>(
        `SELECT * FROM sandbox_supplier_resource_drafts
         WHERE supplier_subject_id=$1 AND client_draft_id=$2 AND simulation FOR UPDATE`,[subjectId,input.clientDraftId]);
      if(existing.rows[0]){
        if(String(existing.rows[0].create_payload_hash)!==payloadHash)fail('IDEMPOTENCY_CONFLICT');
        return{status:200,body:{draft:this.supplierDraftView(existing.rows[0])}};
      }
      const id=randomUUID();
      await tx.query(`INSERT INTO sandbox_supplier_resource_drafts(
        id,supplier_subject_id,client_draft_id,create_payload_hash,resource,delivery_plan,pricing,acknowledgements,
        status,version,visibility,purchasable,simulation,environment)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'draft',1,'private',false,true,'staging')`,
      [id,subjectId,input.clientDraftId,payloadHash,JSON.stringify(input.resource),
        input.deliveryPlan===null?null:JSON.stringify(input.deliveryPlan),JSON.stringify(input.pricing),JSON.stringify(input.acknowledgements)]);
      await this.supplierDraftEvent(tx,subjectId,'created',id,{changedFields:['resource','deliveryPlan','pricing','acknowledgements'],version:1,requestId});
      const row=(await tx.query<Record<string,unknown>>('SELECT * FROM sandbox_supplier_resource_drafts WHERE id=$1',[id])).rows[0]!;
      return{body:{draft:this.supplierDraftView(row)}};
    });
  }

  async supplierResourceDraft(subjectId:string,id:string,query:Queryable=this.db){
    const row=(await query.query<Record<string,unknown>>(
      `SELECT * FROM sandbox_supplier_resource_drafts WHERE id=$1 AND supplier_subject_id=$2 AND simulation`,[id,subjectId])).rows[0];
    if(!row)fail('NOT_FOUND',404);
    return this.supplierDraftView(row);
  }

  async supplierResourceDrafts(subjectId:string,limit:number,start:number){
    const rows=await this.db.query<Record<string,unknown>>(
      `SELECT * FROM sandbox_supplier_resource_drafts WHERE supplier_subject_id=$1 AND simulation
       ORDER BY updated_at DESC,id DESC LIMIT $2 OFFSET $3`,[subjectId,limit,start]);
    return rows.rows.map(row=>this.supplierDraftView(row));
  }

  async updateSupplierResourceDraft(subjectId:string,id:string,expectedVersion:number,patch:SupplierDraftPatch,key:string,requestId='internal-test'){
    return this.idempotent(subjectId,'supplier_resource_draft.update',key,{id,expectedVersion,patch},async tx=>{
      const row=(await tx.query<Record<string,unknown>>(
        `SELECT * FROM sandbox_supplier_resource_drafts WHERE id=$1 AND supplier_subject_id=$2 AND simulation FOR UPDATE`,[id,subjectId])).rows[0];
      if(!row)fail('NOT_FOUND',404);
      if(Number(row.version)!==expectedVersion)throw Object.assign(new Error('VERSION_CONFLICT'),{code:'VERSION_CONFLICT',statusCode:409,currentVersion:Number(row.version)});
      const resource={...(row.resource as SupplierDraftResource),...(patch.resource??{})};
      const deliveryPlan=Object.prototype.hasOwnProperty.call(patch,'deliveryPlan')?patch.deliveryPlan!:(row.delivery_plan??null) as SupplierDraftDeliveryPlan;
      const pricing={...(row.pricing as SupplierDraftInput['pricing']),...(patch.pricing??{})};
      const acknowledgements={...(row.acknowledgements as SupplierDraftInput['acknowledgements']),...(patch.acknowledgements??{})};
      const changedFields=Object.keys(patch).sort();
      const nextVersion=expectedVersion+1;
      await tx.query(`UPDATE sandbox_supplier_resource_drafts SET resource=$3,delivery_plan=$4,pricing=$5,
        acknowledgements=$6,version=$7,updated_at=now() WHERE id=$1 AND supplier_subject_id=$2`,
      [id,subjectId,JSON.stringify(resource),deliveryPlan===null?null:JSON.stringify(deliveryPlan),JSON.stringify(pricing),JSON.stringify(acknowledgements),nextVersion]);
      await this.supplierDraftEvent(tx,subjectId,'updated',id,{changedFields,version:nextVersion,requestId});
      const updated=(await tx.query<Record<string,unknown>>('SELECT * FROM sandbox_supplier_resource_drafts WHERE id=$1',[id])).rows[0]!;
      return{status:200,body:{draft:this.supplierDraftView(updated)}};
    });
  }

  async balance(subjectId: string, query: Queryable = this.db) {
    const rows = await query.query<{kind:string;balance_micros:string;version:number}>(
      `SELECT kind,balance_micros::text,version FROM sandbox_accounts WHERE subject_id=$1 AND kind IN('available','reserved')`,[subjectId]);
    const map=new Map(rows.rows.map(row=>[row.kind,BigInt(row.balance_micros)]));
    const available=map.get('available')??0n,reserved=map.get('reserved')??0n;
    return { unit:'KAI_CARD_HOUR' as const,precision:2 as const,available:formatCredit(available),reserved:formatCredit(reserved),total:formatCredit(available+reserved),version:Math.max(...rows.rows.map(row=>row.version),1) };
  }

  async createTopup(subjectId:string, amount:string, key:string) {
    const amountCents=cents(amount), creditMinor=amountCents*1000n/1002n, creditMicros=creditMinor*10_000n;
    return this.idempotent(subjectId,'topup.create',key,{amount},async tx=>{
      const id=randomUUID();
      await tx.query(`INSERT INTO sandbox_topups(id,subject_id,payment_amount_cents,credit_micros,status,simulation,environment)
        VALUES($1,$2,$3,$4,'processing',true,'staging')`,[id,subjectId,amountCents,creditMicros]);
      await this.event(tx,subjectId,'TOPUP_CREATED','topup',id,{amount,creditAmount:formatCredit(creditMicros)});
      return {body:{topup:await this.topup(id,subjectId,tx)}};
    });
  }

  async topup(id:string,subjectId:string,query:Queryable=this.db) {
    const result=await query.query<Record<string,unknown>>(`SELECT * FROM sandbox_topups WHERE id=$1 AND subject_id=$2 AND simulation`,[id,subjectId]);
    const row=result.rows[0]; if(!row)fail('NOT_FOUND',404); return this.topupView(row);
  }
  async topups(subjectId:string,limit:number,offset=0) { const r=await this.db.query<Record<string,unknown>>(
    `SELECT * FROM sandbox_topups WHERE subject_id=$1 AND simulation ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3`,[subjectId,limit,offset]);return r.rows.map(row=>this.topupView(row)); }
  private topupView(row:Record<string,unknown>){const status=String(row.status);return{id:String(row.id),paymentAmount:formatCents(BigInt(String(row.payment_amount_cents))),currency:'CNY' as const,
    creditAmount:formatCredit(BigInt(String(row.credit_micros))),status,channel:'demo' as const,version:Number(row.version),allowedActions:status==='processing'?['refresh']:status==='succeeded'?['view_balance']:['create_new'],createdAt:iso(row.created_at),updatedAt:iso(row.updated_at)};}

  async topupOutcome(operator:string,id:string,input:{outcome:'succeeded'|'failed'|'canceled';expectedVersion:number;reasonCode:string},key:string){
    return this.idempotent(operator,'topup.outcome',key,{id,...input},async tx=>{
      const r=await tx.query<Record<string,unknown>>('SELECT * FROM sandbox_topups WHERE id=$1 FOR UPDATE',[id]);const row=r.rows[0];if(!row)fail('NOT_FOUND',404);
      if(row.status!=='processing')fail('TOPUP_ALREADY_FINAL');if(Number(row.version)!==input.expectedVersion)fail('VERSION_CONFLICT');
      if(input.outcome==='succeeded'){const amount=BigInt(String(row.credit_micros));await this.post(tx,{reason:'demo_topup_succeeded',entityType:'topup',entityId:id,lines:[
        {subjectId:null,kind:'demo_funding',delta:-amount},{subjectId:String(row.subject_id),kind:'available',delta:amount}]});}
      await tx.query('UPDATE sandbox_topups SET status=$2,reason_code=$3,version=version+1,updated_at=now() WHERE id=$1',[id,input.outcome,input.reasonCode]);
      await this.event(tx,operator,'TOPUP_OUTCOME','topup',id,input);
      return{status:200,body:{topup:await this.topup(id,String(row.subject_id),tx),balance:await this.balance(String(row.subject_id),tx)}};
    });
  }

  async catalog(query:string|undefined,region:string|undefined,limit:number,offset=0){const r=await this.db.query<Record<string,unknown>>(
    `SELECT * FROM sandbox_listings WHERE simulation AND ($1::text IS NULL OR title ILIKE '%'||$1||'%' OR product_code ILIKE '%'||$1||'%')
     AND ($2::text IS NULL OR region=$2) ORDER BY updated_at DESC,id DESC LIMIT $3 OFFSET $4`,[query??null,region??null,limit,offset]);return r.rows.map(row=>this.listingView(row));}
  private listingView(row:Record<string,unknown>){const total=BigInt(String(row.capacity_total_minor)),reserved=BigInt(String(row.capacity_reserved_minor)),consumed=BigInt(String(row.capacity_consumed_minor));return{id:String(row.id),simulation:true,title:String(row.title),productCode:String(row.product_code),region:String(row.region),specifications:row.specifications,capacityUnit:String(row.capacity_unit),unitPriceCredits:formatCredit(BigInt(String(row.unit_price_micros))),capacityAvailable:formatCredit((total-reserved-consumed)*10_000n),purchasable:true,auditLabel:'演示审核',inventoryLabel:'演示容量',version:Number(row.version),updatedAt:iso(row.updated_at)};}

  async createOrder(subjectId:string,input:{listingId:string;quantity:string},key:string){const quantityMicros=parseCredit(input.quantity,{positive:true});const quantityMinor=quantityMicros/10_000n;
    return this.idempotent(subjectId,'order.create',key,input,async tx=>{const lr=await tx.query<Record<string,unknown>>('SELECT * FROM sandbox_listings WHERE id=$1 AND simulation FOR UPDATE',[input.listingId]);const listing=lr.rows[0];if(!listing)fail('NOT_FOUND',404);
      const remaining=BigInt(String(listing.capacity_total_minor))-BigInt(String(listing.capacity_reserved_minor))-BigInt(String(listing.capacity_consumed_minor));if(quantityMinor>remaining)fail('DEMO_CAPACITY_UNAVAILABLE');
      const unit=BigInt(String(listing.unit_price_micros)),total=unit*quantityMinor/100n;if(total%10_000n!==0n)fail('INVALID_CREDIT_PRECISION',400);
      const available=await this.account(tx,subjectId,'available');if(available.balance<total)fail('INSUFFICIENT_DEMO_CREDITS');
      const id=randomUUID(),number=`SIM-${Date.now()}-${id.slice(0,6).toUpperCase()}`,snapshot={id:String(listing.id),title:String(listing.title),productCode:String(listing.product_code),region:String(listing.region),specifications:listing.specifications,simulation:true};
      await this.post(tx,{reason:'compute_order_reserved',entityType:'order',entityId:id,lines:[{subjectId,kind:'available',delta:-total},{subjectId,kind:'reserved',delta:total}]});
      await tx.query('UPDATE sandbox_listings SET capacity_reserved_minor=capacity_reserved_minor+$2,version=version+1,updated_at=now() WHERE id=$1',[input.listingId,quantityMinor]);
      await tx.query(`INSERT INTO sandbox_orders(id,number,buyer_subject_id,listing_id,listing_snapshot,quantity_minor,unit_price_micros,total_micros,status,fulfillment_status,connection_status,simulation,environment)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'reserved','queued','not_available',true,'staging')`,[id,number,subjectId,input.listingId,JSON.stringify(snapshot),quantityMinor,unit,total]);
      const attribution=await tx.query<{creator_subject_id:string}>('SELECT creator_subject_id FROM sandbox_attributions WHERE buyer_subject_id=$1',[subjectId]);
      const creator=attribution.rows[0]?.creator_subject_id;if(creator){await tx.query(`INSERT INTO sandbox_commissions(id,order_id,creator_subject_id,amount_micros,status,simulation,environment)
        VALUES($1,$2,$3,0,'attributed',true,'staging')`,[randomUUID(),id,creator]);}
      await this.event(tx,subjectId,'COMPUTE_ORDER_CREATED','order',id,{listingId:input.listingId,quantity:input.quantity,totalCredits:formatCredit(total)});
      return{body:{order:await this.order(id,subjectId,tx),balance:await this.balance(subjectId,tx)}};
    });}

  private orderSelect=`SELECT o.*,EXISTS(SELECT 1 FROM sandbox_manual_delivery_requests r WHERE r.order_id=o.id AND r.status IN('submitted','key_verified','provisioning','ready')) AS has_active_manual_delivery FROM sandbox_orders o`;
  async order(id:string,subjectId:string,query:Queryable=this.db){const r=await query.query<Record<string,unknown>>(`${this.orderSelect} WHERE o.id=$1 AND o.buyer_subject_id=$2 AND o.simulation`,[id,subjectId]);const row=r.rows[0];if(!row)fail('NOT_FOUND',404);return{...this.orderView(row),manualDeliveryRequest:await this.manualDeliveryForOrder(id,subjectId,query)};}
  async orderForOperator(id:string,query:Queryable=this.db){const r=await query.query<Record<string,unknown>>(`${this.orderSelect} WHERE o.id=$1 AND o.simulation`,[id]);const row=r.rows[0];if(!row)fail('NOT_FOUND',404);return row;}
  async orders(subjectId:string,status:string|undefined,limit:number,offset=0){const r=await this.db.query<Record<string,unknown>>(`${this.orderSelect} WHERE o.buyer_subject_id=$1 AND o.simulation AND ($2::text IS NULL OR o.status=$2) ORDER BY o.created_at DESC,o.id DESC LIMIT $3 OFFSET $4`,[subjectId,status??null,limit,offset]);return Promise.all(r.rows.map(async row=>({...this.orderView(row),manualDeliveryRequest:await this.manualDeliveryForOrder(String(row.id),subjectId)})));}
  private orderView(row:Record<string,unknown>){const status=String(row.status),fulfillment=String(row.fulfillment_status);let actions:string[]=[];if(!['canceled','accepted','refunded','disputed','failed'].includes(status)){if(status==='acceptance_pending')actions=['accept','open_dispute'];else if(status==='reserved'&&fulfillment==='queued')actions=['cancel',...(row.has_active_manual_delivery?[]:['submit_manual_delivery'])];else if(fulfillment==='ready')actions=['access_preview'];else if(fulfillment==='running')actions=['access_preview','request_stop','open_dispute'];else if(fulfillment==='disconnected')actions=['request_stop','open_dispute'];}const quantityMinor=BigInt(String(row.quantity_minor));const unit=BigInt(String(row.unit_price_micros));const total=BigInt(String(row.total_micros));return{id:String(row.id),number:String(row.number),status,version:Number(row.version),listingSnapshot:row.listing_snapshot,quantity:formatCredit(quantityMinor*10_000n),capacityUnit:'GPU时',unitPriceCredits:formatCredit(unit),totalCredits:formatCredit(total),reservedCredits:formatCredit(['reserved','acceptance_pending','disputed'].includes(status)?total:0n),fulfillment:{status:fulfillment,connectionStatus:String(row.connection_status)},metering:row.consumed_micros===null?null:{reservedCredits:formatCredit(total),consumedCredits:formatCredit(BigInt(String(row.consumed_micros))),refundableCredits:formatCredit(total-BigInt(String(row.consumed_micros))),measuredAt:iso(row.updated_at),evidenceRef:String(row.evidence_ref)},allowedActions:actions,createdAt:iso(row.created_at),updatedAt:iso(row.updated_at)};}

  private async lockedOrder(tx:Transaction,id:string,expectedVersion:number){const r=await tx.query<Record<string,unknown>>('SELECT * FROM sandbox_orders WHERE id=$1 AND simulation FOR UPDATE',[id]);const row=r.rows[0];if(!row)fail('NOT_FOUND',404);if(Number(row.version)!==expectedVersion)fail('VERSION_CONFLICT');return row;}
  private async lockedBuyerOrder(tx:Transaction,id:string,buyerSubjectId:string,expectedVersion:number){const r=await tx.query<Record<string,unknown>>('SELECT * FROM sandbox_orders WHERE id=$1 AND buyer_subject_id=$2 AND simulation FOR UPDATE',[id,buyerSubjectId]);const row=r.rows[0];if(!row)fail('NOT_FOUND',404);if(Number(row.version)!==expectedVersion)fail('VERSION_CONFLICT');return row;}
  private async releaseReservation(tx:Transaction,row:Record<string,unknown>,reason:string){const total=BigInt(String(row.total_micros)),subject=String(row.buyer_subject_id),id=String(row.id);await this.post(tx,{reason,entityType:'order',entityId:id,lines:[{subjectId:subject,kind:'reserved',delta:-total},{subjectId:subject,kind:'available',delta:total}]});await tx.query('UPDATE sandbox_listings SET capacity_reserved_minor=capacity_reserved_minor-$2,version=version+1,updated_at=now() WHERE id=$1',[row.listing_id,row.quantity_minor]);}

  async cancelOrder(subjectId:string,id:string,expectedVersion:number,key:string,requestId='internal-test'){return this.idempotent(subjectId,'order.cancel',key,{id,expectedVersion},async tx=>{const row=await this.lockedBuyerOrder(tx,id,subjectId,expectedVersion);if(row.status!=='reserved'||row.fulfillment_status!=='queued')fail('INVALID_STATE');const requests=await tx.query<Record<string,unknown>>(`SELECT * FROM sandbox_manual_delivery_requests WHERE order_id=$1 AND status IN('submitted','key_verified') FOR UPDATE`,[id]);for(const request of requests.rows){await tx.query(`UPDATE sandbox_manual_delivery_requests SET status='canceled',version=version+1,updated_at=now() WHERE id=$1`,[request.id]);await this.safeDomainEvent(tx,subjectId,'staging.manual_delivery_request.canceled','MANUAL_DELIVERY_REQUEST_CANCELED','manual_delivery_request',String(request.id),{subjectId,orderId:id,keyId:request.ssh_public_key_id,version:Number(request.version)+1,requestId});}await this.releaseReservation(tx,row,'compute_order_canceled');await tx.query(`UPDATE sandbox_orders SET status='canceled',version=version+1,updated_at=now() WHERE id=$1`,[id]);await this.event(tx,subjectId,'COMPUTE_ORDER_CANCELED','order',id,{});return{status:200,body:{order:await this.order(id,subjectId,tx),balance:await this.balance(subjectId,tx)}};});}

  async requestStop(subjectId:string,id:string,expectedVersion:number,key:string){return this.idempotent(subjectId,'order.request_stop',key,{id,expectedVersion},async tx=>{const row=await this.lockedBuyerOrder(tx,id,subjectId,expectedVersion);if(!['running','disconnected'].includes(String(row.fulfillment_status)))fail('INVALID_STATE');await tx.query(`UPDATE sandbox_orders SET fulfillment_status='stopping',connection_status='stopped',version=version+1,updated_at=now() WHERE id=$1`,[id]);await this.event(tx,subjectId,'STOP_REQUESTED','order',id,{});return{status:200,body:{order:await this.order(id,subjectId,tx)}};});}

  async transition(operator:string,id:string,input:{event:string;expectedVersion:number;reasonCode?:string},key:string){return this.idempotent(operator,'order.transition',key,{id,...input},async tx=>{const row=await this.lockedOrder(tx,id,input.expectedVersion);if(!['reserved','disputed'].includes(String(row.status)))fail('INVALID_STATE');const manual=await tx.query<{status:string}>(`SELECT status FROM sandbox_manual_delivery_requests WHERE order_id=$1 AND status IN('submitted','key_verified','provisioning') FOR UPDATE`,[id]);if(manual.rows.length>0&&['start_provisioning','mark_ready','fail_provisioning'].includes(input.event))fail('INVALID_STATE');const current=String(row.fulfillment_status);const map:Record<string,[string,string]>= {start_provisioning:['queued','provisioning'],mark_ready:['provisioning','ready'],start_running:['ready','running'],request_stop:['running','stopping'],mark_stopped:['stopping','stopped'],fail_provisioning:['provisioning','failed']};const edge=map[input.event];if(!edge||(input.event==='request_stop'?!['running','disconnected'].includes(current):current!==edge[0]))fail('INVALID_STATE');if(row.status==='disputed'&&!['request_stop','mark_stopped'].includes(input.event))fail('INVALID_STATE');if(input.event==='fail_provisioning'){await this.releaseReservation(tx,row,'compute_order_provisioning_failed');await tx.query(`UPDATE sandbox_orders SET status='failed',fulfillment_status='failed',connection_status='not_available',version=version+1,updated_at=now() WHERE id=$1`,[id]);}else{const connection=input.event==='mark_ready'?'ready':input.event==='start_running'?'connected':input.event==='request_stop'||input.event==='mark_stopped'?'stopped':String(row.connection_status);await tx.query('UPDATE sandbox_orders SET fulfillment_status=$2,connection_status=$3,version=version+1,updated_at=now() WHERE id=$1',[id,edge[1],connection]);}await this.event(tx,operator,'FULFILLMENT_TRANSITION','order',id,input);return{status:200,body:{order:this.orderView((await this.orderForOperator(id,tx)))}};});}

  async connection(operator:string,id:string,input:{event:'lost'|'restored';expectedVersion:number;reasonCode:string},key:string){return this.idempotent(operator,'order.connection',key,{id,...input},async tx=>{const row=await this.lockedOrder(tx,id,input.expectedVersion);if(row.status!=='reserved')fail('INVALID_STATE');const expected=input.event==='lost'?'running':'disconnected',next=input.event==='lost'?'disconnected':'running',connection=input.event==='lost'?'disconnected':'connected';if(row.fulfillment_status!==expected)fail('INVALID_STATE');await tx.query('UPDATE sandbox_orders SET fulfillment_status=$2,connection_status=$3,version=version+1,updated_at=now() WHERE id=$1',[id,next,connection]);await this.event(tx,operator,'CONNECTION_CHANGED','order',id,input);return{status:200,body:{order:this.orderView(await this.orderForOperator(id,tx))}};});}

  async meter(operator:string,id:string,input:{consumedQuantity:string;expectedVersion:number;evidenceRef:string},key:string){const consumedQuantity=parseCredit(input.consumedQuantity);return this.idempotent(operator,'order.metering',key,{id,...input},async tx=>{const row=await this.lockedOrder(tx,id,input.expectedVersion);if(row.fulfillment_status!=='stopped'||!['reserved','disputed'].includes(String(row.status)))fail('INVALID_STATE');const quantity=BigInt(String(row.quantity_minor))*10_000n;if(consumedQuantity>quantity)fail('VALIDATION_ERROR',400);const consumedMinor=consumedQuantity/10_000n,consumed=BigInt(String(row.unit_price_micros))*consumedMinor/100n;if(consumed%10_000n!==0n)fail('INVALID_CREDIT_PRECISION',400);const nextStatus=row.status==='disputed'?'disputed':'acceptance_pending';await tx.query(`UPDATE sandbox_orders SET status=$2,consumed_micros=$3,consumed_quantity_minor=$4,evidence_ref=$5,version=version+1,updated_at=now() WHERE id=$1`,[id,nextStatus,consumed,consumedMinor,input.evidenceRef]);await this.event(tx,operator,'METERING_SIGNED','order',id,{...input,signature:`demo:${digest({id,consumed:consumed.toString(),evidenceRef:input.evidenceRef})}`});return{status:200,body:{order:this.orderView(await this.orderForOperator(id,tx))}};});}

  private async settle(tx:Transaction,row:Record<string,unknown>,refund:bigint,reason:string){const total=BigInt(String(row.total_micros)),consumed=total-refund,buyer=String(row.buyer_subject_id),id=String(row.id);if(refund<0n||refund>total)fail('VALIDATION_ERROR',400);await this.post(tx,{reason,entityType:'order',entityId:id,lines:[{subjectId:buyer,kind:'reserved',delta:-total},{subjectId:buyer,kind:'available',delta:refund},{subjectId:SEEDED.supplier,kind:'supplier_earned',delta:consumed}]});const consumedQuantity=row.consumed_quantity_minor===null?BigInt(String(row.quantity_minor)):BigInt(String(row.consumed_quantity_minor));await tx.query('UPDATE sandbox_listings SET capacity_reserved_minor=capacity_reserved_minor-$2,capacity_consumed_minor=capacity_consumed_minor+$3,version=version+1,updated_at=now() WHERE id=$1',[row.listing_id,row.quantity_minor,consumedQuantity]);await tx.query('UPDATE sandbox_orders SET settled_micros=$2 WHERE id=$1',[id,consumed]);}
  async accept(subjectId:string,id:string,expectedVersion:number,key:string){return this.idempotent(subjectId,'order.accept',key,{id,expectedVersion},async tx=>{const row=await this.lockedBuyerOrder(tx,id,subjectId,expectedVersion);if(row.status!=='acceptance_pending'||row.consumed_micros===null)fail('INVALID_STATE');const total=BigInt(String(row.total_micros)),consumed=BigInt(String(row.consumed_micros));await this.settle(tx,row,total-consumed,'compute_order_accepted');await tx.query(`UPDATE sandbox_orders SET status='accepted',version=version+1,updated_at=now() WHERE id=$1`,[id]);await this.event(tx,subjectId,'COMPUTE_ORDER_ACCEPTED','order',id,{consumedCredits:formatCredit(consumed)});return{status:200,body:{order:await this.order(id,subjectId,tx),balance:await this.balance(subjectId,tx)}};});}

  async openDispute(subjectId:string,id:string,input:{expectedVersion:number;category:string;description:string},key:string){return this.idempotent(subjectId,'dispute.open',key,{id,...input},async tx=>{const row=await this.lockedBuyerOrder(tx,id,subjectId,input.expectedVersion);if(!['running','disconnected'].includes(String(row.fulfillment_status))&&row.status!=='acceptance_pending')fail('INVALID_STATE');const disputeId=randomUUID();await tx.query(`INSERT INTO sandbox_disputes(id,order_id,subject_id,category,description,status,simulation,environment) VALUES($1,$2,$3,$4,$5,'open',true,'staging')`,[disputeId,id,subjectId,input.category,input.description]);await tx.query(`UPDATE sandbox_orders SET status='disputed',version=version+1,updated_at=now() WHERE id=$1`,[id]);await this.event(tx,subjectId,'DISPUTE_OPENED','dispute',disputeId,input,'high');return{body:{dispute:{id:disputeId,orderId:id,status:'open',version:1,category:input.category,description:input.description},order:await this.order(id,subjectId,tx)}};});}

  async resolveDispute(operator:string,disputeId:string,input:{outcome:'full_refund'|'partial_refund'|'reject_refund';refundCredits?:string;expectedVersion:number;reasonCode:string},key:string){return this.idempotent(operator,'dispute.resolve',key,{disputeId,...input},async tx=>{
    const dr=await tx.query<Record<string,unknown>>('SELECT * FROM sandbox_disputes WHERE id=$1 AND simulation FOR UPDATE',[disputeId]);const dispute=dr.rows[0];if(!dispute)fail('NOT_FOUND',404);if(dispute.status!=='open')fail('INVALID_STATE');if(Number(dispute.version)!==input.expectedVersion)fail('VERSION_CONFLICT');
    const row=await this.orderForOperator(String(dispute.order_id),tx);if(row.status!=='disputed')fail('INVALID_STATE');const total=BigInt(String(row.total_micros));let refund:bigint,status:'refunded'|'accepted';
    if(input.outcome==='full_refund'){
      refund=total;status='refunded';await this.releaseReservation(tx,row,'dispute_full_refund');
      const fulfillment=['running','disconnected'].includes(String(row.fulfillment_status))?'failed':'stopped';
      await tx.query(`UPDATE sandbox_orders SET status='refunded',fulfillment_status=$2,connection_status='stopped',version=version+1,updated_at=now() WHERE id=$1`,[row.id,fulfillment]);
    }else{
      if(row.fulfillment_status!=='stopped'||row.consumed_micros===null)fail('INVALID_STATE');
      const unused=total-BigInt(String(row.consumed_micros));
      if(input.outcome==='partial_refund'){
        if(!input.refundCredits)fail('VALIDATION_ERROR',400);refund=parseCredit(input.refundCredits,{positive:true});
        if(refund<unused||refund>=total)fail('VALIDATION_ERROR',400);
      }else refund=unused;
      status='accepted';await this.settle(tx,row,refund,'dispute_resolved');
      await tx.query(`UPDATE sandbox_orders SET status='accepted',fulfillment_status='stopped',connection_status='stopped',version=version+1,updated_at=now() WHERE id=$1`,[row.id]);
    }
    await tx.query(`UPDATE sandbox_disputes SET status='resolved',outcome=$2,refund_micros=$3,version=version+1,updated_at=now() WHERE id=$1`,[disputeId,input.outcome,refund]);await this.event(tx,operator,'DISPUTE_RESOLVED','dispute',disputeId,input,'high');return{status:200,body:{dispute:{id:disputeId,orderId:String(row.id),status:'resolved',outcome:input.outcome,refundCredits:formatCredit(refund),version:Number(dispute.version)+1},order:this.orderView(await this.orderForOperator(String(row.id),tx)),balance:await this.balance(String(row.buyer_subject_id),tx)}};
  });}

  async referralLink(subjectId:string,key:string){return this.idempotent(subjectId,'creator.link',key,{},async tx=>{const id=randomUUID(),token=`demo_${randomUUID().replaceAll('-','')}_${randomUUID().replaceAll('-','')}`;await tx.query(`INSERT INTO sandbox_referral_links(id,creator_subject_id,token,simulation,environment) VALUES($1,$2,$3,true,'staging')`,[id,subjectId,token]);await this.event(tx,subjectId,'REFERRAL_LINK_CREATED','referral_link',id,{});return{body:{referralLink:{id,code:id.slice(0,8),providerSource:'staging_demo',token,url:`zod-staging://referral?token=${token}`,expiresAt:null,simulation:true}}};});}
  async attribute(subjectId:string,token:string,key:string){return this.idempotent(subjectId,'referral.attribute',key,{token},async tx=>{const lr=await tx.query<{id:string;creator_subject_id:string}>('SELECT id,creator_subject_id FROM sandbox_referral_links WHERE token=$1',[token]);const link=lr.rows[0];if(!link)fail('NOT_FOUND',404);if(link.creator_subject_id===subjectId)fail('INVALID_STATE');const existing=await tx.query<{id:string;creator_subject_id:string}>('SELECT id,creator_subject_id FROM sandbox_attributions WHERE buyer_subject_id=$1',[subjectId]);if(existing.rows[0]){if(existing.rows[0].creator_subject_id!==link.creator_subject_id)fail('IDEMPOTENCY_CONFLICT');return{status:200,body:{attribution:{id:existing.rows[0].id,providerSource:'staging_demo',expiresAt:null,simulation:true}}};}const id=randomUUID();await tx.query(`INSERT INTO sandbox_attributions(id,buyer_subject_id,creator_subject_id,simulation,environment) VALUES($1,$2,$3,true,'staging')`,[id,subjectId,link.creator_subject_id]);await this.event(tx,subjectId,'REFERRAL_ATTRIBUTED','attribution',id,{linkId:link.id});return{body:{attribution:{id,providerSource:'staging_demo',expiresAt:null,simulation:true}}};});}

  async commissions(subjectId:string){const r=await this.db.query<Record<string,unknown>>('SELECT * FROM sandbox_commissions WHERE creator_subject_id=$1 ORDER BY created_at DESC',[subjectId]);const sums=new Map<string,bigint>();for(const row of r.rows)sums.set(String(row.status),(sums.get(String(row.status))??0n)+BigInt(String(row.amount_micros)));const available=sums.get('available')??0n;return{unit:'KAI_CARD_HOUR',precision:2,policy:{version:STAGING_POLICY.version,commissionBasisPoints:STAGING_POLICY.commissionBasisPoints,observationDays:STAGING_POLICY.observationDays},balances:{pendingCardHours:formatCredit((sums.get('attributed')??0n)+(sums.get('refund_observation')??0n)),availableCardHours:formatCredit(available),transferredCardHours:formatCredit(sums.get('transferred')??0n)},allowedActions:available>0n?['transfer']:[],commissions:r.rows.map(row=>({id:String(row.id),orderKind:'staging_compute_order',orderId:String(row.order_id),status:String(row.status),commissionCardHours:formatCredit(BigInt(String(row.amount_micros))),completedAt:row.observation_started_at?iso(row.observation_started_at):null,availableAt:row.available_at?iso(row.available_at):null,allowedActions:row.status==='available'?['transfer']:[],createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),simulation:true}))};}

  async reconcile(operator:string,orderId:string,input:{event:'source_completed'|'source_refunded'|'mature_observation';expectedVersion:number},key:string){return this.idempotent(operator,'creator.reconcile',key,{orderId,...input},async tx=>{
    const cr=await tx.query<Record<string,unknown>>('SELECT * FROM sandbox_commissions WHERE order_id=$1 FOR UPDATE',[orderId]);const row=cr.rows[0];if(!row)fail('NOT_FOUND',404);if(Number(row.version)!==input.expectedVersion)fail('VERSION_CONFLICT');
    const order=await this.orderForOperator(orderId,tx),current=String(row.status);let next:string,amount=BigInt(String(row.amount_micros));let clock=(await tx.query<{current_at:Date}>('SELECT current_at FROM sandbox_clock WHERE singleton=true FOR UPDATE')).rows[0]!.current_at;
    if(input.event==='source_completed'){
      if(current!=='attributed'||order.status!=='accepted'||order.consumed_micros===null||order.settled_micros===null)fail('INVALID_STATE');
      const raw=BigInt(String(order.settled_micros))*BigInt(STAGING_POLICY.commissionBasisPoints)/10_000n;amount=raw-raw%10_000n;next='refund_observation';
    }else if(input.event==='source_refunded'){
      if(!['attributed','refund_observation','available'].includes(current))fail('INVALID_STATE');
      if(order.status==='accepted'){
        if(current==='attributed'||order.consumed_micros===null)fail('INVALID_STATE');
        const captured=BigInt(String(order.settled_micros??order.consumed_micros)),quantity=BigInt(String(order.consumed_quantity_minor??0));
        await this.post(tx,{reason:'source_order_refunded',entityType:'order',entityId:orderId,lines:[{subjectId:SEEDED.supplier,kind:'supplier_earned',delta:-captured},{subjectId:String(order.buyer_subject_id),kind:'available',delta:captured}]});
        await tx.query(`UPDATE sandbox_listings SET capacity_consumed_minor=capacity_consumed_minor-$2,version=version+1,updated_at=now() WHERE id=$1`,[order.listing_id,quantity]);
        await tx.query(`UPDATE sandbox_orders SET status='refunded',fulfillment_status='stopped',connection_status='stopped',version=version+1,updated_at=now() WHERE id=$1`,[orderId]);
        await this.event(tx,operator,'SOURCE_ORDER_REFUNDED','order',orderId,{commissionId:row.id});
      }else if(!['canceled','failed','refunded'].includes(String(order.status)))fail('INVALID_STATE');
      if(current==='available'&&amount>0n)await this.post(tx,{reason:'creator_commission_reversed',entityType:'commission',entityId:String(row.id),lines:[{subjectId:String(row.creator_subject_id),kind:'creator_available',delta:-amount},{subjectId:null,kind:'demo_funding',delta:amount}]});
      next='reversed';
    }else{
      if(current!=='refund_observation'||order.status!=='accepted')fail('INVALID_STATE');
      clock=(await tx.query<{current_at:Date}>(`UPDATE sandbox_clock SET current_at=current_at+interval '7 days' WHERE singleton=true RETURNING current_at`)).rows[0]!.current_at;const started=new Date(String(row.observation_started_at));if(!row.observation_started_at||clock.getTime()-started.getTime()<STAGING_POLICY.observationDays*86_400_000)fail('INVALID_STATE');
      if(amount>0n)await this.post(tx,{reason:'creator_commission_matured',entityType:'commission',entityId:String(row.id),lines:[{subjectId:null,kind:'demo_funding',delta:-amount},{subjectId:String(row.creator_subject_id),kind:'creator_available',delta:amount}]});next='available';
    }
    await tx.query(`UPDATE sandbox_commissions SET status=$2,amount_micros=$3,observation_started_at=CASE WHEN $4='source_completed' THEN $5 ELSE observation_started_at END,available_at=CASE WHEN $4='mature_observation' THEN $5 ELSE available_at END,version=version+1,updated_at=now() WHERE id=$1`,[row.id,next,amount,input.event,clock]);await this.event(tx,operator,'CREATOR_RECONCILED','commission',String(row.id),{...input,...(input.event==='mature_observation'?{sandboxClockAdvancedDays:7}:{})});return{status:200,body:{commission:{id:String(row.id),orderId,status:next,version:Number(row.version)+1,commissionCardHours:formatCredit(amount),simulation:true}}};
  });}

  async transfer(subjectId:string,key:string){return this.idempotent(subjectId,'creator.transfer',key,{},async tx=>{const account=await this.account(tx,subjectId,'creator_available');if(account.balance<=0n)fail('INVALID_STATE');const transferId=randomUUID(),rewardId=randomUUID(),amount=account.balance;await this.post(tx,{reason:'creator_commission_transferred',entityType:'transfer',entityId:transferId,lines:[{subjectId,kind:'creator_available',delta:-amount},{subjectId,kind:'available',delta:amount}]});await tx.query(`UPDATE sandbox_commissions SET status='transferred',version=version+1,updated_at=now() WHERE creator_subject_id=$1 AND status='available'`,[subjectId]);await tx.query(`INSERT INTO sandbox_reward_events(id,creator_subject_id,transfer_id,amount_micros,status,simulation,environment) VALUES($1,$2,$3,$4,'pending',true,'staging')`,[rewardId,subjectId,transferId,amount]);await this.event(tx,subjectId,'CREATOR_TRANSFERRED','transfer',transferId,{amount:formatCredit(amount)});return{body:{transfer:{cardHours:formatCredit(amount),rewardEvent:{eventId:rewardId,transferId,cardHours:formatCredit(amount),status:'pending',allowedActions:['consume'],createdAt:new Date().toISOString(),consumedAt:null,simulation:true}},balance:await this.balance(subjectId,tx)}};});}
  async rewards(subjectId:string,limit:number){const r=await this.db.query<Record<string,unknown>>('SELECT * FROM sandbox_reward_events WHERE creator_subject_id=$1 ORDER BY created_at DESC LIMIT $2',[subjectId,limit]);return r.rows.map(row=>this.rewardView(row));}
  private rewardView(row:Record<string,unknown>){const status=String(row.status);return{eventId:String(row.id),transferId:String(row.transfer_id),cardHours:formatCredit(BigInt(String(row.amount_micros))),status,allowedActions:status==='pending'?['consume']:[],createdAt:iso(row.created_at),consumedAt:row.consumed_at?iso(row.consumed_at):null,simulation:true};}
  async consumeReward(subjectId:string,id:string,key:string){return this.idempotent(subjectId,'reward.consume',key,{id},async tx=>{const r=await tx.query<Record<string,unknown>>('SELECT * FROM sandbox_reward_events WHERE id=$1 AND creator_subject_id=$2 FOR UPDATE',[id,subjectId]);const row=r.rows[0];if(!row)fail('NOT_FOUND',404);if(row.status==='consumed')return{status:200,body:{event:this.rewardView(row)}};await tx.query(`UPDATE sandbox_reward_events SET status='consumed',consumed_at=now() WHERE id=$1`,[id]);await this.event(tx,subjectId,'REWARD_CONSUMED','reward_event',id,{});const updated=(await tx.query<Record<string,unknown>>('SELECT * FROM sandbox_reward_events WHERE id=$1',[id])).rows[0]!;return{status:200,body:{event:this.rewardView(updated)}};});}

  async reset(operator:string,subjectId:string,input:{confirmation:string;expectedVersion:number},key:string){return this.idempotent(operator,'subject.reset',key,{subjectId,...input},async tx=>{
    if(input.confirmation!=='RESET STAGING SUBJECT')fail('VALIDATION_ERROR',400);
    const sr=await tx.query<{version:number;role:string}>('SELECT version,role FROM sandbox_subjects WHERE id=$1 FOR UPDATE',[subjectId]);const subject=sr.rows[0];if(!subject)fail('NOT_FOUND',404);if(subject.role!=='member')fail('FORBIDDEN',403);if(subject.version!==input.expectedVersion)fail('VERSION_CONFLICT');
    const orderRows=await tx.query<{id:string;listing_id:string;quantity_minor:string;consumed_quantity_minor:string|null;settled_micros:string|null;status:string}>(`SELECT id,listing_id,quantity_minor::text,consumed_quantity_minor::text,settled_micros::text,status FROM sandbox_orders WHERE buyer_subject_id=$1 AND simulation FOR UPDATE`,[subjectId]);
    const externalCommission=(await tx.query<{count:string}>(`SELECT count(*)::text AS count FROM sandbox_commissions WHERE order_id IN(SELECT id FROM sandbox_orders WHERE buyer_subject_id=$1) AND creator_subject_id<>$1`,[subjectId])).rows[0]?.count??'0';
    const externalAttribution=(await tx.query<{count:string}>(`SELECT count(*)::text AS count FROM sandbox_attributions WHERE creator_subject_id=$1 AND buyer_subject_id<>$1`,[subjectId])).rows[0]?.count??'0';
    if(externalCommission!=='0'||externalAttribution!=='0')fail('INVALID_STATE');
    for(const order of orderRows.rows){let reserved='0',consumed='0';if(['reserved','disputed','acceptance_pending'].includes(order.status))reserved=order.quantity_minor;else if(order.status==='accepted'){consumed=order.consumed_quantity_minor??'0';const settled=BigInt(order.settled_micros??'0');if(settled>0n)await this.post(tx,{reason:'subject_reset_supplier_reversal',entityType:'order',entityId:order.id,lines:[{subjectId:SEEDED.supplier,kind:'supplier_earned',delta:-settled},{subjectId:null,kind:'demo_funding',delta:settled}]});}if(reserved!=='0'||consumed!=='0')await tx.query(`UPDATE sandbox_listings SET capacity_reserved_minor=capacity_reserved_minor-$2::bigint,capacity_consumed_minor=capacity_consumed_minor-$3::bigint,version=version+1,updated_at=now() WHERE id=$1`,[order.listing_id,reserved,consumed]);}
    const accounts=await tx.query<{kind:string;balance_micros:string}>('SELECT kind,balance_micros::text FROM sandbox_accounts WHERE subject_id=$1 FOR UPDATE',[subjectId]);const resetId=randomUUID();
    for(const account of accounts.rows){const amount=BigInt(account.balance_micros);if(amount>0n)await this.post(tx,{reason:`subject_reset_clear_${account.kind}`,entityType:'reset',entityId:resetId,lines:[{subjectId,kind:account.kind,delta:-amount},{subjectId:null,kind:'demo_funding',delta:amount}]});}
    const seedBalance=subjectId===SEEDED.buyer?100_000_000n:0n;
    if(seedBalance>0n)await this.post(tx,{reason:'subject_reset_seed_balance',entityType:'reset',entityId:resetId,lines:[{subjectId:null,kind:'demo_funding',delta:-seedBalance},{subjectId,kind:'available',delta:seedBalance}]});
    const counts:Record<string,number>={};
    for(const [name,sql] of [
      ['rewardEvents','DELETE FROM sandbox_reward_events WHERE creator_subject_id=$1 AND simulation'],
      ['commissions','DELETE FROM sandbox_commissions WHERE creator_subject_id=$1 OR order_id IN(SELECT id FROM sandbox_orders WHERE buyer_subject_id=$1)'],
      ['disputes','DELETE FROM sandbox_disputes WHERE subject_id=$1 AND simulation'],
      ['manualDeliveryRequests','DELETE FROM sandbox_manual_delivery_requests WHERE buyer_subject_id=$1 AND simulation'],
      ['orders','DELETE FROM sandbox_orders WHERE buyer_subject_id=$1 AND simulation'],
      ['sshPublicKeys','DELETE FROM sandbox_ssh_public_keys WHERE subject_id=$1 AND simulation'],
      ['topups','DELETE FROM sandbox_topups WHERE subject_id=$1 AND simulation'],
      ['attributions','DELETE FROM sandbox_attributions WHERE (buyer_subject_id=$1 OR creator_subject_id=$1) AND simulation'],
      ['referralLinks','DELETE FROM sandbox_referral_links WHERE creator_subject_id=$1 AND simulation'],
      ['idempotency','DELETE FROM sandbox_idempotency WHERE actor_subject_id=$1 AND simulation'],
    ] as const){const result=await tx.query(sql,[subjectId]);counts[name]=result.affectedRows??0;}
    await tx.query('UPDATE sandbox_subjects SET version=version+1 WHERE id=$1',[subjectId]);const completedAt=new Date();await tx.query(`INSERT INTO sandbox_resets(id,subject_id,counts,completed_at,simulation,environment) VALUES($1,$2,$3,$4,true,'staging')`,[resetId,subjectId,JSON.stringify(counts),completedAt]);await this.event(tx,operator,'SUBJECT_RESET','reset',resetId,{subjectId,counts},'high');return{status:200,body:{resetId,subjectId,counts,newBalance:await this.balance(subjectId,tx),completedAt:completedAt.toISOString()}};
  });}

  async ledgerConservation(){const r=await this.db.query<{total:string}>('SELECT COALESCE(sum(delta_micros),0)::text AS total FROM sandbox_ledger_entries');return BigInt(r.rows[0]?.total??'0');}
}
