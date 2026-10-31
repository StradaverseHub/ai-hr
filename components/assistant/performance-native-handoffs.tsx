import 'server-only';
import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {getBrowserCommandSession} from '@/lib/session';
import {readPerformanceNativeHandoffs} from '@/core/assistant-actions/performance-native-handoffs';
/** Read-only, bounded handoff to the native human workflow; never submits a decision. */
export async function PerformanceNativeHandoffs(){
 try{
  const doors=await readPerformanceNativeHandoffs(await getBrowserCommandSession());
  if(!doors.length)return null;
  const t=await getTranslations('performanceArea'),actions=await getTranslations('assistant.workspace.performanceActions');
  return <section className="space-y-3"><h2 className="font-semibold">{actions('manual')}</h2><ul className="space-y-2">{doors.map(door=><li key={door.id}><Link href={door.href} className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t(door.labelKey)}</Link></li>)}</ul></section>;
 }catch{return null;}
}
