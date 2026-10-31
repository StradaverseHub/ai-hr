import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {ArrowRight,BookOpen,Mail,ShieldCheck,UserRoundPlus,Users} from 'lucide-react';
import {Card,PageHeader} from '@/components/ui';
import {requireSecurityCenter} from '@/lib/security-center-authz';
import {SECURITY_PAGES,securityDestinationAllowed} from '@/lib/security-center-navigation';
const icons={permissions:ShieldCheck,functions:BookOpen,create:UserRoundPlus,invite:Mail,users:Users};
export default async function SecurityCenterPage(){
 const {access}=await requireSecurityCenter(),t=await getTranslations('securityCenter');
 return <div className="mx-auto max-w-5xl space-y-6"><PageHeader title={t('title')}/><p className="text-sm text-muted-foreground">{t('description')}</p>
  <div className="grid gap-4 sm:grid-cols-2">{SECURITY_PAGES.filter(page=>securityDestinationAllowed(page.href,access)).map(page=>{
   const Icon=icons[page.key];
   return <Card key={page.href}><Link href={page.href} className="group flex h-full items-start gap-4 rounded-lg p-5 outline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"><Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground"/><div className="min-w-0 flex-1"><h2 className="font-medium group-hover:underline">{t(`${page.key}.title`)}</h2><p className="mt-1 text-sm leading-relaxed text-muted-foreground">{t(`${page.key}.description`)}</p></div><ArrowRight className="mt-1 size-4 shrink-0 text-muted-foreground"/></Link></Card>;
  })}</div>
 </div>;
}
