/** Percentages are integer hundredths. Never round an imprecise or over-precision input. */
import {z} from 'zod';
export const ALLOCATION_SHEET='Cost Center Allocations';
/** c4055300: a company is named by its Company Code (resolved per row), never by an internal identifier. */
export const ALLOCATION_COLUMNS=['company_code','employee_code','effective_date','operation','cost_center_code','percentage'] as const;
export type AllocationColumn=typeof ALLOCATION_COLUMNS[number];
/** Worksheet captions. The parser accepts these or the column keys above, case and spacing insensitive. */
export const ALLOCATION_CAPTIONS:Record<AllocationColumn,string>={company_code:'Company Code',employee_code:'Employee ID',effective_date:'Effective Date',operation:'Operation',cost_center_code:'Cost Center Code',percentage:'Percentage'};
export const ALLOCATION_REFERENCE_SHEET='Allocation Reference';
export const ALLOCATION_INSTRUCTIONS_SHEET='Allocation Instructions';
export type AllocationSource='manual'|'employee-import'|'allocation-import'|'import-revert';
export type AllocationCode='invalid'|'duplicate'|'total'|'scope'|'label'|'changed'|'date'|'clear'|'preview'|'binding'|'transfer';
const messages:Record<AllocationCode,string>={invalid:'Enter a percentage greater than zero and at most 100, with up to two decimal places.',duplicate:'Select each cost center once.',total:'The total allocation cannot exceed 100%.',scope:'Employee record or permission is unavailable.',label:'A cost center is inactive or unavailable for this company.',changed:'Allocations changed. Reload and preview again.',date:'Choose an effective date with proven employment company history.',clear:'Clearing allocations requires an explicit clear operation.',preview:'The input or reference data changed. Preview again.',binding:'Match each allocation to one company and Employee ID.',transfer:'Save an explicit clear set at the transfer date and clear any later scheduled sets before transferring. Then save a new destination-company allocation.'};
export class CostAllocationError extends Error{constructor(readonly code:AllocationCode){super(messages[code]);this.name='CostAllocationError';}}
export function percentageHundredths(raw:unknown):number{
 if(typeof raw!=='string'&&!Number.isFinite(raw))throw new CostAllocationError('invalid');
 const value=String(raw).trim();if(!/^(?:0|[1-9]\d{0,2})(?:\.\d{1,2})?$/.test(value))throw new CostAllocationError('invalid');
 const[whole,fraction='']=value.split('.');const scaled=Number(whole)*100+Number(fraction.padEnd(2,'0'));
 if(scaled<=0||scaled>10000)throw new CostAllocationError('invalid');return scaled;
}
export const formatAllocationPercent=(value:number)=>`${Math.floor(value/100)}.${String(value%100).padStart(2,'0')}`;
export const allocationInputSchema=z.object({employmentId:z.uuid(),effectiveDate:z.iso.date(),expectedRevision:z.number().int().min(0),operation:z.enum(['replace','clear']),rows:z.array(z.object({costCenterId:z.uuid(),percentage:z.string()}).strict()).max(100)}).strict();
export type CostAllocationInput=z.infer<typeof allocationInputSchema>;
export function normalizedAllocationRows(rows:CostAllocationInput['rows'],operation:'replace'|'clear'){
 if(operation==='clear'){if(rows.length)throw new CostAllocationError('clear');return[];}
 if(!rows.length)throw new CostAllocationError('clear');const ids=new Set<string>();
 const result=rows.map(row=>{if(ids.has(row.costCenterId))throw new CostAllocationError('duplicate');ids.add(row.costCenterId);return{costCenterId:row.costCenterId,hundredths:percentageHundredths(row.percentage)};});
 if(result.reduce((sum,row)=>sum+row.hundredths,0)>10000)throw new CostAllocationError('total');return result.sort((a,b)=>a.costCenterId.localeCompare(b.costCenterId));
}
