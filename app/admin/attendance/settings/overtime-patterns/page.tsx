import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {scopedAdmin} from '@/lib/scope';
import {PageHeader,Card,pageWideCls,btnPrimary,inputCls} from '@/components/ui';
import {listOvertimePatterns,getOvertimePattern,overtimePatternSetup,overtimePatternWorkspaceCompanies,listAttendanceRules,attendanceGroupPolicyReview,OvertimeOwnerError,type AttendanceGroupPolicyReview} from '@/packs/attendance/service';
import {overtimeStarter} from '@/lib/overtime-pattern-starters';
import {plannedEligibilityFromAssignments} from '@/lib/overtime-pattern-eligibility';
import type {OvertimeAssignmentTarget} from '@/lib/overtime-pattern-model';
import {OvertimeWorkspace} from '@/components/overtime-patterns/workspace';
import {OvertimePatternListActions} from '@/components/overtime-patterns/list-actions';
import {OvertimeGroupPolicyReview} from '@/components/overtime-patterns/group-policy-review';
import {LegacyOvertimeBands} from './legacy-bands';
import {todayInKualaLumpur} from '@/lib/hr-date';

const PAGE='/admin/attendance/settings/overtime-patterns';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const states=['draft','scheduled','active','inactive','archived'] as const;
/** Board 4197534a: no starting patterns are created on visit (Create pattern offers the four as templates). One Pattern
 * Code holds the overtime rules; Eligibility decides which companies and employees follow it. The listing is one
 * set-based read (packs/attendance/overtime-patterns.ts listOvertimePatterns). */
export default async function OvertimePatternsPage({searchParams}:{searchParams:Promise<{pattern?:string;version?:string;new?:string;starter?:string;search?:string;status?:string;cursor?:string;mode?:string;notice?:string;policyCompany?:string;policyGroup?:string;policyVersion?:string;bandError?:string;saveAck?:string}>}) {
  const {s,scopeIds:selectedScopeIds}=await scopedAdmin();
  const [t,query]=await Promise.all([getTranslations('overtimePatterns'),searchParams]);
  const eligible=await overtimePatternWorkspaceCompanies(s),eligibleIds=new Set(eligible.map(company=>company.id));
  const scopeIds=selectedScopeIds.filter(id=>eligibleIds.has(id));
  if(!scopeIds.length)return <div className={pageWideCls}><PageHeader title={t('title')} description={t('descriptionText')} back={{href:'/admin/attendance/settings',label:t('backToSettings')}}/><Card className="p-6"><p role="status">{t('noActiveAdminScope')}</p></Card></div>;

  const status=states.find(state=>state===query.status);
  async function readDetail(id:string) {try{return await getOvertimePattern(s,id);}catch(error){if(error instanceof OvertimeOwnerError&&['permission','unavailable','invalid'].includes(error.code))return null;throw error;}}
  const showEditor=query.new==='1'||Boolean(query.pattern);
  // The editor's Eligibility offers every company the reader administers (not only the company switcher's selection).
  const [list,setup,detail]=await Promise.all([
    showEditor?Promise.resolve(null):listOvertimePatterns(s,{companyIds:scopeIds,search:query.search?.slice(0,200),status,cursor:query.cursor&&UUID.test(query.cursor)?query.cursor:undefined,limit:50}),
    showEditor?overtimePatternSetup(s,{limit:100}):Promise.resolve(null),
    query.pattern&&UUID.test(query.pattern)?readDetail(query.pattern):Promise.resolve(null),
  ]);
  const version=detail?.versions.find(item=>item.id===query.version)??(!query.version?detail?.versions[0]:undefined);
  const starter=query.new==='1'?overtimeStarter(query.starter):null;
  // A new pattern starts with the single company of the company selection; with several, Eligibility chooses.
  const newPatternCompany=scopeIds.length===1?eligible.filter(company=>company.id===scopeIds[0]).map(company=>({id:company.id,currency:company.currency}))[0]??null:null;
  // A draft carries its planned Eligibility; an activated version shows the Eligibility its live assignments express.
  const today=todayInKualaLumpur();
  const planned=version?(version.activatedAt?plannedEligibilityFromAssignments((detail?.assignments??[]).filter(row=>row.versionId===version.id&&!row.supersededAt&&(!row.validTo||row.validTo>today)).map(row=>({target:row.target as unknown as OvertimeAssignmentTarget,priority:row.priority,validFrom:row.validFrom}))):version.plannedEligibility):null;
  const plannedFrom=version?.activatedAt?version.effectiveFrom:null;
  // Only the list view loads this independent review. An editor GET/prefetch remains read-only.
  const groups=showEditor?[]:await listAttendanceRules(s);
  const policyCompanies=eligible.filter(row=>scopeIds.includes(row.id));
  const policyCompany=policyCompanies.find(row=>row.id===query.policyCompany)?.id??'';
  const policyGroup=groups.find(row=>row.id===query.policyGroup)?.id??'';
  let policyReview:AttendanceGroupPolicyReview|null=null,policyFailed=false;
  if(policyCompany&&policyGroup)try{policyReview=await attendanceGroupPolicyReview(s,{companyId:policyCompany,ruleId:policyGroup});policyFailed=!policyReview;}
  catch(error){policyFailed=true;console.error('[overtime-group policy review]',error);}
  function listHref(cursor:string) {const params=new URLSearchParams();if(query.search)params.set('search',query.search);if(status)params.set('status',status);params.set('cursor',cursor);return `${PAGE}?${params}`;}
  const notice=query.notice==='activated'||query.notice==='deleted'?query.notice:null;
  return <div className={pageWideCls}>
    <PageHeader title={t('title')} description={t('listing.description')} back={{href:'/admin/attendance/settings',label:t('backToSettings')}} actions={<Link className={btnPrimary} href={`${PAGE}?new=1`}>{t('create')}</Link>}/>
    {notice?<p role="status" className="rounded-lg border border-border p-3 text-sm">{t(`listing.notice.${notice}`)}</p>:null}
    {showEditor?<>
      <div className="flex flex-wrap items-center justify-between gap-3"><Link href={PAGE} className="text-sm text-primary hover:underline">{t('backToList')}</Link>{detail?<div className="flex flex-wrap items-center gap-2 text-sm"><span>{t('versions')}</span>{detail.versions.map(item=><Link key={item.id} href={`${PAGE}?pattern=${detail.pattern.id}&version=${item.id}`} aria-current={version?.id===item.id?'page':undefined} className="rounded-lg border border-border px-3 py-2">{item.ordinal} · {t(`status.${item.status}`)}</Link>)}</div>:null}</div>
      {query.pattern&&!detail?<p role="alert" className="rounded-lg border border-border p-4 text-sm">{t('unavailable')}</p>:
      setup&&(query.new==='1'||version)?<OvertimeWorkspace legacyEditor={query.new!=='1'&&detail?.pattern.kind==='legacy'?<LegacyOvertimeBands s={s} ruleId={detail.pattern.legacyRuleId} patternId={detail.pattern.id}
        error={typeof query.bandError==='string'?query.bandError.slice(0,500):undefined} savedReceipt={typeof query.saveAck==='string'&&/^[a-f0-9]{32}$/.test(query.saveAck)?query.saveAck:undefined}/>:undefined}
        key={`${detail?.pattern.id??'new'}:${version?.id??'new'}:${version?.revision??0}:${s.userId??'session'}:${starter?.key??'custom'}:${query.mode??''}`}
        detail={query.new==='1'?null:detail} version={query.new==='1'?undefined:version} setup={setup} starterKey={starter?.key} newPatternCompany={newPatternCompany}
        plannedEligibility={query.new==='1'?null:planned&&plannedFrom&&typeof planned==='object'?{...planned,from:plannedFrom}:planned} readOnly={query.mode==='view'}/>:<p role="alert" className="rounded-lg border border-border p-4 text-sm">{t('unavailable')}</p>}
    </>:<>
      <form method="get" className="flex flex-wrap items-end gap-3"><label className="space-y-1 text-sm"><span className="block">{t('search')}</span><input className={inputCls} name="search" placeholder={t('listing.searchPlaceholder')} defaultValue={query.search??''} maxLength={200}/></label><label className="space-y-1 text-sm"><span className="block">{t('statusLabel')}</span><select name="status" className={inputCls} defaultValue={status??''}><option value="">{t('allStatuses')}</option>{states.map(state=><option key={state} value={state}>{t(`status.${state}`)}</option>)}</select></label><button className={btnPrimary}>{t('search')}</button></form>
      <Card className="overflow-hidden">{!list?.items.length?<p className="p-8 text-center text-sm text-muted-foreground">{t('empty')}</p>:<div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="border-b border-border text-xs text-muted-foreground"><tr>{['code','name','listing.companies','statusLabel','actions'].map(key=><th scope="col" className="px-4 py-3" key={key}>{t(key)}</th>)}</tr></thead><tbody>{list.items.map(item=><tr className="border-b border-border/60" key={item.id}>
        <td className="px-4 py-3 font-mono text-xs">{item.kind==='legacy'?<span className="font-sans text-sm">{t('listing.scheduleGroup')}</span>:item.code}</td>
        <td className="px-4 py-3">{item.name??t('unavailable')}</td>
        <td className="px-4 py-3">{item.kind==='legacy'?t('listing.setBySchedule'):item.companyCount===1?item.companyNames[0]??'—':item.companyCount?<span title={item.companyNames.join(', ')+(item.companyCount>item.companyNames.length?' …':'')}>{t('listing.companyCount',{count:item.companyCount})}</span>:'—'}</td>
        <td className="px-4 py-3"><span className="rounded-full border border-border px-2 py-0.5 text-xs">{t(`status.${item.status}`)}</span>{item.pendingDraft?<span className="ml-2 text-xs text-muted-foreground">{t('listing.pendingDraft')}</span>:null}</td>
        <td className="px-4 py-3"><OvertimePatternListActions row={{id:item.id,kind:item.kind,code:item.code,name:item.name,revision:item.revision,latestVersionId:item.latestVersionId,liveVersionId:item.liveVersionId,latestDraft:item.latestDraft,writable:item.writable,archived:item.archived}}/></td>
      </tr>)}</tbody></table></div>}</Card>
      {list?.nextCursor?<Link href={listHref(list.nextCursor)} className="text-sm text-primary hover:underline">{t('nextPage')}</Link>:null}
      <p className="text-xs text-muted-foreground">{t('listing.footnote')}</p>
      <OvertimeGroupPolicyReview companies={policyCompanies.map(row=>({...row}))} groups={groups.map(row=>({id:row.id,name:row.label?.trim()?`${row.label} — ${row.name}`:row.name}))} companyId={policyCompany} groupId={policyGroup} review={policyReview} failed={policyFailed} versionId={query.policyVersion} today={todayInKualaLumpur()}/>
    </>}
  </div>;
}
