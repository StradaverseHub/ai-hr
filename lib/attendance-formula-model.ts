import {z} from 'zod';
import {isCalendarDate} from './calendar-date';
import {validateAllowanceEmployeeExpression,type AllowanceEmployeeGroup} from './allowance-employee-expression';
import {compileAttendanceFormulaLibrary,type AttendanceFormulaLibrary} from './attendance-formula-language';
export type AttendanceFormulaEligibility={mode:'all'}|{mode:'selected';employmentIds:string[]}|{mode:'criteria';expression:AllowanceEmployeeGroup};
export type AttendanceFormulaConfiguration={
 code:string;description:string;companyId:string;payItemId:string;effectiveFrom:string;
 period:{method:'daily'}|{method:'weekly';cutoff:number}|{method:'monthly';cutoff:number};
 outputUnit:'amount'|'minutes'|'hours'|'days';purpose:'earning'|'deduction'|'overtime';
 eligibility:AttendanceFormulaEligibility;
 posting:{kind:'exclusive'}|{kind:'sum'}|{kind:'priority';priority:number};
 library:AttendanceFormulaLibrary;
};
const code=z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const expression=z.string().min(1).max(24000);
const formula=z.object({code,source:expression}).strict();
const period=z.discriminatedUnion('method',[z.object({method:z.literal('daily')}).strict(),z.object({method:z.literal('weekly'),cutoff:z.number().int().min(1).max(7)}).strict(),z.object({method:z.literal('monthly'),cutoff:z.number().int().min(1).max(31)}).strict()]);
const configuration=z.object({
 code,description:z.string().trim().min(1).max(1000),companyId:z.uuid().transform(value=>value.toLowerCase()),payItemId:z.uuid().transform(value=>value.toLowerCase()),effectiveFrom:z.string().refine(isCalendarDate,'Choose a real effective date.'),period,
 outputUnit:z.enum(['amount','minutes','hours','days']),purpose:z.enum(['earning','deduction','overtime']),
 eligibility:z.discriminatedUnion('mode',[z.object({mode:z.literal('all')}).strict(),z.object({mode:z.literal('selected'),employmentIds:z.array(z.uuid().transform(value=>value.toLowerCase())).min(1).max(2000).refine(ids=>new Set(ids.map(id=>id.toLowerCase())).size===ids.length,'Choose each employee once.')}).strict(),z.object({mode:z.literal('criteria'),expression:z.unknown().transform(value=>validateAllowanceEmployeeExpression(value))}).strict()]),
 posting:z.discriminatedUnion('kind',[z.object({kind:z.literal('exclusive')}).strict(),z.object({kind:z.literal('sum')}).strict(),z.object({kind:z.literal('priority'),priority:z.number().int().min(1).max(10000)}).strict()]),
 library:z.object({formulas:z.array(formula).min(1).max(64),conditions:z.array(formula.extend({type:z.enum(['decimal','boolean']).optional()}).strict()).max(64)}).strict(),
}).strict();
/** Configuration selects only closed owners; source values, permissions and activation proof are absent. */
export function validateAttendanceFormulaConfiguration(raw:unknown):AttendanceFormulaConfiguration{
 const value=configuration.parse(raw);
 if(JSON.stringify(value).length>262144)throw Error('The complete attendance formula definition exceeds 256 KB.');
 if(!value.library.formulas.some(formula=>formula.code===value.code))throw Error('The main Formula ID must have a matching saved expression.');
 if(value.purpose==='overtime'&&!['minutes','hours','amount'].includes(value.outputUnit))throw Error('Overtime must produce time or a canonical checked amount.');
 compileAttendanceFormulaLibrary(value.library,value.code);
 return value;
}
