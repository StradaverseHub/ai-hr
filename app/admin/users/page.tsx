import {getTranslations} from 'next-intl/server';
import {redirect} from 'next/navigation';
import Link from 'next/link';
import {requireAdmin,isGroupAdmin} from '@/lib/authz';
import {ErrorBanner,btnGhost} from '@/components/ui';
import {manualIdentityErrorCodes} from '@/lib/identity/manual-model';
import {loadUsersData} from './data';
import {UsersDirectory} from './users-directory';
import {SecurityPageHeader} from './security-page';
import {LegacySecurityNavigation} from './legacy-navigation';
export default async function UsersPage({searchParams}:{searchParams:Promise<{error?:string;archived?:string;manualError?:string;manualSuccess?:string;activate?:string}>}){
 const s=await requireAdmin(),params=await searchParams,t=await getTranslations('admin.users'),center=await getTranslations('securityCenter');
 const legacy=new URLSearchParams();
 if(manualIdentityErrorCodes.some(code=>code===params.manualError))legacy.set('manualError',params.manualError!);
 if(['created','cancelled'].includes(params.manualSuccess??''))legacy.set('manualSuccess',params.manualSuccess!);
 if(legacy.size)redirect(`/admin/users/create?${legacy}`);
 const {rows,groupAdmin,companies,roleOptions,assistantGranted}=await loadUsersData(s);
 const target=params.activate&&/^[0-9a-f-]{36}$/i.test(params.activate)?`?activate=${encodeURIComponent(params.activate)}`:'';
 return <div className="mx-auto max-w-5xl space-y-6">
  <SecurityPageHeader title={center('users.title')} actions={<span className="text-sm text-muted-foreground">{t('userCount',{count:rows.length})}</span>}/>
  {params.error&&<div role="alert"><ErrorBanner message={params.error}/></div>}
  <div data-tour="admin-provisioning" className="rounded-lg border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">{t.rich('provisioningNote',{strong:chunks=><span className="font-medium">{chunks}</span>,em:chunks=><em>{chunks}</em>})}</div>
  {isGroupAdmin(s)&&<><LegacySecurityNavigation/><noscript><p>{center('legacyHelp')}</p><Link href={`/admin/users/create${target}`} className={btnGhost}>{center('create.title')}</Link><Link href={`/admin/users/invite${target}`} className={btnGhost}>{center('invite.title')}</Link></noscript></>}
  <UsersDirectory rows={rows} groupAdmin={groupAdmin} includeArchived={params.archived==='1'} companies={companies} roleOptions={[...roleOptions]} assistantGrantedIds={rows.flatMap(row=>row.appUserId&&assistantGranted.has(row.appUserId)?[row.appUserId]:[])}/>
 </div>;
}
