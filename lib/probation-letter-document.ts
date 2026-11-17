import {validateFieldValue,type Field} from './lifecycle-v9-model';
import {ProbationError} from './probation-model';
export {automationDocument as probationLetterDocument,automationSignerRoleLabel as probationSignerRoleLabel,signerMergeKey} from './automation-document';

/** Required and conditional values are checked before freezing an HR-authored letter. */
export function validateProbationLetterFields(fields:Field[],merge:Record<string,string>){
 const values=Object.fromEntries(fields.map(field=>[field.id,merge[field.pmKey??field.id]??'']));
 for(const field of fields){
  if(field.when&&values[field.when.field]!==field.when.value)continue;
  if(field.owner==='pmLocked'&&['acknowledgedBy','acknowledgedOn'].includes(field.pmKey??''))continue;
  const value=values[field.id];validateFieldValue(field,value);
  if(field.required&&(!value.trim()||field.type==='checkbox'&&value!=='true'||field.type==='table'&&JSON.parse(value).length===0))throw new ProbationError('invalid','Complete every required visible letter field before preparation.');
 }
}
