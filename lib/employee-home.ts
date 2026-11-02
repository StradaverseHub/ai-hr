/** Employee Home's deterministic presentation contract. No records, permissions or AI are owned here.
 * Services supply already-authorized, minimal facts; templates cannot retrieve more data or run code. */
import {locales,type Locale} from '../i18n/config';

export const EMPLOYEE_HOME_CARDS=['summary','today','calendar','notices','tasks','timeOff','team','celebrations'] as const;
export type EmployeeHomeCard=typeof EMPLOYEE_HOME_CARDS[number];
/** Defaults for the existing Dashboard Card Master, not a second per-company card store. */
export const EMPLOYEE_HOME_CARD_DEFAULTS=EMPLOYEE_HOME_CARDS.map((cardKey,index)=>({
 cardKey,name:({summary:'My Day at a Glance',today:'Your Day',calendar:'My Calendar',notices:'Notice Board',tasks:'Waiting for You',timeOff:'Time Off',team:"Who’s Around",celebrations:'Little Moments'} as const)[cardKey],
 cardType:cardKey==='tasks'?'action' as const:'information' as const,href:null,
 employeeSelectable:cardKey!=='summary',defaultDisplay:true,mandatory:cardKey==='summary',displayOrder:index+1,
}));
export const HOME_QUICK_ACTIONS=['leave','claim','payslip','profile','calendar','notices'] as const;
export type HomeQuickAction=typeof HOME_QUICK_ACTIONS[number];
export const HOME_TASK_KINDS=['leave','leaveCancellation','attendance','profile','claim','resignation','managerReview','hrReview','feedback','noticeAcknowledgement','replacementLeave','onboarding','performanceReview','assessmentWork','careerPlan','calibration','rewardReview'] as const;
export type HomeTaskKind=typeof HOME_TASK_KINDS[number];
export const DEFAULT_HOME_QUICK_ACTIONS:readonly HomeQuickAction[]=['leave','claim','payslip','profile'];
export const HOME_TEMPLATE_FIELDS={
 greetingMorning:['name'],greetingAfternoon:['name'],greetingEvening:['name'],
 greetingBirthday:['name'],greetingFirstDay:['name'],greetingAnniversary:['name','years'],greetingReturn:['name'],
 tasksPending:['count'],leaveApproved:['dates'],holidayComing:['name','date'],paydayComing:['date'],payslipReady:['period'],calm:[],
} as const;
export type HomeTemplateKey=keyof typeof HOME_TEMPLATE_FIELDS;
export type HomeGreetingTemplateKey=Extract<HomeTemplateKey,`greeting${string}`>;
export type HomeTemplate={version:1;key:HomeTemplateKey;enabled:boolean;priority:number;text:Record<Locale,string>};
export class HomeConfigurationError extends Error{
 constructor(readonly field:string){super('Invalid employee Home configuration: '+field);this.name='HomeConfigurationError';}
}
const refuse=(field:string):never=>{throw new HomeConfigurationError(field);};
function object(value:unknown,field:string):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return refuse(field);
 if(Object.values(Object.getOwnPropertyDescriptors(value)).some(descriptor=>'get' in descriptor||'set' in descriptor))return refuse(field);
 return value as Record<string,unknown>;
}
function keys(value:Record<string,unknown>,allowed:readonly string[],field:string){
 if(Object.keys(value).some(key=>!allowed.includes(key)))refuse(field);
}
export function homeTemplateTokens(key:HomeTemplateKey,body:unknown):string[]{
 if(!Object.hasOwn(HOME_TEMPLATE_FIELDS,key)||typeof body!=='string'||!body.trim()||body.length>600||/[\x00-\x1f\x7f<>]/.test(body))return refuse('template.text');
 const allowed:readonly string[]=HOME_TEMPLATE_FIELDS[key],tokens=[...body.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map(match=>match[1]);
 if(tokens.some(token=>!allowed.includes(token))||/[{}]/.test(body.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g,'')))return refuse('template.placeholders');
 return [...new Set(tokens)];
}
export function validateHomeTemplate(raw:unknown):HomeTemplate{
 const value=object(raw,'template');keys(value,['version','key','enabled','priority','text'],'template');
 if(value.version!==1||typeof value.key!=='string'||!Object.hasOwn(HOME_TEMPLATE_FIELDS,value.key))return refuse('template.key');
 if(typeof value.enabled!=='boolean'||!Number.isSafeInteger(value.priority)||Number(value.priority)<0||Number(value.priority)>1000)return refuse('template.options');
 const key=value.key as HomeTemplateKey,text=object(value.text,'template.text');keys(text,locales,'template.locales');
 const translated={} as Record<Locale,string>;
 for(const locale of locales){homeTemplateTokens(key,text[locale]);translated[locale]=text[locale] as string;}
 return {version:1,key,enabled:value.enabled,priority:value.priority as number,text:translated};
}
function templateValues(key:HomeTemplateKey,raw:unknown,required:readonly string[]):Record<string,string|number>{
 if(!Object.hasOwn(HOME_TEMPLATE_FIELDS,key))return refuse('template.key');
 const values=object(raw,'template.values'),allowed:readonly string[]=HOME_TEMPLATE_FIELDS[key];keys(values,allowed,'template.values');
 for(const token of new Set([...required,...Object.keys(values)])){
  const value=values[token],numeric=token==='count'||token==='years';
  // Work totals can exceed10,000; retain safe integer validation without hiding a large queue.
  if(numeric?typeof value!=='number'||!Number.isSafeInteger(value)||value<0||(token==='years'&&value>200):
   typeof value!=='string'||!value.trim()||value.length>500||/[\x00-\x1f\x7f]/.test(value))refuse('template.values.'+token);
 }
 return values as Record<string,string|number>;
}
/** One substitution pass. A value containing braces remains literal, never another template program.
 * The returned string is rendered as text; it is never HTML or an arbitrary navigation destination. */
export function renderHomeTemplate(template:HomeTemplate,locale:Locale,raw:unknown):string{
 const body=template.text[locale],tokens=homeTemplateTokens(template.key,body),values=templateValues(template.key,raw,tokens);
 const rendered=body.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g,(_,token:string)=>typeof values[token]==='number'?new Intl.NumberFormat(locale).format(values[token] as number):String(values[token]));
 if(rendered.length>2000)return refuse('template.renderedLength');return rendered;
}
export function validateHomeQuickActions(raw:unknown):HomeQuickAction[]{
 if(!Array.isArray(raw)||raw.length>6||new Set(raw).size!==raw.length||raw.some(value=>!HOME_QUICK_ACTIONS.includes(value)))return refuse('quickActions');
 return [...raw] as HomeQuickAction[];
}
/** Visibility only. Each linked owner repeats authorization at its own read/write boundary. */
export function visibleHomeQuickActions(configured:readonly HomeQuickAction[],allowed:ReadonlySet<HomeQuickAction>):HomeQuickAction[]{
 return validateHomeQuickActions(configured).filter(action=>allowed.has(action));
}
export type EmployeeHomeConfiguration={
 version:1;templates:HomeTemplate[];quickActions:HomeQuickAction[];
 effortMinutes:Partial<Record<HomeTaskKind,number>>;
 teamVisibility:'off'|'direct'|'department';
 celebrations:{enabled:boolean;scope:'direct'|'department'};
};
/** Versioned presentation and explicit sharing choices only. No arbitrary destinations, data selectors,
 * authority grants or executable conditions are accepted as configuration. Missing effort is unknown. */
export function validateEmployeeHomeConfiguration(raw:unknown):EmployeeHomeConfiguration{
 const value=object(raw,'configuration');keys(value,['version','templates','quickActions','effortMinutes','teamVisibility','celebrations'],'configuration');
 if(value.version!==1||!Array.isArray(value.templates)||value.templates.length!==Object.keys(HOME_TEMPLATE_FIELDS).length)return refuse('configuration.templates');
 const templates=value.templates.map(validateHomeTemplate);
 if(new Set(templates.map(row=>row.key)).size!==Object.keys(HOME_TEMPLATE_FIELDS).length)return refuse('configuration.templates');
 const quickActions=validateHomeQuickActions(value.quickActions),effort=object(value.effortMinutes,'configuration.effortMinutes');
 keys(effort,HOME_TASK_KINDS,'configuration.effortMinutes');
 const effortMinutes:Partial<Record<HomeTaskKind,number>>={};
 for(const [kind,minutes] of Object.entries(effort)){
  if(typeof minutes!=='number'||!Number.isSafeInteger(minutes)||minutes<0||minutes>1440)return refuse('configuration.effortMinutes');
  effortMinutes[kind as HomeTaskKind]=minutes;
 }
 if(!['off','direct','department'].includes(String(value.teamVisibility)))return refuse('configuration.teamVisibility');
 const celebrations=object(value.celebrations,'configuration.celebrations');keys(celebrations,['enabled','scope'],'configuration.celebrations');
 if(typeof celebrations.enabled!=='boolean'||!['direct','department'].includes(String(celebrations.scope)))return refuse('configuration.celebrations');
 return {version:1,templates,quickActions,effortMinutes,teamVisibility:value.teamVisibility as EmployeeHomeConfiguration['teamVisibility'],
  celebrations:{enabled:celebrations.enabled,scope:celebrations.scope as 'direct'|'department'}};
}
export type EmployeeHomePreferences={version:1;timeZone:string|null;weekStartsOn:number;hiddenCards:EmployeeHomeCard[];cardOrder:EmployeeHomeCard[]};
export function defaultEmployeeHomePreferences():EmployeeHomePreferences{
 return {version:1,timeZone:null,weekStartsOn:1,hiddenCards:[],cardOrder:[...EMPLOYEE_HOME_CARDS]};
}
/** Read-only transition from the previous dashboard's cosmetic keys. Keep an explicitly hidden
 * corresponding card hidden; genuinely new Home cards use the live master's defaults. The different
 * old layout geometry cannot establish an ordering for the new eight-slot surface. No stored value is
 * rewritten here, and a saved Home layout is always handed back unchanged to the canonical normalizer. */
export function employeeHomeLayoutInput(raw:unknown,defaultKeys:readonly string[]=EMPLOYEE_HOME_CARDS):unknown{
 if(raw==null)return raw;
 const value=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as Record<string,unknown>:null;
 const selected=value&&Array.isArray(value.selected)?value.selected.filter((key):key is string=>typeof key==='string'):null;
 const order=value&&Array.isArray(value.order)?value.order.filter((key):key is string=>typeof key==='string'):null;
 const all=Array.isArray(raw)?raw.filter((key):key is string=>typeof key==='string'):[...(selected??[]),...(order??[])];
 if(all.some(key=>EMPLOYEE_HOME_CARDS.some(card=>card===key)))return raw;
 if(!Array.isArray(raw)&&!selected&&!order)return raw;
 const corresponding:Partial<Record<EmployeeHomeCard,readonly string[]>>={timeOff:['leaveBalance'],calendar:['nextHoliday','upcomingEvents'],tasks:['pendingTasks'],notices:['noticeBoard']};
 // An old order-only array meant all its cards were shown. An explicit selected array can preserve hiding.
 const shown=new Set(defaultKeys);
 if(selected)for(const [card,previous] of Object.entries(corresponding)){
  if(!previous.some(key=>all.includes(key)))continue;
  if(previous.some(key=>selected.includes(key)))shown.add(card);else shown.delete(card);
 }
 return {selected:EMPLOYEE_HOME_CARDS.filter(card=>shown.has(card)),order:[...EMPLOYEE_HOME_CARDS]};
}
/** Cosmetic settings only. They neither change the HR business-day clock nor grant access to cards. */
export function validateEmployeeHomePreferences(raw:unknown):EmployeeHomePreferences{
 const value=object(raw,'preferences');keys(value,['version','timeZone','weekStartsOn','hiddenCards','cardOrder'],'preferences');
 if(value.version!==1||!Number.isInteger(value.weekStartsOn)||Number(value.weekStartsOn)<0||Number(value.weekStartsOn)>6)return refuse('preferences.weekStart');
 let timeZone:string|null=null;
 if(value.timeZone!==null){if(typeof value.timeZone!=='string')return refuse('preferences.timeZone');timeZone=homeDisplayClock(new Date(0),value.timeZone).timeZone;}
 const cards=(raw:unknown,field:string):EmployeeHomeCard[]=>{
  if(!Array.isArray(raw)||raw.length>EMPLOYEE_HOME_CARDS.length||new Set(raw).size!==raw.length||raw.some(key=>!EMPLOYEE_HOME_CARDS.includes(key)))return refuse(field);
  return [...raw] as EmployeeHomeCard[];
 };
 const hiddenCards=cards(value.hiddenCards,'preferences.hiddenCards'),cardOrder=cards(value.cardOrder,'preferences.cardOrder');
 if(hiddenCards.includes('summary')||cardOrder.length!==EMPLOYEE_HOME_CARDS.length)return refuse('preferences.cardOrder');
 return {version:1,timeZone,weekStartsOn:value.weekStartsOn as number,hiddenCards,cardOrder};
}
/** An obsolete stored preference must not prevent Home from rendering. Reading this fallback never
 * writes over the original value; an explicit validated Save is required to replace it. */
export function readEmployeeHomePreferences(raw:unknown):EmployeeHomePreferences{
 try{return validateEmployeeHomePreferences(raw);}catch{return defaultEmployeeHomePreferences();}
}
export function employeeHomeGreetingName(p:{preferredName?:string|null;firstName?:string|null;fullName?:string|null}):string|null{
 for(const value of [p.preferredName,p.firstName,p.fullName])if(value?.trim())return value.trim();
 return null;
}
export function homeDisplayClock(now:Date,timeZone:string):{date:string;hour:number;timeZone:string}{
 if(!Number.isFinite(now.getTime())||typeof timeZone!=='string'||timeZone.length>100)return refuse('timeZone');
 let format:Intl.DateTimeFormat;
 try{format=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'});}catch{return refuse('timeZone');}
 const parts=format.formatToParts(now),part=(type:Intl.DateTimeFormatPartTypes)=>parts.find(item=>item.type===type)?.value;
 return {date:`${part('year')}-${part('month')}-${part('day')}`,hour:Number(part('hour')),timeZone:format.resolvedOptions().timeZone};
}
/** Special-event booleans must come from the authorized self reader. No birth date/year is exposed. */
export function homeGreetingKey(p:{hour:number;birthday:boolean;firstDay:boolean;anniversary:boolean;returnedFromLeave:boolean}):HomeGreetingTemplateKey{
 if([p.birthday,p.firstDay,p.anniversary,p.returnedFromLeave].some(value=>typeof value!=='boolean'))return refuse('greeting.events');
 if(!Number.isInteger(p.hour)||p.hour<0||p.hour>23)return refuse('greeting.hour');
 if(p.birthday)return 'greetingBirthday';if(p.firstDay)return 'greetingFirstDay';
 if(p.anniversary)return 'greetingAnniversary';if(p.returnedFromLeave)return 'greetingReturn';
 return p.hour>=5&&p.hour<12?'greetingMorning':p.hour>=12&&p.hour<18?'greetingAfternoon':'greetingEvening';
}
/** Resolve configuration before choosing an event. Disabling a special greeting must not suppress the
 * ordinary time greeting. HR priority orders simultaneous enabled events; stable event order breaks ties. */
export function homeGreetingTemplate(p:Parameters<typeof homeGreetingKey>[0],templates:readonly HomeTemplate[]):HomeTemplate|null{
 const ordinary=homeGreetingKey({...p,birthday:false,firstDay:false,anniversary:false,returnedFromLeave:false});
 homeGreetingKey(p); // Validate the original event facts even when their templates are disabled.
 if(templates.length>Object.keys(HOME_TEMPLATE_FIELDS).length)return refuse('greeting.limit');
 const byKey=new Map(templates.map(raw=>{const template=validateHomeTemplate(raw);return [template.key,template] as const;}));
 if(byKey.size!==templates.length)return refuse('greeting.duplicates');
 const events:readonly [boolean,HomeGreetingTemplateKey][]=[
  [p.birthday,'greetingBirthday'],[p.firstDay,'greetingFirstDay'],
  [p.anniversary,'greetingAnniversary'],[p.returnedFromLeave,'greetingReturn'],
 ];
 const enabled=events.flatMap(([active,key],order)=>{
  const template=byKey.get(key);return active&&template?.enabled?[{template,order}]:[];
 }).sort((a,b)=>a.template.priority-b.template.priority||a.order-b.order);
 if(enabled.length)return enabled[0].template;
 const fallback=byKey.get(ordinary);return fallback?.enabled?fallback:null;
}
type SummaryKey=Extract<HomeTemplateKey,'tasksPending'|'leaveApproved'|'holidayComing'|'paydayComing'|'payslipReady'>;
type TemplateValues<Key extends HomeTemplateKey>={[Field in typeof HOME_TEMPLATE_FIELDS[Key][number]]:Field extends 'count'|'years'?number:string};
export type HomeSummaryCandidate={key:string;importance:'urgent'|'reminder'|'goodNews';destination:HomeQuickAction|'tasks'}&{
 [Key in SummaryKey]:{templateKey:Key;values:TemplateValues<Key>}
}[SummaryKey];
/** Urgent actions always precede reminders and good news. Stable identities break equal priorities;
 * missing/disabled templates are omitted, and no second sentence is fabricated to meet a quota. */
export function homeSummaryCandidates(candidates:readonly HomeSummaryCandidate[],templates:readonly HomeTemplate[]):HomeSummaryCandidate[]{
 if(candidates.length>100||templates.length>Object.keys(HOME_TEMPLATE_FIELDS).length)return refuse('summary.limit');
 const byKey=new Map(templates.map(template=>[template.key,template]));
 if(byKey.size!==templates.length||new Set(candidates.map(item=>item.key)).size!==candidates.length)return refuse('summary.duplicates');
 const weight={urgent:0,reminder:1,goodNews:2};
 return candidates.map(item=>{
  const row=object(item,'summary.candidate');keys(row,['key','templateKey','importance','values','destination'],'summary.candidate');
  if(typeof item.key!=='string'||!/^[A-Za-z0-9_:-]{1,160}$/.test(item.key)||!Object.hasOwn(weight,item.importance)||
   !['tasksPending','leaveApproved','holidayComing','paydayComing','payslipReady'].includes(item.templateKey)||
   !(item.destination==='tasks'||HOME_QUICK_ACTIONS.includes(item.destination)))return refuse('summary.candidate');
  templateValues(item.templateKey,item.values,HOME_TEMPLATE_FIELDS[item.templateKey]);
  return item;
 }).filter(item=>byKey.get(item.templateKey)?.enabled).sort((a,b)=>weight[a.importance]-weight[b.importance]||byKey.get(a.templateKey)!.priority-byKey.get(b.templateKey)!.priority||(a.key<b.key?-1:a.key>b.key?1:0)).slice(0,4);
}
