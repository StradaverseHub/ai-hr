import Link from 'next/link';
import {useTranslations} from 'next-intl';
import type {RewardFlag} from '@/packs/rewards/model';
import {Card} from '@/components/ui';
export function FlagsPanel({unitId,flags,filtered}:{unitId:string;flags:readonly RewardFlag[];filtered:boolean}){
 const t=useTranslations('rewards');
 // The engine reuses CFG-01 for both exempted salary-pool and bonus-pool overruns.
 // Its fixed native message distinguishes these two budget checks until they gain separate codes.
 const section=(flag:RewardFlag)=>flag.code==='CFG-01'?(/\bbonus\b/i.test(flag.message)?'bonus':'salary-increase'):flag.code.startsWith('SAL')||flag.code.startsWith('POOL')?'salary-increase':flag.code.startsWith('BUD')?'bonus':'people';
 return <aside className="min-w-0 xl:sticky xl:top-4 xl:self-start" aria-label={t('desk.flags')}><Card id="checks" className="scroll-mt-6 p-4"><h2 className="font-semibold">{t('desk.flags')} ({flags.length})</h2>{filtered&&<Link href={`/rewards/${unitId}#checks`} className="mt-2 inline-block text-sm text-primary hover:underline">{t('showAllChecks')}</Link>}{!flags.length&&<p className="mt-3 text-sm text-muted-foreground">{t('noChecks')}</p>}<ul className="mt-3 divide-y divide-border">{flags.map((flag,index)=><li key={index} className="py-3"><Link href={flag.entryId?`/rewards/${unitId}/people/${flag.entryId}`:`#${section(flag)}`} className="block space-y-2 text-sm hover:underline"><span className={`inline-block rounded-full px-2 py-1 text-xs font-semibold ${flag.severity==='block'?'bg-destructive/10 text-destructive':flag.severity==='warning'||flag.severity==='exception'?'bg-amber-100 text-amber-950 dark:bg-amber-950 dark:text-amber-100':'bg-muted text-muted-foreground'}`}>{t(`severity.${flag.severity}`)}</span><span className="block leading-6">{flag.message}</span></Link></li>)}</ul></Card></aside>;
}
