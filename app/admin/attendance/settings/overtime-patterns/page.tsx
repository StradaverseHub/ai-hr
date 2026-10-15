import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {scopedAdmin} from '@/lib/scope';
import {PageHeader,Card,pageWideCls,btnPrimary,inputCls} from '@/components/ui';
import {listOvertimePatterns,getOvertimePattern,overtimePatternSetup,OvertimeOwnerError} from '@/packs/attendance/service';
import {OvertimeWorkspace} from '@/components/overtime-patterns/workspace';

const PAGE='/admin/attendance/settings/overtime-patterns';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const states=['draft','active','inactive','archived'] as const;
export default async function OvertimePatternsPage({searchParams}:{searchParams:Promise<{pattern?:string;version?:string;new?:string;search?:string;status?:string;cursor?:string;method?:string;assignmentSearch?:string}>}) {
  const {s,scopeIds}=await scopedAdmin();
  const [t,query]=await Promise.all([getTranslations('overtimePatterns'),searchParams]);
  const status=states.find(state=>state===query.status);
  const method=(['hourly','flat','formula'] as const).find(value=>value===query.method);
  async function readDetail(id:string) {try{return await getOvertimePattern(s,id);}catch(error){if(error instanceof OvertimeOwnerError&&['permission','unavailable','invalid'].includes(error.code))return null;throw error;}}
  const [list,setup,detail]=await Promise.all([
    listOvertimePatterns(s,{companyIds:scopeIds,search:query.search?.slice(0,200),status,method,assignmentSearch:query.assignmentSearch?.slice(0,200),cursor:query.cursor,limit:50}),
    overtimePatternSetup(s,{companyIds:scopeIds,limit:100}),
    query.pattern&&UUID.test(query.pattern)?readDetail(query.pattern):Promise.resolve(null),
  ]);
  const version=detail?.versions.find(item=>item.id===query.version)??(!query.version?detail?.versions[0]:undefined);
  const showEditor=query.new==='1'||Boolean(detail&&version);
  function listHref(cursor:string) {const params=new URLSearchParams();if(query.search)params.set('search',query.search);if(status)params.set('status',status);if(method)params.set('method',method);if(query.assignmentSearch)params.set('assignmentSearch',query.assignmentSearch);params.set('cursor',cursor);return `${PAGE}?${params}`;}
  return <div className={pageWideCls}>
    <PageHeader title={t('title')} description={t('descriptionText')} back={{href:'/admin/attendance/settings',label:t('backToSettings')}} actions={<Link className={btnPrimary} href={`${PAGE}?new=1`}>{t('create')}</Link>}/>
    {showEditor?<>
      <div className="flex flex-wrap items-center justify-between gap-3"><Link href={PAGE} className="text-sm text-primary hover:underline">{t('backToList')}</Link>{detail?<div className="flex flex-wrap items-center gap-2 text-sm"><span>{t('versions')}</span>{detail.versions.map(item=><Link key={item.id} href={`${PAGE}?pattern=${detail.pattern.id}&version=${item.id}`} aria-current={version?.id===item.id?'page':undefined} className="rounded-lg border border-border px-3 py-2">{item.ordinal} · {t(`status.${item.status}`)}</Link>)}</div>:null}</div>
      <OvertimeWorkspace key={`${detail?.pattern.id??'new'}:${version?.id??'new'}:${version?.revision??0}:${s.userId??'session'}:${scopeIds.join(',')}`} detail={query.new==='1'?null:detail} version={query.new==='1'?undefined:version} setup={setup}/>
    </>:<>
      {query.pattern||query.version?<p role="alert" className="rounded-lg border border-border p-4 text-sm">{t('unavailable')}</p>:null}
      <form method="get" className="flex flex-wrap items-end gap-3"><label className="space-y-1 text-sm"><span className="block">{t('search')}</span><input className={inputCls} name="search" defaultValue={query.search??''} maxLength={200}/></label><label className="space-y-1 text-sm"><span className="block">{t('statusLabel')}</span><select name="status" className={inputCls} defaultValue={status??''}><option value="">{t('allStatuses')}</option>{states.map(state=><option key={state} value={state}>{t(`status.${state}`)}</option>)}</select></label><label className="space-y-1 text-sm"><span className="block">{t('method')}</span><select name="method" className={inputCls} defaultValue={method??''}><option value="">{t('allMethods')}</option>{['hourly','flat','formula'].map(value=><option key={value} value={value}>{t(`methods.${value}`)}</option>)}</select></label><label className="space-y-1 text-sm"><span className="block">{t('assignmentSearch')}</span><input className={inputCls} name="assignmentSearch" defaultValue={query.assignmentSearch??''} maxLength={200}/></label><button className={btnPrimary}>{t('search')}</button></form>
      <Card className="overflow-hidden">{!list.items.length?<p className="p-8 text-center text-sm text-muted-foreground">{t('empty')}</p>:<div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="border-b border-border text-xs text-muted-foreground"><tr>{['code','name','method','companies','effectivePeriod','statusLabel','actions'].map(key=><th className="px-4 py-3" key={key}>{t(key)}</th>)}</tr></thead><tbody>{list.items.map(item=><tr className="border-b border-border/60" key={item.id}><td className="px-4 py-3 font-mono text-xs">{item.code??t('legacy')}</td><td className="px-4 py-3">{(item.matchingVersion??item.latestVersion)?.name??t('unavailable')}</td><td className="px-4 py-3">{item.kind==='legacy'?t('legacy'):methodsFor((item.matchingVersion??item.latestVersion)?.definition).map(value=>t(`methods.${value}`)).join(', ')||t('notConfigured')}</td><td className="px-4 py-3">{(item.matchingVersion??item.latestVersion)?.companyIds.map(id=>setup.companies.find(company=>company.id===id)?.name??t('unavailable')).join(', ')??'—'}</td><td className="px-4 py-3">{(item.matchingVersion??item.latestVersion)?.effectiveFrom??'—'} → {(item.matchingVersion??item.latestVersion)?.states.find(state=>state.state!=='active'&&state.effectiveFrom>((item.matchingVersion??item.latestVersion)?.effectiveFrom??''))?.effectiveFrom??t('noEnd')}</td><td className="px-4 py-3">{t(`status.${item.archivedAt?'archived':(item.matchingVersion??item.latestVersion)?.status??'draft'}`)}</td><td className="px-4 py-3"><Link href={`${PAGE}?pattern=${item.id}&version=${(item.matchingVersion??item.latestVersion)?.id??''}`} className="text-primary hover:underline">{t('open')}</Link></td></tr>)}</tbody></table></div>}</Card>
      {list.nextCursor?<Link href={listHref(list.nextCursor)} className="text-sm text-primary hover:underline">{t('nextPage')}</Link>:null}
    </>}
  </div>;
}

function methodsFor(definition:Record<string,unknown>|undefined):('hourly'|'flat'|'formula')[] {
  if(!definition||!Array.isArray(definition.rates))return [];
  const methods=new Set<'hourly'|'flat'|'formula'>();
  for(const rate of definition.rates)if(rate&&Array.isArray(rate.tiers))for(const tier of rate.tiers)if(['hourly','flat','formula'].includes(tier?.payment?.method))methods.add(tier.payment.method);
  return [...methods];
}
