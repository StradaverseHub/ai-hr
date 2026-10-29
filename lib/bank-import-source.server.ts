/** This decoder runs only in the durable worker, never in a response deadline. */
import {readImportFile} from './import-file';
import {BANK_IMPORT_MAX_BYTES,BANK_IMPORT_MAX_ROWS} from './bank-import-job';
import {parsePersonnelImportCsv} from './personnel-import-contract';
import {personnelImportLabelResolvers} from './personnel-import-labels.runtime';
import {sectionParseColumns} from './import-sections';
import {normalizeEmployeeCode} from './employee-code';
export async function decodeBankImportSource(name:string,content:Buffer){
 const {text}=await readImportFile(new File([new Uint8Array(content)],name),{allowedSheets:['Reference','Instructions','__PersonnelLists'],maxFileBytes:BANK_IMPORT_MAX_BYTES,maxCsvBytes:BANK_IMPORT_MAX_BYTES,maxRows:BANK_IMPORT_MAX_ROWS+2,maxCells:20_000_000});
 const parsed=parsePersonnelImportCsv(text,{columns:sectionParseColumns('bank_statutory'),sheet:'employee',rowLimit:BANK_IMPORT_MAX_ROWS+2,resolvers:personnelImportLabelResolvers});
 if(!parsed.records.length||parsed.records.length>BANK_IMPORT_MAX_ROWS)throw new Error('Choose a file with 1 to 250,000 data rows.');
 const codes=new Map<string,number>(),cards=new Map<string,number[]>(),errors=new Map<number,string>();
 parsed.records.forEach((r,index)=>{
  const code=normalizeEmployeeCode(r.employee_code),prior=codes.get(code);
  if(code){if(prior!==undefined)errors.set(index+1,`Duplicate Employee ID in this file; first used at row ${prior}.`);else codes.set(code,index+1);}
  const card=r.card_id?.trim().toLowerCase();if(card){const group=cards.get(card)??[];group.push(index+1);cards.set(card,group);}
 });
 for(const group of cards.values())if(group.length>1)for(const row of group)errors.set(row,'Duplicate Card ID in this file.');
 return{...parsed,errors};
}
