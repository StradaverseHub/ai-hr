import {isCalendarDate} from './calendar-date';
import {todayInKualaLumpur} from './hr-date';
import {LetterWorkflowError} from './letter-workflow';
import type {LetterReportFilter} from '../core/letters';
export function letterReportFilter(params:URLSearchParams):LetterReportFilter{
 const today=todayInKualaLumpur(),from=params.get('from')??today.slice(0,7)+'-01',to=params.get('to')??today;
 if(!isCalendarDate(from)||!isCalendarDate(to)||from>to||(Date.parse(to)-Date.parse(from))/86400000>365)throw new LetterWorkflowError('invalid','period');
 const result:LetterReportFilter={from,to};for(const key of ['companyId','departmentId','cursor'] as const){const value=params.get(key);if(value){if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))throw new LetterWorkflowError('invalid','identity');result[key]=value;}}
 return result;
}
export function letterReportQuery(input:LetterReportFilter){const params=new URLSearchParams({from:input.from,to:input.to});for(const key of ['companyId','departmentId'] as const)if(input[key])params.set(key,input[key]!);return params;}
