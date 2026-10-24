import {HOME_QUICK_ACTIONS,type HomeQuickAction} from './employee-home';

export const HOME_ACTION_REFUSALS=['moduleUnavailable','notConfigured','noPayslip','detailsLocked'] as const;
export type HomeActionRefusal=typeof HOME_ACTION_REFUSALS[number];
export type EmployeeHomeSummary={
 version:1;employmentId:string;serverNow:string;
 items:{key:string;message:string;destination:HomeQuickAction|'tasks'}[];
 calm:string|null;
 quickActions:{key:HomeQuickAction;reason:HomeActionRefusal|null}[];
};
/** Fixed destinations only. Neither an HR template nor a transport response supplies arbitrary URLs.
 * Tasks are account-wide and can belong to different module owners, so their count is plain text. */
export function homeSummaryHref(key:HomeQuickAction|'tasks',employmentId:string):string|null{
 const params=new URLSearchParams({employmentId});
 switch(key){
  case 'tasks':return null;
  case 'leave':return '/leave?'+params;
  case 'claim':return '/claims?'+params;
  case 'payslip':return '/me?'+new URLSearchParams({tab:'payroll',employmentId});
  case 'profile':return '/me?'+params;
  case 'calendar':return '/me/calendar?'+params;
  case 'notices':return '/notices?'+params;
 }
}
export function homeQuickActionHref(key:HomeQuickAction,employmentId:string):string{
 return key==='leave'?'/leave?'+new URLSearchParams({apply:'1',employmentId}):homeSummaryHref(key,employmentId)!;
}
export function validateEmployeeHomeSummary(raw:unknown,employmentId:string):EmployeeHomeSummary{
 const fail=():never=>{throw Error('Home summary unavailable');};
 const object=(value:unknown,allowed:readonly string[]):Record<string,unknown>=>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))return fail();
  return value as Record<string,unknown>;
 };
 const text=(value:unknown)=>typeof value==='string'&&Boolean(value.trim())&&value.length<=2000&&!/[\x00-\x1f\x7f]/.test(value);
 const value=object(raw,['version','employmentId','serverNow','items','calm','quickActions']);
 if(value.version!==1||value.employmentId!==employmentId||typeof value.serverNow!=='string'||!Number.isFinite(Date.parse(value.serverNow))
  ||!Array.isArray(value.items)||value.items.length>4||!Array.isArray(value.quickActions)||value.quickActions.length>6
  ||value.calm!==null&&!text(value.calm)||value.calm!==null&&value.items.length>0)return fail();
 const items=value.items.map(raw=>{
  const row=object(raw,['key','message','destination']);
  if(typeof row.key!=='string'||!/^[A-Za-z0-9_:-]{1,160}$/.test(row.key)||!text(row.message)
   ||row.destination!=='tasks'&&!HOME_QUICK_ACTIONS.some(key=>key===row.destination))return fail();
  return {key:row.key,message:row.message as string,destination:row.destination as HomeQuickAction|'tasks'};
 });
 const quickActions=value.quickActions.map(raw=>{
  const row=object(raw,['key','reason']);
  if(!HOME_QUICK_ACTIONS.some(key=>key===row.key)||row.reason!==null&&!HOME_ACTION_REFUSALS.some(reason=>reason===row.reason))return fail();
  return {key:row.key as HomeQuickAction,reason:row.reason as HomeActionRefusal|null};
 });
 if(new Set(items.map(row=>row.key)).size!==items.length||new Set(quickActions.map(row=>row.key)).size!==quickActions.length)return fail();
 return {version:1,employmentId,serverNow:value.serverNow,items,calm:value.calm as string|null,quickActions};
}
