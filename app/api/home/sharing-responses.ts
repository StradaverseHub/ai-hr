import type {SessionContext} from '@/db/client';
import {AuthRequiredError} from '@/lib/auth-errors';
import {HomeAccessError} from '@/core/employee-home';
import {readHomeCelebrationPage,readHomeTeamPage} from '@/core/employee-home-sharing';
import {validateHomeCelebrationResponse,validateHomeTeamResponse} from '@/lib/employee-home-sharing';

export const sharingHeaders={'Cache-Control':'private, no-store','Vary':'Cookie, Authorization','X-Content-Type-Options':'nosniff'};

export function sharingError(error:unknown){
 const code=error instanceof AuthRequiredError?'authentication':error instanceof HomeAccessError?error.code:'unavailable';
 const status=code==='authentication'?401:code==='employmentUnavailable'?403:code==='chooseEmployment'?400:503;
 return {code,status} as const;
}

export async function teamResponse(session:SessionContext,employmentId:string,input:Parameters<typeof readHomeTeamPage>[2]={}){
 const page=await readHomeTeamPage(session,employmentId,input);
 return validateHomeTeamResponse({version:1,employmentId,page},employmentId,input.date);
}
export async function celebrationsResponse(session:SessionContext,employmentId:string,input:Parameters<typeof readHomeCelebrationPage>[2]={}){
 const page=await readHomeCelebrationPage(session,employmentId,input);
 return validateHomeCelebrationResponse({version:1,employmentId,page},employmentId);
}
