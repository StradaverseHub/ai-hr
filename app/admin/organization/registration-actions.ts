'use server';
import {redirect} from 'next/navigation';
import {getTranslations} from 'next-intl/server';
import {scopedAdmin} from '@/lib/scope';
import {changeCompanyRegistrationClassification} from '@/core/company-registration-readiness';
export async function saveRegistrationClassification(fd:FormData){
 const{s}=await scopedAdmin(),id=String(fd.get('companyId')??'');let failed=false;
 try{await changeCompanyRegistrationClassification(s,{companyId:id,entityKind:String(fd.get('entityKind')??''),isTestEntity:fd.get('isTestEntity')==='true',expectedRevision:Number(fd.get('expectedRevision'))});}catch{failed=true;}
 const t=await getTranslations('admin.organization');
 redirect(`/admin/organization/${encodeURIComponent(id)}?${failed?'error='+encodeURIComponent(t('registration.saveFailed')):'classificationSaved=1'}`);
}
