import {Field,inputCls} from '@/components/ui';
import {CURRENCIES} from '@/lib/currencies';
import type {LetterField,LetterValue} from '@/lib/letter-model';
/** Initial values are version-bound snapshots. Form owners retain inputs when an action is refused. */
export function LetterCustomInputs({fields,values={},currencyLabel}:{fields:LetterField[];values?:Record<string,LetterValue|null>;currencyLabel:string}){
 return fields.filter(field=>field.source.startsWith('custom.')).map(field=>{const initial=values[field.key];return <div key={field.key} className="space-y-2"><Field label={field.label}>{field.kind==='text'?<textarea name={'custom:'+field.key+':value'} className={`${inputCls} min-h-24`} maxLength={10000} defaultValue={initial?.value??''}/>:<input name={'custom:'+field.key+':value'} className={`${inputCls} min-h-11`} type={field.kind==='date'?'date':'text'} inputMode={field.kind==='currency'?'decimal':undefined} maxLength={30} defaultValue={initial?.value??''}/>}</Field>{field.kind==='currency'&&<Field label={field.label+' · '+currencyLabel}><select name={'custom:'+field.key+':currency'} className={`${inputCls} min-h-11`} defaultValue={initial?.kind==='currency'?initial.currency:''}><option value="">—</option>{CURRENCIES.map(currency=><option key={currency.code} value={currency.code}>{currency.code} · {currency.name}</option>)}</select></Field>}</div>;});
}
