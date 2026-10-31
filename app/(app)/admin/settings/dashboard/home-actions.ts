'use server';

import {getSession} from '@/lib/session';
import {getTranslations} from 'next-intl/server';
import {AuthRequiredError} from '@/lib/auth-errors';
import {HomeConfigurationError} from '@/lib/employee-home';
import {parseEmployeeHomeConfigurationForm} from '@/lib/employee-home-configuration-form';
import {saveEmployeeHomeConfiguration,HomeConfigurationAccessError,HomeConfigurationChangedError} from '@/core/employee-home-configuration';

export type HomeConfigurationSaveState={error:string|null;destination?:string};
export async function saveHomeConfigurationAction(_state:HomeConfigurationSaveState,data:FormData):Promise<HomeConfigurationSaveState>{
 const t=await getTranslations('employeeHome.configuration');
 let context:{companyId:string;audienceRole:string};
 try{
  const session=await getSession(),parsed=parseEmployeeHomeConfigurationForm(data);
  await saveEmployeeHomeConfiguration(session,parsed);
  context={companyId:parsed.companyId,audienceRole:parsed.audienceRole};
 }catch(error){
  return {error:t(error instanceof HomeConfigurationError?'invalid':error instanceof HomeConfigurationChangedError?'changed':
   error instanceof HomeConfigurationAccessError||error instanceof AuthRequiredError?'forbidden':'failed')};
 }
 const query=new URLSearchParams({section:'content',homeCompanyId:context.companyId,homeRole:context.audienceRole,toast:t('saved')});
 // The client navigates only after receiving this confirmed result. All configuration reads are
 // direct, uncached transactions; navigating reloads the chosen version without resetting a refused draft.
 return {error:null,destination:'/admin/settings/dashboard?'+query};
}
