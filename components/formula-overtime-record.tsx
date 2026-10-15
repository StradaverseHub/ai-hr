'use client';
import {useTranslations} from 'next-intl';
import {exactOvertimeMinutesText,type FormulaOvertimeRecord,type OvertimeRecordSummary} from '@/lib/overtime-records';
import {fmtMin} from './attendance-format';
/** Salary-free, stored-only duration. Native details keeps reference disclosure keyboard accessible. */
export function FormulaOvertimeDuration({record,legacyMinutes,showReference=true}:{record?:FormulaOvertimeRecord|null;legacyMinutes?:number|null;showReference?:boolean}){
 const t=useTranslations('attendance.overtimeRecords');
 if(!record)return <>{fmtMin(legacyMinutes)}</>;
 const duration=record.payableExact&&record.status!=='refused'?t('minutes',{value:exactOvertimeMinutesText(record.payableExact)}):t('unavailable');
 const text=record.status==='ineligible'?`${t('ineligible')} · ${duration}`:duration;
 const content=<><span className="font-medium tabular-nums">{text}</span><span className="block text-xs text-muted-foreground">{t('formula')}</span></>;
 if(!showReference)return <span>{content}</span>;
 return <details className="max-w-sm text-left"><summary className="cursor-pointer rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">{content}</summary><div className="mt-2 space-y-1 text-xs text-muted-foreground">
  {record.reason&&<p>{t(record.reason)}</p>}
  {record.cashStatus==='refused'&&record.status!=='refused'&&<p>{t('cashUnavailable')}</p>}
  <p>{t('storedOnly')}</p>
  {record.versionId&&<p className="break-all">{t('version')}: <code>{record.versionId}</code></p>}
  {record.calculationId&&<p className="break-all">{t('reference')}: <code>{record.calculationId}</code></p>}
 </div></details>;
}
export function OvertimeSummaryValue({summary}:{summary:OvertimeRecordSummary}){
 const t=useTranslations('attendance.overtimeRecords');return <span className="tabular-nums">{summary.complete?t('minutes',{value:exactOvertimeMinutesText(summary.knownMinutes)}):t('incompleteTotal',{value:exactOvertimeMinutesText(summary.knownMinutes),count:summary.unknownDays})}</span>;
}
