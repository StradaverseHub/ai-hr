/** The "Offline clocking" settings card's server read, one entry per company in the viewer's active scope. Server code
 * only: core/mobile-offline-rollout is server-only, so this module is never imported by a client component.
 *
 * available: this server's deployment policy is active for the company AND draft 0647 storage is ready. columns: the
 * two attendance_policy settings columns exist (without them the card shows "Not available" and the save refuses).
 * waiting: held claims of the company with no human resolution that this viewer may correct; null without the draft.
 * The "phones offline now" count of the approved design is NOT read: mobile_offline_context is readable only by its
 * own actor under RLS (0647), so an administrator's count would be a false zero. It needs a decision (a definer
 * count in the draft) before it can be shown. */
import type {SessionContext} from '@/db/client';
import {allowedCompanies} from '@/core/read';
import {getScopeIds} from '@/lib/scope';
import {isMobileOfflineDeploymentActiveForCompany,isMobileOfflineStorageReady} from '@/core/mobile-offline-rollout';
import {countOfflineClaimsAwaitingReview,readOfflineClockingSettings} from '@/packs/attendance/service';

export type OfflineClockingCompanySettings={companyId:string;companyName:string;available:boolean;columns:boolean;canEdit:boolean;
 enabled:boolean;maxProvenWindowSeconds:number;waiting:number|null};

export async function loadOfflineClockingSettings(s:SessionContext):Promise<OfflineClockingCompanySettings[]>{
 const allowed=await allowedCompanies(s),scope=await getScopeIds(allowed.map(c=>c.id));
 const companies=allowed.filter(c=>scope.includes(c.id));
 if(!companies.length)return [];
 const storage=await isMobileOfflineStorageReady(s);
 return Promise.all(companies.map(async c=>{
  const [settings,waiting]=await Promise.all([readOfflineClockingSettings(s,c.id),countOfflineClaimsAwaitingReview(s,[c.id])]);
  return {companyId:c.id,companyName:c.name,available:storage&&settings.columns&&isMobileOfflineDeploymentActiveForCompany(s.tenantId,c.id),columns:settings.columns,
   canEdit:settings.canEdit,enabled:settings.policy.enabled,maxProvenWindowSeconds:settings.policy.maxProvenWindowSeconds,waiting};
 }));
}
