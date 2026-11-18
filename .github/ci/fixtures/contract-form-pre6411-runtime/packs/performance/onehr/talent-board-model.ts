import { pmBands,potentialBands,potentialReferenceCurve,talentCategory,talentCell9,talentColumn,type PMBand,type Policy,type PotentialBand,type Talent } from './model';

/**
 * Talent Box board arithmetic, shared by the board (display) and the calibration writer (the movement ceiling).
 * Pure: no database, no clock. Every number here is derived from bands already on the box; nothing is stored.
 */
export type TalentBoxGrid=9|15;
export type TalentBands={performance:PMBand|null;potential:PotentialBand|null};
export type TalentBoxSettings={grid:TalentBoxGrid;moveCap:{pct:number}|null};
export const talentCategoryOrder:readonly Talent[]=['PIP/Improvement','Solid Core','Star','Super Star'];

/** The cycle policy's Talent Box choices. Source defaults: nine cells and no movement ceiling (the source ships it paused). */
export function talentBoxSettings(policy:Pick<Policy,'talentBox'>):TalentBoxSettings{
 const box=policy.talentBox;
 return {grid:box?.grid??9,moveCap:box?.moveCap?.enabled?{pct:box.moveCap.pct}:null};
}

/** Nine cells group the five performance bands into three columns; fifteen keep each band. Potential rows never change. */
export function boardColumns(grid:TalentBoxGrid):readonly string[]{return grid===9?['low','mid','high']:pmBands;}
export function boardColumn(band:PMBand,grid:TalentBoxGrid):string{return grid===9?talentColumn(band):band;}
export function boardCellKey(bands:TalentBands,grid:TalentBoxGrid):string|null{return bands.performance&&bands.potential?`${boardColumn(bands.performance,grid)}|${bands.potential}`:null;}
/** A cell's label comes from its own grid's table: the nine-cell labels are not the fifteen merged. */
export function boardCellCategory(column:string,potential:PotentialBand,grid:TalentBoxGrid):Talent{
 return grid===9?talentCell9(column as 'low'|'mid'|'high',potential):talentCategory(column as PMBand,potential)!;
}
/** Python's round(): halves go to the even neighbour, read on the exact binary value. */
export function roundHalfEven(x:number):number{const f=Math.floor(x),d=x-f;return d>0.5?f+1:d<0.5?f:f%2===0?f:f+1;}
/** One decimal the way the source formats a share: a binary-exact tie (only quarters can be) rounds to even. */
export function fixed1(x:number):string{
 if(Number.isInteger(x*4)&&!Number.isInteger(x*2)){const tenths=Math.floor(x*10);return ((tenths%2===0?tenths:tenths+1)/10).toFixed(1);}
 return x.toFixed(1);
}
/** A reference share as the source prints it: a whole number keeps one decimal, otherwise as many as it has. */
export function referenceText(pct:number):string{return Number.isInteger(pct)?pct.toFixed(1):String(pct);}

/**
 * Reference share per cell: the performance reference (summed into groups for nine cells) crossed with the
 * potential reference. Absent, never invented, when the scope has no single performance reference.
 */
export function boardCellReference(reference:Partial<Record<PMBand,number>>|null|undefined,grid:TalentBoxGrid):Record<string,number>{
 if(!reference||!pmBands.every(band=>typeof reference[band]==='number'))return {};
 const r=reference as Record<PMBand,number>;
 const perf:Record<string,number>=grid===9?{low:r.UA+r.BE,mid:r.ME,high:r.AE+r.OU}:{...r};
 return Object.fromEntries(boardColumns(grid).flatMap(column=>potentialBands.map(potential=>[`${column}|${potential}`,roundHalfEven(perf[column]*potentialReferenceCurve[potential])/100])));
}

export type BoardPerson=TalentBands&{id:string;from?:TalentBands|null};
export type BoardCell<T>={key:string;column:string;potential:PotentialBand;category:Talent;members:T[];count:number;pct:number;reference:number|null};
export type BoardDelta={category:Talent;actual:number;target:number;delta:number};
/**
 * Everything the board reads off one population: per-cell members and shares, each category's own count (a person's
 * five-band category, used by the tabs), and how many people each category is from its reference share. The
 * deltas count the cells on screen, so they reconcile with the grid beside them; positive means "add this many".
 */
export function boardSummary<T extends BoardPerson>(rows:T[],grid:TalentBoxGrid,reference:Partial<Record<PMBand,number>>|null|undefined){
 const columns=boardColumns(grid),cellReference=boardCellReference(reference,grid);
 const placed=rows.filter(r=>boardCellKey(r,grid)!=null).length;
 const cells:BoardCell<T>[]=[...potentialBands].reverse().flatMap(potential=>columns.map(column=>{
  const key=`${column}|${potential}`,members=rows.filter(r=>boardCellKey(r,grid)===key);
  return {key,column,potential,category:boardCellCategory(column,potential,grid),members,count:members.length,pct:placed?members.length/placed*100:0,reference:key in cellReference?cellReference[key]:null};
 }));
 const categoryCounts=Object.fromEntries(talentCategoryOrder.map(category=>[category,rows.filter(r=>talentCategory(r.performance,r.potential)===category).length])) as Record<Talent,number>;
 const deltas:BoardDelta[]=[];
 if(Object.keys(cellReference).length)for(const category of talentCategoryOrder){
  // Summed column by column, low potential first, the order the source adds them in.
  const keys=columns.flatMap(column=>potentialBands.map(potential=>`${column}|${potential}`)).filter(key=>cellReference[key]!=null&&boardCellCategory(key.split('|')[0],key.split('|')[1] as PotentialBand,grid)===category);
  if(!keys.length)continue;
  const actual=keys.reduce((n,key)=>n+(cells.find(c=>c.key===key)?.count??0),0);
  const target=roundHalfEven(keys.reduce((n,key)=>n+cellReference[key],0)*placed/100);
  deltas.push({category,actual,target,delta:target-actual});
 }
 return {placed,cells,categoryCounts,deltas,hasReference:Object.keys(cellReference).length>0};
}

/** ↗ when a person left a lower box this calibration, ↘ when a higher one (a level diagonal reads as down), else none. */
export function boardMove(person:BoardPerson,grid:TalentBoxGrid):'up'|'down'|null{
 const from=person.from;if(!from?.performance||!from.potential||!person.performance||!person.potential)return null;
 const columns=boardColumns(grid),fromColumn=boardColumn(from.performance,grid),toColumn=boardColumn(person.performance,grid);
 if(fromColumn===toColumn&&from.potential===person.potential)return null;
 const delta=columns.indexOf(toColumn)-columns.indexOf(fromColumn)+potentialBands.indexOf(person.potential)-potentialBands.indexOf(from.potential);
 return delta>0?'up':'down';
}

/** Where a drop lands: a column of the grid plus a potential row, as the bands the writer accepts. */
export function boardDropTarget(current:TalentBands,cellKey:string,grid:TalentBoxGrid):TalentBands|null{
 const [column,potential]=cellKey.split('|');
 if(!boardColumns(grid).includes(column)||!(potentialBands as readonly string[]).includes(potential))return null;
 let performance:PMBand;
 if(grid===15)performance=column as PMBand;
 else if(current.performance&&talentColumn(current.performance)===column)performance=current.performance;
 else performance=column==='low'?'BE':column==='mid'?'ME':'AE';
 return {performance,potential:potential as PotentialBand};
}

/* ---------------------------------------------------------------- movement ceiling ---------------------------- */
export type CapPerson={companyId:string;from:TalentBands;current:TalentBands};
/** How many people one unit may re-categorise: half-up rounding, never below one, nothing for an empty unit. */
export function talentMoveAllowance(headcount:number,pct:number):number{return headcount<=0?0:Math.max(1,Math.trunc(headcount*pct/100+0.5));}
/** Only a change of talent category counts; a correction inside a category, or a return to the origin, is free. */
export function talentRecategorised(person:Pick<CapPerson,'from'|'current'>):boolean{
 const now=talentCategory(person.current.performance,person.current.potential);
 return !!now&&talentCategory(person.from.performance,person.from.potential)!==now;
}
export type CapUsage={headcount:number;used:number;cap:number;left:number};
/** Per unit, over the whole session population, never a filtered view. */
export function talentMoveUsage(rows:CapPerson[],pct:number):Map<string,CapUsage>{
 const out=new Map<string,CapUsage>();
 for(const row of rows){const usage=out.get(row.companyId)??{headcount:0,used:0,cap:0,left:0};usage.headcount++;if(talentRecategorised(row))usage.used++;out.set(row.companyId,usage);}
 for(const usage of out.values()){usage.cap=talentMoveAllowance(usage.headcount,pct);usage.left=Math.max(0,usage.cap-usage.used);}
 return out;
}
/** The unit's usage when this move would newly spend an allowance that is already used up; null when it may go ahead. */
export function talentMoveCapBreach(rows:CapPerson[],subject:CapPerson,next:TalentBands,pct:number):CapUsage|null{
 const would=talentCategory(next.performance??subject.current.performance,next.potential??subject.current.potential);
 if(!would||would===talentCategory(subject.from.performance,subject.from.potential)||talentRecategorised(subject))return null;
 const usage=talentMoveUsage(rows,pct).get(subject.companyId);
 return usage&&usage.used>=usage.cap?usage:null;
}
