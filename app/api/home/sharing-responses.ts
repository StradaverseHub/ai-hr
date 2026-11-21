import {getLocale} from 'next-intl/server';
import {readEmployeeHomeNotices} from '@/core/employee-home-notices';
import {readEmployeeHomeTimeOff} from '@/core/employee-home-time-off';
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

export async function teamResponse(session:SessionContext,employmentId:string,input:Parameters<typeof readHomeTeamPage>[2]={},signal?:AbortSignal){
 const page=await readHomeTeamPage(session,employmentId,input,signal);
 return validateHomeTeamResponse({version:1,employmentId,page},employmentId,input.date);
}
export async function celebrationsResponse(session:SessionContext,employmentId:string,input:Parameters<typeof readHomeCelebrationPage>[2]={},signal?:AbortSignal){
 const page=await readHomeCelebrationPage(session,employmentId,input,signal);
 return validateHomeCelebrationResponse({version:1,employmentId,page},employmentId);
}

export async function noticesResponse(session:SessionContext,employmentId:string,signal?:AbortSignal){
 const value=await readEmployeeHomeNotices(session,employmentId,signal);
 return {version:value.version,employmentId:value.employmentId,total:value.total,unread:value.unread,
   acknowledgementRequired:value.acknowledgementRequired,items:value.items.map(row=>({id:row.id,title:row.title,
    summary:row.summary,category:row.category,pinned:row.pinned,requiresAcknowledgement:row.requiresAcknowledgement,
    publishedAt:row.publishedAt,publishedBy:row.publishedBy,firstViewedAt:row.firstViewedAt,acknowledgedAt:row.acknowledgedAt}))};
}

export async function timeOffResponse(session:SessionContext,employmentId:string|undefined,signal?:AbortSignal){
 const value=await readEmployeeHomeTimeOff(session,employmentId,await getLocale(),signal);
 return {version:value.version,employmentId:value.employmentId,asOf:value.asOf,canApply:value.canApply,
   balances:value.balances.map(row=>({id:row.id,name:row.name,annualLeave:row.annualLeave,available:row.available,pending:row.pending})),
   nextApproved:value.nextApproved?{requestId:value.nextApproved.requestId,date:value.nextApproved.date,duration:value.nextApproved.duration}:null};
}
