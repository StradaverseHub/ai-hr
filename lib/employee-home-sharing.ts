import {calendarWindowDates} from './calendar-window';

export type HomeSharingScope='off'|'direct'|'department';
export type HomeTeamMember={employmentId:string;name:string|null;presence:'full_day'|'part_day'|null};
export type HomeTeamPage={scope:HomeSharingScope;date:string;totalEmployments:number;items:HomeTeamMember[];nextCursor:string|null};
export type HomeCelebration={employmentId:string;name:string|null;date:string;kind:'birthday'|'anniversary';years:number|null};
export type HomeCelebrationPage={scope:HomeSharingScope;from:string;to:string;total:number;items:HomeCelebration[];nextCursor:string|null};
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const eventCursor=/^\d{4}-\d{2}-\d{2}\|(birthday|anniversary)\|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const fail=():never=>{throw Error('Home sharing unavailable.');};
function object(value:unknown,keys:string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value))return fail();
 const record=value as Record<string,unknown>;
 if(Object.keys(record).length!==keys.length||keys.some(key=>!Object.hasOwn(record,key)))return fail();
 return record;
}
function scope(value:unknown):HomeSharingScope{
 if(value!=='off'&&value!=='direct'&&value!=='department')return fail();return value;
}
function date(value:unknown):string{if(typeof value!=='string')return fail();calendarWindowDates(value,value);return value;}
function name(value:unknown):string|null{if(value===null)return null;if(typeof value!=='string'||!value.trim()||value.length>1000)return fail();return value;}
function id(value:unknown):string{if(typeof value!=='string'||!uuid.test(value))return fail();return value;}
function total(value:unknown,count:number):number{if(!Number.isSafeInteger(value)||Number(value)<count)return fail();return Number(value);}
function items(value:unknown):unknown[]{if(!Array.isArray(value)||value.length>50)return fail();return value;}
export function homeSharingPageInput(after:string|undefined,limit=20,kind:'team'|'celebration'='team'){
 if(!Number.isSafeInteger(limit)||limit<1||limit>50||after!==undefined&&!(kind==='team'?uuid:eventCursor).test(after))throw Error('Invalid Home sharing page.');
 if(after!==undefined&&kind==='celebration')calendarWindowDates(after.slice(0,10),after.slice(0,10));
 return {after:after??null,limit};
}
export function validateHomeTeamPage(raw:unknown,expectedDate:string):HomeTeamPage{
 const value=object(raw,['scope','date','totalEmployments','items','nextCursor']);
 const rows=items(value.items).map<HomeTeamMember>(raw=>{
  const row=object(raw,['employmentId','name','presence']);
  if(row.presence!==null&&row.presence!=='full_day'&&row.presence!=='part_day')return fail();
  return {employmentId:id(row.employmentId),name:name(row.name),presence:row.presence};
 });
 const result={scope:scope(value.scope),date:date(value.date),totalEmployments:total(value.totalEmployments,rows.length),items:rows,
  nextCursor:value.nextCursor===null?null:id(value.nextCursor)};
 if(result.date!==expectedDate||new Set(rows.map(row=>row.employmentId)).size!==rows.length
  ||result.scope==='off'&&(rows.length>0||result.totalEmployments!==0||result.nextCursor!==null)
  ||result.nextCursor!==null&&result.nextCursor!==rows.at(-1)?.employmentId)return fail();
 return result;
}
export function validateHomeCelebrationPage(raw:unknown):HomeCelebrationPage{
 const value=object(raw,['scope','from','to','total','items','nextCursor']);
 const from=date(value.from),to=date(value.to);
 if(calendarWindowDates(from,to).length!==8)return fail();
 const rows=items(value.items).map<HomeCelebration>(raw=>{
  const row=object(raw,['employmentId','name','date','kind','years']);
  if(row.kind!=='birthday'&&row.kind!=='anniversary'||row.kind==='birthday'&&row.years!==null
   ||row.kind==='anniversary'&&row.years!==null&&(!Number.isSafeInteger(row.years)||Number(row.years)<1))return fail();
  const on=date(row.date);if(on<from||on>to)return fail();
  return {employmentId:id(row.employmentId),name:name(row.name),date:on,kind:row.kind,years:row.years as number|null};
 });
 const next=value.nextCursor;
 if(next!==null&&(typeof next!=='string'||!eventCursor.test(next)))return fail();
 const result={scope:scope(value.scope),from,to,total:total(value.total,rows.length),items:rows,nextCursor:next as string|null};
 const keys=rows.map(row=>row.date+'|'+row.kind+'|'+row.employmentId);
 if(new Set(keys).size!==keys.length||result.scope==='off'&&(rows.length>0||result.total!==0||next!==null)
  ||next!==null&&next!==keys.at(-1))return fail();
 return result;
}
