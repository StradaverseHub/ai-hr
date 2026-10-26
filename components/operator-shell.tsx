'use client';
import {useEffect,useState,type ReactNode} from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { usePathname } from 'next/navigation';
import { BookOpen, Building2, UserRoundPlus } from 'lucide-react';
import { LanguageSwitcher } from './language-switcher';
import { ThemeToggle } from './theme-toggle';
import { LogoutButton } from './logout-button';

/** An installation workspace has its own destinations and no employee/company controls. */
export function OperatorShell({children,name}:{children:ReactNode;name:string|null}) {
  const t=useTranslations('operatorWorkspace');
  const common=useTranslations('common');
  const pathname=usePathname();
  const [hash,setHash]=useState('');
  useEffect(()=>{const update=()=>setHash(window.location.hash);update();window.addEventListener('hashchange',update);return()=>window.removeEventListener('hashchange',update);},[pathname]);
  const links=[{href:'/operator',label:t('customers'),Icon:Building2},
    {href:'/operator#new-customer',label:t('provisioning'),Icon:UserRoundPlus},
    {href:'/operator#operator-knowledge-base',label:t('guide'),Icon:BookOpen}];
  return <div data-operator-shell className="flex h-dvh min-w-0 flex-col bg-canvas sm:flex-row">
    <aside className="shrink-0 border-b border-border bg-card sm:w-56 sm:border-r sm:border-b-0">
      <Link href="/operator" className="block px-5 pt-5 pb-3 text-lg font-semibold tracking-tight">{common('appName')}</Link>
      <p className="px-5 pb-4 text-sm text-muted-foreground">{t('workspace')}</p>
      <nav aria-label={t('workspace')} className="flex gap-1 overflow-x-auto px-2 pb-2 sm:flex-col sm:px-3">
        {links.map(({href,label,Icon},i)=><Link key={href} href={href} onClick={()=>setHash(href.includes('#')?'#'+href.split('#')[1]:'')}
          aria-current={(i===0?(!hash||pathname!=='/operator'):href.endsWith(hash)&&!!hash)?'page':undefined}
          className="flex min-h-11 shrink-0 items-center gap-2 rounded-lg px-3 text-sm font-medium hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring">
          <Icon className="size-4 shrink-0" aria-hidden="true"/>{label}
        </Link>)}
      </nav>
    </aside>
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex min-h-16 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-card px-4 sm:px-6">
        <span className="min-w-0 truncate text-sm font-medium">{name??t('workspace')}</span>
        <div className="flex shrink-0 items-center gap-1"><LanguageSwitcher/><ThemeToggle/><LogoutButton/></div>
      </header>
      <main className="relative min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">{children}</main>
    </div>
  </div>;
}
