import type { PersonnelFieldDescriptor } from './personnel-field-registry';
import type { MasterColumn } from './employee-master-report';
import { masterDateText } from './employee-master-date';
type Field = Pick<PersonnelFieldDescriptor,'type'|'unit'>;
type Column = Pick<MasterColumn,'format'|'decimals'>;

/** Fixed decimal DISPLAY, half-expand like Intl's default; never returned to an owner/calculation.
 * Work on the recorded decimal digits so a string is not first rounded through a binary Number.
 */
function fixedNumberText(value: string|number, decimals: number): string|undefined {
 if (!Number.isInteger(decimals) || decimals<0 || decimals>6 || typeof value==='number'&&!Number.isFinite(value)) return undefined;
 const raw=String(value); if(raw.length>1024)return undefined;
 const match=/^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(raw);if(!match)return undefined;
 const exponent=Number(match[4]??0);if(!Number.isInteger(exponent)||Math.abs(exponent)>308)return undefined;
 const digits=match[2]+(match[3]??''),point=match[2].length+exponent;
 const whole=point<=0?'0':point>=digits.length?digits+'0'.repeat(point-digits.length):digits.slice(0,point);
 const fraction=point<=0?'0'.repeat(-point)+digits:point>=digits.length?'':digits.slice(point);
 let shown=BigInt(whole+fraction.slice(0,decimals).padEnd(decimals,'0'));
 if((fraction[decimals]??'0')>='5')shown+=BigInt(1);
 const padded=String(shown).padStart(decimals+1,'0');
 return match[1]+(decimals?padded.slice(0,-decimals)+'.'+padded.slice(-decimals):padded);
}

/** One date/number presentation entry for preview and exports. No column means no numeric rounding:
 * group identities are facts, not measures whose display precision may conceal a distinct key.
 */
export function masterValueText(value: unknown, field: Field|undefined, column?: Column): string|undefined {
 const date=masterDateText(value,field,column?.format);if(date!==undefined)return date;
 if(!field||!['number','currency'].includes(field.type)||!column||typeof value!=='number'&&typeof value!=='string')return undefined;
 return column.format==='text'?String(value):fixedNumberText(value,column.decimals);
}
