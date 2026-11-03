/** AI v2 Phase 2, P2-5 — the Living Handbook's closed catalogue of settings a policy can enforce (migration 0971).
 *
 * ONLY SETTINGS THAT ALREADY EXIST in an owner service, each read and written through that owner's own functions and
 * validation (packs/<pack>/service):
 *  - claims.mileage_rates: the company-wide ("all grades", "any vehicle") mileage rate table of the tenant's mileage
 *    claim type (core/claims.ts listMileageRateTables / setMileageRateTable, effective-dated). The claims service prices
 *    each claim's own distance against its bands; it keeps no monthly running total.
 *  - claims.submit_within_days: a claim type's submission window, "receipt date no more than N days ago" at submit
 *    (claim_type.max_receipt_age_days through updateClaimType; not dated by the claims service).
 *  - leave.entitlement_days: a leave type's DEFAULT entitlement table, days by completed years of service
 *    (core/entitlement-template.ts updateEntitlementTemplate, effective-dated). Employees an eligibility rule routes to
 *    another table keep that table.
 * Approval before travel has no setting in the claims service, so a policy that says it is kept as text ("not enforced
 * yet"); so is every other area. All three settings are shared by every company of the tenant, so they are enforced
 * only from a policy version that applies to all of them.
 *
 * This module never decides: it reads the owner's current value, compares two values exactly, and asks the owner to
 * apply one. A refusal is the owner's own message. */
import {listLeaveTypes} from '../read';
import {listClaimTypes,listMileageRateTables,setMileageRateTable,updateClaimType,RECEIPT_BACKDATE_DAYS,type MileageBand} from '../../packs/claims/service';
import {listEntitlementTemplates,updateEntitlementTemplate,type ServiceBand} from '../../packs/leave/service';
import {isModuleEnabled} from '../entitlements';
import type {SessionContext} from '../../db/client';

export * from './types';
import {AREA_SETTINGS,type EntitlementBandValue,type MileageBandValue,type PolicyArea,type PolicySetting,type SettingBody,type SettingTarget} from './types';
export type OwnerTargets=Readonly<{
 mileageType:Readonly<{id:string;code:string;name:string}>|null;
 claimTypes:readonly Readonly<{id:string;code:string;name:string;maxReceiptAgeDays:number|null;description:string|null;defaultTaxable:boolean;requiresReceipt:boolean}>[];
 leaveTypes:readonly Readonly<{id:string;code:string;name:string;defaultLineageId:string}>[];
}>;
const EMPTY:OwnerTargets=Object.freeze({mileageType:null,claimTypes:[],leaveTypes:[]});

/** What the owners hold that a policy can name, as the caller reads it. A module the tenant does not hold offers nothing. */
export async function ownerTargets(ctx:SessionContext,asOf:string):Promise<OwnerTargets>{
 let claimTypes:OwnerTargets['claimTypes']=[],mileageType:OwnerTargets['mileageType']=null,leaveTypes:OwnerTargets['leaveTypes']=[];
 if(isModuleEnabled(ctx,'claims')){
  const types=await listClaimTypes(ctx,{asOf}).catch(()=>[]);
  claimTypes=types.map(t=>Object.freeze({id:t.id,code:t.code,name:t.name,maxReceiptAgeDays:t.maxReceiptAgeDays,description:t.description,defaultTaxable:t.defaultTaxable,requiresReceipt:t.requiresReceipt}));
  const mileage=types.find(t=>t.isMileage);mileageType=mileage?Object.freeze({id:mileage.id,code:mileage.code,name:mileage.name}):null;
 }
 if(isModuleEnabled(ctx,'leave')){
  const types=await Promise.resolve(listLeaveTypes(ctx)).catch(()=>[]) as readonly {id:string;code:string;name:string;defaultEntitlementTemplateLineageId?:string|null}[];
  leaveTypes=types.filter(t=>t.defaultEntitlementTemplateLineageId).map(t=>Object.freeze({id:t.id,code:t.code,name:t.name,defaultLineageId:t.defaultEntitlementTemplateLineageId!}));
 }
 return Object.freeze({mileageType,claimTypes:Object.freeze(claimTypes),leaveTypes:Object.freeze(leaveTypes)});
}
export const noOwnerTargets=():OwnerTargets=>EMPTY;

/** The settings a version of this area can enforce for the caller's tenant now: the area's settings whose owner holds them. */
export function availableSettings(area:PolicyArea,targets:OwnerTargets):readonly PolicySetting[]{
 return AREA_SETTINGS[area].filter(setting=>setting==='claims.mileage_rates'?targets.mileageType!==null:setting==='claims.submit_within_days'?targets.claimTypes.length>0:targets.leaveTypes.length>0);
}
const sameCode=(a:string|undefined,b:string)=>typeof a==='string'&&a.trim().toUpperCase()===b.toUpperCase();
export const claimTypeOf=(targets:OwnerTargets,target:SettingTarget)=>targets.claimTypes.find(t=>sameCode(target.claimType,t.code))??null;
export const leaveTypeOf=(targets:OwnerTargets,target:SettingTarget)=>targets.leaveTypes.find(t=>sameCode(target.leaveType,t.code))??null;

const round=(n:number,places:number)=>Math.round(n*10**places)/10**places;
/** One canonical form for comparison and storage: bands ascending, figures at the owner's own precision. */
export function normalizeBody(setting:PolicySetting,body:unknown):SettingBody|null{
 if(!body||typeof body!=='object')return null;
 const raw=body as {bands?:unknown;days?:unknown};
 if(setting==='claims.submit_within_days')return typeof raw.days==='number'&&Number.isInteger(raw.days)?Object.freeze({days:raw.days}):null;
 if(!Array.isArray(raw.bands))return null;
 if(setting==='claims.mileage_rates')return Object.freeze({bands:Object.freeze(raw.bands.map(b=>Object.freeze({fromKm:round(Number(b?.fromKm),2),toKm:b?.toKm==null?null:round(Number(b.toKm),2),ratePerKm:round(Number(b?.ratePerKm),4)}))
  .sort((a,b)=>a.fromKm-b.fromKm))});
 return Object.freeze({bands:Object.freeze(raw.bands.map(b=>Object.freeze({fromYears:Number(b?.fromYears),toYears:b?.toYears==null?null:Number(b.toYears),days:round(Number(b?.days),2)}))
  .sort((a,b)=>a.fromYears-b.fromYears))});
}
/** Exact equality of two values of one setting (null: the owner holds none). */
export function sameValue(setting:PolicySetting,a:unknown,b:unknown):boolean{
 const x=a==null?null:normalizeBody(setting,a),y=b==null?null:normalizeBody(setting,b);
 return JSON.stringify(x)===JSON.stringify(y);
}

export type OwnerValue=Readonly<{value:SettingBody|null;defaulted:boolean;available:boolean}>;
/** The owner's current value of a setting for a target (null when the owner holds none, e.g. no table yet). */
export async function currentOwnerValue(ctx:SessionContext,setting:PolicySetting,target:SettingTarget,targets:OwnerTargets,asOf:string):Promise<OwnerValue>{
 if(setting==='claims.mileage_rates'){
  if(!targets.mileageType)return Object.freeze({value:null,defaulted:false,available:false});
  const {tables}=await listMileageRateTables(ctx,{claimTypeId:targets.mileageType.id,gradeId:null,asOf});
  const table=tables.find(t=>t.gradeId===null&&t.vehicleClass==='any');
  return Object.freeze({value:table?normalizeBody(setting,{bands:table.bands}):null,defaulted:false,available:true});
 }
 if(setting==='claims.submit_within_days'){
  const type=claimTypeOf(targets,target);if(!type)return Object.freeze({value:null,defaulted:false,available:false});
  return Object.freeze({value:Object.freeze({days:type.maxReceiptAgeDays??RECEIPT_BACKDATE_DAYS}),defaulted:type.maxReceiptAgeDays==null,available:true});
 }
 const type=leaveTypeOf(targets,target);if(!type)return Object.freeze({value:null,defaulted:false,available:false});
 const table=(await listEntitlementTemplates(ctx,{asOf,leaveTypeId:type.id})).find(t=>t.lineageId===type.defaultLineageId);
 return Object.freeze({value:table?normalizeBody(setting,{bands:table.serviceBands}):null,defaulted:false,available:true});
}

export class OwnerRefused extends Error{constructor(message:string){super(message.slice(0,300));this.name='OwnerRefused';}}
/** The owner's error text, never a stack or a database detail. */
export const ownerMessage=(error:unknown):string=>{
 const text=error instanceof Error?error.message:String(error);
 return (/^(insert|update|select|delete) |violates|duplicate key|sqlstate|relation "/i.test(text)?'The owner service refused this value.':text).slice(0,300)||'The owner service refused this value.';
};

/** Ask the owner to apply one value, from `applyOn`, under the caller's own login. Returns the owner's value before and
 * after (read back from the owner). Throws OwnerRefused with the owner's message when it refuses. */
export async function applyOwnerValue(ctx:SessionContext,setting:PolicySetting,target:SettingTarget,body:SettingBody,targets:OwnerTargets,applyOn:string):Promise<Readonly<{before:SettingBody|null;after:SettingBody|null}>>{
 const before=(await currentOwnerValue(ctx,setting,target,targets,applyOn)).value;
 try{
  if(setting==='claims.mileage_rates'){
   if(!targets.mileageType)throw new OwnerRefused('No claim type is marked as the mileage claim.');
   const bands:MileageBand[]=(body as {bands:readonly MileageBandValue[]}).bands.map(b=>({fromKm:b.fromKm,toKm:b.toKm,ratePerKm:b.ratePerKm}));
   await setMileageRateTable(ctx,{claimTypeId:targets.mileageType.id,gradeId:null,vehicleClass:'any',effectiveFrom:applyOn,bands});
  }else if(setting==='claims.submit_within_days'){
   const type=claimTypeOf(targets,target);if(!type)throw new OwnerRefused('That claim type no longer exists.');
   await updateClaimType(ctx,{id:type.id,name:type.name,description:type.description,defaultTaxable:type.defaultTaxable,requiresReceipt:type.requiresReceipt,maxReceiptAgeDays:(body as {days:number}).days});
  }else{
   const type=leaveTypeOf(targets,target);if(!type)throw new OwnerRefused('That leave type has no default entitlement table.');
   const current=(await listEntitlementTemplates(ctx,{asOf:applyOn,leaveTypeId:type.id})).find(t=>t.lineageId===type.defaultLineageId);
   if(!current)throw new OwnerRefused('That leave type has no default entitlement table in force.');
   await updateEntitlementTemplate(ctx,{lineageId:type.defaultLineageId,serviceBands:mergeServiceBands(current.serviceBands,(body as {bands:readonly EntitlementBandValue[]}).bands),validFrom:applyOn});
  }
 }catch(error){throw error instanceof OwnerRefused?error:new OwnerRefused(ownerMessage(error));}
 const after=(await currentOwnerValue(ctx,setting,target,targets,applyOn)).value;
 return Object.freeze({before,after});
}

/** The policy's days on the entitlement table's own ranges: a range that keeps its years keeps its per-range carry-forward
 * and maximum balance settings. A range carrying such settings that the policy does not keep is refused, because the
 * policy says nothing about them: change that on the entitlement table itself. */
export function mergeServiceBands(existing:readonly ServiceBand[],bands:readonly EntitlementBandValue[]):ServiceBand[]{
 const extras=(b:ServiceBand)=>b.carryForwardDays!=null||b.carryForwardExpiryMonth!=null||b.carryForwardExpiryDay!=null||b.maxBalanceDays!=null;
 const out=bands.map(b=>{const same=existing.find(e=>e.fromYears===b.fromYears&&(e.toYears??null)===(b.toYears??null));return same?{...same,days:b.days}:{fromYears:b.fromYears,toYears:b.toYears,days:b.days};});
 for(const e of existing)if(extras(e)&&!out.some(b=>b.fromYears===e.fromYears&&(b.toYears??null)===(e.toYears??null)))
  throw new OwnerRefused('The entitlement table has carry-forward or maximum balance settings on a service range this policy changes. Change that range on the entitlement table first.');
 return out;
}
