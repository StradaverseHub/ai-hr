import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { scopedAdmin } from '@/lib/scope';
import { listAllowancePolicies } from '@/core/read';
import { Card, ErrorBanner, PageHeader, SectionHeader, btnPrimary, pageWideCls } from '@/components/ui';
import { Badge } from '@/components/ui/badge';
import { ConfirmSubmit } from '@/components/ui/confirm-submit';
import { formatMoney } from '@/lib/money';
import { archiveAllowancePolicyAction,setAllowanceStatusAction } from './actions';
const PAGE='/admin/attendance-allowance';
export default async function AttendanceAllowancePage({searchParams}:{searchParams:Promise<{error?:string;toast?:string;edit?:string}>}){
  const {s,scopeIds}=await scopedAdmin();
  const t=await getTranslations('allowanceV2'),v=await getTranslations('allowanceV3');
  const settings=await getTranslations('attendanceSettingsHub');
  const {error,edit}=await searchParams;
  if(edit&&/^[0-9a-f-]{36}$/i.test(edit))redirect(`${PAGE}/${edit}?edit=1`);
  const policies=scopeIds.length?await listAllowancePolicies(s,{companyIds:scopeIds,includeArchived:false}):[];
  return <div className={pageWideCls}>
    <a href="/admin/attendance/settings" className="text-sm text-muted-foreground hover:underline">← {settings('backToSettings')}</a>
    <PageHeader title={t('title')} description={t('description')}/>
    {error&&<ErrorBanner message={error}/>}
    <div className="flex justify-end"><a href={`${PAGE}/new`} className={btnPrimary}>{t('create')}</a></div>
    <Card className="overflow-hidden"><SectionHeader title={t('policies')} count={policies.length}/>
      {!policies.length?<p className="p-8 text-center text-sm text-muted-foreground">{t('empty')}</p>:<div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b border-border text-left text-xs text-muted-foreground">{['code','name','company','policyType','method','amount','payrollCode','statusLabel','actions'].map(k=><th className="px-4 py-3" key={k}>{t(k)}</th>)}</tr></thead><tbody>
      {policies.map(p=><tr key={p.id} className="border-b border-border/60"><td className="px-4 py-3 font-mono text-xs">{p.code}</td><td className="px-4 py-3">{p.name}{!p.rules&&<span className="block text-xs text-muted-foreground">{t('legacy')}</span>}</td><td className="px-4 py-3">{p.companyName}</td><td className="px-4 py-3">{t(p.policyType==='deduction'?'deduction':'earning')}</td><td className="px-4 py-3">{t(`methods.${p.method}`)}</td><td className="px-4 py-3">{formatMoney(p.amount,p.currency)}</td><td className="px-4 py-3">{p.payComponentCode??'—'}</td><td className="px-4 py-3"><Badge variant={p.status==='active'?'success':'default'}>{t(`status.${p.status}`)}</Badge></td><td className="px-4 py-3"><div className="flex flex-wrap gap-3"><a href={`${PAGE}/${p.id}`} className="text-primary hover:underline">{t('view')}</a><a href={`${PAGE}/${p.id}?edit=1`} className="text-primary hover:underline">{t('edit')}</a>{(p.rules?.v===3||p.rules?.v===4)&&p.status==='inactive'?<a href={`${PAGE}/${p.id}`} className="text-primary hover:underline">{v('reviewActivate')}</a>:<form action={setAllowanceStatusAction}><input type="hidden" name="id" value={p.id}/><input type="hidden" name="status" value={p.status==='active'?'inactive':'active'}/><button className="text-muted-foreground hover:underline">{p.status==='active'?t('deactivate'):t('activate')}</button></form>}<form action={archiveAllowancePolicyAction}><input type="hidden" name="id" value={p.id}/><ConfirmSubmit size="sm" variant="ghost" title={t('archive')} description={t('archiveWarning')} confirmLabel={t('archive')}>{t('archive')}</ConfirmSubmit></form></div></td></tr>)}
      </tbody></table></div>}
    </Card>
  </div>;
}
