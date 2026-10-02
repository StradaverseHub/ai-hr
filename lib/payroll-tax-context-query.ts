import {payrollListReturnTo} from './return-to';
const uuid=/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
/** Carry only the shared payroll-list whitelist and a shaped job id, never a submitted redirect. */
export function payrollTaxContextQuery(rawFrom:unknown,rawJob:unknown):URLSearchParams{
  const q=new URLSearchParams();
  const from=payrollListReturnTo(rawFrom);
  if(from!=='/payroll')q.set('from',from);
  if(typeof rawJob==='string'&&uuid.test(rawJob))q.set('job',rawJob);
  return q;
}
