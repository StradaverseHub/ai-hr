import type { Document } from './lifecycle-v9-model';
/** All printed identity comes from the saved instance and actual signing receipt. */
/** The role a signature block prints: `step:<id>` (routed template versions) or the HR / employee signature. */
export function v9SignatureBlockRole(role:string|undefined):'hr'|'employee'|`step:${string}`{return role?.startsWith('step:')?role as `step:${string}`:role==='hr'?'hr':'employee';}
export function v9SignaturePresentation(document:Document,role:'hr'|'employee'|`step:${string}`) {
  if(role.startsWith('step:')){
    const signature=document.stepSignatures?.[role.slice(5)]??null,values=document.mergeValues??{};
    const signedAt=signature&&Number.isFinite(Date.parse(signature.at))?new Intl.DateTimeFormat('en-GB',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'}).format(new Date(signature.at)):'';
    // An unsigned step block names who holds the step, else what it was routed to (Probation letters, 5765); a document
    // without those values keeps the placeholder.
    const step=role.slice(5),pending=(field:string)=>signature?'':values[`signingStep.${step}.${field}`]??'';
    return {signature,name:signature?.by.name??(pending('name')||pending('label')||'[Signatory]'),detail:[signature?.printedTitle??pending('title'),values['company.name']].filter(Boolean).join(', '),status:signature?`Signed electronically${signedAt?' on '+signedAt:''}`:'Not signed yet'};
  }
  const signature=role==='hr'?document.hrSignature:document.employeeSignature,values=document.mergeValues??{};
  const name=signature?.by.name??values[role==='hr'?'signatory.name':'employee.name']??'';
  const title=role==='hr'?(signature?.printedTitle??(!signature||signature.by.id===document.signatoryUserId?values['signatory.title']??'':'')):'';
  const detail=role==='hr'?[title,values['company.name']].filter(Boolean).join(', '):`NRIC: ${values['employee.icNo']||'[IC NO.]'}`;
  const signedAt=signature&&Number.isFinite(Date.parse(signature.at))?new Intl.DateTimeFormat('en-GB',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'}).format(new Date(signature.at)):'';
  return {signature,name:name||(role==='hr'?'[HR signatory]':'[Employee name]'),detail,status:signature?`Signed electronically${signedAt?' on '+signedAt:''}`:'Not signed yet'};
}
