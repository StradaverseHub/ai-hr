'use client';
import type {ReactNode} from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {X} from 'lucide-react';
import {useLocale,useTranslations} from 'next-intl';
import {Button} from '@/components/ui';
import {meritMatrixRows} from '@/packs/rewards/model';
import type {RewardPolicySummary} from '@/packs/rewards/service';

/** Read-only settings a review would start from (56595838). Shows policy inputs only; never people or pay. */
export function RewardPolicySummaryDialog({title,policy}:{title:string;policy:RewardPolicySummary}){
 const t=useTranslations('rewardsConfig.summary'),locale=useLocale();
 const pct=(bp:number)=>new Intl.NumberFormat(locale,{style:'percent',maximumFractionDigits:2}).format(bp/10000);
 const pools=(p:readonly number[])=>p.map(pct).join(' / ');
 const rows:[string,ReactNode][]=[
  [t('merit'),<ul key="m" className="space-y-0.5">{meritMatrixRows(policy.meritMatrix).map(([talent,values])=><li key={talent}><span className="font-medium">{talent}</span> {pools(values)}</li>)}</ul>],
  [t('standardPools'),pools(policy.standardPools)],
  [t('hPools'),pools(policy.hPools)],
  [t('bonusReference'),t('bonusByGrade',{count:Object.keys(policy.bonusMatrix).length})],
 ];
 return <Dialog.Root>
  <Dialog.Trigger asChild><Button type="button" variant="link" size="sm" className="h-auto p-0">{t('viewSettings')}</Button></Dialog.Trigger>
  <Dialog.Portal>
   <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50"/>
   <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-lg">
    <div className="flex items-start justify-between gap-3"><Dialog.Title className="text-base font-semibold">{title} <span className="ml-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{t('readOnly')}</span></Dialog.Title>
     <Dialog.Close asChild><Button type="button" variant="ghost" size="sm" aria-label={t('close')}><X aria-hidden className="size-4"/></Button></Dialog.Close></div>
    <Dialog.Description className="mt-1 text-sm text-muted-foreground">{t('help')}</Dialog.Description>
    <p className="mt-3 text-sm text-muted-foreground">{t('unitInputs')}</p><table className="mt-4 w-full text-sm"><thead className="text-left text-xs text-muted-foreground"><tr><th className="py-1 pr-3 font-medium">{t('setting')}</th><th className="py-1 font-medium">{t('value')}</th></tr></thead>
     <tbody className="divide-y divide-border">{rows.map(([label,value])=><tr key={label} className="align-top"><th scope="row" className="py-2 pr-3 text-left font-normal">{label}</th><td className="py-2 tabular-nums">{value}</td></tr>)}</tbody></table>
   </Dialog.Content>
  </Dialog.Portal>
 </Dialog.Root>;
}
