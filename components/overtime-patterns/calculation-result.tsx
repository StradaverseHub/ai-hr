'use client';

import {useTranslations} from 'next-intl';
import type {OvertimeChoice} from './rule-controls';
import type {OvertimeEvaluation,OvertimeExact,OvertimeValue,OvertimeIssue,OvertimePattern,OvertimeDurationEvaluation} from '@/lib/overtime-pattern-model';

/** Display an integer minor-unit result without a floating point money conversion. */
export function overtimeMoneyText(minorUnits:string,scale:number,currency:string):string {
  if(!/^-?\d+$/.test(minorUnits)||!Number.isInteger(scale)||scale<0||scale>6) return '—';
  const negative=minorUnits.startsWith('-');
  const digits=(negative?minorUnits.slice(1):minorUnits).padStart(scale+1,'0');
  return `${currency} ${negative?'-':''}${scale?`${digits.slice(0,-scale)}.${digits.slice(-scale)}`:digits}`;
}
const evidenceAliases:Record<string,string>={unit:'unit',currency:'currency',reason:'reason',basis:'basis',method:'method',priority:'priority',resource:'resource',field:'field',operator:'operator',condition:'condition',sessionGranularity:'sessionGranularity',approvalStatus:'approvalStatus',accumulation:'accumulation',tierMode:'tierMode',ceiling:'ceiling',base:'base',minutes:'minutes',amount:'amount',multiplier:'multiplier',effectiveFrom:'effectiveFrom'};
const exact=(value:OvertimeExact)=>value.denominator==='1'?value.numerator:`${value.numerator} / ${value.denominator}`;
function EvidenceValue({value,depth=0}:{value:unknown;depth?:number}) {
  const t=useTranslations('overtimePatterns');
  if(value===null||value===undefined) return <span>{t('unknown')}</span>;
  if(typeof value==='boolean') return <span>{t(value?'yes':'no')}</span>;
  if(typeof value==='string'||typeof value==='number') return <span className="break-words">{String(value)}</span>;
  if(depth>12) return <span>{t('errors.limit')}</span>;
  if(Array.isArray(value)) return <ol className="space-y-1">{value.map((item,index)=><li key={index}><EvidenceValue value={item} depth={depth+1}/></li>)}</ol>;
  if(typeof value==='object') return <dl className="space-y-1">{Object.entries(value).map(([key,item])=><div key={key} className="grid min-w-0 gap-x-3 sm:grid-cols-[minmax(8rem,1fr)_minmax(0,2fr)]"><dt className="break-words text-muted-foreground">{t.has(`evidence.${key}`)?t(`evidence.${key}`):t.has(`fields.${key}`)?t(`fields.${key}`):evidenceAliases[key]?t(evidenceAliases[key]):t('evidenceDetail',{key})}</dt><dd className="min-w-0"><EvidenceValue value={item} depth={depth+1}/></dd></div>)}</dl>;
  return <span>{t('unknown')}</span>;
}
export function OvertimeIssues({issues}:{issues:OvertimeIssue[]}) {
  const t=useTranslations('overtimePatterns');
  if(!issues.length) return null;
  return <ul role="alert" className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">{issues.map((issue,index)=><li key={`${issue.code}:${issue.path}:${index}`}><strong>{issue.severity==='runtime'?t('runtimeCheckRequired'):t(`errors.${issue.code}`)}</strong><span className="mt-1 block break-words text-xs text-muted-foreground">{issue.path}</span></li>)}</ul>;
}
export function OvertimeCalculationResult({result,pattern,earningItems=[],preview=true}:{result:OvertimeEvaluation;pattern?:OvertimePattern;earningItems?:readonly OvertimeChoice[];preview?:boolean}) {
  const t=useTranslations('overtimePatterns');
  function measured(value:OvertimeValue) {return value.state==='known'?exact(value.value):t('unknown');}
  const rateName=(id:string)=>pattern?.rates.find(rate=>rate.id===id)?.name??t('unavailableRate');
  // Presentation only: authorized setup names do not replace immutable mapping IDs.
  const earningLabels=new Map(earningItems.map(item=>[item.id,item.label]));
  const sessions=result.status==='refused'?[]:[...new Set(result.lines.map(line=>line.sessionId))];
  const inputEvidence=result.trace.find(step=>step.kind==='duration'&&step.id==='input')?.data;
  const granularity=inputEvidence?.sessionGranularity;
  const sessionName=(id:string)=>granularity==='dayAggregate'?t('bases.day'):
    granularity==='recorded'?t('numberedSession',{number:sessions.indexOf(id)+1}):t('unknown');
  return <div className="min-w-0 space-y-5" aria-live="polite">
    <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-base font-semibold">{t(`resultStatus.${result.status}`)}</h3><span className="text-xs text-muted-foreground">{t(preview?'previewNoWrite':'recordedCalculation')}</span></div>
    <p className="break-all text-xs text-muted-foreground">{t('versionId',{id:result.patternVersionId})} · {result.source.date}</p>
    {result.status==='refused'?<OvertimeIssues issues={result.issues}/>:<>
      <dl className="grid grid-cols-2 gap-4 lg:grid-cols-5">{[
        ['rawMinutes',measured(result.rawMinutes)],['eligibleMinutes',measured(result.eligibleMinutes)],
        ['approvedMinutes',measured(result.approvedMinutes)],['payableMinutes',exact(result.payableMinutes)],
        ['amount',overtimeMoneyText(result.amountMinorUnits,result.currency.minorScale,result.currency.code)],
      ].map(([key,value])=><div key={key} className="rounded-lg border border-border p-3"><dt className="text-xs text-muted-foreground">{t.has(`fields.${key}`)?t(`fields.${key}`):t(key)}</dt><dd className="mt-2 break-words font-medium tabular-nums">{value}</dd></div>)}</dl>
      <div className="overflow-x-auto rounded-lg border border-border"><table className="w-full text-left text-sm"><thead className="border-b border-border text-xs text-muted-foreground"><tr>{['rateName','tier','session','payableMinutes','payrollItem','amount'].map(key=><th key={key} className="px-3 py-3">{t(key)}</th>)}</tr></thead><tbody>{result.lines.map(line=><tr key={line.id} className="border-b border-border/60"><td className="px-3 py-3">{rateName(line.rateId)}</td><td className="px-3 py-3">{pattern?.rates.find(rate=>rate.id===line.rateId)?.tiers.some(tier=>tier.id===line.tierId)?(pattern.rates.find(rate=>rate.id===line.rateId)!.tiers.findIndex(tier=>tier.id===line.tierId)+1):t('unknown')}</td><td className="px-3 py-3"><span className="block">{sessionName(line.sessionId)}</span><span className="mt-1 block break-all text-xs text-muted-foreground">{line.sessionId}</span></td><td className="px-3 py-3 tabular-nums">{exact(line.payableMinutes)}</td><td className="px-3 py-3"><span className="block">{earningLabels.get(line.mapping.earningItemId)||t('unknown')}</span><span className="mt-1 block break-all text-xs text-muted-foreground">{earningLabels.get(line.mapping.earningItemId)?line.mapping.earningItemId:t('unavailableReference',{id:line.mapping.earningItemId})}</span></td><td className="px-3 py-3 whitespace-nowrap tabular-nums">{overtimeMoneyText(line.amountMinorUnits,result.currency.minorScale,result.currency.code)}</td></tr>)}</tbody></table></div>
    </>}
    <div className="space-y-2"><h3 className="font-semibold">{t('calculationTrace')}</h3>{result.trace.map((step,index)=><details key={`${step.id}:${index}`} className="rounded-lg border border-border p-3"><summary className="cursor-pointer py-1 text-sm font-medium">{t(`traceKinds.${step.kind}`)} · {index+1}</summary><div className="pt-3 text-sm"><EvidenceValue value={step.data}/></div></details>)}</div>
  </div>;
}

/** Display the owner's saved duration independently of any cash-pricing refusal. */
export function OvertimeDurationResult({result}:{result:OvertimeDurationEvaluation}) {
  const t=useTranslations('overtimePatterns');
  const measured=(value:OvertimeValue)=>value.state==='known'?exact(value.value):t('unknown');
  return <section className="space-y-4 rounded-lg border border-border p-4" aria-label={t('durationResult')}>
    <h3 className="font-semibold">{t('durationResult')} · {t(`resultStatus.${result.status}`)}</h3>
    <p className="text-xs text-muted-foreground">{t('durationAuthorityHelp')}</p>
    <p className="break-all text-xs text-muted-foreground">{t('versionId',{id:result.patternVersionId})} · {result.source.date}</p>
    {result.status==='refused'?<OvertimeIssues issues={result.issues}/>:<dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">{[['rawMinutes',measured(result.rawMinutes)],['eligibleMinutes',measured(result.eligibleMinutes)],['approvedMinutes',measured(result.approvedMinutes)],['payableMinutes',exact(result.payableMinutes)]].map(([key,value])=><div key={key}><dt className="text-xs text-muted-foreground">{t(`fields.${key}`)}</dt><dd className="mt-1 break-words tabular-nums">{value}</dd></div>)}</dl>}
    <details><summary className="cursor-pointer text-sm font-medium">{t('calculationTrace')}</summary><div className="mt-3 space-y-3">{result.trace.map((step,index)=><details key={`${step.id}:${index}`} className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm">{t(`traceKinds.${step.kind}`)} · {index+1}</summary><div className="pt-3 text-sm"><EvidenceValue value={step.data}/></div></details>)}</div></details>
  </section>;
}
