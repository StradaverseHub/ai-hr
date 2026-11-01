'use server';
import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { scopedAdmin } from '@/lib/scope';
import { withTenant } from '@/db/client';
import { connector, requireEntraAdmin, saveConnector } from '@/lib/entra/store';
import { graphToken } from '@/lib/entra/graph';
import { oidcConfiguration } from '@/lib/entra/login';
import { entraConfigSchema } from '@/lib/entra/model';
async function context(){const {s:ctx}=await scopedAdmin();await requireEntraAdmin(ctx);return ctx;}
export async function saveEntra(form:FormData) {
  const ctx=await context();
  let failed=false;
  try{
    const current=await connector(ctx.tenantId), get=(key:string)=>String(form.get(key)||'').trim();
    const value=entraConfigSchema.parse({tenantId:ctx.tenantId,organization:get('organization'),directoryTenantId:get('directoryTenantId').toLowerCase(),clientId:get('clientId'),clientSecret:get('clientSecret')||current?.clientSecret||'',
      provisioningClientId:get('provisioningClientId'),provisioningClientSecret:get('provisioningClientSecret')||current?.provisioningClientSecret||'',servicePrincipalId:get('servicePrincipalId'),jobId:get('jobId'),
      sourceAnchorAttribute:get('sourceAnchorAttribute'),mode:get('mode'),domain:get('domain'),enabled:form.get('enabled')==='on',provisioningEnabled:form.get('provisioningEnabled')==='on',immutableMatchingConfirmed:form.get('immutableMatchingConfirmed')==='on',revision:randomUUID()});
    await saveConnector(ctx,value,get('revision')||null);
  }catch{failed=true;}
  redirect('/admin/settings/entra?'+(failed?'error=1':'saved=1'));
}
export async function testEntra() {
  const ctx=await context();let failed=false;
  try{const config=await connector(ctx.tenantId);if(!config||(!config.enabled&&!config.provisioningEnabled))throw Error();if(config.enabled)await oidcConfiguration(config);if(config.provisioningEnabled)await graphToken(config);}catch{failed=true;}
  redirect('/admin/settings/entra?'+(failed?'error=1':'tested=1'));
}
export async function bindEntra(form:FormData) {
  const ctx=await context();let failed=false;
  try{
    const {z}=await import('zod');const target=String(form.get('target')||'').split(':');const person=z.uuid().parse(target[0]),user=z.uuid().parse(target[1]),object=z.uuid().parse(form.get('objectId')).toLowerCase();
    if(form.get('confirmed')!=='on')throw Error();
    await withTenant(ctx,tx=>tx.execute(sql`select app.entra_bind(${person}::uuid,${user}::uuid,${object}::uuid)`));
  }catch{failed=true;}
  redirect('/admin/settings/entra?'+(failed?'error=1':'linked=1'));
}
export async function retryEntra(form:FormData) {
  const ctx=await context();let failed=false;
  try{const {z}=await import('zod');const person=z.uuid().parse(form.get('personId'));await withTenant(ctx,tx=>tx.execute(sql`select app.entra_retry(${person}::uuid)`));}catch{failed=true;}
  redirect('/admin/settings/entra?'+(failed?'error=1':'saved=1'));
}

export async function reconcileEntra(form:FormData) {
  const ctx=await context();let failed=false;
  try{
    const {z}=await import('zod');const person=z.uuid().parse(form.get('personId'));
    if(form.get('confirmed')!=='on')throw Error();
    const {todayInKualaLumpur}=await import('@/lib/hr-date');
    await withTenant(ctx,tx=>tx.execute(sql`select app.entra_reconcile_hold(${person}::uuid,${todayInKualaLumpur()}::date)`));
  }catch{failed=true;}
  redirect('/admin/settings/entra?'+(failed?'error=1':'saved=1'));
}
