export type HomePersonPrivacy={version:1;ordinal:number;hideBirthday:boolean;hideAnniversary:boolean};
export type HomePersonPrivacyInput={expectedOrdinal:number;hideBirthday:boolean;hideAnniversary:boolean};
export class HomePersonPrivacyInputError extends Error{
 constructor(){super('Invalid celebration privacy choices');this.name='HomePersonPrivacyInputError';}
}
export function validateHomePersonPrivacyInput(raw:unknown):HomePersonPrivacyInput{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new HomePersonPrivacyInputError();
 const row=raw as Record<string,unknown>;
 if(Object.keys(row).some(key=>!['expectedOrdinal','hideBirthday','hideAnniversary'].includes(key))
  ||!Number.isSafeInteger(row.expectedOrdinal)||Number(row.expectedOrdinal)<0||Number(row.expectedOrdinal)>=2147483647
  ||typeof row.hideBirthday!=='boolean'||typeof row.hideAnniversary!=='boolean')throw new HomePersonPrivacyInputError();
 return {expectedOrdinal:row.expectedOrdinal as number,hideBirthday:row.hideBirthday,hideAnniversary:row.hideAnniversary};
}
/** Presence is meaningful only for these optional checkboxes. Identity and disclosure scope are
 * supplied by the actual login owner, never hidden posted person/employment/company fields. */
export function parseHomePersonPrivacyForm(data:FormData):HomePersonPrivacyInput{
 if([...data.keys()].some(key=>!['expectedOrdinal','hideBirthday','hideAnniversary'].includes(key)))throw new HomePersonPrivacyInputError();
 const one=data.getAll('expectedOrdinal');
 if(one.length!==1||typeof one[0]!=='string'||!/^\d+$/.test(one[0]))throw new HomePersonPrivacyInputError();
 const checked=(key:string)=>{
  const values=data.getAll(key);if(values.length>1||values.length===1&&values[0]!=='1')throw new HomePersonPrivacyInputError();
  return values.length===1;
 };
 return validateHomePersonPrivacyInput({expectedOrdinal:Number(one[0]),hideBirthday:checked('hideBirthday'),hideAnniversary:checked('hideAnniversary')});
}
