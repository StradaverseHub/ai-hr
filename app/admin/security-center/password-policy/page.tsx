import {readPasswordPolicy} from '@/core/password-policy';
import {requireGroupAdministration} from '@/lib/security-center-authz';
import {getTranslations} from 'next-intl/server';
import {Card,pageWideCls} from '@/components/ui';
import {SecurityPageHeader} from '@/app/admin/users/security-page';
import {PasswordPolicyForm} from './policy-form';
export default async function PasswordPolicyPage(){
 const session=await requireGroupAdministration(),state=await readPasswordPolicy(session),t=await getTranslations('passwordPolicy');
 return <div className={pageWideCls}><SecurityPageHeader title={t('title')}/><Card className="mt-6 p-6"><PasswordPolicyForm {...state}/></Card></div>;
}
