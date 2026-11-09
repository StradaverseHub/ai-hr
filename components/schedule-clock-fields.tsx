'use client';

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Card, Field, inputCls } from '@/components/ui';
import {ATTENDANCE_CLOCK_DAY_TYPES as days,MAX_ATTENDANCE_CLOCK_INTERVAL_MINUTES,type AttendanceClockPolicy} from '@/lib/attendance-clock-policy';

export type ScheduleClockCompany = {
  id: string;
  name: string;
  history: { ordinal:number; effectiveFrom:string; reason:string; policy:AttendanceClockPolicy}[];
};

export function ScheduleClockFields({companies, today, editing, grace}: {
  companies:ScheduleClockCompany[]; today:string; editing:boolean; grace:ReactNode;
}) {
  const t = useTranslations('scheduleGroupEditor');
  const [companyId,setCompanyId] = useState(companies.length===1 ? companies[0].id : '');
  const [draftOrdinal,setDraftOrdinal] = useState<number|null>(null);
  const company = companies.find(row=>row.id===companyId);
  const latest = company?.history.at(-1);
  const active = company?.history.filter(row=>row.effectiveFrom<=today).at(-1);
  const boundary = latest && latest.effectiveFrom>today ? latest.effectiveFrom : today;
  const minimum = new Date(Date.parse(boundary+'T00:00:00Z')+86_400_000).toISOString().slice(0,10);
  const ordinal=latest?.ordinal??0;
  const enabled=draftOrdinal===ordinal;
  const clockDisabled = !enabled || !company;

  return <div className="space-y-4">
    {!!companies.length && <Card className="space-y-3 p-4">
      <Field label={t('company')}>
        <select name="clockCompanyId" className={inputCls} value={companyId} onChange={event=>{
          setCompanyId(event.target.value);
          setDraftOrdinal(null);
        }}>
          <option value="">{t('chooseCompany')}</option>
          {companies.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}
        </select>
      </Field>
      {company && <p className="text-sm text-muted-foreground">{active
        ? t('currentRevision',{revision:active.ordinal,date:active.effectiveFrom})
        : t('noClockRevision')}</p>}
      {editing&&company&&<label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5 accent-primary" name="scheduleClockPolicy" value="1"
          data-attendance-reset-on-save data-attendance-reset-on-save-trigger checked={enabled} onChange={event=>setDraftOrdinal(event.target.checked?ordinal:null)}/>
        {t('scheduleClock')}
      </label>}
    </Card>}
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <Card className="space-y-4 p-4">
        <h3 className="font-semibold">{t('pairing')}</h3>
        <p className="text-sm text-muted-foreground">{t('pairingHelp')}</p>
        <div key={companyId+'-'+(latest?.ordinal??0)} className="space-y-3">
          {editing ? <fieldset data-attendance-reset-on-save disabled={clockDisabled} className="space-y-3">
            {days.map(day=><Field key={day} label={t(day)}>
              <select name={'clockPairing_'+day} defaultValue={latest?.policy.pairing[day]??'auto'} className={inputCls}>
                <option value="auto">{t('auto')}</option>
                <option value="firstInLastOut">{t('firstInLastOut')}</option>
              </select>
            </Field>)}
          </fieldset> : active ? <dl className="divide-y divide-border">
            {days.map(day=><div key={day} className="flex justify-between gap-4 py-2 text-sm">
              <dt>{t(day)}</dt><dd>{t(active.policy.pairing[day])}</dd>
            </div>)}
          </dl> : <p className="text-sm text-muted-foreground">{t('noClockRevision')}</p>}
        </div>
      </Card>
      <Card className="space-y-4 p-4">
        {grace}
        <div key={companyId+'-'+(latest?.ordinal??0)} className="space-y-3">
          <h3 className="font-semibold">{t('minimumInterval')}</h3>
          {editing ? <fieldset data-attendance-reset-on-save disabled={clockDisabled} className="space-y-3">
            <input type="hidden" name="clockExpectedOrdinal" data-attendance-guard-meta value={ordinal}/>
            <Field label={t('minutes')}>
              <input name="clockMinimumInterval" type="number" min={0} max={MAX_ATTENDANCE_CLOCK_INTERVAL_MINUTES} step={1}
                defaultValue={latest?.policy.minimumIntervalMinutes??0} className={inputCls}/>
            </Field>
            <p className="text-sm text-muted-foreground">{t('intervalHelp')}</p>
            <Field label={t('effectiveFrom')}>
              <input name="clockEffectiveFrom" type="date" min={minimum} className={inputCls}/>
            </Field>
            <Field label={t('reason')}>
              <input name="clockReason" maxLength={500} className={inputCls}/>
            </Field>
          </fieldset> : active && <p className="text-sm">{active.policy.minimumIntervalMinutes} {t('minutes')}</p>}
        </div>
      </Card>
    </div>
    {company&&company.history.length>0&&<Card className="p-4">
      <details>
        <summary className="cursor-pointer text-sm font-medium">{t('clockHistory')}</summary>
        <ol className="mt-3 space-y-2 text-sm">
          {[...company.history].reverse().map(row=><li key={row.ordinal} className="space-y-1">
            <p className="font-medium">{t('currentRevision',{revision:row.ordinal,date:row.effectiveFrom})} · {row.reason}</p>
            <p className="text-muted-foreground">{days.map(day=>t(day)+' · '+t(row.policy.pairing[day])).join(' / ')}
              {' · '}{row.policy.minimumIntervalMinutes} {t('minutes')}</p>
          </li>)}
        </ol>
      </details>
    </Card>}
  </div>;
}
