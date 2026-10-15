'use client';
import { useActionState, useState } from 'react';
import { AttendanceSettingsNavigation } from '@/components/attendance-settings-navigation';
import { useTranslations } from 'next-intl';
import { ErrorBanner, Field, inputCls, btnPrimary } from '@/components/ui';
import { ALLOWANCE_DAY_KINDS, ALLOWANCE_EMPLOYEE_FIELDS, ALLOWANCE_METRICS, ALLOWANCE_OPERATORS, emptyAllowanceRulesV3, upgradeAllowanceRules, type AllowanceRules, type AllowanceEmployeeField, type AllowanceMetric } from '@/lib/attendance-allowance-rules';
import { AttendanceAllowanceExpressionEditor, AllowanceChoices } from '@/components/attendance-allowance-expression-editor';
import { AllowanceExpressionView } from '@/components/attendance-allowance-expression';
import { ALLOWANCE_METRICS_V3 } from '@/lib/attendance-allowance-expression';
import type { allowanceSetupOptions, getAllowancePolicy } from '@/packs/attendance/service';
type Options=Awaited<ReturnType<typeof allowanceSetupOptions>>;
type Policy=NonNullable<Awaited<ReturnType<typeof getAllowancePolicy>>>;
const selected=(event:React.ChangeEvent<HTMLSelectElement>)=>Array.from(event.currentTarget.selectedOptions,o=>o.value);
export function AttendanceAllowanceEditor({options,components,policy,action}:{options:Options;components:{id:string;code:string;name:string;kind:string}[];policy?:Policy;action:(state:{error:string|null},formData:FormData)=>Promise<{error:string|null}>}){
  const t=useTranslations('allowanceV2'),v=useTranslations('allowanceV3');
  const expressionLabels={all:v('all'),any:v('any'),unrestricted:v('unrestricted'),unknown:v('unknown'),pass:t('pass'),fail:t('fail'),unknownMeasurement:v('unknownMeasurement'),allLeaveTypes:v('allLeaveTypes'),leaveTypes:v('leaveTypes'),metrics:Object.fromEntries(ALLOWANCE_METRICS_V3.map(field=>[field,t(`metrics.${field}`)])),operators:Object.fromEntries(ALLOWANCE_OPERATORS.map(operator=>[operator,t(`operators.${operator}`)])),units:Object.fromEntries(['hours','minutes','days','occurrences'].map(unit=>[unit,t(`units.${unit}`)]))};
  const [state,formAction,pending]=useActionState(action,{error:null});
  const [effectiveFrom,setEffectiveFrom]=useState(policy?.effectiveFrom??'');
  const [legacyCriteria,setLegacyCriteria]=useState<Record<string,number|boolean|undefined>>(policy?.criteria??{});
  const [companyId,setCompanyId]=useState(policy?.companyId??options.companies[0]?.id??'');
  const [policyType,setPolicyType]=useState(policy?.policyType??'earning');
  const [method,setMethod]=useState(policy?.method??'monthly');
  const [amount,setAmount]=useState(policy?.amount??'');
  const [code,setCode]=useState(policy?.code??'');
  const [name,setName]=useState(policy?.name??'');
  const [componentId,setComponentId]=useState(policy?.payComponentId??'');
  const [advanced,setAdvanced]=useState(!policy||!!policy.rules);
  const [rules,setRules]=useState<AllowanceRules>(policy?.rules??emptyAllowanceRulesV3());
  const [reviewed,setReviewed]=useState(false);
  const update=(next:AllowanceRules)=>{setRules(next);setReviewed(false);};
  const company=options.companies.find(c=>c.id===companyId);
  const scoped=<T extends {companyId:string|null;isGlobal?:boolean}>(rows:T[])=>rows.filter(r=>r.companyId==null||r.companyId===companyId||r.isGlobal);
  const employeeOptions=(field:AllowanceEmployeeField):{id:string;label:string}[]=>{
    if(field==='companyId')return options.companies.filter(c=>c.id===companyId);
    if(field==='departmentId')return scoped(options.departments);
    if(field==='businessUnitId')return scoped(options.businessUnits);
    if(field==='positionId')return scoped(options.positions);
    if(field==='gradeId')return options.grades;
    if(field==='employmentCategory')return options.categories.map(c=>({id:c,label:c}));
    if(field==='status')return ['active','terminated'].map(id=>({id,label:t(`status.${id}`)}));
    return ['full_time','part_time','contract','intern'].map(id=>({id,label:t(`employmentType.${id}`)}));
  };
  const mutateAttendance=(index:number,patch:Partial<AllowanceRules['attendance']['criteria'][number]>)=>{if(rules.v===2)update({...rules,attendance:{...rules.attendance,criteria:rules.attendance.criteria.map((c,i)=>i===index?{...c,...patch}:c)}});};
  const updateApplicability=(patch:Partial<Pick<AllowanceRules['attendance'],'dayKinds'|'shiftIds'>>)=>{
    if(rules.v===3)update({...rules,attendance:{...rules.attendance,...patch}});
    else update({...rules,attendance:{...rules.attendance,...patch}});
  };
  const component=components.find(c=>c.id===componentId);
  return <form id="attendance-allowance-editor" action={formAction} className="space-y-6" onChange={()=>setReviewed(false)}>
    <AttendanceSettingsNavigation formId="attendance-allowance-editor" savedRevision={policy?.version??0}/>
    {state.error&&<ErrorBanner message={state.error}/>}
    {policy&&<input type="hidden" name="id" value={policy.id}/>}
    <input type="hidden" name="rules" value={advanced?JSON.stringify(rules):''}/>
    <fieldset disabled={pending} className="space-y-6">
    <section className="space-y-4 rounded-2xl border border-border bg-card p-5">
      <h2 className="font-semibold">{t('sections.information')}</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('company')}><select name="companyId" value={companyId} disabled={!!policy} required className={inputCls} onChange={e=>{setCompanyId(e.target.value);update(emptyAllowanceRulesV3());}}>{options.companies.map(c=><option key={c.id} value={c.id}>{c.label}</option>)}</select>{policy&&<input type="hidden" name="companyId" value={companyId}/>}</Field>
        <Field label={t('policyType')}><select name="policyType" className={inputCls} value={policyType} onChange={e=>{setPolicyType(e.target.value);setComponentId('');}}><option value="earning">{t('earning')}</option><option value="deduction">{t('deduction')}</option></select></Field>
        <Field label={t('code')}><input name="code" value={code} onChange={e=>setCode(e.target.value)} required maxLength={80} className={inputCls}/></Field>
        <Field label={t('name')}><input name="name" value={name} onChange={e=>setName(e.target.value)} required maxLength={150} className={inputCls}/></Field>
        <Field label={t('method')}><select name="method" className={inputCls} value={method} onChange={e=>setMethod(e.target.value)}>{(advanced?['monthly','weekly','daily']:['monthly']).map(m=><option key={m} value={m}>{t(`methods.${m}`)}</option>)}</select></Field>
        <Field label={`${t('amount')} (${company?.currency??'—'})`}><input name="amount" type="number" value={amount} onChange={e=>setAmount(e.target.value)} required min="0" step="0.01" className={inputCls}/></Field>
        <Field label={policyType==='deduction'?t('deductionCode'):t('earningCode')}><select name="payComponentId" className={inputCls} value={componentId} onChange={e=>setComponentId(e.target.value)} required><option value="">{t('chooseCode')}</option>{components.filter(c=>policyType==='deduction'?c.kind==='deduction':c.kind==='allowance').map(c=><option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}</select></Field>
        <Field label={t('effectiveFrom')}><input name="effectiveFrom" type="date" required value={effectiveFrom} onChange={e=>setEffectiveFrom(e.target.value)} className={inputCls}/></Field>
      </div>
      {policy?.rules?.v===2&&rules.v===2&&<div className="space-y-2 rounded-xl bg-muted p-3 text-sm"><p>{v('versionNotice')}</p><button type="button" className="text-primary" onClick={()=>{if(rules.v===2)update(upgradeAllowanceRules(rules));}}>{v('upgrade')}</button></div>}
      {policy&&!policy.rules&&<div className="space-y-2 rounded-xl bg-muted p-3 text-sm"><p>{t('legacyNotice')}</p><label className="flex gap-2"><input type="checkbox" checked={advanced} onChange={e=>{setAdvanced(e.target.checked);if(!e.target.checked)setMethod('monthly');}}/>{t('convertLegacy')}</label></div>}
      <p className="text-sm text-muted-foreground">{rules.v===3&&advanced?v('fixedRule'):t('fixedRule')}</p>
    </section>
    <section className="space-y-4 rounded-2xl border border-border bg-card p-5"><h2 className="font-semibold">{t('sections.employees')}</h2>
      {advanced?<>
        <Field label={t('selection')}><select className={inputCls} value={rules.employee.mode} onChange={e=>update({...rules,employee:{...rules.employee,mode:e.target.value as AllowanceRules['employee']['mode']}})}>{['all','selected','criteria'].map(m=><option key={m} value={m}>{t(`selectionModes.${m}`)}</option>)}</select></Field>
        {rules.employee.mode==='selected'&&<Field label={t('employees')}><select multiple size={8} className={inputCls} value={rules.employee.employmentIds} onChange={e=>update({...rules,employee:{...rules.employee,employmentIds:selected(e)}})}>{scoped(options.employees).map(e=><option key={e.id} value={e.id}>{e.label}</option>)}</select></Field>}
        {rules.employee.mode==='criteria'&&<>
          <Field label={t('employeeLogic')}><select className={inputCls} value={rules.employee.logic} onChange={e=>update({...rules,employee:{...rules.employee,logic:e.target.value as 'and'|'or'}})}><option value="and">{t('and')}</option><option value="or">{t('or')}</option></select></Field>
          {rules.employee.criteria.map((c,index)=><div key={index} className="grid gap-3 rounded-xl border border-border p-3 sm:grid-cols-4">
            <Field label={t('field')}><select className={inputCls} value={c.field} onChange={e=>update({...rules,employee:{...rules.employee,criteria:rules.employee.criteria.map((r,i)=>i===index?{...r,field:e.target.value as AllowanceEmployeeField,values:[]}:r)}})}>{ALLOWANCE_EMPLOYEE_FIELDS.map(f=><option key={f} value={f}>{t(`employeeFields.${f}`)}</option>)}</select></Field>
            <Field label={t('operator')}><select className={inputCls} value={c.operator} onChange={e=>update({...rules,employee:{...rules.employee,criteria:rules.employee.criteria.map((r,i)=>i===index?{...r,operator:e.target.value as 'in'|'notIn'}:r)}})}><option value="in">{t('operators.in')}</option><option value="notIn">{t('operators.notIn')}</option></select></Field>
            <Field label={t('values')}><select multiple size={4} className={inputCls} value={c.values} onChange={e=>update({...rules,employee:{...rules.employee,criteria:rules.employee.criteria.map((r,i)=>i===index?{...r,values:selected(e)}:r)}})}>{employeeOptions(c.field).map(v=><option key={v.id} value={v.id}>{v.label}</option>)}</select></Field>
            <button type="button" className="self-end text-sm text-destructive" onClick={()=>update({...rules,employee:{...rules.employee,criteria:rules.employee.criteria.filter((_,i)=>i!==index)}})}>{t('remove')}</button>
          </div>)}
          <button type="button" className="text-sm text-primary" onClick={()=>update({...rules,employee:{...rules.employee,criteria:[...rules.employee.criteria,{field:'departmentId',operator:'in',values:[]}]}})}>{t('addEmployeeCriterion')}</button>
        </>}
        <p className="text-sm text-muted-foreground">{t('employeeRule')}</p>
      </>:<><p className="text-sm text-muted-foreground">{t('legacyScope')}</p>{Object.entries(policy?.scope??{}).map(([key,values])=><div key={key}><p className="text-sm">{key}: {(values as string[]).length}</p>{(values as string[]).map(value=><input type="hidden" key={value} name={key} value={value}/>)}</div>)}</>}
    </section>
    <section className="space-y-4 rounded-2xl border border-border bg-card p-5"><h2 className="font-semibold">{t('sections.attendance')}</h2>
      {advanced?<>
        <fieldset className="space-y-2"><legend className="text-xs font-medium text-muted-foreground">{t('dayTypes')}</legend><div className="flex flex-wrap gap-4">{ALLOWANCE_DAY_KINDS.map(k=><label key={k} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={rules.attendance.dayKinds.includes(k)} onChange={e=>updateApplicability({dayKinds:e.target.checked?[...rules.attendance.dayKinds,k]:rules.attendance.dayKinds.filter(v=>v!==k)})}/>{t(`dayKinds.${k}`)}</label>)}</div></fieldset><p className="text-xs text-muted-foreground">{t('allDaysHint')}</p>
        <AllowanceChoices key={companyId} label={t('shifts')} choices={scoped(options.shifts)} values={rules.attendance.shiftIds} onChange={shiftIds=>updateApplicability({shiftIds})}/><p className="text-xs text-muted-foreground">{v('allShiftsHint')}</p>
        {rules.v===3?<AttendanceAllowanceExpressionEditor value={rules.attendance.expression} leaveTypes={options.leaveTypes.filter(type=>type.companyId===companyId)} onChange={expression=>update({...rules,attendance:{...rules.attendance,expression}})}/>:<>
        <Field label={t('attendanceLogic')}><select className={inputCls} value={rules.attendance.logic} onChange={e=>update({...rules,attendance:{...rules.attendance,logic:e.target.value as 'and'|'or'}})}><option value="and">{t('and')}</option><option value="or">{t('or')}</option></select></Field>
        {rules.attendance.criteria.map((c,index)=><div key={index} className="grid gap-3 rounded-xl border border-border p-3 sm:grid-cols-5">
          <Field label={t('field')}><select className={inputCls} value={c.field} onChange={e=>{const field=e.target.value as AllowanceMetric;mutateAttendance(index,{field,unit:field.endsWith('Minutes')?'hours':'days'});}}>{ALLOWANCE_METRICS.map(f=><option key={f} value={f}>{t(`metrics.${f}`)}</option>)}</select></Field>
          <Field label={t('operator')}><select className={inputCls} value={c.operator} onChange={e=>mutateAttendance(index,{operator:e.target.value as typeof c.operator})}>{ALLOWANCE_OPERATORS.map(op=><option key={op} value={op}>{t(`operators.${op}`)}</option>)}</select></Field>
          <Field label={t('threshold')}><input type="number" min="0" step="0.01" className={inputCls} required value={c.value} onChange={e=>mutateAttendance(index,{value:e.target.value})}/>{c.operator==='between'&&<input aria-label={t('upper')} type="number" min="0" step="0.01" className={`${inputCls} mt-2`} required value={c.upper??''} onChange={e=>mutateAttendance(index,{upper:e.target.value})}/>}</Field>
          <Field label={t('unit')}><select className={inputCls} value={c.unit} onChange={e=>mutateAttendance(index,{unit:e.target.value as typeof c.unit})}>{(c.field.endsWith('Minutes')?['hours','minutes']:['days']).map(unit=><option key={unit} value={unit}>{t(`units.${unit}`)}</option>)}</select></Field>
          <button type="button" className="self-end text-sm text-destructive" onClick={()=>update({...rules,attendance:{...rules.attendance,criteria:rules.attendance.criteria.filter((_,i)=>i!==index)}})}>{t('remove')}</button>
        </div>)}
        <button type="button" className="text-sm text-primary" onClick={()=>update({...rules,attendance:{...rules.attendance,criteria:[...rules.attendance.criteria,{field:'actualMinutes',operator:'gte',value:'8',unit:'hours'}]}})}>{t('addAttendanceCriterion')}</button></>}
        <p className="text-sm text-muted-foreground">{rules.v===3?v('measurementsHint'):t('measurementsHint')}</p>
      </>:<div className="grid gap-3 sm:grid-cols-2">{['minAttendanceDays','maxAbsentDays','maxLateCount','maxTotalLeaveDays'].map(key=><Field key={key} label={t(`legacyCriteria.${key}`)}><input name={key} type="number" min="0" step="1" className={inputCls} value={legacyCriteria[key]===undefined?'':String(legacyCriteria[key])} onChange={e=>setLegacyCriteria({...legacyCriteria,[key]:e.target.value===''?undefined:Number(e.target.value)})}/></Field>)}<label className="flex gap-2 text-sm"><input type="checkbox" name="requirePerfectAttendance" checked={legacyCriteria.requirePerfectAttendance===true} onChange={e=>setLegacyCriteria({...legacyCriteria,requirePerfectAttendance:e.target.checked})}/>{t('legacyCriteria.requirePerfectAttendance')}</label></div>}
    </section>
    <section className="space-y-4 rounded-2xl border border-border bg-card p-5"><h2 className="font-semibold">{t('sections.review')}</h2>
      <dl className="grid gap-2 text-sm sm:grid-cols-2"><div><dt className="text-muted-foreground">{t('code')}</dt><dd>{code} · {name}</dd></div><div><dt className="text-muted-foreground">{t('policyType')}</dt><dd>{policyType==='deduction'?t('deduction'):t('earning')} · {t(`methods.${method}`)}</dd></div><div><dt className="text-muted-foreground">{t('amount')}</dt><dd>{company?.currency} {amount||'—'}</dd></div><div><dt className="text-muted-foreground">{t('payrollCode')}</dt><dd>{component?.code??'—'}</dd></div></dl>
      <p className="text-sm">{t('company')}: {company?.label} · {t('effectiveFrom')}: {effectiveFrom||'—'}</p>
      {advanced&&<div className="space-y-2 text-sm">
        <p>{t(`selectionModes.${rules.employee.mode}`)} · {t('employeeLogic')}: {rules.employee.logic.toUpperCase()}</p>
        {rules.employee.mode==='selected'&&<p>{rules.employee.employmentIds.map(id=>options.employees.find(e=>e.id===id)?.label??id).join(', ')}</p>}
        {rules.employee.mode==='criteria'&&rules.employee.criteria.map((c,i)=><p key={i}>{t(`employeeFields.${c.field}`)} {t(`operators.${c.operator}`)} {c.values.map(value=>employeeOptions(c.field).find(v=>v.id===value)?.label??value).join(', ')}</p>)}
        <p>{t('dayTypes')}: {rules.attendance.dayKinds.length?rules.attendance.dayKinds.map(k=>t(`dayKinds.${k}`)).join(', '):t('allDays')}</p>
        <p>{t('shifts')}: {rules.attendance.shiftIds.length?rules.attendance.shiftIds.map(id=>options.shifts.find(s=>s.id===id)?.label??id).join(', '):t('allShifts')}</p>
        {rules.v===3?<AllowanceExpressionView node={rules.attendance.expression} labels={expressionLabels} leaveTypes={options.leaveTypes}/>:<><p>{t('attendanceLogic')}: {rules.attendance.logic.toUpperCase()}</p>
        <ul className="space-y-1">{rules.attendance.criteria.map((c,i)=><li key={i}>{t(`metrics.${c.field}`)} {t(`operators.${c.operator}`)} {c.value}{c.operator==='between'?` – ${c.upper??'—'}`:''} {t(`units.${c.unit}`)}</li>)}</ul></>}
      </div>}
      {method==='weekly'&&<p className="rounded-xl bg-muted p-3 text-sm">{t('weeklyRule')}</p>}
      <p className="text-sm text-muted-foreground">{t('reviewWarning')}</p>{advanced&&rules.v===3&&<p className="text-sm text-muted-foreground">{v('activationHint')}</p>}
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" required name="reviewed" checked={reviewed} onChange={e=>{e.stopPropagation();setReviewed(e.target.checked);}}/>{t('reviewConfirm')}</label>
      <div className="flex items-center gap-4"><button type="submit" className={btnPrimary} disabled={!reviewed||pending}>{advanced&&rules.v===3?v('savePreview'):t('save')}</button><a className="text-sm text-muted-foreground" href="/admin/attendance-allowance">{t('cancel')}</a></div>
    </section>
    </fieldset>
  </form>;
}
