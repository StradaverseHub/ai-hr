import { PerformanceAdminAssistant } from './admin-assistant';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ErrorBanner, PageHeader } from '@/components/ui';
import type { getOnehrCycle } from '@/packs/performance/service';
import { adminCards, adminSectionHref } from '@/packs/performance/onehr/admin-sections';
import { adminCardRenderer, type ProgressQuery } from './admin-cards';
type View=NonNullable<Awaited<ReturnType<typeof getOnehrCycle>>>;
/**
 * The OneHR cycle page at /performance/[cycleId]: every card, whole, in the order it has always had (D8). D-P1-32
 * PT-X4 moved the cards into admin-cards.tsx so the admin area's tabs draw the same cards, each in one place
 * (packs/performance/onehr/admin-sections.ts); this page links into that area and changes nothing else.
 */
export async function OnehrCycleView({v,error,initialProgress}:{v:View;error?:string;initialProgress?:ProgressQuery}){
  const [t,ta,render]=await Promise.all([getTranslations('onehr'),getTranslations('performanceAdmin'),adminCardRenderer(v,{progress:initialProgress})]);const {cycle}=v;
  return <div className="mx-auto max-w-5xl space-y-6"><PageHeader back={{href:'/performance',label:t('back')}} title={cycle.name} description={t('nativeWorkflow')} actions={<Link href={adminSectionHref(cycle.id,'cycle')} className="text-sm text-primary hover:underline">{ta('title')} →</Link>}/><ErrorBanner message={error}/><PerformanceAdminAssistant key={cycle.id} cycleId={cycle.id}/>
    {adminCards.map(card=>render.card(card.id))}
  </div>;
}
