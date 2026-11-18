import {parseCsv,parseCsvRecords} from './csv';
import {INDIVIDUAL_IMPORT_HEADERS,type IndividualImportMethod} from './payroll-txn-import-schema';

export function parseIndividualImport(csv:string,method:IndividualImportMethod):Record<string,string>[] {
 if(method!=='monthly'&&method!=='daily')throw new Error('templateMismatch');
 if(new TextEncoder().encode(csv).byteLength>900000)throw new Error('fileTooLarge');
 const {headers,records}=parseCsvRecords(csv);
 const expected=INDIVIDUAL_IMPORT_HEADERS[method].map(h=>h.toLowerCase().replace(/\s+/g,'_'));
 if(parseCsv(csv).slice(1).some(row=>row.length>expected.length))throw new Error('templateMismatch');
 if(headers.length!==expected.length||headers.some((h,i)=>h!==expected[i])||new Set(headers).size!==headers.length)throw new Error('templateMismatch');
 if(!records.length)throw new Error('emptyFile');
 if(records.length>2000)throw new Error('tooManyRows');
 return records.map(r=>({employee_id:r.employee_id,employee_name:r['employee_name_(optional)'],pay_item_code:r.pay_item,
 transaction_date:r.effective_date,quantity:r.quantity,amount:r.amount??'',notes:r.remark??r.remarks??'',kind:'',payroll_cycle:'',
 __method:method,__pay_period:r.month_with_year,__configured_cycle:r.pay_cycle,__input_unit:r.input_type??''}));
}
