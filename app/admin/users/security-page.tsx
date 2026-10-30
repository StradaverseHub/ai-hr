import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {PageHeader} from '@/components/ui';
import {SECURITY_CENTER} from '@/lib/security-center-navigation';
export async function SecurityBackLink(){const t=await getTranslations('securityCenter');return <Link href={SECURITY_CENTER} className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground">← {t('back')}</Link>;}
export async function SecurityPageHeader({title,actions}:{title:string;actions?:React.ReactNode}){
 const t=await getTranslations('securityCenter');
 return <PageHeader title={title} actions={actions} back={{href:SECURITY_CENTER,label:t('back')}}/>;
}
