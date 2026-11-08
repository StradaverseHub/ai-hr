/** Pure fictional data shaped like system-fixture.mjs users.push; not a native seed. */
import {fixtureNavigationActor} from '../../scripts/performance/navigation-protocol';
export const navigationFixtureUuid=(n:number)=>'00000001-0000-0000-0000-'+String(n).padStart(12,'0');
export function fictionalNavigationFixture(){
 const uuid=navigationFixtureUuid;
 const tenants=Array.from({length:2},(_,t)=>({tenantId:uuid(1000+t),companies:Array.from({length:5},(_,c)=>({companyId:uuid(2000+t*5+c)})),rewardDraft:undefined as {companyId:string;employmentId:string}|undefined}));
 const users=Array.from({length:500},(_,index)=>{const tenant=Math.floor(index/250),company=Math.floor((index%250)/50),constructedTenant=tenants[tenant];
  return {index,tenant,tenantId:constructedTenant.tenantId,company,...fixtureNavigationActor(index),userId:uuid(100000+index),personId:uuid(200000+index),subject:uuid(300000+index),
   companyId:constructedTenant.companies[company].companyId,employmentId:uuid(index+1),batchId:uuid(400000+index),claimTypeId:uuid(500000+index),leaveTypeId:uuid(600000+index),
   token:'NEVER_EXPORT_TOKEN',organization:'perf-'+tenant,username:'person'+index,password:'NEVER_EXPORT_PASSWORD',secret:'NEVER_EXPORT_MFA'};
 });
 const assistantHistory=Object.fromEntries([1,4,251,254].map(index=>[index,{version:1,userIndex:index,rowsVerified:true,defaultCompanyScopeOnly:true,threads:20,exchanges:160,rootTitles:Array.from({length:20},(_,n)=>`PERF saved ${index} root ${String(n).padStart(2,'0')}`)}]));
 return {today:'2026-11-07',month:'2026-11',tenants,users,assistantHistory};
}
