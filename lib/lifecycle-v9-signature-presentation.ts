import type { Document } from './lifecycle-v9-model';
/** All printed identity comes from the saved instance and actual signing receipt. */
export function v9SignaturePresentation(document:Document,role:'hr'|'employee') {
  const signature=role==='hr'?document.hrSignature:document.employeeSignature,values=document.mergeValues??{};
  const name=signature?.by.name??values[role==='hr'?'signatory.name':'employee.name']??'';
  const title=role==='hr'?(signature?.printedTitle??(!signature||signature.by.id===document.signatoryUserId?values['signatory.title']??'':'')):'';
  const detail=role==='hr'?[title,values['company.name']].filter(Boolean).join(', '):`NRIC: ${values['employee.icNo']||'[IC NO.]'}`;
  const signedAt=signature&&Number.isFinite(Date.parse(signature.at))?new Intl.DateTimeFormat('en-GB',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Kuala_Lumpur'}).format(new Date(signature.at)):'';
  return {signature,name:name||(role==='hr'?'[HR signatory]':'[Employee name]'),detail,status:signature?`Signed electronically${signedAt?' on '+signedAt:''}`:'Not signed yet'};
}
