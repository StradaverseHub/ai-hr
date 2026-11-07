import {revalidatePath} from 'next/cache';
import {getLocale,getTranslations} from 'next-intl/server';
import {scopedAdmin} from '@/lib/scope';
import {isSameOriginBrowserRequest} from '@/lib/request-origin';
import {BodyReadError} from '@/lib/bounded-body';
import {escapeFormHtml as esc,hiddenFormField as hidden,NativeFormError,readNativeUrlForm} from '@/lib/native-form';
import {parseRosterDraftSelection,parseRosterSelection,RosterSelectionError} from '@/lib/roster-selection';
import {isCalendarDate} from '@/lib/calendar-date';
import {currentUiTheme} from '@/lib/ui-theme-server';
import {copyRoster,generateRosterFromTemplate,listShiftsForTenant,RosterAdminRequiredError} from '@/core/roster';
import {rosterEmployeePage,rosterPopulationReview} from '@/core/roster-presentation';
import {listDepartments} from '@/core/read';
import {organisationChoiceLabel} from '@/lib/organisation-choice-label';
import {AiGatewayError} from '@/lib/ai/types';
import {rosterPopulationScope} from '../population-scope';
import {rosterCommandScope,rosterCommandTargets,RosterCommandTargetError} from '../command-targets';

export const runtime='nodejs';
const headers={'Cache-Control':'private, no-store','Content-Type':'text/html; charset=utf-8','X-Content-Type-Options':'nosniff'};
const allowed=new Set(['command','stage','review','companyId','populationQuery','selectionIds','employmentIds','currentPageIds','offset','pickerQuery','selectionMode','shiftId','departmentId','from','to','sourceFrom','sourceTo','targetFrom']);
const commandKeys=['command','companyId','populationQuery','shiftId','departmentId','from','to','sourceFrom','sourceTo','targetFrom'] as const;
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
type T=Awaited<ReturnType<typeof getTranslations<'roster'>>>;
function text(data:FormData,key:string,maximum=16384){const value=data.get(key);if(value===null)return '';if(typeof value!=='string'||value.length>maximum)throw new NativeFormError('Invalid field');return value;}
function validateControls(data:FormData){
 const command=text(data,'command');if(!['generate','copy'].includes(command)||!uuid.test(text(data,'companyId')))throw new NativeFormError('Invalid command');
 const dates=command==='generate'?['from','to']:['sourceFrom','sourceTo','targetFrom'];
 if(dates.some(key=>!isCalendarDate(text(data,key,10))))throw new NativeFormError('Invalid dates');
 if(command==='generate'&&(!uuid.test(text(data,'shiftId'))||text(data,'departmentId')&&!uuid.test(text(data,'departmentId'))))throw new NativeFormError('Invalid shift or department');
 return command;
}
function fields(data:FormData){return commandKeys.map(key=>hidden(key,text(data,key))).join('');}
function backHref(data:FormData){const q=new URLSearchParams(text(data,'populationQuery'));for(const key of [...q.keys()])if(!['companyId','myTeam','view','month','from','to','bu','dept','q','page','size'].includes(key))q.delete(key);q.set('companyId',text(data,'companyId'));return '/roster?'+q;}
function documentHtml(locale:string,theme:string,title:string,back:string,backLabel:string,body:string){
 return `<!doctype html><html lang="${esc(locale)}" data-ui-theme="${esc(theme)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{font:1rem/1.5 system-ui,sans-serif;margin:2rem auto;padding:0 1rem;max-width:64rem;color:CanvasText;background:Canvas;color-scheme:light dark}header,form,section{margin-bottom:1.5rem}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:.5rem;border-bottom:1px solid GrayText}fieldset{margin:1rem 0}label{display:block;margin:.35rem 0}button,input,select{font:inherit;padding:.4rem}button,a{cursor:pointer}nav{display:flex;gap:1rem;flex-wrap:wrap}html[data-ui-theme="monolith"] button{border-radius:0}html[data-ui-theme="classic"] button{border-radius:.5rem}html[data-ui-theme="atelier"]{font-family:system-ui,sans-serif}</style></head><body><header><a href="${esc(back)}">${esc(backLabel)}</a><h1>${esc(title)}</h1></header>${body}</body></html>`;
}
function selectedDraft(data:FormData){
 const previous=parseRosterDraftSelection(data.get('selectionIds')),page=parseRosterDraftSelection(data.get('currentPageIds'));
 const posted=parseRosterDraftSelection(JSON.stringify(data.getAll('employmentIds')));
 const selected=new Set(previous);for(const id of page)selected.delete(id);for(const id of posted)selected.add(id);
 return parseRosterDraftSelection(JSON.stringify([...selected]));
}
function controlSummary(data:FormData,t:T,labels:{shiftId:string;departmentId:string}){
 const keys=text(data,'command')==='generate'?['shiftId','departmentId','from','to']:['sourceFrom','sourceTo','targetFrom'];
 return `<dl>${keys.filter(key=>text(data,key)).map(key=>`<dt>${esc(t(key==='shiftId'?'shifts':key==='departmentId'?'filterDepartment':key==='sourceFrom'||key==='sourceTo'?'copySource':key==='targetFrom'?'copyTargetStart':key==='from'?'filterFrom':'filterTo'))}</dt><dd>${esc(key==='shiftId'?labels.shiftId:key==='departmentId'?labels.departmentId:text(data,key))}</dd>`).join('')}</dl>`;
}

/** Native preparation/browsing is a read. Only the separate explicit Confirm POST writes. */
export async function POST(request:Request){
 const site=request.headers.get('sec-fetch-site');
 if(!isSameOriginBrowserRequest(request)||site!==null&&site!=='same-origin'||request.headers.has('authorization'))return new Response('Forbidden',{status:403,headers});
 const {s}=await scopedAdmin(),t=await getTranslations('roster'),pt=await getTranslations('pagination'),locale=await getLocale(),theme=await currentUiTheme();
 if(!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(request.headers.get('content-type')??''))return new Response(esc(t('prepareFailed')),{status:415,headers});
 let data:FormData;
 try{data=await readNativeUrlForm(request,6_000_000,allowed,new Set(['employmentIds']));}catch(error){return new Response(esc(t('prepareFailed')),{status:error instanceof BodyReadError?413:400,headers});}
 let command:string,stage:string,back:string;
 try{
  command=validateControls(data);for(const key of commandKeys)text(data,key);
  const review=text(data,'review');if(review&&!['selected','matching'].includes(review))throw new NativeFormError('Invalid review');
  if(review)data.set('selectionMode',review);
  stage=review?'prepare':text(data,'stage')||'prepare';
  if(!['browse','prepare','confirm'].includes(stage))throw new NativeFormError('Invalid stage');
  back=backHref(data);
 }catch{return new Response(esc(t('prepareFailed')),{status:400,headers});}
 const render=(body:string,status=200)=>new Response(documentHtml(locale,theme,t('prepareTitle'),back,t('exceptionsBack'),body),{status,headers});
 try{
  if(stage==='confirm'){
   const ids=await rosterCommandTargets(s,data,command==='generate');
   const q=new URLSearchParams({companyId:text(data,'companyId')});
   if(command==='generate'){
    const result=await generateRosterFromTemplate(s,{shiftId:text(data,'shiftId'),employmentIds:ids,from:text(data,'from'),to:text(data,'to')});
    q.set('month',text(data,'from').slice(0,7));q.set('generated',`${result.employments}.${result.workingRows}.${result.restRows}`);
   }else{
    const result=await copyRoster(s,{employmentIds:ids,sourceFrom:text(data,'sourceFrom'),sourceTo:text(data,'sourceTo'),targetFrom:text(data,'targetFrom')});
    q.set('month',text(data,'targetFrom').slice(0,7));q.set('copied',String(result.copied));
   }
   revalidatePath('/roster');return new Response(null,{status:303,headers:{...headers,Location:'/roster?'+q}});
  }
  const scope=await rosterCommandScope(s,data);
  const shifts=await listShiftsForTenant(s),departments=await listDepartments(s,{companyIds:scope.companyIds});
  const selectedShift=shifts.find(row=>row.id===text(data,'shiftId')),selectedDepartment=departments.find(row=>row.id===text(data,'departmentId'));
  if(command==='generate'&&(!selectedShift||text(data,'departmentId')&&!selectedDepartment))throw new NativeFormError('Shift or department unavailable');
  const labels={shiftId:selectedShift?`${selectedShift.code?selectedShift.code+' · ':''}${selectedShift.name}`:'—',departmentId:selectedDepartment?organisationChoiceLabel(selectedDepartment):'—'};
  const draft=selectedDraft(data),query=new URLSearchParams(text(data,'populationQuery'));
  if(data.has('pickerQuery')){const search=text(data,'pickerQuery',1000);if(search)query.set('q',search);else query.delete('q');}
  const population=await rosterPopulationScope(s,query,text(data,'companyId'),{requireWrite:true});
  if(stage==='browse'){
   const raw=text(data,'offset')||'0',offset=Number(raw);if(!/^\d+$/.test(raw)||!Number.isSafeInteger(offset))throw new NativeFormError('Invalid page');
   const page=await rosterEmployeePage(s,{...population,offset,limit:25},request.signal),picked=new Set(draft);
   const rows=page.rows.map(row=>`<label><input type="checkbox" name="employmentIds" value="${esc(row.employmentId)}"${picked.has(row.employmentId)?' checked':''}> ${esc(row.name)}${row.code?' ('+esc(row.code)+')':''}</label>`).join('');
   const range=page.rows.length?pt('range',{from:offset+1,to:offset+page.rows.length,total:page.total}):pt('rangeEmpty',{total:page.total});
   return render(`<p>${esc(t('selectedCount',{n:draft.length}))}</p>${controlSummary(data,t,labels)}<form method="post" action="/roster/prepare">${fields(data)}${hidden('selectionIds',JSON.stringify(draft))}${hidden('currentPageIds',JSON.stringify(page.rows.map(row=>row.employmentId)))}<label>${esc(t('filterEmployee'))}<input name="pickerQuery" value="${esc(query.get('q')??'')}"></label><button>${esc(t('query'))}</button><fieldset><legend>${esc(t('scopeEmployees'))}</legend>${rows}</fieldset><p>${esc(range)}</p><nav><button name="offset" value="${Math.max(0,offset-25)}"${offset===0?' disabled':''}>${esc(pt('previous'))}</button><button name="offset" value="${offset+25}"${offset+page.rows.length>=page.total?' disabled':''}>${esc(pt('next'))}</button></nav><input type="hidden" name="stage" value="browse"><button type="submit" name="review" value="selected">${esc(t('reviewTargets'))}</button><button type="submit" name="review" value="matching">${esc(t('pickerSelectMatching',{n:page.total}))}</button></form>`);
  }
  const department=command==='generate'&&text(data,'departmentId')?{departmentId:text(data,'departmentId'),shiftId:text(data,'shiftId')}:undefined;
  const matching=text(data,'selectionMode')==='matching';
  const {ids,page}=await rosterPopulationReview(s,department?{...scope,department}:matching?population:{...scope,selectedIds:parseRosterSelection(JSON.stringify(draft))},request.signal);

  return render(`<p>${esc(t('selectedCount',{n:ids.length}))}</p><p>${esc(t('prepareHint'))}</p>${controlSummary(data,t,labels)}<table><thead><tr><th>${esc(t('employee'))}</th><th>${esc(t('colEmployeeNo'))}</th></tr></thead><tbody>${page.rows.map(row=>`<tr><td>${esc(row.name)}</td><td>${esc(row.code??'')}</td></tr>`).join('')}</tbody></table><p>${esc(pt('range',{from:1,to:page.rows.length,total:ids.length}))}</p><form method="post" action="/roster/prepare">${fields(data)}${hidden('selectionIds',JSON.stringify(ids))}${hidden('stage','confirm')}<button type="submit">${esc(t('confirmRoster'))}</button></form>`);
 }catch(error){
  if(request.signal.aborted)throw error;
  if(error instanceof RosterAdminRequiredError||error instanceof AiGatewayError||error instanceof Error&&error.message==='Forbidden')return render(`<p role="alert">${esc(t('prepareFailed'))}</p>`,403);
  if(error instanceof NativeFormError||error instanceof RosterSelectionError||error instanceof RosterCommandTargetError)return render(`<p role="alert">${esc(t('prepareFailed'))}</p>`,400);
  throw error;
 }
}
