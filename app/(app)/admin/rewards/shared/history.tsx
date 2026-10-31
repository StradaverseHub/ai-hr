import Link from 'next/link';
import {getLocale,getTranslations} from 'next-intl/server';
import {Card,Button} from '@/components/ui';
import type {SessionContext} from '@/db/client';
import {rewardPolicyHistory,rewardPolicyHiddenCount,type RewardPolicyHistory} from '@/packs/rewards/service';
import type {RewardPolicyGroupVersion} from '@/packs/rewards/policy-group-model';
import {diffRewardPolicyVersions} from '@/packs/rewards/policy-version-diff';
import {RewardPolicyFields} from '@/app/(app)/rewards/[unitId]/policy-form';
type Props={session:SessionContext;groups:RewardPolicyGroupVersion[];groupId?:string;showVersions?:string;versionId?:string;compare?:string|string[];companies:readonly{id:string;name:string}[];units:readonly{id:string;name:string}[]};
const status=(row:RewardPolicyHistory)=>!row.version.targets.length?'archived':row.locked?'locked':'active';
export async function SharedRewardHistory({session,groups,groupId,showVersions,versionId,compare,companies,units}:Props){
 const t=await getTranslations('rewards.sharedGovernance'),locale=await getLocale();
 const [histories,hidden]=await Promise.all([Promise.all(groups.map(group=>rewardPolicyHistory(session,group.groupId))),rewardPolicyHiddenCount(session)]);
 const current=histories.flatMap(rows=>rows.filter(row=>row.current)),history=groupId?histories[groups.findIndex(group=>group.groupId===groupId)]??[]:[];
 const chosen=history.find(row=>row.version.versionId===versionId),compareIds=typeof compare==='string'?compare.split(','):compare??[];
 const sides=compareIds.length===2?compareIds.map(id=>history.find(row=>row.version.versionId===id)):[];
 const pairLabel=(pair:{companyId:string;businessUnitId:string})=>`${companies.find(c=>c.id===pair.companyId)?.name??t('unavailable')} · ${units.find(u=>u.id===pair.businessUnitId)?.name??t('unavailable')}`;
 const coverage=(v:RewardPolicyGroupVersion)=>t('coverage',{companies:new Set(v.targets.map(row=>row.companyId)).size,units:v.targets.length});
 const date=(iso:string)=>new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeZone:'Asia/Kuala_Lumpur'}).format(new Date(iso));
 function format(key:string,value:unknown):string{
  if(value===null||value===undefined||value==='')return t('notSet');
  if(Array.isArray(value))return value.map(item=>format(key,item)).join(' / ');
  if(typeof value==='object')return Object.entries(value).map(([label,item])=>`${label}: ${format(key,item)}`).join('\n');
  if(typeof value!=='number')return String(value);
  if(['standardPools','hPools','meritMatrix','lumpShareBp'].includes(key))return new Intl.NumberFormat(locale,{style:'percent',maximumFractionDigits:2}).format(value/10000);
  if(['ranges','patActual','patTarget','lumpStepCents','lumpCapCents','lumpUnitCents'].includes(key))return new Intl.NumberFormat(locale,{style:'currency',currency:'MYR'}).format(value/100);
  return new Intl.NumberFormat(locale,{maximumFractionDigits:4}).format(['bonusMatrix','targetMonthsBp','multiplierBp','branchFactors'].includes(key)?value/10000:value);
 }
 return <>
  <Card className="space-y-3 p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">{t('configurations')}</h2><Link href="/admin/rewards/shared" className="text-sm font-medium text-primary hover:underline">{t('newConfiguration')}</Link></div>
   {current.length?<div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr>{(['name','year','version','status','covers','lastSaved','reviews'] as const).map(key=><th key={key} className="whitespace-nowrap p-2 text-left font-medium">{t(key)}</th>)}</tr></thead><tbody className="divide-y">{current.map(row=><tr key={row.version.groupId} className="align-top"><td className="p-2"><Link href={`/admin/rewards/shared?group=${row.version.groupId}`} className="font-medium text-primary hover:underline">{row.version.name}</Link><div><Link href={`/admin/rewards/shared?group=${row.version.groupId}&versions=1`} className="text-xs text-primary hover:underline">{t('versions')}</Link></div></td><td className="p-2">{row.version.policy.year}</td><td className="p-2">{row.version.revision}</td><td className="p-2">{t(status(row))}</td><td className="p-2">{coverage(row.version)}</td><td className="p-2">{row.savedBy??t('unknownActor')}<div className="text-xs text-muted-foreground">{date(row.savedAt)}</div></td><td className="p-2"><Link href={`/admin/rewards/shared?group=${row.version.groupId}#configuration-usage`} className="text-primary hover:underline">{row.usageCount}</Link></td></tr>)}</tbody></table></div>:<p className="text-sm text-muted-foreground">{hidden?t('hiddenConfigurations',{count:hidden}):t('noneSaved')}</p>}
   <p className="text-sm text-muted-foreground">{t('lockedHelp')}</p>
  </Card>
  {groupId&&(showVersions||versionId||compareIds.length>0)&&<Card className="space-y-4 p-4"><h2 className="font-semibold">{t('versions')}</h2>
   <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr>{(['version','lastSaved','covers','status','reviews','view'] as const).map(key=><th key={key} className="p-2 text-left">{t(key)}</th>)}</tr></thead><tbody className="divide-y">{history.map(row=><tr key={row.version.versionId}><td className="p-2">{row.version.revision}{row.current&&<> · {t('current')}</>}</td><td className="p-2">{row.savedBy??t('unknownActor')} · {date(row.savedAt)}</td><td className="p-2">{coverage(row.version)}</td><td className="p-2">{t(status(row))}</td><td className="p-2"><Link href={`/admin/rewards/shared?group=${groupId}&version=${row.version.versionId}#configuration-usage`} className="text-primary hover:underline">{row.usageCount}</Link></td><td className="p-2"><Link href={`/admin/rewards/shared?group=${groupId}&version=${row.version.versionId}`} className="text-primary hover:underline">{t('view')}</Link></td></tr>)}</tbody></table></div>
   {history.length>=2&&<form method="get" className="flex flex-wrap items-end gap-3"><input type="hidden" name="group" value={groupId}/>{[0,1].map((side)=><label key={side} className="space-y-1 text-sm"><span className="block">{t(side?'compareTo':'compareFrom')}</span><select name="compare" defaultValue={compareIds[side]??history[side].version.versionId} className="rounded-md border bg-background p-2">{history.map(row=><option key={row.version.versionId} value={row.version.versionId}>{row.version.name} · {row.version.revision}</option>)}</select></label>)}<Button type="submit">{t('compare')}</Button></form>}
   {chosen&&<details open><summary className="cursor-pointer text-sm font-medium">{t('readOnlyVersion',{version:chosen.version.revision})}</summary><RewardPolicyFields policy={chosen.version.policy} readOnly context="shared"/><ul className="text-sm">{chosen.version.targets.map(pair=><li key={`${pair.companyId}:${pair.businessUnitId}`}>{pairLabel(pair)}</li>)}</ul></details>}
   {sides.length===2&&sides[0]&&sides[1]&&(()=>{const [before,after]=[sides[0]!,sides[1]!],diff=diffRewardPolicyVersions(before.version,after.version);return <div className="space-y-4"><h3 className="font-semibold">{t('comparison',{before:before.version.revision,after:after.version.revision})}</h3><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr><th className="p-2 text-left">{t('setting')}</th><th className="p-2 text-left">{before.version.revision}</th><th className="p-2 text-left">{after.version.revision}</th></tr></thead><tbody className="divide-y">{diff.settings.map(key=><tr key={key} className="bg-amber-50/60 dark:bg-amber-950/20"><th className="p-2 text-left font-medium">{t.has(`policyLabels.${key}`)?t(`policyLabels.${key}`):t('otherSetting')}</th><td className="whitespace-pre-wrap p-2">{format(key,before.version.policy[key])}</td><td className="whitespace-pre-wrap p-2">{format(key,after.version.policy[key])}</td></tr>)}</tbody></table></div>
    {!diff.settings.length&&!diff.added.length&&!diff.removed.length&&<p className="text-sm text-muted-foreground">{t('noDifferences')}</p>}
    {diff.added.length>0&&<div className="rounded-md border border-amber-500/50 p-3 text-sm"><h4 className="font-medium">{t('addedCoverage')}</h4><ul>{diff.added.map(pair=><li key={`${pair.companyId}:${pair.businessUnitId}`}>{pairLabel(pair)}</li>)}</ul></div>}
    {diff.removed.length>0&&<div className="rounded-md border border-amber-500/50 p-3 text-sm"><h4 className="font-medium">{t('removedCoverage')}</h4><ul>{diff.removed.map(pair=><li key={`${pair.companyId}:${pair.businessUnitId}`}>{pairLabel(pair)}</li>)}</ul></div>}
   </div>;})()}
  </Card>}
 </>;
}
