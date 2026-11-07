import {randomBytes} from 'node:crypto';
import {PersonnelImportHeaderError,parsePersonnelImportCsv,type PersonnelImportHeaderOptions} from './personnel-import-contract';
import {PersonnelCsvError,parsePersonnelCsv} from './personnel-csv';
import {AllocationFileError} from './cost-allocation-import';
import {WorkforceAccessError} from '../core/workforce-access';
import {ImportHistoryError} from '../core/import-history';
import {isDatabaseError} from './db-error';
import {publicErrorMessage} from './public-error';

/** Add import-screen guidance without changing the shared, approved AI parser. */
export function parseEmployeeImportText(text:string,options:PersonnelImportHeaderOptions){
  try{return parsePersonnelImportCsv(text,options);}
  catch(error){
    if(error instanceof PersonnelImportHeaderError && error.message.startsWith('Unrecognized or removed column “”.')){
      const sheet=options.sheet??'employee';
      const index=parsePersonnelCsv(text,sheet,options.rowLimit)[0]?.findIndex(raw=>!raw.replace(/^\uFEFF/,'').trim())??-1;
      if(index>=0)throw new PersonnelImportHeaderError(`The ${sheet} worksheet has a blank column heading at column ${index+1}. Add the matching heading from the current template, or remove the column if it is unused, then upload the file again.`);
    }
    throw error;
  }
}

/** Successful previews/results retain their shape; refusals travel as data, never RSC exceptions. */
export type EmployeeImportFailure = {error:string};
const expectedMessages=new Set([
  'Unknown register sheet.',
  'The import is too large. Split the workbook and check each part.',
  'Employee import inputs changed. Preview the complete file again.',
  'Cost Center Allocations changed. Preview the complete workbook again.',
]);
export function employeeImportFailure(error:unknown,operation:'validate'|'commit'):EmployeeImportFailure {
  if(isDatabaseError(error))return {error:publicErrorMessage(error)};
  if(error instanceof PersonnelImportHeaderError && error.message.startsWith('Unrecognized or removed column “”.')){
    return {error:'The file has a blank column heading. Add the matching heading from the current template, or remove the column if it is unused, then check the file again.'};
  }
  if(error instanceof PersonnelImportHeaderError || error instanceof PersonnelCsvError ||
    error instanceof AllocationFileError || error instanceof WorkforceAccessError ||
    error instanceof ImportHistoryError || error instanceof Error && expectedMessages.has(error.message)){
    return {error:publicErrorMessage(error)};
  }
  const reference=randomBytes(6).toString('hex').toUpperCase();
  console.error(`[employee import ${operation} ${reference}]`,error);
  return {error:operation==='validate'
    ? `The import could not be checked because of a system error. Try again. If it keeps failing, report reference ${reference}.`
    : `The import could not be completed. Check Import History before trying again, and report reference ${reference}.`};
}
