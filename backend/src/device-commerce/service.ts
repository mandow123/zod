import { randomBytes, randomUUID } from 'node:crypto';
import { decryptPii, encryptPii, secretHash } from '../account/crypto.js';
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
  private readonly piiKey:string;
  constructor(private readonly store:PostgresDeviceCommerceStore,private readonly subjects:SubjectAccess,
    config:RuntimeConfig,private readonly now:()=>Date=()=>new Date()){
    if(!config.AUDIT_PEPPER||!config.PII_ENCRYPTION_KEY)throw new Error('AUDIT_PEPPER and PII_ENCRYPTION_KEY are required.');
    this.pepper=config.AUDIT_PEPPER;this.piiKey=config.PII_ENCRYPTION_KEY;
  }
  async products(_principal?:AccountPrincipal){return (await this.store.listProducts()).map(x=>this.serializeProduct(x));}
  async product(_principal:AccountPrincipal|undefined,id:string){const item=await this.store.getProduct(id);if(!item)throw new AppError('DEVICE_PRODUCT_NOT_FOUND',404,'设备商品不存在。');return this.serializeProduct(item);}
  async activationReadiness(principal:AccountPrincipal,productId:string,supplierSubjectId:string){this.operator(principal);return this.store.activationReadiness(productId,supplierSubjectId);}
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
    if(!('order'in r))throw new Error('unhandled device order result');return{replayed:r.status==='replayed',order:this.order(r.order,s.subjectId,true)};
  }
  async orders(principal:AccountPrincipal){const s=await this.subjects.current(principal.userId,'orders.read');return (await this.store.listOrders(s.subjectId)).map(x=>this.order(x,s.subjectId,false));}
  async get(principal:AccountPrincipal,id:string){const s=await this.subjects.current(principal.userId,'orders.read');const o=await this.store.getOrder(s.subjectId,id);if(!o)throw new AppError('DEVICE_ORDER_NOT_FOUND',404,'设备订单不存在。');return this.order(o,s.subjectId,true);}
  async assets(principal:AccountPrincipal){const s=await this.subjects.current(principal.userId,'orders.read');return (await this.store.listAssets(s.subjectId)).map(a=>({...a,acquiredAt:a.acquiredAt.toISOString()}));}
  async confirm(principal:AccountPrincipal,id:string,key:string,ctx:Context){return this.action(principal,id,key,ctx,'supplier','confirm','reserved','confirmed','provider.order.manage',{});}
  async ship(principal:AccountPrincipal,id:string,key:string,ctx:Context,details:{logisticsProvider:string;trackingNumber:string}){
    const logisticsProvider=details.logisticsProvider.normalize('NFKC').trim();
    const trackingNumber=details.trackingNumber.normalize('NFKC').replace(/\s+/gu,'').toUpperCase();
    const protectedTracking={logisticsProvider,trackingDigest:this.digest({trackingNumber}),trackingCiphertext:encryptPii(trackingNumber,this.piiKey)};
    return this.action(principal,id,key,ctx,'supplier','ship','confirmed','shipping','provider.order.manage',protectedTracking);
  }
  async receive(principal:AccountPrincipal,id:string,key:string,ctx:Context){return this.action(principal,id,key,ctx,'buyer','receive','shipping','received','orders.buy',{});}
  async cancel(principal:AccountPrincipal,id:string,key:string,ctx:Context){this.key(key);const s=await this.subjects.current(principal.userId,'orders.buy');const current=await this.store.getOrder(s.subjectId,id);if(!current)throw new AppError('DEVICE_ORDER_NOT_FOUND',404,'设备订单不存在。');
    if(current.buyerSubjectId!==s.subjectId)throw new AppError('DEVICE_ORDER_BUYER_REQUIRED',403,'只有买方可以取消设备订单。');
    if(current.status!=='reserved'&&current.status!=='confirmed')throw new AppError('DEVICE_ORDER_STATE_INVALID',409,'当前设备订单不能取消。');
    const r=await this.store.action({orderId:id,actorId:principal.userId,actorSubjectId:s.subjectId,side:'buyer',action:'cancel',from:current.status,to:'cancelled',clientRequestId:key,
      payloadDigest:this.digest({action:'cancel',id,subjectId:s.subjectId}),now:this.now()});return this.result(r,s.subjectId,ctx);}
  private async action(principal:AccountPrincipal,id:string,key:string,_ctx:Context,side:'buyer'|'supplier',action:'confirm'|'ship'|'receive',from:DeviceOrder['status'],to:DeviceOrder['status'],permission:'provider.order.manage'|'orders.buy',details:{logisticsProvider?:string;trackingDigest?:string;trackingCiphertext?:string}){this.key(key);
    const s=await this.subjects.current(principal.userId,permission);const r=await this.store.action({orderId:id,actorId:principal.userId,actorSubjectId:s.subjectId,side,action,from,to,clientRequestId:key,
      payloadDigest:this.digest({action,id,subjectId:s.subjectId,logisticsProvider:details.logisticsProvider,trackingDigest:details.trackingDigest}),now:this.now(),...details});return this.result(r,s.subjectId,_ctx);}
  private result(r:Awaited<ReturnType<PostgresDeviceCommerceStore['action']>>,subjectId:string,_ctx:Context){if(r.status==='conflict')throw new AppError('IDEMPOTENCY_KEY_CONFLICT',409,'同一请求标识对应了不同的设备订单操作。');
    if(r.status==='not_found')throw new AppError('DEVICE_ORDER_NOT_FOUND',404,'设备订单不存在。');if(r.status==='invalid_state')throw new AppError('DEVICE_ORDER_STATE_INVALID',409,'设备订单状态已变化。');
    if(!('order'in r))throw new Error('unhandled device action result');return{replayed:r.status==='replayed',order:this.order(r.order,subjectId,true)};}
  private serializeProduct(p:DeviceProduct){const available=p.inventoryTotal-p.inventoryReserved-p.inventorySold;const purchasable=p.activationStatus==='active'&&available>0;
    const blockedReason=p.activationStatus!=='active'?'supplier_verification_pending':available<=0?'sold_out':null;return{id:p.id,sku:p.sku,title:p.title,productType:'physical_delivery' as const,
    campaignKey:p.campaignKey,templateKey:p.templateKey,template:{key:p.templateKey},
    supplier:{displayName:p.supplierDisplayName,verified:p.activationStatus==='active'},activationStatus:p.activationStatus,purchasable,blockedReason,
    capabilities:{creditOnly:true,requiresShippingAddress:true,physicalDelivery:true,maxQuantityPerOrder:20},
    inventory:{total:p.inventoryTotal,reserved:p.inventoryReserved,sold:p.inventorySold,available},pricing:{
      listUnitCredit:formatCreditDisplayMicros(p.listUnitCreditMicros),unitCredit:formatCreditDisplayMicros(p.unitCreditMicros),
      discountBasisPoints:p.discountBasisPoints,discountPercent:100-p.discountBasisPoints/100},
    expectedDelivery:{days:p.expectedShipDays,label:p.expectedShipDays===90?'预计3个月发货':`预计${p.expectedShipDays}天发货`},specifications:p.specifications};}
  private order(o:DeviceOrder,subjectId:string,revealTracking:boolean){const side=o.buyerSubjectId===subjectId?'buyer':'provider';const actions=this.actions(o,side);
    const trackingDisplay=this.tracking(o,side,revealTracking);return{id:o.id,orderNumber:o.orderNumber,productId:o.productId,
    campaignKey:o.campaignKey,campaignVersion:o.campaignVersion,side,actions,status:o.status,quantity:o.quantity,
    unitCredit:formatCreditDisplayMicros(o.unitCreditMicros),totalCredit:formatCreditDisplayMicros(o.grossCreditMicros),
    serviceFeeCredit:side==='provider'&&o.serviceFeeCreditMicros!==null?formatCreditDisplayMicros(o.serviceFeeCreditMicros):null,
    supplierNetCredit:side==='provider'&&o.supplierNetCreditMicros!==null?formatCreditDisplayMicros(o.supplierNetCreditMicros):null,reservationTransactionId:o.reservationTransactionId,
    resolutionTransactionId:o.resolutionTransactionId,reservationExpiresAt:o.reservationExpiresAt.toISOString(),confirmedAt:o.confirmedAt?.toISOString()??null,
    shippedAt:o.shippedAt?.toISOString()??null,receivedAt:o.receivedAt?.toISOString()??null,
    logisticsProvider:o.logisticsProvider,trackingDisplay,settlement:null,createdAt:o.createdAt.toISOString()};}
  private actions(o:DeviceOrder,side:'buyer'|'provider'){
    if(side==='buyer'&&(o.status==='reserved'||o.status==='confirmed'))return['cancel'] as const;
    if(side==='buyer'&&o.status==='shipping')return['receive'] as const;
    if(side==='provider'&&o.status==='reserved')return['confirm'] as const;
    if(side==='provider'&&o.status==='confirmed')return['ship'] as const;
    return[] as const;
  }
  private tracking(o:DeviceOrder,side:'buyer'|'provider',reveal:boolean){if(!o.trackingCiphertext)return null;let value:string;
    try{value=decryptPii(o.trackingCiphertext,this.piiKey);}catch{throw new AppError('DEVICE_TRACKING_UNAVAILABLE',503,'物流信息暂时无法读取。');}
    if(side==='buyer'&&reveal)return value;if(value.length<=6)return`***${value.slice(-2)}`;return`${value.slice(0,2)}****${value.slice(-4)}`;}
  private key(v:string){if(!/^[A-Za-z0-9:_-]{16,120}$/u.test(v))throw new AppError('IDEMPOTENCY_KEY_INVALID',400,'请求缺少有效的幂等标识。');}
  private digest(v:unknown){return secretHash(JSON.stringify(v),this.pepper);}private number(){return`KDO${this.now().getTime().toString(36).toUpperCase()}${randomBytes(5).toString('hex').toUpperCase()}`;}
  private operator(p:AccountPrincipal){if(p.role!=='operator'&&p.role!=='admin')throw new AppError('OPERATOR_REQUIRED',403,'该操作需要运营权限。');}
}
