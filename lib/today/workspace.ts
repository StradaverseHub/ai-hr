/** "Your workspace" on Employee Today and Manager Today (owner decision, 12 Nov 2026, retiring the old dashboard): links
 * to pages this person can already open, chosen by the same checks those pages make. A link grants nothing: each page
 * still runs its own guard and every read its own authorization, and a module the company has not bought is not
 * offered (the rail's cosmetic rule).
 *
 * The old dashboard's two addresses, `/?workspace=dashboard` and `/?workspace=team`, now redirect to `/`, where the
 * person's own Today is drawn (see retiredWorkspaceRedirect). */
import type {SessionContext} from '@/db/client';
import {canAdminOnehr,canManagePayroll,hasTeamAccess,isAdmin} from '@/lib/authz-model';

export type WorkspaceLinkKey='myTeam'|'approvals'|'teamLeaveTracker'|'payslipInformation'|'incomeTaxRecalculation'|'performanceAdmin';
export type WorkspaceLink=Readonly<{key:WorkspaceLinkKey;href:string}>;

/** `team`: the person manages a team (Manager Today, or Employee Today for someone whose own employment manages people).
 * `moduleOn`: whether a module is in use, answered by the caller's entitlement owner. */
export function workspaceLinksFor(s:SessionContext,p:Readonly<{team:boolean;moduleOn:(code:string)=>boolean}>):WorkspaceLink[]{
 const links:WorkspaceLink[]=[];
 if(p.team){
  // app/manage/my-team/page.tsx requireTeamAccess.
  if(hasTeamAccess(s))links.push({key:'myTeam',href:'/manage/my-team'});
  // The rail's Approvals rule (canApprove in app/layout.tsx); /approvals checks the person's own queue again.
  if(isAdmin(s)||(s.roles??[]).includes('manager'))links.push({key:'approvals',href:'/approvals'});
  // The Team Leave Tracker, which the old Team Away Today card opened.
  if(p.moduleOn('leave'))links.push({key:'teamLeaveTracker',href:'/leave/tracker?calendar=1'});
 }
 // A payroll partner's own pages (requirePayrollAccess), and the performance administration a performance partner
 // reaches (app/performance/page.tsx admits canAdminOnehr). The Exceptions page is not offered: it runs requireAdmin,
 // and an administrator has Admin Today instead.
 if(canManagePayroll(s)&&p.moduleOn('payroll')){
  links.push({key:'payslipInformation',href:'/payroll/payslip-information'});
  links.push({key:'incomeTaxRecalculation',href:'/payroll/income-tax-recalculation'});
 }
 if(canAdminOnehr(s)&&p.moduleOn('performance'))links.push({key:'performanceAdmin',href:'/performance'});
 return links;
}

/** The query parameters `/` reads. A redirect from a retired address keeps these and drops everything else. */
const HOME_PARAMS=['moduleUnavailable','employmentId','needs','recommend'] as const;
const RETIRED_WORKSPACES:ReadonlySet<string>=new Set(['dashboard','team']);

/** `/?workspace=dashboard` (the old administrator dashboard) and `/?workspace=team` (the old team workbench) are
 * retired: an old bookmark lands on `/`, which draws the person's own Today (an administrator Admin Today, a manager
 * Manager Today, everyone else Employee Today). Null when the address is not a retired one. */
export function retiredWorkspaceRedirect(query:Readonly<Record<string,string|string[]|undefined>>|undefined):string|null{
 const raw=query?.workspace;
 const values=raw==null?[]:Array.isArray(raw)?raw:[raw];
 if(!values.some(value=>RETIRED_WORKSPACES.has(value)))return null;
 const kept=new URLSearchParams();
 for(const key of HOME_PARAMS){
  const value=query?.[key];
  for(const one of value==null?[]:Array.isArray(value)?value:[value])kept.append(key,one);
 }
 const search=kept.toString();
 return search?`/?${search}`:'/';
}
