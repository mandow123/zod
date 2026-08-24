import { AppError } from '../errors.js';
import { CursorService } from '../market/cursor.js';
import type { PostgresSupplierInquiryCatalogStore } from './store.js';
import type { SupplierCatalogFilters,SupplierCatalogItem,SupplierCatalogKind,SupplierCatalogMode,SupplierCatalogModel } from './types.js';

function amount(value:bigint|null){if(value===null)return null;return`${value/100n}.${(value%100n).toString().padStart(2,'0')}`;}

export class SupplierInquiryCatalogService {
  private readonly cursor:CursorService;
  constructor(private readonly store:PostgresSupplierInquiryCatalogStore,private readonly mode:SupplierCatalogMode,
    cursorSecret:string,private readonly now:()=>Date=()=>new Date()){this.cursor=new CursorService(cursorSecret);}

  async readiness(){if(this.mode==='off')return{mode:this.mode,ready:false,blockers:[]};
    const state=await this.store.readiness(this.now());return{mode:this.mode,...state};}

  async list(input:Readonly<{kind?:SupplierCatalogKind;model?:SupplierCatalogModel;query?:string;cursor?:string;limit?:number}>){
    await this.requireReadable();const limit=Math.min(Math.max(input.limit??20,1),50),filters:SupplierCatalogFilters={
      ...(input.kind?{kind:input.kind}:{}),...(input.model?{model:input.model}:{}),
      ...(input.query?.trim()?{query:input.query.trim()}:{}),cursor:this.cursor.decode(input.cursor),limit};
    const rows=await this.store.list(filters,this.now()),last=rows.at(-1);return{items:rows.map((row)=>this.publicItem(row)),
      nextCursor:rows.length===limit&&last?this.cursor.encode({createdAt:last.createdAt.toISOString(),id:last.id}):null};}

  async get(resourceId:string){await this.requireReadable();const item=await this.store.get(resourceId,this.now());
    if(!item)throw new AppError('SUPPLIER_INQUIRY_RESOURCE_NOT_FOUND',404,'没有找到这项供应商预约资源。');return this.publicItem(item);}

  private async requireReadable(){if(this.mode==='off')throw new AppError('NOT_FOUND',404,'接口不存在。');
    const state=await this.readiness();if(!state.ready)throw new AppError('SUPPLIER_INQUIRY_CATALOG_NOT_READY',503,
      '供应商预约目录暂不可用。',{blockers:state.blockers});}

  private publicItem(item:SupplierCatalogItem){return{resourceId:item.resourceId,version:item.version,catalogKind:item.catalogKind,
    title:item.title,legalReviewRequired:item.legalReviewRequired,supplier:{id:item.supplierId,legalName:item.supplierLegalName,
      displayName:item.supplierDisplayName,logo:{httpsUrl:item.logoHttpsUrl,version:item.logoVersion,
        authorizationStatus:'unverified' as const,provenance:'user_provided' as const},
      disclosureStatus:item.supplierDisclosureStatus},specifications:item.specifications,quantity:{unit:item.quantityUnit,
      min:item.quantityMin,max:item.quantityMax,allowedValues:item.quantityAllowedValues},region:{scope:'national' as const,
      exact:null,confirmationRequired:true as const},billing:{modes:[item.billingMode],unit:item.billingUnit,
      referencePrice:{currency:'KAI_CARD_HOUR' as const,precision:2 as const,status:'reference_only' as const,
        hourlyAmount:amount(item.referenceHourlyMinor),dailyAmount:amount(item.referenceDailyMinor),
        monthlyAmount:amount(item.referenceMonthlyMinor),validUntil:item.validUntil.toISOString()}},availability:{
      status:'inquiry_required' as const,quantity:null,inventoryCommitment:false as const},delivery:{mode:'manual' as const,
      leadTime:{value:item.deliveryLeadTimeValue,unit:item.deliveryLeadTimeUnit,status:item.deliveryLeadTimeStatus}},
    purchase:{purchasable:false as const,orderCreation:false as const,inquiryAvailable:true as const,cta:'submit_inquiry' as const},
    source:{observedAt:item.sourceObservedAt as '2026-08-19',kind:'USER_PROVIDED_SUPPLIER_QUOTE' as const,
      label:'资料来源：用户提供的供应商报价' as const,verificationStatus:'unverified' as const},terms:'inquiry-required' as const};}
}
