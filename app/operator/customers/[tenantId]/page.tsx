import Link from 'next/link';
import { HR_LOCAL_TZ } from '@/lib/hr-date';
import { notFound,redirect } from 'next/navigation';
import { getTranslations,getLocale } from 'next-intl/server';
import { getSession } from '@/lib/session';
import { isOperator } from '@/lib/authz-model';
import { isDemoDeployment } from '@/lib/demo-mode';
import { listOperatorCustomers } from '@/core/operator-customers';
import { readOperatorMobileSetup } from '@/core/operator-mobile-setup';
import { toDataURL } from 'qrcode';
import { MODULE_CATALOG } from '@/packs/catalog';
import { Card, PageHeader,SectionHeader } from '@/components/ui';
import { Badge } from '@/components/ui/badge';
import { AutoRefresh } from '../../auto-refresh';
import { CustomerNameForm,CustomerModuleForm } from '../../customer-forms';
import { OperatorMobileSetupPanel, type OperatorMobileSetupView } from '../../mobile-setup-panel';

export default async function CustomerPage({params}:{params:Promise<{tenantId:string}>}) {
  const session=await getSession();
  if(!isOperator(session)||isDemoDeployment())redirect('/');
  const {tenantId}=await params;
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId))notFound();
  const [customer]=await listOperatorCustomers(session,tenantId);
  if(!customer)notFound();
  const w=await getTranslations('operatorWorkspace'),o=await getTranslations('operator');
  const locale=await getLocale();
  const date=new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'short',timeZone:HR_LOCAL_TZ});
  const optional=MODULE_CATALOG.filter(m=>!m.isCore).sort((a,b)=>a.sortOrder-b.sortOrder);
  const busy=customer.changes.some(c=>['pending','running'].includes(c.status));
  // ADR-0161 — status only; the runner signs. The link and QR appear only for a setup that re-verified.
  // A failed status read hides this one panel rather than the customer's module management.
  const setup=await readOperatorMobileSetup(session,tenantId).catch(error=>{console.error('Mobile setup status unavailable.',error instanceof Error?error.name:'');return null;});
  const when=(iso:string|null)=>iso?`${date.format(new Date(iso))} MYT`:null;
  const day=new Intl.DateTimeFormat(locale,{dateStyle:'long',timeZone:HR_LOCAL_TZ});
  const mobile:OperatorMobileSetupView|null=setup&&{
    signs:setup.signs,state:setup.state,reason:setup.reason,keyId:setup.keyId,expires:setup.expiresAt?day.format(new Date(setup.expiresAt*1000)):null,
    expiresSoon:setup.expiresSoon,origin:setup.origin,organization:setup.organization,recorded:when(setup.recordedAt),
    failure:setup.failure&&{reason:setup.failure.reason,at:when(setup.failure.at)!},link:setup.link,
    qr:setup.link?await toDataURL(setup.link,{errorCorrectionLevel:'M',margin:4,width:384}).catch(()=>null):null,pending:setup.pending,
    requests:setup.requests.map(r=>({id:r.id,action:r.action,status:r.status,error:r.error,created:when(r.createdAt)!})),
  };
  return <div className="mx-auto max-w-5xl space-y-6">
    {(busy||mobile?.pending)&&<AutoRefresh/>}<Link href="/operator" className="text-sm text-primary underline underline-offset-4">{w('back')}</Link>
    <div className="flex flex-wrap items-start justify-between gap-3"><PageHeader title={customer.customer_name} description={w('customerDescription')}/><Badge variant={customer.customer_status==='suspended'?'warning':'default'}>{w.has(customer.customer_status)?w(customer.customer_status):customer.customer_status}</Badge></div>
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
      <section className="space-y-5"><Card className="space-y-4 p-5">
        <dl className="space-y-4 text-sm"><div><dt className="text-muted-foreground">{w('organizationCode')}</dt><dd className="mt-1 font-medium">{customer.organizationCode??w('codeUnavailable')}</dd></div>
          <div><dt className="text-muted-foreground">{o('adminEmail')}</dt><dd className="mt-1 break-all">{customer.admin_email??'—'}</dd></div></dl>
        <p className="text-xs text-muted-foreground">{w('codeFixed')}</p><CustomerNameForm tenantId={tenantId} name={customer.customer_name}/>
      </Card></section>
      <section className="space-y-5"><Card className="space-y-4 p-5"><SectionHeader title={w('modules')}/>
        <ul className="divide-y divide-border">{optional.map(m=>{
          const rows=customer.modules.filter(g=>g.code===m.code);
          const enabled=rows.some(g=>['active','trial'].includes(g.status));
          return <li key={m.code} className="flex items-center justify-between gap-3 py-2.5 text-sm"><span>{m.name}</span><span className="flex flex-wrap items-center justify-end gap-2">{rows.some(g=>g.companyId!==null)&&<span className="text-xs text-muted-foreground">{w('companySpecific')}</span>}<Badge variant={enabled?'success':'default'}>{rows.some(g=>g.status==='trial')?w('trial'):enabled?w('active'):rows.some(g=>g.status==='expired')?w('expired'):w('disabled')}</Badge></span></li>;
        })}</ul><p className="text-xs text-muted-foreground">{w('coreIncluded',{modules:MODULE_CATALOG.filter(m=>m.isCore).map(m=>m.name).join(', ')})}</p>
      </Card><Card className="space-y-4 p-5"><SectionHeader title={w('manageModules')}/>
        <CustomerModuleForm tenantId={tenantId} modules={optional} grants={customer.modules} blockers={customer.blockers} busy={busy}/>
      </Card></section>
    </div>
    {mobile&&<OperatorMobileSetupPanel tenantId={tenantId} view={mobile}/>}
    <Card className="p-5"><SectionHeader title={w('changeHistory')}/>
      {customer.changes.length===0?<p className="mt-3 text-sm text-muted-foreground">{w('noChanges')}</p>:<ul className="mt-3 divide-y divide-border">{customer.changes.map(c=><li key={c.id} className="space-y-1 py-3">
        <div className="flex flex-wrap justify-between gap-2 text-sm"><span className="font-medium">{c.action==='activate'?w('enable'):w('disable')} · {MODULE_CATALOG.find(m=>m.code===c.module_code)?.name??c.module_code}</span><Badge variant={c.status==='failed'?'danger':c.status==='done'?'success':'warning'}>{o(`status.${c.status}`)}</Badge></div>
        <p className="text-xs text-muted-foreground"><time dateTime={new Date(c.created_at).toISOString()}>{date.format(new Date(c.created_at))} MYT</time></p>{c.error&&<p role="alert" className="text-sm text-destructive">{c.error}</p>}
      </li>)}</ul>}
    </Card>
  </div>;
}
