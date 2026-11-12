import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import type {SessionContext} from '@/db/client';
import {workspaceLinksFor,type WorkspaceLinkKey} from '@/lib/today/workspace';
import {LINK} from './employee/panel';
import {moduleState} from './employee/reads';

/** "Your workspace": the pages this person already opens (lib/today/workspace.ts), in place of the old dashboard's team
 * workbench and the old personal Home under a partner's Today. Nothing is drawn when there is no such page. */
export async function WorkspaceLinks({session,team}:{session:SessionContext;team:boolean}){
 // The Today panels' own module reader (isModuleEnabled): a failed entitlement read offers no link, as a module that is
 // off does, without hiding the failure from the page's other owners.
 const links=workspaceLinksFor(session,{team,moduleOn:code=>moduleState(session,code,null)==='on'});
 if(!links.length)return null;
 const [t,tNav,tPayslip,tTax]=await Promise.all([getTranslations('today'),getTranslations('nav'),
  getTranslations('payroll.payslipInformation'),getTranslations('payrollTaxBasis')]);
 const label:Record<WorkspaceLinkKey,string>={myTeam:tNav('myTeam'),approvals:tNav('approvals'),teamLeaveTracker:tNav('teamLeaveTracker'),
  payslipInformation:tPayslip('title'),incomeTaxRecalculation:tTax('title'),performanceAdmin:tNav('performanceAdmin')};
 return <nav aria-label={t('workspaceTitle')} data-today-workspace className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1">
  <span className="text-sm text-muted-foreground">{t('workspaceTitle')}</span>
  {links.map(link=><Link key={link.key} href={link.href} data-today-workspace-link={link.key} className={LINK}>{label[link.key]}</Link>)}
 </nav>;
}
