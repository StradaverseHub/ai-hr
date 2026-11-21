'use client';
/** 2f803985 — Schedule Group › Overtime › Overtime Setting. One client island used by Add Schedule (inside
 * the create form) and Edit Schedule (inside its own section form). Conditional fields are HIDDEN, not just
 * disabled: Show Lateness Exception After Offset appears only with the offset ticked, and Auto Overtime
 * Approval Method (with its Overtime Pattern per day type) only with Auto chosen. Hidden fields are not
 * posted, and the server drops a stale dependent tick as well (lib/schedule-overtime-setting.ts).
 *
 * 87bd9656 — three boxed sections: Overtime Approval Method, Overtime Rounding (with None, which greys out
 * Overtime Rounding to Minute and does not post it, and a static worked example) and Overtime Backdate Control
 * (the day count appears only with the box ticked). The submission owner enforces the backdate limit. */
import {useMemo,useState} from 'react';
import {useTranslations} from 'next-intl';
import {inputCls} from '@/components/ui';
import {ATTENDANCE_POLICY_DAY_CLASSES,type AttendancePolicyDayClass} from '@/lib/attendance-group-policy';
import {SCHEDULE_OVERTIME_AUTO_METHODS,SCHEDULE_OVERTIME_BACKDATE_MAX_DAYS,SCHEDULE_OVERTIME_ROUNDING_MODES,SCHEDULE_OVERTIME_ROUNDING_STEPS,type ScheduleOvertimeSetting} from '@/lib/schedule-overtime-setting';

export type ScheduleOvertimeSettingIslandProps={
 editing:boolean;
 initial:ScheduleOvertimeSetting;
 companies:{id:string;name:string}[];
 patterns:{versionId:string;name:string;code:string|null;companyIds:string[]}[];
 minimumDate:string;
 token:string;
 saved:{effectiveFrom:string;differingCount:number;unsupportedRounding:boolean}|null;
};
const DAY_KEY:Record<AttendancePolicyDayClass,string>={normal:'dayNormal',off:'dayOff',rest:'dayRest',publicHoliday:'dayPublicHoliday',replacementHoliday:'dayReplacementHoliday'};
const METHOD_KEY={intersect:'methodIntersect',actual:'methodActual',preApproved:'methodPreApproved'} as const;
const HINT_KEY={intersect:'methodIntersectHint',actual:'methodActualHint',preApproved:'methodPreApprovedHint'} as const;
const MODE_KEY={none:'roundNone',up:'roundUp',down:'roundDown'} as const;
/** The request's own table: 31 and 46 eligible minutes under None, Round Up 15 and Round Down 15. */
const EXAMPLE_ROWS=[31,46].flatMap(minutes=>([['none',null],['up',15],['down',15]] as const).map(([mode,step])=>({minutes,mode,step,
 final:mode==='none'?minutes:mode==='up'?Math.ceil(minutes/step!)*step!:Math.floor(minutes/step!)*step!})));
const CARD='space-y-3 rounded-lg border border-border p-4';

export function ScheduleOvertimeSettingFields({editing,initial,companies,patterns,minimumDate,token,saved}:ScheduleOvertimeSettingIslandProps){
 const t=useTranslations('scheduleOvertimeSetting');
 const [value,setValue]=useState(initial);
 const [scope,setScope]=useState<'all'|'companies'>('all');
 const [chosen,setChosen]=useState<string[]>(companies.map(row=>row.id));
 // The interval to restore when None is changed back to Round Up or Round Down.
 const [lastStep,setLastStep]=useState<typeof SCHEDULE_OVERTIME_ROUNDING_STEPS[number]>(initial.roundingStep??15);
 const [daysText,setDaysText]=useState(initial.backdateDays===null?'':String(initial.backdateDays));
 const set=<K extends keyof ScheduleOvertimeSetting>(key:K,next:ScheduleOvertimeSetting[K])=>setValue(current=>({...current,[key]:next}));
 const inScope=scope==='all'?companies.map(row=>row.id):chosen;
 // Only a formula active for EVERY chosen company can price their overtime; the writer rechecks.
 const usable=useMemo(()=>patterns.filter(row=>inScope.every(id=>row.companyIds.includes(id))),[patterns,inScope]);
 const check=(key:'beforeShift'|'afterShift'|'allowBackdatedWithoutClock'|'splitAtMidnight'|'offsetLateness'|'showLatenessExceptionAfterOffset'|'backdateControl',
  name:string,label:string,hint:string)=><label className="flex items-start gap-2 text-sm" data-ot-setting={key}>
   {editing?<input type="checkbox" name={name} checked={value[key]} onChange={event=>set(key,event.target.checked)} className="mt-0.5 h-3.5 w-3.5 accent-primary"/>
    :<span className="min-w-8 font-medium">{value[key]?t('on'):t('off')}</span>}
   <span><span className="font-medium">{label}</span><span className="block text-xs text-muted-foreground">{hint}</span></span>
  </label>;
 const read=(text:string)=><p className="text-sm">{text}</p>;
 return <div className="space-y-5" data-schedule-overtime-setting="">
  {editing&&<input type="hidden" name="otSettingEditor" value="1"/>}
  {editing&&<input type="hidden" name="otSettingToken" value={token}/>}
  <p className="text-sm text-muted-foreground">{t('intro')}</p>
  {saved?<p className="text-sm" data-ot-setting-saved="">{t('savedFrom',{date:saved.effectiveFrom})}</p>:<p className="text-sm text-muted-foreground">{t('none')}</p>}
  {saved&&saved.differingCount>0&&<p className="text-sm text-amber-800 dark:text-amber-200" role="note">{t('differs',{n:saved.differingCount})}</p>}
  {saved?.unsupportedRounding&&<p className="text-sm text-amber-800 dark:text-amber-200" role="note">{t('unsupportedRounding')}</p>}

  {editing&&<div className="grid gap-3 sm:grid-cols-2">
   <fieldset className="space-y-2"><legend className="text-sm font-medium">{t('companiesLabel')}</legend>
    <label className="flex items-center gap-2 text-sm"><input type="radio" name="otScope" value="all" checked={scope==='all'} onChange={()=>setScope('all')}/>{t('allCompanies')}</label>
    <label className="flex items-center gap-2 text-sm"><input type="radio" name="otScope" value="companies" checked={scope==='companies'} onChange={()=>setScope('companies')}/>{t('selectedCompanies')}</label>
    {scope==='companies'&&<div className="max-h-48 space-y-1 overflow-y-auto rounded border border-border p-2" data-ot-setting-companies="">
     {companies.map(row=><label key={row.id} className="flex items-center gap-2 text-sm"><input type="checkbox" name="otCompanyIds" value={row.id}
      checked={chosen.includes(row.id)} onChange={event=>setChosen(current=>event.target.checked?[...current,row.id]:current.filter(id=>id!==row.id))}/>{row.name}</label>)}
    </div>}
   </fieldset>
   <label className="text-sm"><span className="font-medium">{t('effectiveFrom')}</span>
    <input type="date" name="otEffectiveFrom" required min={minimumDate} defaultValue={minimumDate} className={inputCls}/>
    <span className="block text-xs text-muted-foreground">{t('effectiveHint')}</span></label>
  </div>}

  <section className="space-y-2" aria-label={t('applicabilityTitle')}>
   <h4 className="text-sm font-semibold">{t('applicabilityTitle')}</h4>
   {check('beforeShift','otBeforeShift',t('beforeShift'),t('beforeShiftHint'))}
   {check('afterShift','otAfterShift',t('afterShift'),t('afterShiftHint'))}
   {check('allowBackdatedWithoutClock','otAllowBackdated',t('allowBackdated'),t('allowBackdatedHint'))}
   {check('splitAtMidnight','otSplitAtMidnight',t('splitAtMidnight'),t('splitAtMidnightHint'))}
  </section>

  <section className="space-y-2" aria-label={t('offsetTitle')}>
   <h4 className="text-sm font-semibold">{t('offsetTitle')}</h4>
   {check('offsetLateness','otOffsetLateness',t('offsetLateness'),t('offsetHint'))}
   {value.offsetLateness&&<div className="pl-6">{check('showLatenessExceptionAfterOffset','otShowLatenessException',t('showLatenessException'),t('showLatenessExceptionHint'))}</div>}
  </section>

  <section className={CARD} aria-label={t('approvalTitle')} data-ot-section="approval">
   <div><h4 className="text-sm font-semibold">{t('approvalTitle')}</h4><p className="text-xs text-muted-foreground">{t('approvalIntro')}</p></div>
   <label className="block text-sm"><span className="font-medium">{t('approvalTitle')}</span>
    {editing?<select name="otApproval" value={value.approval} onChange={event=>set('approval',event.target.value as ScheduleOvertimeSetting['approval'])} className={inputCls}>
     <option value="manual">{t('approvalManual')}</option><option value="auto">{t('approvalAuto')}</option></select>
     :read(t(value.approval==='auto'?'approvalAuto':'approvalManual'))}</label>
   {value.approval==='manual'&&<p className="text-xs text-muted-foreground">{t('approvalManualHint')}</p>}
   {value.approval==='auto'&&<div className="space-y-3" data-ot-setting="autoMethod">
    <label className="block text-sm"><span className="font-medium">{t('autoMethod')}</span>
     {editing?<select name="otAutoMethod" value={value.autoMethod} onChange={event=>set('autoMethod',event.target.value as ScheduleOvertimeSetting['autoMethod'])} className={inputCls}>
      {SCHEDULE_OVERTIME_AUTO_METHODS.map(key=><option key={key} value={key}>{t(METHOD_KEY[key])}</option>)}</select>
      :read(t(METHOD_KEY[value.autoMethod]))}
     <span className="block text-xs text-muted-foreground">{t(HINT_KEY[value.autoMethod])}</span></label>
    <div className="space-y-2" data-ot-setting="patterns">
     <p className="text-sm font-medium">{t('patternsTitle')}</p>
     <p className="text-xs text-muted-foreground">{t('patternsHint')}</p>
     {editing&&!usable.length&&<p role="alert" className="text-sm text-destructive">{t('patternsNone')}</p>}
     <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{ATTENDANCE_POLICY_DAY_CLASSES.map(key=>{
      const current=value.patternVersionIds[key],label=patterns.find(row=>row.versionId===current);
      return <label key={key} className="text-sm"><span>{t(DAY_KEY[key])}</span>
       {editing?<select name={`otPattern_${key}`} value={current??''} className={inputCls}
         onChange={event=>set('patternVersionIds',{...value.patternVersionIds,[key]:event.target.value||null})}>
         <option value="">{t('choosePattern')}</option>
         {current&&!usable.some(row=>row.versionId===current)&&<option value={current}>{label?.name??current}</option>}
         {usable.map(row=><option key={row.versionId} value={row.versionId}>{row.code?`${row.code} · `:''}{row.name}</option>)}
        </select>:read(label?.name??'—')}</label>;})}</div>
    </div>
   </div>}
  </section>

  <section className={CARD} aria-label={t('roundingTitle')} data-ot-section="rounding">
   <div><h4 className="text-sm font-semibold">{t('roundingTitle')}</h4><p className="text-xs text-muted-foreground">{t('roundingIntro')}</p></div>
   <div className="grid gap-3 sm:grid-cols-2">
    <label className="text-sm"><span className="font-medium">{t('roundingMethod')}</span>
     {editing?<select name="otRoundingMode" value={value.roundingMode} className={inputCls}
       onChange={event=>{const mode=event.target.value as ScheduleOvertimeSetting['roundingMode'];
        setValue(current=>({...current,roundingMode:mode,roundingStep:mode==='none'?null:current.roundingStep??lastStep}));}}>
      {SCHEDULE_OVERTIME_ROUNDING_MODES.map(mode=><option key={mode} value={mode}>{t(MODE_KEY[mode])}</option>)}</select>
      :read(t(MODE_KEY[value.roundingMode]))}</label>
    <label className="text-sm" data-ot-setting="roundingStep"><span className={value.roundingMode==='none'?'font-medium text-muted-foreground':'font-medium'}>{t('roundingStep')}</span>
     {/* Disabled when None: a disabled select is not posted, and the server ignores a step for None anyway. */}
     {editing?<select name="otRoundingStep" value={String(value.roundingStep??lastStep)} disabled={value.roundingMode==='none'} aria-disabled={value.roundingMode==='none'}
       onChange={event=>{const step=Number(event.target.value) as typeof SCHEDULE_OVERTIME_ROUNDING_STEPS[number];setLastStep(step);set('roundingStep',step);}}
       className={inputCls+' disabled:cursor-not-allowed disabled:opacity-60'}>
      {SCHEDULE_OVERTIME_ROUNDING_STEPS.map(step=><option key={step} value={step}>{t('stepMinutes',{n:step})}</option>)}</select>
      :read(value.roundingStep===null?t('notApplicable'):t('stepMinutes',{n:value.roundingStep}))}
     {value.roundingMode==='none'&&<span className="block text-xs text-muted-foreground">{t('roundingNoneHint')}</span>}</label>
   </div>
   <p className="text-xs text-muted-foreground">{t('roundingHint')}</p>
   <div className="overflow-x-auto" data-ot-rounding-example="">
    <table className="w-full text-left text-xs">
     <caption className="pb-2 text-left text-xs font-medium">{t('roundingExampleTitle')}</caption>
     <thead><tr className="border-b border-border">{(['roundingExampleActual','roundingExampleMethod','roundingExampleInterval','roundingExampleFinal'] as const)
      .map(key=><th key={key} scope="col" className="px-2 py-1.5 font-medium">{t(key)}</th>)}</tr></thead>
     <tbody>{EXAMPLE_ROWS.map(row=><tr key={`${row.minutes}-${row.mode}`} className="border-b border-border/60">
      <td className="px-2 py-1.5">{t('minutesValue',{n:row.minutes})}</td><td className="px-2 py-1.5">{t(MODE_KEY[row.mode])}</td>
      <td className="px-2 py-1.5">{row.step===null?t('notApplicable'):t('minutesValue',{n:row.step})}</td>
      <td className="px-2 py-1.5 font-medium">{t('minutesValue',{n:row.final})}</td></tr>)}</tbody>
    </table>
   </div>
  </section>

  <section className={CARD} aria-label={t('backdateTitle')} data-ot-section="backdate">
   <div><h4 className="text-sm font-semibold">{t('backdateTitle')}</h4><p className="text-xs text-muted-foreground">{t('backdateIntro')}</p></div>
   {check('backdateControl','otBackdateControl',t('backdateControl'),t('backdateControlHint'))}
   {value.backdateControl&&<label className="block pl-6 text-sm" data-ot-setting="backdateDays"><span className="font-medium">{t('backdateDays')}</span>
    {editing?<input type="number" name="otBackdateDays" required min={1} max={SCHEDULE_OVERTIME_BACKDATE_MAX_DAYS} step={1} inputMode="numeric"
      value={daysText} onChange={event=>{setDaysText(event.target.value);const n=Number(event.target.value);
       set('backdateDays',/^\d+$/.test(event.target.value)&&n>=1&&n<=SCHEDULE_OVERTIME_BACKDATE_MAX_DAYS?n:null);}} className={inputCls+' max-w-40'}/>
     :read(value.backdateDays===null?'—':t('backdateDaysValue',{n:value.backdateDays}))}
    <span className="block text-xs text-muted-foreground">{t('backdateDaysHint',{max:SCHEDULE_OVERTIME_BACKDATE_MAX_DAYS})}</span></label>}
  </section>
  <p className="border-l-2 border-border pl-3 text-sm">{t('payrollNote')}</p>
 </div>;
}
