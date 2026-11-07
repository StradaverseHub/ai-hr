import {randomBytes} from 'node:crypto';
import {PersonnelImportHeaderError} from './personnel-import-contract';
import {PersonnelCsvError} from './personnel-csv';
import {AllocationFileError} from './cost-allocation-import';
import {WorkforceAccessError} from '../core/workforce-access';
import {ImportHistoryError} from '../core/import-history';
import {isDatabaseError} from './db-error';
import {publicErrorMessage} from './public-error';

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
