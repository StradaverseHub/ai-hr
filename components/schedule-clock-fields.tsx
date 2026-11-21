'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Card, Field, inputCls } from '@/components/ui';
import {ATTENDANCE_CLOCK_DAY_TYPES as days,MAX_ATTENDANCE_CLOCK_INTERVAL_MINUTES,type AttendanceClockPolicy} from '@/lib/attendance-clock-policy';
import {scheduleClockDisplay,type ClockHistoryRow} from '@/lib/schedule-clock-scope';

/** c03670cc — the companies this administrator administers, plus the group-wide and per-company chains. */
export type ScheduleClockSettings = {
  canUseAll: boolean;
  group: ClockHistoryRow[];
  companies: { id:string; name:string; history:ClockHistoryRow[] }[];
};

/**
 * Clock settings on the Schedule Group Attendance tab (c03670cc).
 *
 * Company: All Companies (group administrators; also covers companies added later) or specific
 * companies. Pairing Method per day type and Minimum Interval Between Clock are always open; there is no
 * Effective From or Reason: the service dates a change from tomorrow and records who made it. A form left
 * untouched writes nothing (the baseline below is what it showed).
 */
export function ScheduleClockFields(props: {settings:ScheduleClockSettings; editing:boolean; grace:ReactNode}) {
  const display = useMemo(()=>scheduleClockDisplay(props.settings),[props.settings]);
  // A newly saved revision changes the token, which remounts the controls with what was saved.
  return <ScheduleClockFieldsBody key={JSON.stringify(display)} {...props} display={display}/>;
}

function ScheduleClockFieldsBody({settings, editing, grace, display}: {
  settings:ScheduleClockSettings; editing:boolean; grace:ReactNode; display:ReturnType<typeof scheduleClockDisplay>;
}) {
  const t = useTranslations('scheduleGroupEditor');
  const [scope,setScope] = useState<'all'|'companies'>(display.scope.kind);
  const [selected,setSelected] = useState<string[]>(display.scope.kind==='companies'?display.scope.companyIds:[]);
  const policy: AttendanceClockPolicy = display.policy;
  const baseline = JSON.stringify({scope:display.scope,policy});
  const names = (ids:readonly string[]) => settings.companies.filter(company=>ids.includes(company.id)).map(company=>company.name);
  const canEdit = editing && (settings.canUseAll || settings.companies.length > 0);
  const histories = [
    ...(settings.group.length ? [{key:'group',name:t('allCompanies'),history:settings.group}] : []),
    ...settings.companies.filter(company=>company.history.length).map(company=>({key:company.id,name:company.name,history:company.history})),
  ];

  return <div className="space-y-4">
    <Card className="space-y-3 p-4" data-schedule-clock-scope="">
      <h3 className="font-semibold">{t('company')}</h3>
      {canEdit ? <fieldset className="space-y-2">
        <legend className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('appliesTo')}</legend>
        <input type="hidden" name="clockEditor" value="1"/>
        <input type="hidden" name="clockBaseline" data-attendance-guard-meta value={baseline}/>
        <input type="hidden" name="clockRevisionToken" data-attendance-guard-meta value={JSON.stringify(display.token)}/>
        {settings.canUseAll && <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="clockScope" value="all" className="accent-primary" checked={scope==='all'} onChange={()=>setScope('all')}/>
          {t('allCompanies')}
        </label>}
        {settings.companies.length > 0 && <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="clockScope" value="companies" className="accent-primary" checked={scope==='companies'} onChange={()=>setScope('companies')}/>
          {t('specificCompanies')}
        </label>}
        {scope==='companies' && <div className="grid gap-1 pl-6 sm:grid-cols-2" role="group" aria-label={t('specificCompanies')}>
          {settings.companies.map(company=><label key={company.id} className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="clockCompanyIds" value={company.id} className="accent-primary"
              checked={selected.includes(company.id)}
              onChange={event=>setSelected(rows=>event.target.checked?[...rows,company.id]:rows.filter(id=>id!==company.id))}/>
            {company.name}
          </label>)}
          {!selected.length && <p className="text-xs text-destructive sm:col-span-2">{t('chooseOneCompany')}</p>}
        </div>}
      </fieldset> : <p className="text-sm">{display.scope.kind==='all' ? t('allCompanies') : names(display.scope.companyIds).join(', ') || '—'}</p>}
      <p className="text-sm text-muted-foreground">{settings.canUseAll ? t('allCompaniesHelp') : t('companyScopedHelp')}</p>
      {display.differing.length > 0 && <p className="text-sm text-amber-700 dark:text-amber-300" data-schedule-clock-differing="">
        {t('differingNote',{companies:display.differing.map(company=>company.name).join(', ')})}
      </p>}
    </Card>
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <Card className="space-y-4 p-4">
        <h3 className="font-semibold">{t('pairing')}</h3>
        <p className="text-sm text-muted-foreground">{t('pairingHelp')}</p>
        {canEdit ? <div className="grid gap-3 sm:grid-cols-2">
          {days.map(day=><Field key={day} label={t(day)}>
            <select name={'clockPairing_'+day} defaultValue={policy.pairing[day]} className={inputCls}>
              <option value="auto">{t('auto')}</option>
              <option value="firstInLastOut">{t('firstInLastOut')}</option>
            </select>
          </Field>)}
        </div> : <dl className="divide-y divide-border">
          {days.map(day=><div key={day} className="flex justify-between gap-4 py-2 text-sm">
            <dt>{t(day)}</dt><dd>{t(policy.pairing[day])}</dd>
          </div>)}
        </dl>}
        <h3 className="font-semibold">{t('minimumInterval')}</h3>
        {canEdit ? <Field label={t('minutes')}>
          <input name="clockMinimumInterval" type="number" inputMode="numeric" min={0} max={MAX_ATTENDANCE_CLOCK_INTERVAL_MINUTES} step={1} required
            defaultValue={policy.minimumIntervalMinutes} className={inputCls}/>
        </Field> : <p className="text-sm">{policy.minimumIntervalMinutes} {t('minutes')}</p>}
        <p className="text-sm text-muted-foreground">{t('intervalHelp')}</p>
      </Card>
      <Card className="space-y-4 p-4">
        {grace}
        {canEdit && <p className="text-sm text-muted-foreground">{t('appliesFromTomorrow')}</p>}
      </Card>
    </div>
    {histories.length>0&&<Card className="p-4">
      <details>
        <summary className="cursor-pointer text-sm font-medium">{t('clockHistory')}</summary>
        <div className="mt-3 space-y-3 text-sm">
          {histories.map(chain=><div key={chain.key} className="space-y-1">
            <p className="font-medium">{chain.name}</p>
            <ol className="space-y-1">
              {[...chain.history].reverse().map(row=><li key={row.ordinal}>
                <span>{t('currentRevision',{revision:row.ordinal,date:row.effectiveFrom})}</span>
                <span className="block text-muted-foreground">{days.map(day=>t(day)+' · '+t(row.policy.pairing[day])).join(' / ')}
                  {' · '}{row.policy.minimumIntervalMinutes} {t('minutes')}</span>
              </li>)}
            </ol>
          </div>)}
        </div>
      </details>
    </Card>}
  </div>;
}
