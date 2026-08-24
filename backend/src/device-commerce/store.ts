import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import type { Database } from '../database.js';
import { KAI_CREDIT_PLATFORM_ACCOUNTS } from '../credits/types.js';
import { CreditLotAllocator } from '../credits/lot-allocator.js';
import { planSettlementFee, shanghaiPeriodStart } from '../settlement-fees/engine.js';
import type { FeeTier } from '../settlement-fees/types.js';
import type { DeviceAsset, DeviceOrder, DeviceOrderStatus, DeviceProduct } from './types.js';

type ProductRow = QueryResultRow & { id:string; sku:string; campaign_key:string; template_key:string; title:string; supplier_display_name:string;
  supplier_subject_id:string|null; activation_status:DeviceProduct['activationStatus']; inventory_total:number;
  inventory_reserved:number; inventory_sold:number; list_price_cny_micros:string; sale_price_cny_micros:string;
  list_unit_credit_micros:string; unit_credit_micros:string; discount_basis_points:number; expected_ship_days:number; specifications:Record<string,unknown> };
type OrderRow = QueryResultRow & { id:string; order_number:string; buyer_subject_id:string; supplier_subject_id:string;
  created_by_user_id:string; product_id:string; campaign_key:string; campaign_version:string; status:DeviceOrderStatus; quantity:number; unit_credit_micros:string;
  gross_credit_micros:string; service_fee_credit_micros:string|null; supplier_net_credit_micros:string|null;
  reservation_transaction_id:string; resolution_transaction_id:string|null; reservation_expires_at:Date;
  confirmed_at:Date|null; shipped_at:Date|null; received_at:Date|null; resolved_at:Date|null;
  logistics_provider:string|null; tracking_ciphertext:string|null; created_at:Date; updated_at:Date };
type AssetRow = QueryResultRow & { id:string; order_id:string; owner_subject_id:string; product_id:string;
  title:string; quantity:number; status:'owned'; acquired_at:Date };

const productColumns = `id,sku,campaign_key,template_key,title,supplier_display_name,supplier_subject_id,activation_status,inventory_total,
  inventory_reserved,inventory_sold,list_price_cny_micros::text,sale_price_cny_micros::text,
  list_unit_credit_micros::text,unit_credit_micros::text,discount_basis_points,expected_ship_days,specifications`;
const orderColumns = `id,order_number,buyer_subject_id,supplier_subject_id,created_by_user_id,product_id,status,
  campaign_key,campaign_version,quantity,unit_credit_micros::text,gross_credit_micros::text,service_fee_credit_micros::text,
  supplier_net_credit_micros::text,reservation_transaction_id,resolution_transaction_id,reservation_expires_at,
  confirmed_at,shipped_at,received_at,resolved_at,logistics_provider,tracking_ciphertext,created_at,updated_at`;
function product(row:ProductRow):DeviceProduct { return { id:row.id,sku:row.sku,campaignKey:row.campaign_key,templateKey:row.template_key,title:row.title,
  supplierDisplayName:row.supplier_display_name,supplierSubjectId:row.supplier_subject_id,
  activationStatus:row.activation_status,inventoryTotal:row.inventory_total,inventoryReserved:row.inventory_reserved,
  inventorySold:row.inventory_sold,listPriceCnyMicros:BigInt(row.list_price_cny_micros),
  salePriceCnyMicros:BigInt(row.sale_price_cny_micros),listUnitCreditMicros:BigInt(row.list_unit_credit_micros),unitCreditMicros:BigInt(row.unit_credit_micros),
  discountBasisPoints:row.discount_basis_points,expectedShipDays:row.expected_ship_days,specifications:row.specifications }; }
function order(row:OrderRow):DeviceOrder { const optional=(x:string|null)=>x===null?null:BigInt(x); return {
  id:row.id,orderNumber:row.order_number,buyerSubjectId:row.buyer_subject_id,supplierSubjectId:row.supplier_subject_id,
  createdByUserId:row.created_by_user_id,productId:row.product_id,campaignKey:row.campaign_key,
  campaignVersion:row.campaign_version,status:row.status,quantity:row.quantity,
  unitCreditMicros:BigInt(row.unit_credit_micros),grossCreditMicros:BigInt(row.gross_credit_micros),
  serviceFeeCreditMicros:optional(row.service_fee_credit_micros),supplierNetCreditMicros:optional(row.supplier_net_credit_micros),
  reservationTransactionId:row.reservation_transaction_id,resolutionTransactionId:row.resolution_transaction_id,
  reservationExpiresAt:new Date(row.reservation_expires_at),confirmedAt:row.confirmed_at?new Date(row.confirmed_at):null,
  shippedAt:row.shipped_at?new Date(row.shipped_at):null,receivedAt:row.received_at?new Date(row.received_at):null,
  resolvedAt:row.resolved_at?new Date(row.resolved_at):null,logisticsProvider:row.logistics_provider,trackingCiphertext:row.tracking_ciphertext,
  createdAt:new Date(row.created_at),updatedAt:new Date(row.updated_at) }; }

export type CreateDeviceOrderResult = {status:'created'|'replayed';order:DeviceOrder}|{status:'conflict'|'product_unavailable'|'address_unavailable'|'insufficient_stock'|'insufficient_credits'|'self_purchase'};
export type DeviceActionResult = {status:'updated'|'replayed';order:DeviceOrder}|{status:'conflict'|'not_found'|'invalid_state'};
export type DeviceSettlementResult = {status:'updated'|'replayed';settlement:{orderId:string;status:'pending'|'succeeded';
  grossCreditMicros:bigint;serviceFeeCreditMicros:bigint;netCreditMicros:bigint;availableAt:Date;
  settlementTransactionId:string|null;settledAt:Date|null}}|{status:'conflict'|'not_found'|'invalid_state'}|{status:'not_due';availableAt:Date};

export class PostgresDeviceCommerceStore {
  constructor(private readonly database:Database, private readonly lots = new CreditLotAllocator()) {}
  async listProducts(){ const r=await this.database.query<ProductRow>(`SELECT ${productColumns} FROM physical_device_products ORDER BY created_at,id`); return r.rows.map(product); }
  async getProduct(id:string){ const r=await this.database.query<ProductRow>(`SELECT ${productColumns} FROM physical_device_products WHERE id=$1`,[id]); return r.rows[0]?product(r.rows[0]):null; }
  async activationReadiness(productId:string,supplierSubjectId:string){
    const result=await this.database.query<{product_status:string|null;subject_status:string|null;subject_kind:string|null;
      subject_name:string|null;payout_status:string|null;recipient_reference:string|null;legal_entity_digest:string|null}>(`SELECT
        p.activation_status product_status,s.status subject_status,s.kind subject_kind,s.display_name subject_name,
        pp.status payout_status,pp.recipient_reference,pp.legal_entity_digest
      FROM physical_device_products p
      LEFT JOIN trading_subjects s ON s.id=$2
      LEFT JOIN kai_credit_payout_profiles pp ON pp.subject_id=s.id
      WHERE p.id=$1`,[productId,supplierSubjectId]);
    const row=result.rows[0];const blockers:string[]=[];
    if(!row)blockers.push('DEVICE_PRODUCT_NOT_FOUND');
    if(row&&row.product_status==='active')blockers.push('DEVICE_PRODUCT_ALREADY_ACTIVE');
    if(row&&row.subject_status!=='active')blockers.push('SUPPLIER_SUBJECT_NOT_ACTIVE');
    if(row&&row.subject_kind!=='organization')blockers.push('SUPPLIER_ORGANIZATION_REQUIRED');
    if(row&&row.payout_status!=='active')blockers.push('SUPPLIER_PAYOUT_PROFILE_NOT_ACTIVE');
    if(row&&(!row.recipient_reference||!row.legal_entity_digest))blockers.push('SUPPLIER_PAYOUT_EVIDENCE_INCOMPLETE');
    return{ready:blockers.length===0,blockers,productStatus:row?.product_status??null,
      supplier:{subjectId:supplierSubjectId,displayName:row?.subject_name??null,subjectStatus:row?.subject_status??null,
        subjectKind:row?.subject_kind??null,payoutProfileStatus:row?.payout_status??null}};
  }
  async activateProduct(productId:string,supplierSubjectId:string,operatorId:string,now:Date){ return this.database.transaction(async client=>{
    const eligible=await client.query<{subject_id:string;display_name:string}>(`SELECT p.subject_id,s.display_name FROM kai_credit_payout_profiles p JOIN trading_subjects s ON s.id=p.subject_id
      WHERE p.subject_id=$1 AND p.status='active' AND s.status='active' AND s.kind='organization'
        AND p.recipient_reference IS NOT NULL AND p.legal_entity_digest IS NOT NULL FOR UPDATE OF p,s`,[supplierSubjectId]);
    if(!eligible.rows[0]) return null;
    const r=await client.query<ProductRow>(`UPDATE physical_device_products SET activation_status='active',supplier_subject_id=$2,
      supplier_display_name=$5,activated_by_user_id=$3,activated_at=$4 WHERE id=$1 AND activation_status IN ('pending_activation','suspended') RETURNING ${productColumns}`,
    [productId,supplierSubjectId,operatorId,now,eligible.rows[0].display_name]); return r.rows[0]?product(r.rows[0]):null; }); }
  async create(input:{id:string;orderNumber:string;buyerSubjectId:string;userId:string;productId:string;quantity:number;
    shippingAddressReference:string;clientRequestId:string;payloadDigest:string;expiresAt:Date;now:Date}):Promise<CreateDeviceOrderResult>{
    return this.database.transaction(async client=>{
      const replay=await client.query<OrderRow&{payload_digest:string}>(`SELECT ${orderColumns},payload_digest FROM physical_device_orders
        WHERE buyer_subject_id=$1 AND client_request_id=$2 FOR UPDATE`,[input.buyerSubjectId,input.clientRequestId]);
      if(replay.rows[0]) return replay.rows[0].payload_digest===input.payloadDigest?{status:'replayed',order:order(replay.rows[0])}:{status:'conflict'};
      const pr=await client.query<ProductRow>(`SELECT ${productColumns} FROM physical_device_products WHERE id=$1 FOR UPDATE`,[input.productId]);
      const item=pr.rows[0]?product(pr.rows[0]):null;
      if(!item||item.activationStatus!=='active'||!item.supplierSubjectId) return {status:'product_unavailable'};
      const address=await client.query(`SELECT id FROM shipping_addresses WHERE reference=$1 AND subject_id=$2 AND status='active' FOR SHARE`,[input.shippingAddressReference,input.buyerSubjectId]);
      if(!address.rows[0])return{status:'address_unavailable'};
      if(item.supplierSubjectId===input.buyerSubjectId) return {status:'self_purchase'};
      if(item.inventoryTotal-item.inventoryReserved-item.inventorySold<input.quantity) return {status:'insufficient_stock'};
      const accounts=await this.ensureBuyerAccounts(client,input.buyerSubjectId);
      const balances=await this.lots.snapshot(client,input.buyerSubjectId,input.now);
      const gross=item.unitCreditMicros*BigInt(input.quantity);
      if(balances.unrestrictedAvailableMicros<gross) return {status:'insufficient_credits'};
      const tx=randomUUID(); await client.query(`INSERT INTO kai_credit_transactions(id,idempotency_owner,scope,idempotency_key,payload_digest,
        reference_type,reference_id,description,status) VALUES($1,$2,'DEVICE_ORDER_RESERVATION',$3,$4,'order_reservation',$5,$6,'pending')`,
      [tx,`subject:${input.buyerSubjectId}`,`device-order-reserve:${input.id}`,input.payloadDigest,input.id,`设备订单 ${input.orderNumber} 卡时预留`]);
      await client.query(`INSERT INTO kai_credit_entries(id,transaction_id,account_id,amount_micros,memo) VALUES
        ($1,$2,$3,$4,'设备订单预留'),($5,$2,$6,$7,'设备订单预留')`,[randomUUID(),tx,accounts.available,(-gross).toString(),randomUUID(),accounts.reserved,gross.toString()]);
      await client.query(`UPDATE kai_credit_transactions SET status='posted',posted_at=$2 WHERE id=$1`,[tx,input.now]);
      await client.query(`UPDATE physical_device_products SET inventory_reserved=inventory_reserved+$2 WHERE id=$1`,[item.id,input.quantity]);
      const r=await client.query<OrderRow>(`INSERT INTO physical_device_orders(id,order_number,buyer_subject_id,supplier_subject_id,
        created_by_user_id,product_id,campaign_key,campaign_version,client_request_id,payload_digest,shipping_address_reference,status,quantity,
        unit_credit_micros,gross_credit_micros,reservation_transaction_id,reservation_expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'reserved',$12,$13,$14,$15,$16) RETURNING ${orderColumns}`,
      [input.id,input.orderNumber,input.buyerSubjectId,item.supplierSubjectId,input.userId,item.id,
        item.campaignKey,item.templateKey,input.clientRequestId,input.payloadDigest,input.shippingAddressReference,input.quantity,
        item.unitCreditMicros.toString(),gross.toString(),tx,input.expiresAt]);
      return {status:'created',order:order(r.rows[0]!)};
    });
  }
  async listOrders(subjectId:string,side:'all'|'buyer'|'supplier'='all',limit=100){const ownership=side==='buyer'?'buyer_subject_id=$1':side==='supplier'?'supplier_subject_id=$1':'(buyer_subject_id=$1 OR supplier_subject_id=$1)';const r=await this.database.query<OrderRow>(`SELECT ${orderColumns} FROM physical_device_orders
    WHERE ${ownership} ORDER BY created_at DESC,id DESC LIMIT $2`,[subjectId,limit]); return r.rows.map(order); }
  async portfolioCounts(subjectId:string){const result=await this.database.query<{buyer_orders:string;supplier_orders:string;owned_devices:string;
    buyer_actions:string;supplier_actions:string}>(`SELECT
      (SELECT count(*) FROM physical_device_orders WHERE buyer_subject_id=$1)::text buyer_orders,
      (SELECT count(*) FROM physical_device_orders WHERE supplier_subject_id=$1)::text supplier_orders,
      (SELECT count(*) FROM physical_device_assets WHERE owner_subject_id=$1)::text owned_devices,
      (SELECT count(*) FROM physical_device_orders WHERE buyer_subject_id=$1 AND status IN ('reserved','confirmed','shipping'))::text buyer_actions,
      (SELECT count(*) FROM physical_device_orders WHERE supplier_subject_id=$1 AND status IN ('reserved','confirmed'))::text supplier_actions`,[subjectId]);const row=result.rows[0];return{buyerOrders:Number(row?.buyer_orders??'0'),supplierOrders:Number(row?.supplier_orders??'0'),
      ownedDevices:Number(row?.owned_devices??'0'),buyerActions:Number(row?.buyer_actions??'0'),supplierActions:Number(row?.supplier_actions??'0')};}
  async getOrder(subjectId:string,id:string){ const r=await this.database.query<OrderRow>(`SELECT ${orderColumns} FROM physical_device_orders
    WHERE id=$1 AND (buyer_subject_id=$2 OR supplier_subject_id=$2)`,[id,subjectId]); return r.rows[0]?order(r.rows[0]):null; }
  async listAssets(subjectId:string,limit=100){ const r=await this.database.query<AssetRow>(`SELECT a.id,a.order_id,a.owner_subject_id,a.product_id,
    p.title,a.quantity,a.status,a.acquired_at FROM physical_device_assets a JOIN physical_device_products p ON p.id=a.product_id
    WHERE a.owner_subject_id=$1 ORDER BY a.acquired_at DESC,a.id DESC LIMIT $2`,[subjectId,limit]); return r.rows.map(row=>({id:row.id,orderId:row.order_id,
      ownerSubjectId:row.owner_subject_id,productId:row.product_id,title:row.title,quantity:row.quantity,status:row.status,acquiredAt:new Date(row.acquired_at)} satisfies DeviceAsset)); }
  async expireReservations(now:Date,limit=100){return this.database.transaction(async client=>{const rows=await client.query<OrderRow>(`SELECT ${orderColumns}
    FROM physical_device_orders WHERE status='reserved' AND reservation_expires_at<=$1 ORDER BY reservation_expires_at,id FOR UPDATE SKIP LOCKED LIMIT $2`,[now,limit]);
    for(const row of rows.rows){const current=order(row);const tx=await this.release(client,current,{payloadDigest:`device-order-expire:${current.id}`,now} as Parameters<PostgresDeviceCommerceStore['action']>[0]);
      await client.query(`UPDATE physical_device_products SET inventory_reserved=inventory_reserved-$2 WHERE id=$1`,[current.productId,current.quantity]);
      await client.query(`UPDATE physical_device_orders SET status='expired',resolution_transaction_id=$2,resolved_at=$3 WHERE id=$1 AND status='reserved'`,[current.id,tx,now]);}
    return rows.rows.length;});}
  async action(input:{orderId:string;actorId:string;actorSubjectId:string;side:'buyer'|'supplier';action:'confirm'|'ship'|'receive'|'cancel'|'expire';
    from:DeviceOrderStatus;to:DeviceOrderStatus;clientRequestId:string;payloadDigest:string;now:Date;logisticsProvider?:string;trackingDigest?:string;trackingCiphertext?:string}):Promise<DeviceActionResult>{
    return this.database.transaction(async client=>{
      const old=await client.query<{order_id:string;action:string;payload_digest:string}>(`SELECT order_id,action,payload_digest FROM physical_device_order_actions
        WHERE actor_id=$1 AND client_request_id=$2 FOR UPDATE`,[input.actorId,input.clientRequestId]);
      if(old.rows[0]){ if(old.rows[0].order_id!==input.orderId||old.rows[0].action!==input.action||old.rows[0].payload_digest!==input.payloadDigest)return {status:'conflict'};
        const replay=await this.lockOrder(client,input.orderId); return replay?{status:'replayed',order:replay}:{status:'not_found'}; }
      const current=await this.lockOrder(client,input.orderId); if(!current)return {status:'not_found'};
      const authorized=(input.side==='buyer'?current.buyerSubjectId:current.supplierSubjectId)===input.actorSubjectId;
      if(!authorized||current.status!==input.from){await this.saveAction(client,input,'invalid_state');return {status:'invalid_state'};}
      let resolution:string|null=null; let fee:bigint|null=null; let net:bigint|null=null;
      if(['cancel','expire'].includes(input.action)){ resolution=await this.release(client,current,input); await client.query(`UPDATE physical_device_products
        SET inventory_reserved=inventory_reserved-$2 WHERE id=$1`,[current.productId,current.quantity]); }
      if(input.action==='receive'){
        const captured=await this.capture(client,current,input); resolution=captured.transactionId;fee=captured.fee;net=captured.net;
        await client.query(`UPDATE physical_device_products SET inventory_reserved=inventory_reserved-$2,inventory_sold=inventory_sold+$2 WHERE id=$1`,[current.productId,current.quantity]);
        await client.query(`INSERT INTO physical_device_assets(id,order_id,owner_subject_id,product_id,quantity,status,acquired_at)
          VALUES($1,$2,$3,$4,$5,'owned',$6)`,[randomUUID(),current.id,current.buyerSubjectId,current.productId,current.quantity,input.now]);
      }
      const r=await client.query<OrderRow>(`UPDATE physical_device_orders SET status=$2,resolution_transaction_id=$3,
        service_fee_credit_micros=$4,supplier_net_credit_micros=$5,
        confirmed_at=CASE WHEN $2='confirmed' THEN $6 ELSE confirmed_at END,
        shipped_at=CASE WHEN $2='shipping' THEN $6 ELSE shipped_at END,
        received_at=CASE WHEN $2='received' THEN $6 ELSE received_at END,
        resolved_at=CASE WHEN $2 IN ('received','cancelled','expired') THEN $6 ELSE NULL END,
        logistics_provider=CASE WHEN $2='shipping' THEN $7 ELSE logistics_provider END,
        tracking_digest=CASE WHEN $2='shipping' THEN $8 ELSE tracking_digest END,
        tracking_ciphertext=CASE WHEN $2='shipping' THEN $9 ELSE tracking_ciphertext END WHERE id=$1 AND status=$10 RETURNING ${orderColumns}`,
      [current.id,input.to,resolution,fee?.toString()??null,net?.toString()??null,input.now,input.logisticsProvider??null,input.trackingDigest??null,input.trackingCiphertext??null,input.from]);
      if(!r.rows[0])throw new Error('DEVICE_ORDER_STATE_CHANGED'); await this.saveAction(client,input,input.to);return {status:'updated',order:order(r.rows[0])};
    });
  }
  async settle(input:{orderId:string;actorId:string;actorSubjectId:string;clientRequestId:string;payloadDigest:string;now:Date}):Promise<DeviceSettlementResult>{
    return this.database.transaction(async client=>{
      const replay=await client.query<{order_id:string;action:string;payload_digest:string}>(`SELECT order_id,action,payload_digest
        FROM physical_device_order_actions WHERE actor_id=$1 AND client_request_id=$2 FOR UPDATE`,[input.actorId,input.clientRequestId]);
      if(replay.rows[0]){if(replay.rows[0].order_id!==input.orderId||replay.rows[0].action!=='settle'||replay.rows[0].payload_digest!==input.payloadDigest)return{status:'conflict'};
        const existing=await this.lockSettlement(client,input.orderId);return existing?{status:'replayed',settlement:existing}:{status:'not_found'};}
      const current=await this.lockOrder(client,input.orderId);if(!current)return{status:'not_found'};
      const settlement=await this.lockSettlement(client,input.orderId);if(current.status!=='received'||current.supplierSubjectId!==input.actorSubjectId||!settlement)return{status:'invalid_state'};
      if(settlement.status==='succeeded'){await client.query(`INSERT INTO physical_device_order_actions(actor_id,client_request_id,order_id,action,payload_digest,result_status)
        VALUES($1,$2,$3,'settle',$4,'succeeded')`,[input.actorId,input.clientRequestId,input.orderId,input.payloadDigest]);return{status:'replayed',settlement};}
      if(settlement.availableAt>input.now)return{status:'not_due',availableAt:settlement.availableAt};
      const accounts=await this.ensureSupplierAccounts(client,current.supplierSubjectId);const tx=randomUUID();
      await client.query(`INSERT INTO kai_credit_transactions(id,idempotency_owner,scope,idempotency_key,payload_digest,reference_type,reference_id,description,status)
        VALUES($1,$2,'DEVICE_SUPPLIER_SETTLEMENT',$3,$4,'settlement',$5,$6,'pending')`,[tx,`subject:${current.supplierSubjectId}`,`device-order-settle:${current.id}`,input.payloadDigest,current.id,`设备订单 ${current.orderNumber} 供应方结算`]);
      await client.query(`INSERT INTO kai_credit_entries(id,transaction_id,account_id,amount_micros,memo) VALUES
        ($1,$2,$3,$4,'设备销售结算转出'),($5,$2,$6,$7,'设备销售供应收益到账')`,[randomUUID(),tx,accounts.receivable,(-settlement.netCreditMicros).toString(),randomUUID(),accounts.supplierEarnings,settlement.netCreditMicros.toString()]);
      await client.query(`UPDATE kai_credit_transactions SET status='posted',posted_at=$2 WHERE id=$1`,[tx,input.now]);
      const r=await client.query<{order_id:string;status:'succeeded';gross_credit_micros:string;service_fee_credit_micros:string;net_credit_micros:string;available_at:Date;settlement_transaction_id:string;settled_at:Date}>(`UPDATE physical_device_supplier_settlements SET status='succeeded',settlement_transaction_id=$2,
        settled_by_user_id=$3,settled_actor_kind='user',settled_at=$4 WHERE order_id=$1 AND status='pending' RETURNING order_id,status,gross_credit_micros::text,
        service_fee_credit_micros::text,net_credit_micros::text,available_at,settlement_transaction_id,settled_at`,[current.id,tx,input.actorId,input.now]);
      if(!r.rows[0])throw new Error('DEVICE_SETTLEMENT_STATE_CHANGED');await client.query(`INSERT INTO physical_device_order_actions(actor_id,client_request_id,order_id,action,payload_digest,result_status)
        VALUES($1,$2,$3,'settle',$4,'succeeded')`,[input.actorId,input.clientRequestId,input.orderId,input.payloadDigest]);return{status:'updated',settlement:this.mapSettlement(r.rows[0])};
    });
  }
  async settleDue(now:Date,limit=100){
    const due=await this.database.query<{order_id:string}>(`SELECT order_id FROM physical_device_supplier_settlements
      WHERE status='pending' AND available_at<=$1 ORDER BY available_at,order_id LIMIT $2`,[now,limit]);
    let settled=0;
    for(const candidate of due.rows){
      const changed=await this.database.transaction(async client=>{
        const pending=await client.query<{net_credit_micros:string;available_at:Date}>(`SELECT net_credit_micros::text,available_at
          FROM physical_device_supplier_settlements WHERE order_id=$1 AND status='pending' FOR UPDATE`,[candidate.order_id]);
        if(!pending.rows[0]||pending.rows[0].available_at>now)return false;
        const current=await this.lockOrder(client,candidate.order_id);if(!current||current.status!=='received')throw new Error('DEVICE_AUTO_SETTLEMENT_ORDER_INVALID');
        const amount=BigInt(pending.rows[0].net_credit_micros);const accounts=await this.ensureSupplierAccounts(client,current.supplierSubjectId);const tx=randomUUID();
        await client.query(`INSERT INTO kai_credit_transactions(id,idempotency_owner,scope,idempotency_key,payload_digest,reference_type,reference_id,description,status)
          VALUES($1,$2,'DEVICE_SUPPLIER_SETTLEMENT',$3,$4,'settlement',$5,$6,'pending')`,[tx,`subject:${current.supplierSubjectId}`,
          `device-order-auto-settle:${current.id}`,`device-order-auto-settle:${current.id}`,current.id,`设备订单 ${current.orderNumber} 售后期自动结算`]);
        await client.query(`INSERT INTO kai_credit_entries(id,transaction_id,account_id,amount_micros,memo) VALUES
          ($1,$2,$3,$4,'设备销售自动结算转出'),($5,$2,$6,$7,'设备销售供应收益自动到账')`,[randomUUID(),tx,accounts.receivable,(-amount).toString(),randomUUID(),accounts.supplierEarnings,amount.toString()]);
        await client.query(`UPDATE kai_credit_transactions SET status='posted',posted_at=$2 WHERE id=$1`,[tx,now]);
        const updated=await client.query(`UPDATE physical_device_supplier_settlements SET status='succeeded',
          settlement_transaction_id=$2,settled_by_user_id=NULL,settled_actor_kind='system',settled_at=$3
          WHERE order_id=$1 AND status='pending'`,[current.id,tx,now]);
        if(updated.rowCount!==1)throw new Error('DEVICE_AUTO_SETTLEMENT_STATE_CHANGED');return true;
      });
      if(changed)settled+=1;
    }
    return settled;
  }
  private async capture(client:PoolClient,o:DeviceOrder,input:Parameters<PostgresDeviceCommerceStore['action']>[0]){
    const feePolicy=await this.lockTradeFeePlan(client,o.supplierSubjectId,o.grossCreditMicros,input.now);
    const acc=await this.ensureCaptureAccounts(client,o.buyerSubjectId,o.supplierSubjectId);
    const plan=feePolicy.plan;const tx=randomUUID();
    await client.query(`INSERT INTO kai_credit_transactions(id,idempotency_owner,scope,idempotency_key,payload_digest,reference_type,reference_id,description,status)
      VALUES($1,$2,'DEVICE_ORDER_CAPTURE',$3,$4,'order_capture',$5,$6,'pending')`,[tx,`subject:${o.buyerSubjectId}`,`device-order-capture:${o.id}`,input.payloadDigest,o.id,`设备订单 ${o.orderNumber} 签收结算`]);
    await client.query(`INSERT INTO kai_credit_entries(id,transaction_id,account_id,amount_micros,memo) VALUES
      ($1,$2,$3,$4,'设备订单签收扣款'),($5,$2,$6,$7,'设备销售待结算')`,
    [randomUUID(),tx,acc.buyerReserved,(-o.grossCreditMicros).toString(),randomUUID(),acc.supplierReceivable,
      plan.netCreditMicros.toString()]);
    if(plan.serviceFeeCreditMicros>0n)await client.query(`INSERT INTO kai_credit_entries(
      id,transaction_id,account_id,amount_micros,memo) VALUES($1,$2,$3,$4,'设备销售平台手续费')`,
    [randomUUID(),tx,KAI_CREDIT_PLATFORM_ACCOUNTS.revenue,plan.serviceFeeCreditMicros.toString()]);
    await client.query(`UPDATE kai_credit_transactions SET status='posted',posted_at=$2 WHERE id=$1`,[tx,input.now]);
    await client.query(`INSERT INTO physical_device_supplier_settlements(id,order_id,supplier_subject_id,
      gross_credit_micros,service_fee_credit_micros,net_credit_micros,status,available_at)
      VALUES($1,$2,$3,$4,$5,$6,'pending',$7)`,[randomUUID(),o.id,o.supplierSubjectId,o.grossCreditMicros.toString(),
      plan.serviceFeeCreditMicros.toString(),plan.netCreditMicros.toString(),new Date(input.now.getTime()+7*24*60*60*1000)]);
    if(feePolicy.persist){const assessmentId=randomUUID();
      await client.query(`INSERT INTO physical_device_fee_assessments(id,order_id,supplier_subject_id,schedule_id,
      schedule_version,period_id,period_start,payload_digest,gross_credit_micros,service_fee_credit_micros,
      net_credit_micros,cumulative_before_micros,cumulative_after_micros,ledger_transaction_id,assessed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,[assessmentId,o.id,o.supplierSubjectId,
      feePolicy.scheduleId,feePolicy.scheduleVersion,feePolicy.periodId,feePolicy.periodStart,input.payloadDigest,
      plan.grossCreditMicros.toString(),plan.serviceFeeCreditMicros.toString(),plan.netCreditMicros.toString(),
      plan.cumulativeBeforeMicros.toString(),plan.cumulativeAfterMicros.toString(),tx,input.now]);
      for(const segment of plan.segments)await client.query(`INSERT INTO physical_device_fee_assessment_segments(id,
      assessment_id,ordinal,tier_ordinal,lower_bound_micros,upper_bound_micros,settled_credit_micros,rate_bps,
      exact_fee_numerator,service_fee_credit_micros) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[randomUUID(),
      assessmentId,segment.ordinal,segment.tierOrdinal,segment.lowerBoundMicros.toString(),
      segment.upperBoundMicros?.toString()??null,segment.settledCreditMicros.toString(),segment.rateBps,
      segment.exactFeeNumerator.toString(),segment.serviceFeeCreditMicros.toString()]);
      await client.query(`UPDATE kai_credit_supplier_fee_periods SET net_settled_credit_micros=$2,version=version+1
        WHERE id=$1`,[feePolicy.periodId,plan.cumulativeAfterMicros.toString()]);}
    return {transactionId:tx,fee:plan.serviceFeeCreditMicros,net:plan.netCreditMicros};
  }
  private async lockTradeFeePlan(client:PoolClient,supplierSubjectId:string,grossCreditMicros:bigint,assessedAt:Date){
    const schedule=await client.query<{id:string;version:string}>(`SELECT id,version FROM kai_credit_fee_schedules
      WHERE fee_category='compute_trade' AND status='active' AND effective_from<=$1
      ORDER BY effective_from DESC,id DESC LIMIT 1 FOR SHARE`,[assessedAt]);
    if(!schedule.rows[0])throw new Error('ACTIVE_TRADE_FEE_SCHEDULE_REQUIRED');
    const tiers=await client.query<{ordinal:number;lower_bound_micros:string;upper_bound_micros:string|null;rate_bps:number}>(
      `SELECT ordinal,lower_bound_micros::text,upper_bound_micros::text,rate_bps FROM kai_credit_fee_tiers
       WHERE schedule_id=$1 ORDER BY ordinal`,[schedule.rows[0].id]);
    const mapped:FeeTier[]=tiers.rows.map(row=>({ordinal:row.ordinal,lowerBoundMicros:BigInt(row.lower_bound_micros),
      upperBoundMicros:row.upper_bound_micros===null?null:BigInt(row.upper_bound_micros),rateBps:row.rate_bps}));
    const periodStart=shanghaiPeriodStart(assessedAt);
    await client.query(`INSERT INTO kai_credit_supplier_fee_periods(id,supplier_subject_id,fee_category,period_start)
      VALUES($1,$2,'compute_trade',$3) ON CONFLICT(supplier_subject_id,fee_category,period_start) DO NOTHING`,
    [randomUUID(),supplierSubjectId,periodStart]);
    const period=await client.query<{id:string;net_settled_credit_micros:string}>(`SELECT id,
      net_settled_credit_micros::text FROM kai_credit_supplier_fee_periods WHERE supplier_subject_id=$1
      AND fee_category='compute_trade' AND period_start=$2 FOR UPDATE`,[supplierSubjectId,periodStart]);
    if(!period.rows[0])throw new Error('TRADE_FEE_PERIOD_LOCK_FAILED');
    const plan=planSettlementFee(mapped,BigInt(period.rows[0].net_settled_credit_micros),grossCreditMicros);
    if(plan.serviceFeeCreditMicros<0n||plan.netCreditMicros<=0n)throw new Error('TRADE_FEE_AMOUNT_INVALID');
    return{persist:true as const,scheduleId:schedule.rows[0].id,scheduleVersion:schedule.rows[0].version,periodId:period.rows[0].id,
      periodStart,plan};
  }
  private async release(client:PoolClient,o:DeviceOrder,input:Parameters<PostgresDeviceCommerceStore['action']>[0]){const a=await this.ensureBuyerAccounts(client,o.buyerSubjectId);const tx=randomUUID();
    await client.query(`INSERT INTO kai_credit_transactions(id,idempotency_owner,scope,idempotency_key,payload_digest,reference_type,reference_id,description,status)
      VALUES($1,$2,'DEVICE_ORDER_RELEASE',$3,$4,'order_release',$5,$6,'pending')`,[tx,`subject:${o.buyerSubjectId}`,`device-order-release:${o.id}`,input.payloadDigest,o.id,`设备订单 ${o.orderNumber} 释放预留`]);
    await client.query(`INSERT INTO kai_credit_entries(id,transaction_id,account_id,amount_micros,memo) VALUES
      ($1,$2,$3,$4,'设备订单释放'),($5,$2,$6,$7,'设备订单释放')`,[randomUUID(),tx,a.reserved,(-o.grossCreditMicros).toString(),randomUUID(),a.available,o.grossCreditMicros.toString()]);
    await client.query(`UPDATE kai_credit_transactions SET status='posted',posted_at=$2 WHERE id=$1`,[tx,input.now]);return tx;}
  private async lockOrder(client:PoolClient,id:string){const r=await client.query<OrderRow>(`SELECT ${orderColumns} FROM physical_device_orders WHERE id=$1 FOR UPDATE`,[id]);return r.rows[0]?order(r.rows[0]):null;}
  private async lockSettlement(client:PoolClient,orderId:string){const r=await client.query<{order_id:string;status:'pending'|'succeeded';gross_credit_micros:string;service_fee_credit_micros:string;net_credit_micros:string;available_at:Date;settlement_transaction_id:string|null;settled_at:Date|null}>(`SELECT order_id,status,gross_credit_micros::text,service_fee_credit_micros::text,
    net_credit_micros::text,available_at,settlement_transaction_id,settled_at FROM physical_device_supplier_settlements WHERE order_id=$1 FOR UPDATE`,[orderId]);return r.rows[0]?this.mapSettlement(r.rows[0]):null;}
  private mapSettlement(r:{order_id:string;status:'pending'|'succeeded';gross_credit_micros:string;service_fee_credit_micros:string;net_credit_micros:string;available_at:Date;settlement_transaction_id:string|null;settled_at:Date|null}){return{orderId:r.order_id,status:r.status,grossCreditMicros:BigInt(r.gross_credit_micros),serviceFeeCreditMicros:BigInt(r.service_fee_credit_micros),netCreditMicros:BigInt(r.net_credit_micros),availableAt:new Date(r.available_at),settlementTransactionId:r.settlement_transaction_id,settledAt:r.settled_at?new Date(r.settled_at):null};}
  private async ensureBuyerAccounts(client:PoolClient,subjectId:string){const s=await client.query(`SELECT id FROM trading_subjects WHERE id=$1 AND status='active' FOR UPDATE`,[subjectId]);if(!s.rows[0])throw new Error('ACTIVE_TRADING_SUBJECT_REQUIRED');
    for(const kind of ['available','reserved'])await client.query(`INSERT INTO kai_credit_accounts(id,owner_kind,subject_id,code,account_kind,allow_negative)
      VALUES($1,'subject',$2,$3,$4,false) ON CONFLICT(subject_id,account_kind) WHERE subject_id IS NOT NULL DO NOTHING`,[randomUUID(),subjectId,`subject:${subjectId}:${kind}`,kind]);
    const r=await client.query<{id:string;account_kind:string}>(`SELECT id,account_kind FROM kai_credit_accounts WHERE subject_id=$1 AND account_kind IN ('available','reserved') ORDER BY id FOR UPDATE`,[subjectId]);
    const available=r.rows.find(x=>x.account_kind==='available')?.id,reserved=r.rows.find(x=>x.account_kind==='reserved')?.id;if(!available||!reserved)throw new Error('DEVICE_BUYER_ACCOUNTS_MISSING');return{available,reserved};}
  private async ensureCaptureAccounts(client:PoolClient,buyer:string,supplier:string){const buyerAcc=await this.ensureBuyerAccounts(client,buyer);await client.query(`INSERT INTO kai_credit_accounts(id,owner_kind,subject_id,code,account_kind,allow_negative)
    VALUES($1,'subject',$2,$3,'supplier_receivable',false) ON CONFLICT(subject_id,account_kind) WHERE subject_id IS NOT NULL DO NOTHING`,[randomUUID(),supplier,`subject:${supplier}:supplier_receivable`]);
    const r=await client.query<{id:string}>(`SELECT id FROM kai_credit_accounts WHERE subject_id=$1 AND account_kind='supplier_receivable' FOR UPDATE`,[supplier]);if(!r.rows[0])throw new Error('DEVICE_SUPPLIER_ACCOUNT_MISSING');return{buyerReserved:buyerAcc.reserved,supplierReceivable:r.rows[0].id};}
  private async ensureSupplierAccounts(client:PoolClient,supplier:string){for(const kind of ['supplier_earnings_available','supplier_receivable'])await client.query(`INSERT INTO kai_credit_accounts(id,owner_kind,subject_id,code,account_kind,allow_negative)
    VALUES($1,'subject',$2,$3,$4,false) ON CONFLICT(subject_id,account_kind) WHERE subject_id IS NOT NULL DO NOTHING`,[randomUUID(),supplier,`subject:${supplier}:${kind}`,kind]);const r=await client.query<{id:string;account_kind:string}>(`SELECT id,account_kind FROM kai_credit_accounts WHERE subject_id=$1 AND account_kind IN ('supplier_earnings_available','supplier_receivable') ORDER BY id FOR UPDATE`,[supplier]);const supplierEarnings=r.rows.find(x=>x.account_kind==='supplier_earnings_available')?.id,receivable=r.rows.find(x=>x.account_kind==='supplier_receivable')?.id;if(!supplierEarnings||!receivable)throw new Error('DEVICE_SETTLEMENT_ACCOUNTS_MISSING');return{supplierEarnings,receivable};}
  private saveAction(client:PoolClient,input:Parameters<PostgresDeviceCommerceStore['action']>[0],result:string){return client.query(`INSERT INTO physical_device_order_actions(actor_id,client_request_id,order_id,action,payload_digest,result_status)
    VALUES($1,$2,$3,$4,$5,$6)`,[input.actorId,input.clientRequestId,input.orderId,input.action,input.payloadDigest,result]).then(()=>undefined);}
}
