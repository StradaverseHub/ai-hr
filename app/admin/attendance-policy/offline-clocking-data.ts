/** The "Offline clocking" settings card's server read, one entry per company in the viewer's active scope. Server code
 * only: core/mobile-offline-rollout is server-only, so this module is never imported by a client component.
 *
 * available: this server's deployment policy is active for the company AND draft 0647 storage is ready. columns: the
 * two attendance_policy settings columns exist (without them the card shows "Not available" and the save refuses).
 * waiting: held claims of the company with no human resolution that this viewer may correct; null without the draft.
 * phonesOffline: the company's open offline contexts, through 0647's definer count (context rows are actor-only under
 * RLS, so a direct read would be a false zero); null without the draft or without the settings card's authority. */
import type {SessionContext} from '@/db/client';
import {allowedCompanies} from '@/core/read';
import {getScopeIds} from '@/lib/scope';
import {isMobileOfflineDeploymentActiveForCompany,isMobileOfflineStorageReady} from '@/core/mobile-offline-rollout';
import {countOfflineClaimsAwaitingReview,countOpenOfflineContexts,readOfflineClockingSettings} from '@/packs/attendance/service';

export type OfflineClockingCompanySettings={companyId:string;companyName:string;available:boolean;columns:boolean;canEdit:boolean;
 enabled:boolean;maxProvenWindowSeconds:number;waiting:number|null;phonesOffline:number|null};

export async function loadOfflineClockingSettings(s:SessionContext):Promise<OfflineClockingCompanySettings[]>{
 const allowed=await allowedCompanies(s),scope=await getScopeIds(allowed.map(c=>c.id));
 const companies=allowed.filter(c=>scope.includes(c.id));
 if(!companies.length)return [];
 const storage=await isMobileOfflineStorageReady(s);
 return Promise.all(companies.map(async c=>{
  const [settings,waiting,phonesOffline]=await Promise.all([readOfflineClockingSettings(s,c.id),countOfflineClaimsAwaitingReview(s,[c.id]),countOpenOfflineContexts(s,c.id)]);
  return {companyId:c.id,companyName:c.name,available:storage&&settings.columns&&isMobileOfflineDeploymentActiveForCompany(s.tenantId,c.id),columns:settings.columns,
   canEdit:settings.canEdit,enabled:settings.policy.enabled,maxProvenWindowSeconds:settings.policy.maxProvenWindowSeconds,waiting,phonesOffline};
 }));
}
