import {z} from 'zod';
import {ratio,type CalculatedEntry} from './engine';
import {performances,talents} from './model';
import {uploadedDecimal} from './uploaded-awards-model';

export type RewardPersonHistoryRow={
 id:string;year:number;kind:'annual'|'offcycle';source:'review'|'upload';
 talent:string|null;performance:string|null;meritBp:number|null;promotionBp:number|null;specialBp:number|null;
 incrementCents:number|null;totalIncreaseBp:number|null;promoted:boolean;promotionGrade:string|null;bonusCents:number|null;bonusMonthsBp:number|null;
 lumpCents:number|null;withheld:{increase?:string;bonus?:string;lump?:string}|null;
};
/** Use the engine's integer ratio, with the payment basic rather than unprorated matrix months. */
export function rewardHistoryValues(row:CalculatedEntry){
 const withheld=(row.recommendation as typeof row.recommendation&{withhold?:RewardPersonHistoryRow['withheld']}).withhold??{};
 return{talent:row.facts.talent,performance:row.facts.performance,meritBp:row.meritBp,promotionBp:row.promotionBp,specialBp:row.specialBp,
  incrementCents:row.newBasicCents-row.source.basicCents,totalIncreaseBp:row.source.basicCents>0?ratio(row.newBasicCents-row.source.basicCents,10000,row.source.basicCents,'nearest'):0,promoted:!!row.recommendation.promotionGrade,promotionGrade:row.recommendation.promotionGrade,
  bonusCents:row.bonusCents,bonusMonthsBp:row.bonusBasicCents>0?ratio(row.bonusCents,10000,row.bonusBasicCents,'nearest'):0,
  lumpCents:row.lumpCents,withheld};
}
const amount=z.number().int().nonnegative().max(100_000_000_000),bp=z.number().int().nonnegative().max(1_000_000);
export const rewardHistoryUploadRowSchema=z.object({
 employeeCode:z.string().trim().min(1).max(200),year:z.number().int().min(2000).max(2200),kind:z.enum(['annual','offcycle']),
 talent:z.enum(talents).nullable(),performance:z.enum(performances).nullable(),incrementBp:bp,incrementCents:amount,bonusCents:amount,bonusMonthsBp:bp,
}).strict();
export type RewardHistoryUploadRow=z.infer<typeof rewardHistoryUploadRowSchema>;
export const rewardHistoryUploadHeaders=['Employee ID','Year','Talent rating','Performance rating','Increment %','Increment MYR','Bonus MYR','Bonus months','Type'];
/** Parse every nonempty row; report original worksheet lines and never coerce malformed money to zero. */
export function rewardHistoryUploadFromCells(cells:readonly string[][],lineNumbers?:readonly number[]){
 const headers=cells[0]??[];
 if(![8,9].includes(headers.length)||headers.some((h,i)=>h.trim()!==rewardHistoryUploadHeaders[i]))throw Error('Use the reward history template without changing its headings.');
 const rows:{line:number;value:RewardHistoryUploadRow}[]=[],problems:{line:number;reason:string}[]=[],seen=new Set<string>();
 for(const [index,cell]of cells.slice(1).entries()){
  if(!cell.some(x=>x.trim()))continue;
  const line=lineNumbers?.[index+1]??index+2;
  try{
   if(cell.length>headers.length)throw Error('Too many columns.');
   const type=cell[8]?.trim().toLowerCase()||'annual';
   const value=rewardHistoryUploadRowSchema.parse({employeeCode:cell[0]?.trim(),year:Number(cell[1]?.trim()),talent:cell[2]?.trim()||null,performance:cell[3]?.trim()||null,
    incrementBp:uploadedDecimal(cell[4]??''),incrementCents:uploadedDecimal(cell[5]??''),bonusCents:uploadedDecimal(cell[6]??''),bonusMonthsBp:uploadedDecimal(cell[7]??'')*100,kind:type==='off-cycle'?'offcycle':type});
   const key=JSON.stringify([value.employeeCode,value.year,value.kind]);
   if(seen.has(key))throw Error('Duplicate employee, year and type.');seen.add(key);rows.push({line,value});
  }catch(e){problems.push({line,reason:e instanceof z.ZodError?'Enter a valid employee, year, rating and nonnegative amount.':e instanceof Error?e.message:'Invalid history row.'});}
 }
 if(rows.length+problems.length>10000)throw Error('Upload at most 10,000 history rows per file.');
 return{rows,problems};
}
