import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {PageHeader,btnGhost} from '@/components/ui';
import {SECURITY_CENTER} from '@/lib/security-center-navigation';
export async function SecurityBackLink(){const t=await getTranslations('securityCenter');return <Link href={SECURITY_CENTER} className={btnGhost}>← {t('back')}</Link>;}
export async function SecurityPageHeader({title,actions}:{title:string;actions?:React.ReactNode}){
 const t=await getTranslations('securityCenter');
 return <><Link href={SECURITY_CENTER} className={btnGhost}>← {t('back')}</Link><PageHeader title={title} actions={actions}/></>;
}
