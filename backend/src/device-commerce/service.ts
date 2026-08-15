import { randomBytes, randomUUID } from 'node:crypto';
import { secretHash } from '../account/crypto.js';
import type { AccountPrincipal } from '../account/types.js';
import type { RuntimeConfig } from '../config.js';
import { formatCreditDisplayMicros } from '../credits/display.js';
import { AppError } from '../errors.js';
import type { SubjectAccess } from '../subjects/types.js';
import type { PostgresDeviceCommerceStore } from './store.js';
import type { DeviceOrder, DeviceProduct } from './types.js';

type Context = Readonly<{requestId:string;ip:string}>;
export class DeviceCommerceService {
  private readonly pepper:string;
  constructor(private readonly store:PostgresDeviceCommerceStore,private readonly subjects:SubjectAccess,
    config:RuntimeConfig,private readonly now:()=>Date=()=>new Date()){
    if(!config.AUDIT_PEPPER)throw new Error('AUDIT_PEPPER is required.');this.pepper=config.AUDIT_PEPPER;
  }
  async products(_principal?:AccountPrincipal){return (await this.store.listProducts()).map(x=>this.serializeProduct(x));}
  async product(_principal:AccountPrincipal|undefined,id:string){const item=await this.store.getProduct(id);if(!item)throw new AppError('DEVICE_PRODUCT_NOT_FOUND',404,'设备商品不存在。');return this.serializeProduct(item);}
  async activate(principal:AccountPrincipal,productId:string,supplierSubjectId:string){this.operator(principal);const item=await this.store.activateProduct(productId,supplierSubjectId,principal.userId,this.now());
    if(!item)throw new AppError('DEVICE_PRODUCT_ACTIVATION_BLOCKED',409,'供应商法定主体或收款账户尚未完成核验。');return this.serializeProduct(item);}
  async create(principal:AccountPrincipal,input:{productId:string;quantity:number;shippingAddressReference:string;idempotencyKey:string},_ctx:Context){this.key(input.idempotencyKey);
    const s=await this.subjects.current(principal.userId,'orders.buy');const digest=this.digest({subjectId:s.subjectId,productId:input.productId,quantity:input.quantity,shippingAddressReference:input.shippingAddressReference});
    const r=await this.store.create({id:randomUUID(),orderNumber:this.number(),buyerSubjectId:s.subjectId,userId:principal.userId,
      productId:input.productId,quantity:input.quantity,shippingAddressReference:input.shippingAddressReference,
      clientRequestId:input.idempotencyKey,payloadDigest:digest,expiresAt:new Date(this.now().getTime()+30*60_000),now:this.now()});
    if(r.status==='conflict')throw new AppError('IDEMPOTENCY_KEY_CONFLICT',409,'同一请求标识对应了不同的设备订单。');
    if(r.status==='product_unavailable')throw new AppError('DEVICE_PRODUCT_PENDING_ACTIVATION',409,'该设备尚未完成供应主体核验，暂不能购买。');
    if(r.status==='address_unavailable')throw new AppError('SHIPPING_ADDRESS_UNAVAILABLE',409,'收货地址不存在或已删除，请重新选择。');
    if(r.status==='insufficient_stock')throw new AppError('DEVICE_STOCK_INSUFFICIENT',409,'设备库存不足。');
    if(r.status==='insufficient_credits')throw new AppError('KAI_CREDITS_INSUFFICIENT',409,'可用卡时不足，请先充值。');
    if(r.status==='self_purchase')throw new AppError('DEVICE_SELF_PURCHASE_FORBIDDEN',409,'不能购买当前主体提供的设备。');
    if(!('order'in r))throw new Error('unhandled device order result');return{replayed:r.status==='replayed',order:this.order(r.order)};
  }
  async orders(principal:AccountPrincipal){const s=await this.subjects.current(principal.userId,'orders.read');return (await this.store.listOrders(s.subjectId)).map(x=>this.order(x));}
  async get(principal:AccountPrincipal,id:string){const s=await this.subjects.current(principal.userId,'orders.read');const o=await this.store.getOrder(s.subjectId,id);if(!o)throw new AppError('DEVICE_ORDER_NOT_FOUND',404,'设备订单不存在。');return this.order(o);}
  async assets(principal:AccountPrincipal){const s=await this.subjects.current(principal.userId,'orders.read');return (await this.store.listAssets(s.subjectId)).map(a=>({...a,acquiredAt:a.acquiredAt.toISOString()}));}
  async confirm(principal:AccountPrincipal,id:string,key:string,ctx:Context){return this.action(principal,id,key,ctx,'supplier','confirm','reserved','confirmed','provider.order.manage',{});}
  async ship(principal:AccountPrincipal,id:string,key:string,ctx:Context,details:{logisticsProvider:string;trackingDigest:string}){return this.action(principal,id,key,ctx,'supplier','ship','confirmed','shipping','provider.order.manage',details);}
  async receive(principal:AccountPrincipal,id:string,key:string,ctx:Context){return this.action(principal,id,key,ctx,'buyer','receive','shipping','received','orders.buy',{});}
  async settle(principal:AccountPrincipal,id:string,key:string,_ctx:Context){this.key(key);const s=await this.subjects.current(principal.userId,'provider.order.manage');
    const r=await this.store.settle({orderId:id,actorId:principal.userId,actorSubjectId:s.subjectId,clientRequestId:key,
      payloadDigest:this.digest({action:'settle',id,subjectId:s.subjectId}),now:this.now()});
    if(r.status==='conflict')throw new AppError('IDEMPOTENCY_KEY_CONFLICT',409,'同一请求标识对应了不同的设备结算操作。');
    if(r.status==='not_found')throw new AppError('DEVICE_ORDER_NOT_FOUND',404,'设备订单不存在。');
    if(r.status==='invalid_state')throw new AppError('DEVICE_SETTLEMENT_STATE_INVALID',409,'该设备订单当前不能结算。');
    if(r.status==='not_due')throw new AppError('DEVICE_SETTLEMENT_NOT_DUE',409,'设备订单尚在售后结算期。',{availableAt:r.availableAt.toISOString()});
    if(!('settlement'in r))throw new Error('unhandled device settlement result');return{replayed:r.status==='replayed',settlement:{orderId:r.settlement.orderId,status:r.settlement.status,
      grossCredit:formatCreditDisplayMicros(r.settlement.grossCreditMicros),serviceFeeCredit:formatCreditDisplayMicros(r.settlement.serviceFeeCreditMicros),
      netCredit:formatCreditDisplayMicros(r.settlement.netCreditMicros),availableAt:r.settlement.availableAt.toISOString(),settlementTransactionId:r.settlement.settlementTransactionId,
      settledAt:r.settlement.settledAt?.toISOString()??null}};}
  async cancel(principal:AccountPrincipal,id:string,key:string,ctx:Context){this.key(key);const s=await this.subjects.current(principal.userId,'orders.buy');const current=await this.store.getOrder(s.subjectId,id);if(!current)throw new AppError('DEVICE_ORDER_NOT_FOUND',404,'设备订单不存在。');
    if(current.buyerSubjectId!==s.subjectId)throw new AppError('DEVICE_ORDER_BUYER_REQUIRED',403,'只有买方可以取消设备订单。');
    if(current.status!=='reserved'&&current.status!=='confirmed')throw new AppError('DEVICE_ORDER_STATE_INVALID',409,'当前设备订单不能取消。');
    const r=await this.store.action({orderId:id,actorId:principal.userId,actorSubjectId:s.subjectId,side:'buyer',action:'cancel',from:current.status,to:'cancelled',clientRequestId:key,
      payloadDigest:this.digest({action:'cancel',id,subjectId:s.subjectId}),now:this.now()});return this.result(r,ctx);}
  private async action(principal:AccountPrincipal,id:string,key:string,_ctx:Context,side:'buyer'|'supplier',action:'confirm'|'ship'|'receive',from:DeviceOrder['status'],to:DeviceOrder['status'],permission:'provider.order.manage'|'orders.buy',details:{logisticsProvider?:string;trackingDigest?:string}){this.key(key);
    const s=await this.subjects.current(principal.userId,permission);const r=await this.store.action({orderId:id,actorId:principal.userId,actorSubjectId:s.subjectId,side,action,from,to,clientRequestId:key,
      payloadDigest:this.digest({action,id,subjectId:s.subjectId,...details}),now:this.now(),...details});return this.result(r,_ctx);}
  private result(r:Awaited<ReturnType<PostgresDeviceCommerceStore['action']>>,_ctx:Context){if(r.status==='conflict')throw new AppError('IDEMPOTENCY_KEY_CONFLICT',409,'同一请求标识对应了不同的设备订单操作。');
    if(r.status==='not_found')throw new AppError('DEVICE_ORDER_NOT_FOUND',404,'设备订单不存在。');if(r.status==='invalid_state')throw new AppError('DEVICE_ORDER_STATE_INVALID',409,'设备订单状态已变化。');
    if(!('order'in r))throw new Error('unhandled device action result');return{replayed:r.status==='replayed',order:this.order(r.order)};}
  private serializeProduct(p:DeviceProduct){const available=p.inventoryTotal-p.inventoryReserved-p.inventorySold;return{id:p.id,sku:p.sku,title:p.title,productType:'physical_delivery' as const,
    supplier:{displayName:p.supplierDisplayName},activationStatus:p.activationStatus,purchasable:p.activationStatus==='active'&&available>0,
    inventory:{total:p.inventoryTotal,reserved:p.inventoryReserved,sold:p.inventorySold,available},pricing:{listPriceCny:this.cny(p.listPriceCnyMicros),salePriceCny:this.cny(p.salePriceCnyMicros),
      unitCredit:formatCreditDisplayMicros(p.unitCreditMicros),discountPercent:20,conversion:'1 KAI卡时 = ¥1.002'},expectedDelivery:{days:p.expectedShipDays,label:'预计3个月发货'},specifications:p.specifications};}
  private order(o:DeviceOrder){return{id:o.id,orderNumber:o.orderNumber,productId:o.productId,status:o.status,quantity:o.quantity,
    unitCredit:formatCreditDisplayMicros(o.unitCreditMicros),totalCredit:formatCreditDisplayMicros(o.grossCreditMicros),serviceFeeCredit:o.serviceFeeCreditMicros===null?null:formatCreditDisplayMicros(o.serviceFeeCreditMicros),
    supplierNetCredit:o.supplierNetCreditMicros===null?null:formatCreditDisplayMicros(o.supplierNetCreditMicros),reservationTransactionId:o.reservationTransactionId,
    resolutionTransactionId:o.resolutionTransactionId,reservationExpiresAt:o.reservationExpiresAt.toISOString(),confirmedAt:o.confirmedAt?.toISOString()??null,
    shippedAt:o.shippedAt?.toISOString()??null,receivedAt:o.receivedAt?.toISOString()??null,createdAt:o.createdAt.toISOString()};}
  private cny(m:bigint){const c=(m+5_000n)/10_000n;return`${c/100n}.${(c%100n).toString().padStart(2,'0')}`;}
  private key(v:string){if(!/^[A-Za-z0-9:_-]{16,120}$/u.test(v))throw new AppError('IDEMPOTENCY_KEY_INVALID',400,'请求缺少有效的幂等标识。');}
  private digest(v:unknown){return secretHash(JSON.stringify(v),this.pepper);}private number(){return`KDO${this.now().getTime().toString(36).toUpperCase()}${randomBytes(5).toString('hex').toUpperCase()}`;}
  private operator(p:AccountPrincipal){if(p.role!=='operator'&&p.role!=='admin')throw new AppError('OPERATOR_REQUIRED',403,'该操作需要运营权限。');}
}
