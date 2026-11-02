import {notFound} from 'next/navigation';
import {settingsAccess} from '@/core/organisation-access';
import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {requireAdmin} from '@/lib/authz';
import {PageHeader,ErrorBanner,pageWideCls} from '@/components/ui';
import {ProfileRoutingSetup} from '../routing-setup';
export default async function ProfileApprovalRulesPage({searchParams}:{searchParams:Promise<{error?:string}>}){
 const s=await requireAdmin();
 if(!await settingsAccess(s,'view','profileApprovalRules'))notFound();
 const t=await getTranslations('essProfile'),sp=await searchParams;
 return <div className={pageWideCls}><PageHeader title={t('approvalRules')} description={t('anyApprover')}/><Link href="/admin/settings/profile-requests" className="text-sm text-primary underline">{t('backToFieldPermissions')}</Link><ErrorBanner message={sp.error}/><ProfileRoutingSetup session={s}/></div>;
}
