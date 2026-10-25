import {calendarWindowDates} from './calendar-window';

export type HomeSharingScope='off'|'direct'|'department';
export type HomeTeamMember={employmentId:string;name:string|null;presence:'leave'|null};
export type HomeTeamPage={scope:HomeSharingScope;date:string;totalPeople:number;items:HomeTeamMember[];nextCursor:string|null};
export type HomeTeamCalendarDay={date:string;available:boolean;totalPeople:number|null;items:{employmentId:string;name:string|null}[];nextCursor:string|null};
export type HomeTeamCalendar={scope:HomeSharingScope|'unavailable';from:string;to:string;days:HomeTeamCalendarDay[]};
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
 const value=object(raw,['scope','date','totalPeople','items','nextCursor']);
 const rows=items(value.items).map<HomeTeamMember>(raw=>{
  const row=object(raw,['employmentId','name','presence']);
  if(row.presence!==null&&row.presence!=='leave')return fail();
  return {employmentId:id(row.employmentId),name:name(row.name),presence:row.presence};
 });
 const result={scope:scope(value.scope),date:date(value.date),totalPeople:total(value.totalPeople,rows.length),items:rows,
  nextCursor:value.nextCursor===null?null:id(value.nextCursor)};
 if(result.date!==expectedDate||new Set(rows.map(row=>row.employmentId)).size!==rows.length
  ||result.scope==='off'&&(rows.length>0||result.totalPeople!==0||result.nextCursor!==null)
  ||result.nextCursor!==null&&result.nextCursor!==rows.at(-1)?.employmentId)return fail();
 return result;
}
export function validateHomeTeamCalendar(raw:unknown,from:string,to:string):HomeTeamCalendar{
 const value=object(raw,['scope','from','to','days']),dates=calendarWindowDates(from,to),sharing=value.scope==='unavailable'?'unavailable' as const:scope(value.scope);
 if(value.from!==from||value.to!==to||!Array.isArray(value.days)||value.days.length!==dates.length)return fail();
 const days=value.days.map<HomeTeamCalendarDay>((raw,index)=>{
  const day=object(raw,['date','available','totalPeople','items','nextCursor']);
  if(day.date!==dates[index]||typeof day.available!=='boolean')return fail();
  const peers=items(day.items).map(raw=>{const peer=object(raw,['employmentId','name']);return {employmentId:id(peer.employmentId),name:name(peer.name)};});
  if(peers.length>5||new Set(peers.map(peer=>peer.employmentId)).size!==peers.length)return fail();
  const count=day.totalPeople===null?null:total(day.totalPeople,peers.length),next=day.nextCursor===null?null:id(day.nextCursor);
  if(!day.available&&(count!==null||peers.length>0||next!==null)||(sharing==='off'||sharing==='unavailable')&&day.available
   ||day.available&&count===null||next!==null&&(next!==peers.at(-1)?.employmentId||count===null||count<=peers.length)
   ||day.available&&count!==null&&count>peers.length&&next===null)return fail();
  return {date:dates[index],available:day.available,totalPeople:count,items:peers,nextCursor:next};
 });
 return {scope:sharing,from,to,days};
}
export function validateHomeTeamResponse(raw:unknown,employmentId:string,expectedDate?:string){
 const value=object(raw,['version','employmentId','page']);
 if(value.version!==1||value.employmentId!==employmentId)return fail();
 const page=object(value.page,['scope','date','totalPeople','items','nextCursor']);
 return {version:1 as const,employmentId,page:validateHomeTeamPage(page,expectedDate??date(page.date))};
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
export function validateHomeCelebrationResponse(raw:unknown,employmentId:string){
 const value=object(raw,['version','employmentId','page']);
 if(value.version!==1||value.employmentId!==employmentId)return fail();
 return {version:1 as const,employmentId,page:validateHomeCelebrationPage(value.page)};
}
