/** Internal canonical read owners. Real Tx only; no pool, authority issuer or audit timing choice.
 * Legacy and uninstalled receipt purposes share these exact validation/order/money queries. */
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {validateRewardLibrary,setupUuid,setupYear,RewardSetupError,type RewardLibrary,type PatInput} from './setup-model';
export type RewardLibraryVersion={id:string;libraryId:string;kind:'salary'|'bonus';name:string;year:number;tags:string[];groupDefault:boolean;previousLibraryId:string|null;sourcePolicyVersionId?:string|null;version:number;data:RewardLibrary;state:'draft'|'pending'|'confirmed';lockVersion:number;createdBy:string;contributors:string[];createdByPersonId?:string;contributorPersonIds?:string[];confirmedBy:string|null;confirmedAt:string|null;reason:string;locked:boolean;usedBy:{plan:string;company:string;year:number}[]};
export type PatVersion={id:string;companyId:string;year:number;revision:number;inputs:PatInput;state:'pending'|'confirmed';createdBy:string;createdByPersonId?:string;confirmedBy:string|null;confirmedAt:string|null;reason:string;createdByName?:string|null;confirmedByName?:string|null};
export type PatCompany={id:string;name:string;parentId:string|null;parentName:string|null;businessGroupId:string|null;businessGroupName:string|null;businessUnitId:string|null;businessUnitName:string|null;structureStatus:string};

/** Closed native helper vocabulary; never a SQL broker or a caller-supplied Tx. */
export type RewardSetupQueryPort=Readonly<{
 authority:(tx:Tx,companyId:string|null,operation:'library_view'|'manage')=>Promise<void>;
 usedBy:(tx:Tx,id:string)=>PromiseLike<{plan:string;company:string;year:number}[]>;
 locked:(tx:Tx,id:string)=>PromiseLike<{locked:boolean}[]>;
 companies:(tx:Tx,year:number)=>PromiseLike<{id:string;name:string;parentId:string|null;parentName:string|null}[]>;
 structure:(tx:Tx,companyId:string,at:string)=>PromiseLike<{tags:{businessGroupId?:string;businessGroupName?:string;businessUnitId?:string;businessUnitName?:string;status?:string}}[]>;
 patHistory:(tx:Tx,companyId:string,year:number)=>PromiseLike<{value:PatVersion}[]>;
}>;
export async function libraryVersionQueryTx(tx:Tx,ctx:SessionContext,id:string,requireConfirmed:boolean,port:RewardSetupQueryPort):Promise<RewardLibraryVersion>{
 setupUuid.parse(id);await port.authority(tx,null,'library_view');
 const [r]=await tx.execute<Omit<RewardLibraryVersion,'usedBy'|'locked'>>(sql`select v.id,l.id as "libraryId",l.kind,l.name,l.year,l.tags,l.group_default as "groupDefault",l.previous_library_id as "previousLibraryId",l.source_policy_version_id as "sourcePolicyVersionId",v.revision as version,v.data,v.state,v.lock_version as "lockVersion",v.created_by as "createdBy",v.contributor_ids as contributors,v.created_by_person_id as "createdByPersonId",v.contributor_person_ids as "contributorPersonIds",v.confirmed_by as "confirmedBy",v.confirmed_at::text as "confirmedAt",v.reason from reward_library_version v join reward_library l on l.id=v.library_id and l.tenant_id=v.tenant_id where v.id=${id}::uuid and v.tenant_id=${ctx.tenantId}::uuid`);
 if(!r||requireConfirmed&&r.state!=='confirmed')throw new RewardSetupError('missing','Choose a confirmed library version.');
 validateRewardLibrary(r.data);
 const usage=await port.usedBy(tx,id);
 const [lock]=await port.locked(tx,id);
 return{...r,usedBy:[...usage],locked:lock?.locked??false};
}

export async function rewardLibrariesQueryTx(tx:Tx,ctx:SessionContext,kind:'salary'|'bonus'|undefined,year:number|undefined,port:RewardSetupQueryPort){await port.authority(tx,null,'library_view');const rows=await tx.execute<{id:string}>(sql`select v.id from reward_library l join reward_library_version v on v.library_id=l.id and v.tenant_id=l.tenant_id where l.tenant_id=${ctx.tenantId}::uuid ${kind?sql`and l.kind=${kind}`:sql``} ${year!==undefined?sql`and l.year=${year}`:sql``} order by l.year desc,l.name,v.revision desc`);const result=[];for(const row of rows)result.push(await libraryVersionQueryTx(tx,ctx,row.id,false,port));return result;}

export async function rewardSetupCompaniesQueryTx(tx:Tx,ctx:SessionContext,year:number,port:RewardSetupQueryPort):Promise<PatCompany[]>{setupYear.parse(year);await port.authority(tx,null,'manage');const rows=await port.companies(tx,year);const result:PatCompany[]=[];const at=year<Number(todayInKualaLumpur().slice(0,4))?`${year}-12-31`:todayInKualaLumpur();for(const company of rows){const [r]=await port.structure(tx,company.id,at);result.push({...company,businessGroupId:r?.tags?.businessGroupId??null,businessGroupName:r?.tags?.businessGroupName??null,businessUnitId:r?.tags?.businessUnitId??null,businessUnitName:r?.tags?.businessUnitName??null,structureStatus:r?.tags?.status??'legacy'});}return result.sort((a,b)=>(a.businessGroupName??a.parentName??'').localeCompare(b.businessGroupName??b.parentName??'')||(a.businessUnitName??'').localeCompare(b.businessUnitName??'')||a.name.localeCompare(b.name)||a.id.localeCompare(b.id));}
export async function rewardPatInputsQueryTx(tx:Tx,ctx:SessionContext,year:number,port:RewardSetupQueryPort){await port.authority(tx,null,'manage');const companies=await rewardSetupCompaniesQueryTx(tx,ctx,year,port),rows:({company:PatCompany;current:PatVersion|null;pending:PatVersion|null;history:PatVersion[]})[]=[];for(const company of companies){const versions=await port.patHistory(tx,company.id,year),all=versions.map(v=>v.value);rows.push({company,current:all.find(v=>v.state==='confirmed')??null,pending:all.find(v=>v.state==='pending')??null,history:all});}return rows;}
