import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {requireModule} from '@/lib/authz';
import {scopedSession,getScopeIds} from '@/lib/scope';
import {rewardAccessRequests,rewardAccessAdministration} from '@/packs/rewards/service';
import {RewardPersonalPages} from './personal-pages';
import {rewardPermissions,rewardPersonalPages,rewardAccessPageCompanies,rewardSetupEntry} from '@/packs/rewards/access-policy';
import {PageHeader,ErrorBanner} from '@/components/ui';
import {RewardAccessEditor} from './access-editor';
import {RewardAccessRequests} from './requests';
import {RewardRolePermissions} from './role-permissions';
import {WholeGroupRoles} from './whole-group-roles';
import { RewardReviewActivity } from './review-activity';
import { RewardApprovalMatrix } from './approval-matrix';
import {RewardsAdminTabs} from '../admin-tabs';
export default async function RewardAccessPage({searchParams}:{searchParams:Promise<{tab?:string;cycle?:string;review?:string;actor?:string;copy?:string;policyError?:string;groupRoleError?:string}>}){
 await requireModule('rewards');const{s}=await scopedSession(),t=await getTranslations('rewardsAccess'),p=await getTranslations('rewardAccessPolicy'),c=await getTranslations('rewardsAccessControl'),b=await getTranslations('rewardsAccessBatch'),sp=await searchParams;
 const setup=await rewardSetupEntry(s);
 const setupLink=setup.bootstrap?<Link href="/admin/rewards/setup-access" className="text-sm text-primary underline">{(await getTranslations('nav'))('rewardsManageSetup')}</Link>:null;
 const groupRoles=setup.bootstrap?<WholeGroupRoles session={s} error={sp.groupRoleError}/>:null;
 const companies=await rewardAccessPageCompanies(s).catch(error=>{
  if(setup.bootstrap)return [];
  throw error;
 });
 if(!companies.length)return <div className="space-y-6"><PageHeader title={t('title')}/>{setupLink}{groupRoles}</div>;
 const permissions=await rewardPermissions(s).catch(()=>null),scopeIds=await getScopeIds(companies.map(c=>c.id));
 const pages=await rewardPersonalPages(s);
 const value=await rewardAccessAdministration(s,scopeIds),requests=(await rewardAccessRequests(s)).filter(q=>q.changes.every(c=>value.reviews.some(r=>r.id===c.unitId)));
 const tab=sp.tab==='activity'?'activity':sp.tab==='matrix'?'matrix':!permissions||sp.tab==='users'?'users':'roles',count=new Set(value.members.filter(m=>!m.disabled).map(m=>m.userId)).size;
 return <div className="w-full space-y-6"><PageHeader title={t('title')} description={p('intro')}/><RewardsAdminTabs current="access"/>{setupLink}
  {sp.policyError&&<ErrorBanner message={p('error')}/>}<RewardAccessRequests requests={requests} value={value}/>
  <div className="flex flex-wrap gap-3"><Link href="/admin/rewards/access/export" className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted">{c('export')}</Link><Link href="/admin/rewards/access/audit" className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted">{c('exportAudit')}</Link><Link href="/admin/rewards/access?tab=users&copy=1" className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted">{b('copyOpen')}</Link></div>
  <nav aria-label={p('tabs')} className="flex border-b border-border"><Link href="/admin/rewards/access?tab=roles" aria-current={tab==='roles'?'page':undefined} className={`border-b-2 px-4 py-3 text-sm ${tab==='roles'?'border-primary font-semibold':'border-transparent text-muted-foreground'}`}>{p('rolePermissions')}</Link><Link href="/admin/rewards/access?tab=users" aria-current={tab==='users'?'page':undefined} className={`border-b-2 px-4 py-3 text-sm ${tab==='users'?'border-primary font-semibold':'border-transparent text-muted-foreground'}`}>{p('users',{count})}</Link><Link href="/admin/rewards/access?tab=matrix" aria-current={tab==='matrix'?'page':undefined} className={`border-b-2 px-4 py-3 text-sm ${tab==='matrix'?'border-primary font-semibold':'border-transparent text-muted-foreground'}`}>{t('coverageTitle')}</Link><Link href="/admin/rewards/access?tab=activity" aria-current={tab==='activity'?'page':undefined} className={`border-b-2 px-4 py-3 text-sm ${tab==='activity'?'border-primary font-semibold':'border-transparent text-muted-foreground'}`}>{t('reviewActivity.title')}</Link></nav>
  {tab==='activity'?<RewardReviewActivity session={s} value={value} reviewId={sp.review} actorId={sp.actor}/>:tab==='matrix'?<RewardApprovalMatrix value={value} cycleId={sp.cycle} groupSession={setup.bootstrap ? s : undefined}/>:tab==='roles'&&permissions?<RewardRolePermissions values={permissions.values} canChange={permissions.canChange} holders={value.members.filter(m=>!m.disabled).map(m=>({role:m.role,name:m.name,proxy:!!m.coversUserId}))}/>:<div className="space-y-5">{groupRoles}<RewardAccessEditor value={value} requests={requests} initialCopy={sp.copy==='1'}/><RewardPersonalPages value={value} pages={pages}/></div>}
 </div>;
}
