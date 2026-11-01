import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { sql } from 'drizzle-orm';
import { withTenant } from '@/db/client';
import { scopedAdmin } from '@/lib/scope';
import { connector, requireEntraAdmin } from '@/lib/entra/store';
import { PageHeader, Card, CardHeader, CardTitle, CardContent, Field, inputCls, btnPrimary, btnGhost } from '@/components/ui';
import { saveEntra, testEntra, bindEntra, retryEntra } from './actions';
export default async function EntraPage({searchParams}:{searchParams:Promise<{error?:string;saved?:string;tested?:string;linked?:string}>}) {
  const {s:ctx}=await scopedAdmin();await requireEntraAdmin(ctx);
  const t=await getTranslations('entra'),config=await connector(ctx.tenantId),query=await searchParams;
  const records=await withTenant(ctx,async tx=>await tx.execute(sql`select * from app.entra_status()`) as unknown as {person_id:string;status:string;object_id:string|null;attempts:number}[]);
  const identifiers=['organization','directoryTenantId','clientId','provisioningClientId','servicePrincipalId','jobId','domain','sourceAnchorAttribute'] as const;
  return <div className="space-y-6" lang="en">
    <PageHeader title={t('title')} description={t('description')}/>
    <Link href="/admin/users" className="text-sm underline">{t('manageUsers')}</Link>
    {query.error&&<p role="alert" className="text-sm text-destructive">{t('error')}</p>}
    {(query.saved||query.tested||query.linked)&&<p role="status" className="text-sm">{t(query.tested?'tested':query.linked?'linked':'saved')}</p>}
    <Card><CardHeader><CardTitle>{t('connection')}</CardTitle></CardHeader><CardContent>
      <form action={saveEntra} className="space-y-5">
        <input type="hidden" name="revision" value={config?.revision||''}/>
        <div className="grid gap-4 sm:grid-cols-2">
          {identifiers.map(key=><Field key={key} label={t(key)}><input name={key} className={inputCls} required defaultValue={config?.[key]||''} maxLength={key==='jobId'?200:253}/></Field>)}
          <Field label={t('mode')}><select name="mode" className={inputCls} defaultValue={config?.mode||'cloud'}><option value="cloud">{t('cloud')}</option><option value="hybrid">{t('hybrid')}</option></select></Field>
          <Field label={t('clientSecret')}><input type="password" name="clientSecret" className={inputCls} required={!config} autoComplete="new-password" maxLength={4096}/></Field>
          <Field label={t('provisioningSecret')}><input type="password" name="provisioningClientSecret" className={inputCls} required={!config} autoComplete="new-password" maxLength={4096}/></Field>
        </div>
        <p className="text-sm text-muted-foreground">{t('secretHelp')}</p>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="enabled" defaultChecked={config?.enabled}/>{t('enabled')}</label>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="provisioningEnabled" defaultChecked={config?.provisioningEnabled}/>{t('provisioningEnabled')}</label>
        <label className="flex items-start gap-2 text-sm"><input required type="checkbox" name="immutableMatchingConfirmed" defaultChecked={config?.immutableMatchingConfirmed}/>{t('matching')}</label>
        <p className="text-sm text-muted-foreground">{t('hybridHelp')}</p>
        <button className={btnPrimary}>{t('save')}</button>
      </form>
      {config&&<form action={testEntra} className="mt-4"><button className={btnGhost}>{t('test')}</button></form>}
    </CardContent></Card>
    <Card><CardHeader><CardTitle>{t('linkTitle')}</CardTitle></CardHeader><CardContent>
      <p className="mb-4 text-sm text-muted-foreground">{t('linkHelp')}</p>
      <form action={bindEntra} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">{['personId','userId','objectId'].map(key=><Field label={t(key)} key={key}><input className={inputCls} name={key} required minLength={36} maxLength={36}/></Field>)}</div>
        <label className="flex items-start gap-2 text-sm"><input required type="checkbox" name="confirmed"/>{t('linkConfirm')}</label>
        <button className={btnPrimary}>{t('link')}</button>
      </form>
    </CardContent></Card>
    <Card><CardHeader><CardTitle>{t('queue')}</CardTitle></CardHeader><CardContent>
      {!records.length?<p className="text-sm text-muted-foreground">{t('empty')}</p>:<div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th className="p-3">{t('personId')}</th><th className="p-3">{t('status')}</th><th className="p-3">{t('attempts')}</th><th className="p-3">{t('action')}</th></tr></thead><tbody>{records.map(row=><tr className="border-t border-border" key={row.person_id}><td className="break-all p-3">{row.person_id}</td><td className="p-3">{t(`states.${row.status}`)}</td><td className="p-3 tabular-nums">{row.attempts}</td><td className="p-3">{row.status==='failed'&&<form action={retryEntra}><input type="hidden" name="personId" value={row.person_id}/><button className={btnGhost}>{t('retry')}</button></form>}</td></tr>)}</tbody></table></div>}
      <p className="mt-4 text-sm text-muted-foreground">{t('queueHelp')}</p>
    </CardContent></Card>
  </div>;
}
