import { PERSONNEL_FIELDS } from './personnel-field-registry';
import { customHolderGaps } from './custom-holder';
export type PersonnelBankValues={bankName:string|null;bankAccountNo:string|null;enableCustomHolderName:boolean;customHolderName:string|null;enableCustomHolderId:boolean;customHolderId:string|null};
const empty:PersonnelBankValues={bankName:null,bankAccountNo:null,enableCustomHolderName:false,customHolderName:null,enableCustomHolderId:false,customHolderId:null};
export function personnelBankValues(record:Record<string,string>,stored:Partial<PersonnelBankValues>={}) {
  const values={...empty,...stored};const supplied:(keyof PersonnelBankValues)[]=[];const errors:string[]=[];
  for(const field of PERSONNEL_FIELDS.filter(field=>field.import.writer==='bank')) {
    const column=field.import.column!,key=field.import.writerField! as keyof PersonnelBankValues,raw=(record[column]??'').trim();if(!raw)continue;
    let value:string|boolean=raw;
    if(field.type==='boolean') {
      if(['yes','true','1','y'].includes(raw.toLowerCase()))value=true;
      else if(['no','false','0','n'].includes(raw.toLowerCase()))value=false;
      else {errors.push(`${column} must be yes or no`);continue;}
    }
    (values as Record<string,string|boolean|null>)[key]=value;supplied.push(key);
  }
  if(supplied.length) {
    if(Boolean(values.bankName)!==Boolean(values.bankAccountNo))errors.push('bank_name and bank_account_no must be provided together');
    for(const field of customHolderGaps(values))errors.push(field==='name'?'Enter the custom holder name or turn its switch off.':'Enter the custom holder identification or turn its switch off.');
    if(supplied.includes('customHolderName')&&!values.enableCustomHolderName)errors.push('Turn on the custom holder name switch before supplying a custom holder name.');
    if(supplied.includes('customHolderId')&&!values.enableCustomHolderId)errors.push('Turn on the custom holder identification switch before supplying a custom identification.');
  }
  return {values,supplied,errors};
}
