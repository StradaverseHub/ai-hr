import {readRememberedMfaPolicyEditor} from '@/core/remembered-mfa-policy';
import {RememberedMfaForm} from '@/app/admin/settings/login/remembered-mfa-form';
import {readSessionPolicyEditor} from '@/core/session-policy';
import {SessionPolicyForm} from '@/app/admin/settings/login/session-policy-form';
import {internalSelected} from '@/lib/internal-auth/config';
import {readPasswordPolicy} from '@/core/password-policy';
import {requireGroupAdministration} from '@/lib/security-center-authz';
import {getTranslations} from 'next-intl/server';
import {Card,pageWideCls} from '@/components/ui';
import {SecurityPageHeader} from '@/app/admin/users/security-page';
import {PasswordPolicyForm} from './policy-form';
export default async function PasswordPolicyPage(){
 const session=await requireGroupAdministration(),state=await readPasswordPolicy(session),t=await getTranslations('passwordPolicy');
 const rememberedMfa=internalSelected()?await readRememberedMfaPolicyEditor(session):null;
 // ADR-0171 (amended 10 November 2026): Automatic sign-out lives here beside the other sign-in security settings.
 // Same owner (core/session-policy), same saved row and same group-administrator authority as before.
 const sessionPolicy=internalSelected()?await readSessionPolicyEditor(session):null;
 return <div className={pageWideCls}><SecurityPageHeader title={t('title')}/><Card className="mt-6 p-6"><PasswordPolicyForm {...state}/></Card>{rememberedMfa&&<Card className="mt-6 p-6"><RememberedMfaForm {...rememberedMfa}/></Card>}{sessionPolicy&&<Card className="mt-6 p-6"><SessionPolicyForm idleTimeoutMinutes={sessionPolicy.idleTimeoutMinutes} revision={sessionPolicy.revision}/></Card>}</div>;
}
