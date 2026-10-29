'use client';

import {useTranslations} from 'next-intl';
import {Field, inputCls} from '@/components/ui';
import type {OvertimePattern,OvertimeExpression,OvertimeRate,OvertimePayment} from '@/lib/overtime-pattern-model';
import {OvertimeScrollTable} from './scroll-table';
import {OvertimeSelectionValues} from './selection-values';
import {overtimeEligibilityContradiction,overtimeSelectedEmployees,withOvertimeSelectedEmployees,overtimeClockInput,overtimeClockToMinutes} from '@/lib/overtime-pattern-guided';
import {OVERTIME_LIMITS} from '@/lib/overtime-pattern-model';
import {ExpressionControl,ConditionControl,blankLiteral,blankCondition,ruleId,type OvertimeChoices,type OvertimeChoice} from './rule-controls';

const button='min-h-10 rounded-lg border border-border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50';
const roundingModes=['down','up','halfUp','halfEven'] as const;
type Props={pattern:OvertimePattern;onChange:(pattern:OvertimePattern)=>void;choices:OvertimeChoices;issues?:import('@/lib/overtime-pattern-model').OvertimeIssue[]};

function OptionalExpression({value,onChange,label,...props}:{value:OvertimeExpression|null;onChange:(value:OvertimeExpression|null)=>void;label:string;unit:'minutes'|'money';currency:string;choices:OvertimeChoices;definitions:string[]}) {
  const t=useTranslations('overtimePatterns');
  return <div className="space-y-3"><label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={value!==null} onChange={event=>onChange(event.target.checked?blankLiteral(props.unit,props.currency):null)}/>{label}</label>
    {value?<ExpressionControl {...props} label={label} value={value} onChange={onChange}/>:null}
  </div>;
}

export function OvertimeEligibilitySection({pattern,onChange,choices}:Props) {
 const t=useTranslations('overtimePatterns');
 const salary=()=>{
  const condition:import('@/lib/overtime-pattern-model').OvertimeCondition={id:ruleId(),type:'compare',operator:'lt',left:{id:ruleId(),type:'field',field:'basicSalary',unit:'money'},right:blankLiteral('money',pattern.currency.code)};
  const old=pattern.eligibility;
  onChange({...pattern,eligibility:old.type==='group'&&old.logic==='and'?{...old,children:[...old.children,condition]}:{id:ruleId(),type:'group',logic:'and',children:[old,condition]}});
 };
 return <div className="space-y-6"><h2 className="font-semibold">{t('guided.employeeEligibility')}</h2>{overtimeEligibilityContradiction(pattern.eligibility)?<p role="status" className="rounded-lg border border-border p-3 text-sm">{t('guided.contradiction')}</p>:null}<label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={overtimeSelectedEmployees(pattern.eligibility)!==null} onChange={event=>onChange(withOvertimeSelectedEmployees(pattern,event.target.checked?[]:null))}/>{t('guided.selectedEmployees')}</label>{overtimeSelectedEmployees(pattern.eligibility)!==null?<OvertimeSelectionValues field="employmentId" options={choices.employmentId??[]} selected={overtimeSelectedEmployees(pattern.eligibility)??[]} onChange={values=>onChange(withOvertimeSelectedEmployees(pattern,values))}/>:null}<h2 className="border-t border-border pt-5 font-semibold">{t('guided.eligibilityConditions')}</h2><p className="max-w-3xl text-sm text-muted-foreground">{t('guided.salaryDateHelp')}</p><button type="button" className={button} onClick={salary}>{t('guided.addSalaryCondition')}</button><ConditionControl value={pattern.eligibility} onChange={eligibility=>onChange({...pattern,eligibility})} currency={pattern.currency.code} choices={choices} definitions={pattern.definitions.map(item=>item.id)}/></div>;
}

export function OvertimeFormulaSection({pattern,onChange,choices,resources,earningItems}:{resources:OvertimeChoice[];earningItems:OvertimeChoice[]}&Props) {
  const t=useTranslations('overtimePatterns');
  const props={currency:pattern.currency.code,choices,definitions:pattern.definitions.map(item=>item.id)};
  const optional=props;
  return <div className="space-y-6">
    <p className="text-sm text-muted-foreground">{t('formulaHelp')}</p>
    <OptionalExpression {...optional} label={t('eligibleMinutes')} unit="minutes" value={pattern.eligibleMinutes} onChange={eligibleMinutes=>onChange({...pattern,eligibleMinutes})}/>
    <OptionalExpression {...optional} label={t('durationCap')} unit="minutes" value={pattern.durationCap} onChange={durationCap=>onChange({...pattern,durationCap})}/>
    <label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={pattern.durationRounding!==null} onChange={event=>onChange({...pattern,durationRounding:event.target.checked?{step:'',mode:'down'}:null})}/>{t('durationRounding')}</label>
    {pattern.durationRounding?<div className="grid gap-3 sm:grid-cols-2">
      <Field label={t('roundStep')}><input className={inputCls} inputMode="decimal" value={pattern.durationRounding.step} onChange={event=>onChange({...pattern,durationRounding:{...pattern.durationRounding!,step:event.target.value}})}/></Field>
      <Field label={t('roundMode')}><select className={inputCls} value={pattern.durationRounding.mode} onChange={event=>onChange({...pattern,durationRounding:{...pattern.durationRounding!,mode:event.target.value as typeof roundingModes[number]}})}>{roundingModes.map(mode=><option key={mode} value={mode}>{t(`rounding.${mode}`)}</option>)}</select></Field>
    </div>:null}
    <div className="space-y-4 border-t border-border pt-4"><h3 className="font-semibold">{t('deductions')}</h3><p className="text-sm text-muted-foreground">{t('deductionHelp')}</p>
      {pattern.deductions.map((deduction,index)=><details key={deduction.id} className="rounded-lg border border-border p-3" open><summary className="cursor-pointer py-2 font-medium">{t('numberedDeduction',{number:index+1})}</summary><div className="space-y-3 pt-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('resource')}><select className={inputCls} value={deduction.resource} onChange={event=>onChange({...pattern,deductions:pattern.deductions.map((old,i)=>i===index?{...old,resource:event.target.value}:old)})}><option value="">{t('choose')}</option>{resources.map(resource=><option key={resource.id} value={resource.id}>{resource.label}</option>)}</select></Field>
          <Field label={t('basis')}><select className={inputCls} value={deduction.basis} onChange={event=>onChange({...pattern,deductions:pattern.deductions.map((old,i)=>i===index?{...old,basis:event.target.value as 'day'|'session'}:old)})}><option value="day">{t('bases.day')}</option><option value="session">{t('bases.session')}</option></select></Field>
          <Field label={t('unit')}><select className={inputCls} value={deduction.unit} onChange={event=>{const unit=event.target.value as 'minutes'|'money';onChange({...pattern,deductions:pattern.deductions.map((old,i)=>i===index?{...old,unit,amount:blankLiteral(unit,pattern.currency.code)}:old)});}}><option value="minutes">{t('units.minutes')}</option><option value="money">{t('units.money')}</option></select></Field>
          {deduction.unit==='money'?<Field label={t('targetItem')}><select className={inputCls} value={deduction.targetEarningItemId??''} onChange={event=>onChange({...pattern,deductions:pattern.deductions.map((old,i)=>i===index?{...old,targetEarningItemId:event.target.value}:old)})}><option value="">{t('choose')}</option>{earningItems.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></Field>:null}
        </div>
        <ConditionControl {...props} value={deduction.when} onChange={when=>onChange({...pattern,deductions:pattern.deductions.map((old,i)=>i===index?{...old,when}:old)})}/>
        <ExpressionControl {...props} label={t('deductionAmount')} value={deduction.amount} onChange={amount=>onChange({...pattern,deductions:pattern.deductions.map((old,i)=>i===index?{...old,amount}:old)})}/>
        <button type="button" className={button} onClick={()=>onChange({...pattern,deductions:pattern.deductions.filter((_,i)=>i!==index)})}>{t('remove')}</button>
      </div></details>)}
      <button type="button" className={button} disabled={pattern.deductions.length>=OVERTIME_LIMITS.deductions} onClick={()=>onChange({...pattern,deductions:[...pattern.deductions,{id:ruleId(),resource:'',basis:'day',unit:'minutes',when:blankCondition(),amount:blankLiteral('minutes',pattern.currency.code)}]})}>{t('addDeduction')}</button>
    </div>
    <OptionalExpression {...optional} label={t('paymentCap')} unit="money" value={pattern.paymentCap} onChange={paymentCap=>onChange({...pattern,paymentCap})}/>
    <div className="grid gap-3 sm:grid-cols-2"><Field label={t('moneyRoundingStage')}><select className={inputCls} value={pattern.moneyRounding.stage} onChange={event=>onChange({...pattern,moneyRounding:{...pattern.moneyRounding,stage:event.target.value as 'line'|'dayMapping'}})}><option value="line">{t('line')}</option><option value="dayMapping">{t('dayMapping')}</option></select></Field><Field label={t('roundMode')}><select className={inputCls} value={pattern.moneyRounding.mode} onChange={event=>onChange({...pattern,moneyRounding:{...pattern.moneyRounding,mode:event.target.value as typeof roundingModes[number]}})}>{roundingModes.map(mode=><option key={mode} value={mode}>{t(`rounding.${mode}`)}</option>)}</select></Field></div>
    <div className="space-y-3 border-t border-border pt-4"><h3 className="font-semibold">{t('definitions')}</h3>
      {pattern.definitions.map((definition,index)=><div key={definition.id} className="space-y-2"><h4 className="text-sm font-medium">{t('numberedDefinition',{number:index+1})}</h4><ExpressionControl {...props} label={t('definition')} value={definition.expression} onChange={expression=>onChange({...pattern,definitions:pattern.definitions.map((old,i)=>i===index?{...old,expression}:old)})}/><button type="button" className={button} onClick={()=>onChange({...pattern,definitions:pattern.definitions.filter((_,i)=>i!==index)})}>{t('remove')}</button></div>)}
      <button type="button" className={button} disabled={pattern.definitions.length>=OVERTIME_LIMITS.definitions} onClick={()=>onChange({...pattern,definitions:[...pattern.definitions,{id:ruleId(),expression:blankLiteral('money',pattern.currency.code)}]})}>{t('addDefinition')}</button>
    </div>
  </div>;
}

function PaymentControl({payment,onChange,...props}:{payment:OvertimePayment;onChange:(payment:OvertimePayment)=>void;currency:string;choices:OvertimeChoices;definitions:string[]}) {
  const t=useTranslations('overtimePatterns');
  return <div className="space-y-3"><Field label={t('method')}><select className={inputCls} value={payment.method} onChange={event=>{const method=event.target.value as OvertimePayment['method'];onChange(method==='hourly'?{method,rate:blankLiteral('moneyPerHour',props.currency),multiplier:blankLiteral('scalar',props.currency)}:{method,basis:'day',chargeId:ruleId(),amount:blankLiteral('money',props.currency)});}}>{['hourly','flat','formula'].map(method=><option key={method} value={method}>{t(`methods.${method}`)}</option>)}</select></Field>
    {payment.method==='hourly'?<><ExpressionControl {...props} label={t('hourlyRate')} value={payment.rate} onChange={rate=>onChange({...payment,rate})}/><ExpressionControl {...props} label={t('multiplier')} value={payment.multiplier} onChange={multiplier=>onChange({...payment,multiplier})}/></>:<>
      <Field label={t('basis')}><select className={inputCls} value={payment.basis} onChange={event=>onChange({...payment,basis:event.target.value as typeof payment.basis})}>{['day','session','tier',...(payment.method==='formula'?['slice']:[])].map(basis=><option key={basis} value={basis}>{t(`bases.${basis}`)}</option>)}</select></Field>
      <ExpressionControl {...props} label={t('amount')} value={payment.amount} onChange={amount=>onChange({...payment,amount})}/>
    </>}
  </div>;
}
export function OvertimeRatesSection({pattern,onChange,choices,issues=[]}:Props) {
 const t=useTranslations('overtimePatterns');
 const props={currency:pattern.currency.code,choices,definitions:pattern.definitions.map(item=>item.id)};
 function replace(index:number,rate:OvertimeRate){onChange({...pattern,rates:pattern.rates.map((old,i)=>i===index?rate:old)});}
 return <div className="space-y-6"><p className="max-w-3xl text-sm text-muted-foreground">{t('guided.rangeHelp')}</p>
  {pattern.rates.map((rate,index)=>{
   const changeTier=(tierIndex:number,patch:Partial<typeof rate.tiers[number]>)=>replace(index,{...rate,tiers:rate.tiers.map((tier,i)=>i===tierIndex?{...tier,...patch}:tier)});
   return <section key={rate.id} className="space-y-4 border-b border-border pb-6">
    <div className="grid gap-3 sm:grid-cols-2"><Field label={t('rateName')}><input className={inputCls} maxLength={120} value={rate.name} onChange={event=>replace(index,{...rate,name:event.target.value})}/></Field><Field label={t('description')}><input className={inputCls} maxLength={1000} value={rate.description} onChange={event=>replace(index,{...rate,description:event.target.value})}/></Field></div>
    <OvertimeScrollTable label={`${t('guided.rates')} · ${rate.name||t('numberedRate',{number:index+1})}`}><table className="w-full min-w-[58rem] text-sm"><caption className="sr-only">{rate.name||t('numberedRate',{number:index+1})}</caption><thead className="bg-muted/50 text-left text-xs text-muted-foreground"><tr>{['fromClock','toClock','method','rateValue','rounding','roundInterval','action'].map(key=><th key={key} scope="col" className="px-2 py-3">{t(`guided.${key}`)}</th>)}</tr></thead><tbody className="divide-y divide-border">
     {rate.tiers.map((tier,tierIndex)=><tr key={tier.id} className={`align-top ${issues.some(issue=>issue.path.startsWith(`rates.${index}.tiers.${tierIndex}`))?'bg-destructive/10':''}`}>
      <td className="min-w-28 p-2"><input aria-invalid={issues.some(issue=>issue.path.startsWith(`rates.${index}.tiers.${tierIndex}`))} aria-label={t('guided.fromFor',{row:tierIndex+1})} className={inputCls} placeholder="0:00" value={overtimeClockInput(tier.from)} onChange={event=>changeTier(tierIndex,{from:overtimeClockToMinutes(event.target.value)})}/></td>
      <td className="min-w-28 p-2"><input aria-invalid={issues.some(issue=>issue.path.startsWith(`rates.${index}.tiers.${tierIndex}`))} aria-label={t('guided.toFor',{row:tierIndex+1})} className={inputCls} placeholder={t('unbounded')} value={overtimeClockInput(tier.to)} onChange={event=>changeTier(tierIndex,{to:event.target.value===''?null:overtimeClockToMinutes(event.target.value)})}/></td>
      <td className="min-w-32 p-2"><select aria-label={t('guided.methodFor',{row:tierIndex+1})} className={inputCls} value={tier.payment.method} onChange={event=>{const method=event.target.value as OvertimePayment['method'];changeTier(tierIndex,{payment:method==='hourly'?{method,rate:blankLiteral('moneyPerHour',pattern.currency.code),multiplier:blankLiteral('scalar',pattern.currency.code)}:{method,basis:'day',chargeId:ruleId(),amount:blankLiteral('money',pattern.currency.code)}});}}>{['hourly','flat','formula'].map(method=><option key={method} value={method}>{t(`methods.${method}`)}</option>)}</select></td>
      <td className="min-w-32 p-2">{tier.payment.method==='hourly'&&tier.payment.multiplier.type==='literal'?<input aria-label={t('guided.rateFor',{row:tierIndex+1})} inputMode="decimal" className={inputCls} value={tier.payment.multiplier.value} onChange={event=>{if(tier.payment.method==='hourly'&&tier.payment.multiplier.type==='literal')changeTier(tierIndex,{payment:{...tier.payment,multiplier:{...tier.payment.multiplier,value:event.target.value}}});}}/>:<span className="block py-2 text-muted-foreground">{t('guided.configuredFormula')}</span>}
       <details className="mt-2"><summary className="cursor-pointer text-xs text-primary">{t('guided.paymentDetails')}</summary><div className="mt-3 min-w-72"><PaymentControl {...props} payment={tier.payment} onChange={payment=>changeTier(tierIndex,{payment})}/></div></details></td>
      <td className="min-w-32 p-2"><select aria-label={t('guided.roundingFor',{row:tierIndex+1})} className={inputCls} disabled={!!pattern.durationRounding} value={tier.rounding?.mode??'none'} onChange={event=>changeTier(tierIndex,{rounding:event.target.value==='none'?null:{step:tier.rounding?.step??'',mode:event.target.value as typeof roundingModes[number]}})}><option value="none">{t('guided.noRounding')}</option>{roundingModes.map(mode=><option key={mode} value={mode}>{t(`rounding.${mode}`)}</option>)}</select></td>
      <td className="min-w-28 p-2"><input aria-label={t('guided.intervalFor',{row:tierIndex+1})} className={inputCls} placeholder="0:15" disabled={!tier.rounding} value={overtimeClockInput(tier.rounding?.step??null)} onChange={event=>{if(tier.rounding)changeTier(tierIndex,{rounding:{...tier.rounding,step:overtimeClockToMinutes(event.target.value)}});}}/></td>
      <td className="p-2"><button type="button" className={button} aria-label={t('guided.removeFor',{row:tierIndex+1})} onClick={()=>replace(index,{...rate,tiers:rate.tiers.filter((_,i)=>i!==tierIndex)})}>{t('removeTier')}</button></td>
     </tr>)}
    </tbody></table></OvertimeScrollTable>
    <p className="text-xs text-muted-foreground">{t(pattern.durationRounding?'guided.patternRounding':'guided.rowRoundingHelp')}</p>
    <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={rate.tiers.length>=OVERTIME_LIMITS.tiers} onClick={()=>replace(index,{...rate,tiers:[...rate.tiers,{id:ruleId(),from:rate.tiers.length?rate.tiers[rate.tiers.length-1].to??'':'0',to:null,payment:{method:'hourly',rate:blankLiteral('moneyPerHour',pattern.currency.code),multiplier:blankLiteral('scalar',pattern.currency.code)},mapping:{earningItemId:'',currency:pattern.currency.code}}]})}>{t('addTier')}</button><button type="button" className={button} onClick={()=>onChange({...pattern,rates:pattern.rates.filter((_,i)=>i!==index)})}>{t('removeRate')}</button></div>
    <details><summary className="cursor-pointer text-sm font-medium text-primary">{t('guided.rateConditions')}</summary><div className="mt-4 space-y-4">
     <div className="grid gap-3 sm:grid-cols-3"><Field label={t('priority')}><input type="number" step="1" min="0" max="9999" className={inputCls} value={Number.isFinite(rate.priority)?rate.priority:''} onChange={event=>replace(index,{...rate,priority:event.currentTarget.valueAsNumber})}/></Field><Field label={t('accumulation')}><select className={inputCls} value={rate.accumulation} onChange={event=>replace(index,{...rate,accumulation:event.target.value as 'day'|'session'})}><option value="day">{t('bases.day')}</option><option value="session">{t('bases.session')}</option></select></Field><Field label={t('tierMode')}><select className={inputCls} value={rate.tierMode} onChange={event=>replace(index,{...rate,tierMode:event.target.value as 'marginal'|'whole'})}><option value="marginal">{t('marginal')}</option><option value="whole">{t('whole')}</option></select></Field></div>
     <ConditionControl {...props} value={rate.when} onChange={when=>replace(index,{...rate,when})}/>
     <label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={rate.timeBand!==null} onChange={event=>replace(index,{...rate,timeBand:event.target.checked?{fromMinute:0,toMinute:0,endDayOffset:0}:null})}/>{t('timeBand')}</label>
     {rate.timeBand?<div className="grid gap-3 sm:grid-cols-3">{(['fromMinute','toMinute'] as const).map(key=><Field key={key} label={t(key)}><input type="time" className={inputCls} disabled={key==='toMinute'&&rate.timeBand!.toMinute===1440} value={rate.timeBand![key]===1440?'00:00':`${String(Math.floor(rate.timeBand![key]/60)).padStart(2,'0')}:${String(rate.timeBand![key]%60).padStart(2,'0')}`} onChange={event=>{const [hours,minutes]=event.target.value.split(':').map(Number);replace(index,{...rate,timeBand:{...rate.timeBand!,[key]:hours*60+minutes}});}}/></Field>)}<Field label={t('endDayOffset')}><select className={inputCls} value={rate.timeBand.endDayOffset} onChange={event=>replace(index,{...rate,timeBand:{...rate.timeBand!,endDayOffset:Number(event.target.value) as 0|1}})}><option value="0">{t('sameDay')}</option><option value="1">{t('nextDay')}</option></select></Field><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={rate.timeBand.toMinute===1440} onChange={event=>replace(index,{...rate,timeBand:{...rate.timeBand!,toMinute:event.target.checked?1440:0,endDayOffset:0}})}/>{t('endOfDay')}</label></div>:null}
    </div></details>
   </section>;
  })}
  <button type="button" className={button} disabled={pattern.rates.length>=OVERTIME_LIMITS.rates} onClick={()=>onChange({...pattern,rates:[...pattern.rates,{id:ruleId(),name:'',description:'',priority:0,when:blankCondition(),timeBand:null,accumulation:'day',tierMode:'marginal',tiers:[]}]})}>{t('addRate')}</button>
 </div>;
}
export function OvertimeMappingSection({pattern,onChange,earningItems}:{pattern:OvertimePattern;onChange:(pattern:OvertimePattern)=>void;earningItems:OvertimeChoice[]}) {
  const t=useTranslations('overtimePatterns');
  return <div className="space-y-4"><p className="text-sm text-muted-foreground">{t('mappingHelp')}</p>{pattern.rates.flatMap((rate,rateIndex)=>rate.tiers.map((tier,tierIndex)=><Field key={tier.id} label={t('rateTier',{rate:rateIndex+1,tier:tierIndex+1})}><select className={inputCls} value={tier.mapping.earningItemId} onChange={event=>onChange({...pattern,rates:pattern.rates.map((old,i)=>i===rateIndex?{...old,tiers:old.tiers.map((oldTier,j)=>j===tierIndex?{...oldTier,mapping:{earningItemId:event.target.value,currency:pattern.currency.code}}:oldTier)}:old)})}><option value="">{t('choose')}</option>{earningItems.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}{tier.mapping.earningItemId&&!earningItems.some(item=>item.id===tier.mapping.earningItemId)?<option value={tier.mapping.earningItemId}>{t('unavailableReference',{id:tier.mapping.earningItemId})}</option>:null}</select></Field>))}</div>;
}
