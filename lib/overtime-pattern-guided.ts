/** Client-safe projections for the guided editor. They never evaluate a payroll amount. */
import type {OvertimeCondition,OvertimePattern} from './overtime-pattern-model';

/** Exact minutes ↔ hours:minutes; preserve existing sub-minute precision without Number rounding. */
export function overtimeMinutesToClock(value:string|null):string {
 if(value===null)return '';
 if(!/^\d{1,12}(?:\.\d{1,6})?$/.test(value))return value;
 const [whole,fraction='']=value.split('.'),minutes=BigInt(whole);
 return `${minutes/BigInt(60)}:${String(minutes%BigInt(60)).padStart(2,'0')}${fraction?'.'+fraction:''}`;
}
export function overtimeClockToMinutes(value:string):string {
 if(value==='')return '';
 const match=/^(\d{1,12}):([0-5]\d)(\.\d{1,6})?$/.exec(value);
 if(!match)return value.includes(':')?'invalid:'+value:value==='0'?'0':'invalid:'+value;
 return String(BigInt(match[1])*BigInt(60)+BigInt(match[2]))+(match[3]??'');
}
export function overtimeClockInput(value:string|null):string {
 return value?.startsWith('invalid:')?value.slice(8):overtimeMinutesToClock(value);
}
export function overtimeDayTypes(condition:OvertimeCondition):string[]|null {
 if(condition.type==='selection'&&condition.field==='dayType'&&condition.operator==='in')return condition.values;
 if(condition.type==='group'&&condition.logic==='and'){
  const selected=condition.children.find(item=>item.type==='selection'&&item.field==='dayType'&&item.operator==='in');
  if(selected?.type==='selection')return selected.values;
 }
 return null;
}
export function withOvertimeDayTypes(pattern:OvertimePattern,values:string[]):OvertimePattern {
 const old=pattern.eligibility;
 if(old.type==='selection'&&old.field==='dayType'&&old.operator==='in')return {...pattern,eligibility:{...old,values}};
 if(old.type==='group'&&old.logic==='and'){
  const index=old.children.findIndex(item=>item.type==='selection'&&item.field==='dayType'&&item.operator==='in');
  if(index>=0)return {...pattern,eligibility:{...old,children:old.children.map((item,i)=>i===index&&item.type==='selection'?{...item,values}:item)}};
  return {...pattern,eligibility:{...old,children:[...old.children,{id:crypto.randomUUID(),type:'selection',field:'dayType',operator:'in',values}]}};
 }
 return {...pattern,eligibility:{id:crypto.randomUUID(),type:'group',logic:'and',children:[old,{id:crypto.randomUUID(),type:'selection',field:'dayType',operator:'in',values}]}};
}
export function overtimeSelectedEmployees(condition:OvertimeCondition):string[]|null {
 if(condition.type==='selection'&&condition.field==='employmentId'&&condition.operator==='in')return condition.values;
 if(condition.type==='group'&&condition.logic==='and'){
  const selected=condition.children.find(item=>item.type==='selection'&&item.field==='employmentId'&&item.operator==='in');
  if(selected?.type==='selection')return selected.values;
 }
 return null;
}
export function withOvertimeSelectedEmployees(pattern:OvertimePattern,values:string[]|null):OvertimePattern {
 const old=pattern.eligibility;
 if(old.type==='selection'&&old.field==='employmentId'&&old.operator==='in')return {...pattern,eligibility:values===null?{id:old.id,type:'constant',value:true}:{...old,values}};
 if(old.type==='group'&&old.logic==='and'){
  const index=old.children.findIndex(item=>item.type==='selection'&&item.field==='employmentId'&&item.operator==='in');
  if(index>=0)return {...pattern,eligibility:{...old,children:values===null?old.children.filter((_,i)=>i!==index):old.children.map((item,i)=>i===index&&item.type==='selection'?{...item,values}:item)}};
  if(values===null)return pattern;
  return {...pattern,eligibility:{...old,children:[...old.children,{id:crypto.randomUUID(),type:'selection',field:'employmentId',operator:'in',values}]}};
 }
 if(values===null)return pattern;
 return {...pattern,eligibility:{id:crypto.randomUUID(),type:'group',logic:'and',children:[old,{id:crypto.randomUUID(),type:'selection',field:'employmentId',operator:'in',values}]}};
}

/** A conservative editor warning, never an execution rule. Only direct numeric bounds and
 * finite selection intersections inside AND are proven; opaque formulas/OR branches stay intact. */
export function overtimeEligibilityContradiction(condition:OvertimeCondition):boolean {
 if(condition.type!=='group')return false;
 if(condition.logic==='or')return condition.children.length>0&&condition.children.every(overtimeEligibilityContradiction);
 const atoms:OvertimeCondition[]=[];
 const flatten=(node:OvertimeCondition)=>{if(node.type==='group'&&node.logic==='and')node.children.forEach(flatten);else atoms.push(node);};
 flatten(condition);
 if(atoms.some(overtimeEligibilityContradiction))return true;
 const scaled=(text:string):bigint|null=>{
  if(!/^-?\d{1,12}(?:\.\d{1,6})?$/.test(text))return null;
  const negative=text.startsWith('-'),[whole,fraction='']=(negative?text.slice(1):text).split('.');
  const value=BigInt(whole)*BigInt(1000000)+BigInt(fraction.padEnd(6,'0'));return negative?-value:value;
 };
 type Bound={value:bigint;inclusive:boolean};
 type NumericState={lower?:Bound;upper?:Bound;excluded:Set<bigint>};
 const numeric=new Map<string,NumericState>();
 const selections=new Map<string,{included:Set<string>|null;excluded:Set<string>}>();
 for(const atom of atoms){
  if(atom.type==='selection'){
   const state=selections.get(atom.field)??{included:null,excluded:new Set<string>()};
   if(atom.operator==='in')state.included=state.included===null?new Set(atom.values):new Set([...state.included].filter(value=>atom.values.includes(value)));
   else atom.values.forEach(value=>state.excluded.add(value));
   selections.set(atom.field,state);
  }
  if(atom.type!=='compare'||atom.left.type!=='field'||atom.right.type!=='literal'||atom.left.unit!==atom.right.unit)continue;
  const value=scaled(atom.right.value);if(value===null)continue;
  const key=atom.left.field+'/'+atom.left.unit+'/'+(atom.right.currency??'');
  const state:NumericState=numeric.get(key)??{excluded:new Set<bigint>()};
  const lower=(value:bigint,inclusive:boolean)=>{if(!state.lower||value>state.lower.value||value===state.lower.value&&!inclusive)state.lower={value,inclusive};};
  const upper=(value:bigint,inclusive:boolean)=>{if(!state.upper||value<state.upper.value||value===state.upper.value&&!inclusive)state.upper={value,inclusive};};
  if(atom.operator==='eq'){lower(value,true);upper(value,true);}
  if(atom.operator==='ne')state.excluded.add(value);
  if(atom.operator==='gt'||atom.operator==='gte')lower(value,atom.operator==='gte');
  if(atom.operator==='lt'||atom.operator==='lte')upper(value,atom.operator==='lte');
  if(atom.operator==='between'&&atom.upper?.type==='literal'&&atom.upper.unit===atom.left.unit&&atom.upper.currency===atom.right.currency){const end=scaled(atom.upper.value);if(end!==null){lower(value,true);upper(end,true);}}
  numeric.set(key,state);
 }
 for(const state of selections.values())if(state.included!==null&&![...state.included].some(value=>!state.excluded.has(value)))return true;
 for(const {lower,upper,excluded} of numeric.values())if(lower&&upper&&(lower.value>upper.value||lower.value===upper.value&&(!lower.inclusive||!upper.inclusive||excluded.has(lower.value))))return true;
 return false;
}
