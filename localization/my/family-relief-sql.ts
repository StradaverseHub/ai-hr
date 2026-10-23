import declaration from '../../lib/family-child-relief-rule.json';
import type {FamilyReliefField as Field,FamilyReliefLeaf as Leaf,FamilyReliefNode as Node} from '../../lib/family-child-relief-rule';
const rule=declaration as unknown as {eligibility:Node;completeGrid:Node};
/** Only used to prepare/check the fixed migration expression, never with request SQL identifiers. */
function compile(node:Node):string{
 const names:Record<Field,string>={relationship:'d.relationship',isDeceased:'d.is_deceased',archivedAt:'d.archived_at',childTaxRelief:'d.child_tax_relief',isStudent:'d.is_student',dateOfBirth:'d.date_of_birth',childReliefCategory:'d.child_relief_category',eligible:'p_eligible',categorised:'p_categorised'};
 const literal=(v:Leaf)=>v===null?'NULL':typeof v==='boolean'?String(v):"'"+v.replaceAll("'","''")+"'";
 const visit=(n:Node):string=>{
  if('all'in n)return '('+n.all.map(visit).join(' AND ')+')';
  if('any'in n)return '('+n.any.map(visit).join(' OR ')+')';
  if('not'in n)return '(NOT '+visit(n.not)+')';
  if('eq'in n)return '('+names[n.eq[0]]+' IS NOT DISTINCT FROM '+literal(n.eq[1])+')';
  if('isNull'in n)return '('+names[n.isNull]+' IS NULL)';
  if('truthy'in n)return n.truthy==='archivedAt'?'('+names[n.truthy]+' IS NOT NULL)':'COALESCE('+names[n.truthy]+',false)';
  if('in'in n)return 'COALESCE('+names[n.in[0]]+' IN ('+n.in[1].map(literal).join(',')+'),false)';
  if('equalFields'in n)return '('+names[n.equalFields[0]]+' IS NOT DISTINCT FROM '+names[n.equalFields[1]]+')';
  if('greater'in n)return 'COALESCE('+names[n.greater[0]]+'>'+n.greater[1]+',false)';
  const dob=names[n.ageBelow[0]];
  return '('+dob+" IS NOT NULL AND (extract(year FROM p_as_of)::int-extract(year FROM "+dob+")::int-(to_char(p_as_of,'MM-DD')<to_char("+dob+",'MM-DD'))::int)<"+n.ageBelow[1]+')';
 };
 return visit(node);
}
export const familyChildReliefSql=()=>compile(rule.eligibility);
export const familyGridCompleteSql=()=>compile(rule.completeGrid);
