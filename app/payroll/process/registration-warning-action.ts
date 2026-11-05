'use server';
import {getSession} from '@/lib/session';
import {companyRegistrationPayrollWarning} from '@/core/company-registration-readiness';
export async function checkRegistrationReadiness(input:{companyIds:string[];payPeriod:string;employmentIds?:string[];payrollCycleId?:string}){return companyRegistrationPayrollWarning(await getSession(),input);}
