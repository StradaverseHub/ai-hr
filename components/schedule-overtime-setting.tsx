'use client';
/** 2f803985 — Schedule Group › Overtime › Overtime Setting. One client island used by Add Schedule (inside
 * the create form) and Edit Schedule (inside its own section form). Conditional fields are HIDDEN, not just
 * disabled: Show Lateness Exception After Offset appears only with the offset ticked, and Auto Overtime
 * Approval Method (with its Overtime Pattern per day type) only with Auto chosen. Hidden fields are not
 * posted, and the server drops a stale dependent tick as well (lib/schedule-overtime-setting.ts). */
import {useMemo,useState} from 'react';
import {useTranslations} from 'next-intl';
import {inputCls} from '@/components/ui';
import {ATTENDANCE_POLICY_DAY_CLASSES,type AttendancePolicyDayClass} from '@/lib/attendance-group-policy';
import {SCHEDULE_OVERTIME_AUTO_METHODS,SCHEDULE_OVERTIME_ROUNDING_STEPS,type ScheduleOvertimeSetting} from '@/lib/schedule-overtime-setting';

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

export function ScheduleOvertimeSettingFields({editing,initial,companies,patterns,minimumDate,token,saved}:ScheduleOvertimeSettingIslandProps){
 const t=useTranslations('scheduleOvertimeSetting');
 const [value,setValue]=useState(initial);
 const [scope,setScope]=useState<'all'|'companies'>('all');
 const [chosen,setChosen]=useState<string[]>(companies.map(row=>row.id));
 const set=<K extends keyof ScheduleOvertimeSetting>(key:K,next:ScheduleOvertimeSetting[K])=>setValue(current=>({...current,[key]:next}));
 const inScope=scope==='all'?companies.map(row=>row.id):chosen;
 // Only a formula active for EVERY chosen company can price their overtime; the writer rechecks.
 const usable=useMemo(()=>patterns.filter(row=>inScope.every(id=>row.companyIds.includes(id))),[patterns,inScope]);
 const check=(key:'beforeShift'|'afterShift'|'allowBackdatedWithoutClock'|'splitAtMidnight'|'offsetLateness'|'showLatenessExceptionAfterOffset',
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

  <section className="space-y-3" aria-label={t('approvalTitle')}>
   <h4 className="text-sm font-semibold">{t('approvalTitle')}</h4>
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

  <section className="space-y-2" aria-label={t('roundingTitle')}>
   <h4 className="text-sm font-semibold">{t('roundingTitle')}</h4>
   <div className="grid gap-3 sm:grid-cols-2">
    <label className="text-sm"><span className="font-medium">{t('roundingMethod')}</span>
     {editing?<select name="otRoundingMode" value={value.roundingMode} onChange={event=>set('roundingMode',event.target.value as 'up'|'down')} className={inputCls}>
      <option value="up">{t('roundUp')}</option><option value="down">{t('roundDown')}</option></select>
      :read(t(value.roundingMode==='up'?'roundUp':'roundDown'))}</label>
    <label className="text-sm"><span className="font-medium">{t('roundingStep')}</span>
     {editing?<select name="otRoundingStep" value={String(value.roundingStep)} onChange={event=>set('roundingStep',Number(event.target.value) as ScheduleOvertimeSetting['roundingStep'])} className={inputCls}>
      {SCHEDULE_OVERTIME_ROUNDING_STEPS.map(step=><option key={step} value={step}>{t('stepMinutes',{n:step})}</option>)}</select>
      :read(t('stepMinutes',{n:value.roundingStep}))}</label>
   </div>
   <p className="text-xs text-muted-foreground">{t('roundingHint')}</p>
  </section>
  <p className="border-l-2 border-border pl-3 text-sm">{t('payrollNote')}</p>
 </div>;
}
