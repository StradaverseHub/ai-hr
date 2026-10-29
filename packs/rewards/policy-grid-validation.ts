/** Editable policy grids use canonical grades and exact decimal input; persisted legacy snapshots stay readable. */
export const REWARD_POLICY_GRADES = ['H', ...Array.from({length:12},(_,i)=>String(i+12))] as const;
export type RewardPolicyGridKind='ranges'|'bonusMatrix'|'branchFactors';
export type PolicyGridIssue={row:string;column:number;code:'missing'|'number'|'precision'|'order'|'zero'|'grade'|'duplicate'};
export const policyGridWidth=(kind:RewardPolicyGridKind)=>kind==='ranges'?3:5;
export function parsePolicyGridDecimal(value:string,scale:number):number|null{
 const text=value.trim(),digits=String(scale).length-1;
 if(!new RegExp(`^\\d+(?:\\.\\d{1,${digits}})?$`).test(text))return null;
 const [whole,fraction='']=text.split('.'),result=Number(whole)*scale+Number(fraction.padEnd(digits,'0'));
 return Number.isSafeInteger(result)?result:null;
}
export function policyGridIssues(kind:RewardPolicyGridKind,rows:readonly (readonly string[])[]):PolicyGridIssue[]{
 const issues:PolicyGridIssue[]=[],seen=new Set<string>(),width=policyGridWidth(kind),scale=kind==='ranges'?100:kind==='bonusMatrix'?100:10000;
 if(kind==='branchFactors'&&rows.length===0)issues.push({row:'',column:0,code:'missing'});
 for(const row of rows){
  const grade=(row[0]??'').trim();
  if(!grade||kind==='branchFactors'&&grade.length>80||kind!=='branchFactors'&&!REWARD_POLICY_GRADES.includes(grade as never)||['__proto__','constructor','prototype'].includes(grade))issues.push({row:grade,column:0,code:'grade'});
  if(seen.has(grade))issues.push({row:grade,column:0,code:'duplicate'});seen.add(grade);
  if(kind==='ranges'&&grade==='23'){
   if(row.slice(1).some(v=>v.trim()!==''))issues.push({row:grade,column:1,code:'grade'});
   continue;
  }
  const values=Array.from({length:width},(_,i)=>parsePolicyGridDecimal(row[i+1]??'',scale));
  values.forEach((value,i)=>{if(value!==null&&value>(kind==='ranges'?100_000_000_000:kind==='bonusMatrix'?1000:100000))issues.push({row:grade,column:i+1,code:'number'});if(value===null)issues.push({row:grade,column:i+1,code:(row[i+1]??'').trim()===''?'missing':'precision'});});
  if(values.some(v=>v===null))continue;
  if(kind==='ranges'){
   if(!(values[0]!>0&&values[0]!<values[1]!&&values[1]!<values[2]!))for(let i=1;i<=width;i++)issues.push({row:grade,column:i,code:'order'});
  }else{
   if(values[0]!==0)issues.push({row:grade,column:1,code:'zero'});
   if(kind==='bonusMatrix')for(let i=1;i<values.length;i++)if(values[i]!<=values[i-1]!)issues.push({row:grade,column:i+1,code:'order'});
  }
 }
 if(kind!=='branchFactors')for(const grade of REWARD_POLICY_GRADES)if(!seen.has(grade))issues.push({row:grade,column:0,code:'missing'});
 return issues;
}
/** Encoded form values remain the existing codec shape, with JG23's no-range row excluded. */
export function encodePolicyGrid(kind:RewardPolicyGridKind,rows:readonly (readonly string[])[]):string{
 return rows.filter(row=>kind!=='ranges'||row[0]!=='23').map(row=>row.join(', ')).join('\n');
}
export function policyGridRows(kind:RewardPolicyGridKind,matrix:Record<string,readonly number[]>):string[][]{
 const scale=kind==='ranges'?100:10000,width=policyGridWidth(kind);
 const names=kind==='branchFactors'?Object.keys(matrix):REWARD_POLICY_GRADES;
 return names.map(name=>[name,...Array.from({length:width},(_,i)=>kind==='ranges'&&name==='23'?'':matrix[name]?.[i]===undefined?'':String(matrix[name][i]/scale))]);
}
export function parsePolicyGridText(kind:RewardPolicyGridKind,text:string):string[][]{
 if(text.length>200000)throw new Error('Grid exceeds the supported size');
 const rows=text.trim()?text.split(/\r?\n/).filter(row=>row.trim()).map(row=>row.split(',').map(v=>v.trim())):[];
 if(rows.length>200||rows.some(row=>row.length!==policyGridWidth(kind)+1))throw new Error('Unexpected grid columns');
 return kind==='ranges'?[...rows,['23','','','']]:rows;
}

export function assertRewardPolicyGrids(policy:{ranges:Record<string,readonly number[]>;bonusMatrix:Record<string,readonly number[]>;bonusStructure:'standard'|'branch';branchFactors:Record<string,readonly number[]>}):void{
 for(const kind of ['ranges','bonusMatrix','branchFactors'] as const){
  if(kind==='branchFactors'&&policy.bonusStructure!=='branch')continue;
  const rows=policyGridRows(kind,policy[kind]);
  // Known-grade projection does not hide forged or retired keys on a new save.
  if(kind!=='branchFactors'&&Object.keys(policy[kind]).some(grade=>!REWARD_POLICY_GRADES.includes(grade as never)||kind==='ranges'&&grade==='23'))throw new Error('Unknown grade in policy grid');
  if(policyGridIssues(kind,rows).length)throw new Error('Invalid policy grid');
 }
}
