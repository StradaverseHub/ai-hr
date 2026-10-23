/** One existing eligibility decision graph, consumed by JS display/derivation and installed SQL.
 * No rates, ringgit arithmetic or caller-editable policy. SQL parity must pass before migration. */
import declaration from './family-child-relief-rule.json';
export type FamilyReliefField='relationship'|'isDeceased'|'archivedAt'|'childTaxRelief'|'isStudent'|'dateOfBirth'|'childReliefCategory'|'eligible'|'categorised';
export type FamilyReliefLeaf=string|boolean|null;
export type FamilyReliefNode={all:FamilyReliefNode[]}|{any:FamilyReliefNode[]}|{not:FamilyReliefNode}|{eq:[FamilyReliefField,FamilyReliefLeaf]}|{isNull:FamilyReliefField}|{truthy:FamilyReliefField}|{ageBelow:[FamilyReliefField,number]}|{in:[FamilyReliefField,string[]]}|{equalFields:[FamilyReliefField,FamilyReliefField]}|{greater:[FamilyReliefField,number]};
const rule=declaration as unknown as {eligibility:FamilyReliefNode;completeGrid:FamilyReliefNode};
function evaluate(node:FamilyReliefNode,row:Partial<Record<FamilyReliefField,unknown>>,age:(dob:string)=>number|null):boolean{
 const visit=(n:FamilyReliefNode):boolean=>{
  if('all'in n)return n.all.every(visit);
  if('any'in n)return n.any.some(visit);
  if('not'in n)return !visit(n.not);
  if('eq'in n)return row[n.eq[0]]===n.eq[1];
  if('isNull'in n)return row[n.isNull]==null;
  if('truthy'in n)return Boolean(row[n.truthy]);
  if('in'in n)return n.in[1].includes(String(row[n.in[0]]??''));
  if('equalFields'in n)return row[n.equalFields[0]]===row[n.equalFields[1]];
  if('greater'in n)return typeof row[n.greater[0]]==='number'&&Number(row[n.greater[0]])>n.greater[1];
  const dob=row[n.ageBelow[0]];const years=typeof dob==='string'?age(dob):null;
  return years!=null&&years<n.ageBelow[1];
 };
 return visit(node);
}
export function evaluateFamilyChildRelief(row:Partial<Record<FamilyReliefField,unknown>>,asOf:Date,age:(dob:string,asOf:Date)=>number|null):boolean{
 return evaluate(rule.eligibility,row,dob=>age(dob,asOf));
}
export function familyGridComplete(eligible:number,categorised:number):boolean{
 return evaluate(rule.completeGrid,{eligible,categorised},()=>null);
}
