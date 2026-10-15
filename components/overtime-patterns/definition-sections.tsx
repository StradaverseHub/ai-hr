'use client';

import {useTranslations} from 'next-intl';
import {Field, inputCls} from '@/components/ui';
import type {OvertimePattern,OvertimeExpression,OvertimeRate,OvertimePayment} from '@/lib/overtime-pattern-model';
import {OVERTIME_LIMITS} from '@/lib/overtime-pattern-model';
import {ExpressionControl,ConditionControl,blankLiteral,blankCondition,ruleId,type OvertimeChoices,type OvertimeChoice} from './rule-controls';

const button='min-h-10 rounded-lg border border-border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50';
const roundingModes=['down','up','halfUp','halfEven'] as const;
type Props={pattern:OvertimePattern;onChange:(pattern:OvertimePattern)=>void;choices:OvertimeChoices};

function OptionalExpression({value,onChange,label,...props}:{value:OvertimeExpression|null;onChange:(value:OvertimeExpression|null)=>void;label:string;unit:'minutes'|'money';currency:string;choices:OvertimeChoices;definitions:string[]}) {
  const t=useTranslations('overtimePatterns');
  return <div className="space-y-3"><label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={value!==null} onChange={event=>onChange(event.target.checked?blankLiteral(props.unit,props.currency):null)}/>{label}</label>
    {value?<ExpressionControl {...props} label={label} value={value} onChange={onChange}/>:null}
  </div>;
}

export function OvertimeEligibilitySection({pattern,onChange,choices}:Props) {
  return <ConditionControl value={pattern.eligibility} onChange={eligibility=>onChange({...pattern,eligibility})} currency={pattern.currency.code} choices={choices} definitions={pattern.definitions.map(item=>item.id)}/>;
}

export function OvertimeFormulaSection({pattern,onChange,choices,resources}:{resources:OvertimeChoice[]}&Props) {
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
          {deduction.unit==='money'?<Field label={t('targetItem')}><select className={inputCls} value={deduction.targetEarningItemId??''} onChange={event=>onChange({...pattern,deductions:pattern.deductions.map((old,i)=>i===index?{...old,targetEarningItemId:event.target.value}:old)})}><option value="">{t('choose')}</option>{choicesForMapping(pattern).map(id=><option key={id} value={id}>{id}</option>)}</select></Field>:null}
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
function choicesForMapping(pattern:OvertimePattern) {return [...new Set(pattern.rates.flatMap(rate=>rate.tiers.map(tier=>tier.mapping.earningItemId)).filter(Boolean))];}

function PaymentControl({payment,onChange,...props}:{payment:OvertimePayment;onChange:(payment:OvertimePayment)=>void;currency:string;choices:OvertimeChoices;definitions:string[]}) {
  const t=useTranslations('overtimePatterns');
  return <div className="space-y-3"><Field label={t('method')}><select className={inputCls} value={payment.method} onChange={event=>{const method=event.target.value as OvertimePayment['method'];onChange(method==='hourly'?{method,rate:blankLiteral('moneyPerHour',props.currency),multiplier:blankLiteral('scalar',props.currency)}:{method,basis:'day',chargeId:ruleId(),amount:blankLiteral('money',props.currency)});}}>{['hourly','flat','formula'].map(method=><option key={method} value={method}>{t(`methods.${method}`)}</option>)}</select></Field>
    {payment.method==='hourly'?<><ExpressionControl {...props} label={t('hourlyRate')} value={payment.rate} onChange={rate=>onChange({...payment,rate})}/><ExpressionControl {...props} label={t('multiplier')} value={payment.multiplier} onChange={multiplier=>onChange({...payment,multiplier})}/></>:<>
      <Field label={t('basis')}><select className={inputCls} value={payment.basis} onChange={event=>onChange({...payment,basis:event.target.value as typeof payment.basis})}>{['day','session','tier','slice'].map(basis=><option key={basis} value={basis}>{t(`bases.${basis}`)}</option>)}</select></Field>
      <ExpressionControl {...props} label={t('amount')} value={payment.amount} onChange={amount=>onChange({...payment,amount})}/>
    </>}
  </div>;
}
export function OvertimeRatesSection({pattern,onChange,choices}:Props) {
  const t=useTranslations('overtimePatterns');
  const props={currency:pattern.currency.code,choices,definitions:pattern.definitions.map(item=>item.id)};
  function replace(index:number,rate:OvertimeRate) {onChange({...pattern,rates:pattern.rates.map((old,i)=>i===index?rate:old)});}
  return <div className="space-y-4"><p className="text-sm text-muted-foreground">{t('rateHelp')}</p>
    {pattern.rates.map((rate,index)=><details key={rate.id} className="rounded-xl border border-border p-4" open><summary className="cursor-pointer py-2 font-semibold">{t('numberedRate',{number:index+1})}</summary><div className="space-y-4 pt-3">
      <div className="grid gap-3 sm:grid-cols-3"><Field label={t('priority')}><input type="number" step="1" className={inputCls} value={rate.priority} onChange={event=>replace(index,{...rate,priority:event.currentTarget.valueAsNumber})}/></Field><Field label={t('accumulation')}><select className={inputCls} value={rate.accumulation} onChange={event=>replace(index,{...rate,accumulation:event.target.value as 'day'|'session'})}><option value="day">{t('bases.day')}</option><option value="session">{t('bases.session')}</option></select></Field><Field label={t('tierMode')}><select className={inputCls} value={rate.tierMode} onChange={event=>replace(index,{...rate,tierMode:event.target.value as 'marginal'|'whole'})}><option value="marginal">{t('marginal')}</option><option value="whole">{t('whole')}</option></select></Field></div>
      <ConditionControl {...props} value={rate.when} onChange={when=>replace(index,{...rate,when})}/>
      <label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={rate.timeBand!==null} onChange={event=>replace(index,{...rate,timeBand:event.target.checked?{fromMinute:0,toMinute:0,endDayOffset:0}:null})}/>{t('timeBand')}</label>
      {rate.timeBand?<div className="grid gap-3 sm:grid-cols-3">{(['fromMinute','toMinute'] as const).map(key=><Field key={key} label={t(key)}><input type="time" className={inputCls} value={`${String(Math.floor(rate.timeBand![key]/60)).padStart(2,'0')}:${String(rate.timeBand![key]%60).padStart(2,'0')}`} onChange={event=>{const [hours,minutes]=event.target.value.split(':').map(Number);replace(index,{...rate,timeBand:{...rate.timeBand!,[key]:hours*60+minutes}});}}/></Field>)}<Field label={t('endDayOffset')}><select className={inputCls} value={rate.timeBand.endDayOffset} onChange={event=>replace(index,{...rate,timeBand:{...rate.timeBand!,endDayOffset:Number(event.target.value) as 0|1}})}><option value="0">{t('sameDay')}</option><option value="1">{t('nextDay')}</option></select></Field></div>:null}
      {rate.tiers.map((tier,tierIndex)=><fieldset key={tier.id} className="space-y-3 rounded-lg border border-border p-3"><legend className="px-1 text-sm">{t('numberedTier',{number:tierIndex+1})}</legend><div className="grid gap-3 sm:grid-cols-2"><Field label={t('fromMinutes')}><input inputMode="decimal" className={inputCls} value={tier.from} onChange={event=>replace(index,{...rate,tiers:rate.tiers.map((old,i)=>i===tierIndex?{...old,from:event.target.value}:old)})}/></Field><Field label={t('toMinutes')}><input inputMode="decimal" className={inputCls} value={tier.to??''} placeholder={t('unbounded')} onChange={event=>replace(index,{...rate,tiers:rate.tiers.map((old,i)=>i===tierIndex?{...old,to:event.target.value||null}:old)})}/></Field></div>
        <PaymentControl {...props} payment={tier.payment} onChange={payment=>replace(index,{...rate,tiers:rate.tiers.map((old,i)=>i===tierIndex?{...old,payment}:old)})}/>
        <button type="button" className={button} onClick={()=>replace(index,{...rate,tiers:rate.tiers.filter((_,i)=>i!==tierIndex)})}>{t('removeTier')}</button>
      </fieldset>)}
      <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={rate.tiers.length>=OVERTIME_LIMITS.tiers} onClick={()=>replace(index,{...rate,tiers:[...rate.tiers,{id:ruleId(),from:'',to:null,payment:{method:'hourly',rate:blankLiteral('moneyPerHour',pattern.currency.code),multiplier:blankLiteral('scalar',pattern.currency.code)},mapping:{earningItemId:'',currency:pattern.currency.code}}]})}>{t('addTier')}</button><button type="button" className={button} onClick={()=>onChange({...pattern,rates:pattern.rates.filter((_,i)=>i!==index)})}>{t('removeRate')}</button></div>
    </div></details>)}
    <button type="button" className={button} disabled={pattern.rates.length>=OVERTIME_LIMITS.rates} onClick={()=>onChange({...pattern,rates:[...pattern.rates,{id:ruleId(),priority:0,when:blankCondition(),timeBand:null,accumulation:'day',tierMode:'marginal',tiers:[]}]})}>{t('addRate')}</button>
  </div>;
}
export function OvertimeMappingSection({pattern,onChange,earningItems}:{pattern:OvertimePattern;onChange:(pattern:OvertimePattern)=>void;earningItems:OvertimeChoice[]}) {
  const t=useTranslations('overtimePatterns');
  return <div className="space-y-4"><p className="text-sm text-muted-foreground">{t('mappingHelp')}</p>{pattern.rates.flatMap((rate,rateIndex)=>rate.tiers.map((tier,tierIndex)=><Field key={tier.id} label={t('rateTier',{rate:rateIndex+1,tier:tierIndex+1})}><select className={inputCls} value={tier.mapping.earningItemId} onChange={event=>onChange({...pattern,rates:pattern.rates.map((old,i)=>i===rateIndex?{...old,tiers:old.tiers.map((oldTier,j)=>j===tierIndex?{...oldTier,mapping:{earningItemId:event.target.value,currency:pattern.currency.code}}:oldTier)}:old)})}><option value="">{t('choose')}</option>{earningItems.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}{tier.mapping.earningItemId&&!earningItems.some(item=>item.id===tier.mapping.earningItemId)?<option value={tier.mapping.earningItemId}>{t('unavailableReference',{id:tier.mapping.earningItemId})}</option>:null}</select></Field>))}</div>;
}
