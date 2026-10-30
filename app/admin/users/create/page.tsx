import {getTranslations} from 'next-intl/server';
import {requireGroupAdministration} from '@/lib/security-center-authz';
import {internalSelected} from '@/lib/internal-auth/config';
import {keycloakSelected} from '@/lib/identity/config';
import {manualIdentityErrorCodes} from '@/lib/identity/manual-model';
import {ErrorBanner} from '@/components/ui';
import {loadUsersData,ROLES} from '../data';
import {ManualAccountSetup} from '../manual-setup';
import {SecurityPageHeader} from '../security-page';
export default async function CreateLoginPage({searchParams}:{searchParams:Promise<{activate?:string;manualError?:string;manualSuccess?:string}>}){
 const s=await requireGroupAdministration(),params=await searchParams,t=await getTranslations('admin.users'),center=await getTranslations('securityCenter');
 const {peopleOptions,companies,manualEnrollments,pendingEmployees}=await loadUsersData(s);
 const error=manualIdentityErrorCodes.find(code=>code===params.manualError);
 return <div className="mx-auto max-w-5xl space-y-6"><SecurityPageHeader title={center('create.title')}/>
  <ErrorBanner message={error?t(`manual.errors.${error}`):undefined}/>
  {['created','cancelled'].includes(params.manualSuccess??'')&&<p role="status" className="rounded-lg border border-border p-4 text-sm">{t(`manual.success.${params.manualSuccess as 'created'|'cancelled'}`)}</p>}
  <ManualAccountSetup available={keycloakSelected()||internalSelected()} people={peopleOptions} companies={companies} roles={ROLES.map(value=>({value,label:t(`role.${value}`)}))} pending={manualEnrollments} selectedPerson={pendingEmployees.find(p=>p.id===params.activate)}/>
 </div>;
}
