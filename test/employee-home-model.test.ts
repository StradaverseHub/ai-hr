import {describe,expect,it} from 'vitest';
import {locales} from '../i18n/config';
import {DEFAULT_HOME_QUICK_ACTIONS,employeeHomeGreetingName,homeDisplayClock,homeGreetingKey,homeGreetingTemplate,homeSummaryCandidates,
 renderHomeTemplate,visibleHomeQuickActions,validateHomeQuickActions,validateHomeTemplate,type HomeTemplate,type HomeTemplateKey,type HomeSummaryCandidate} from '../lib/employee-home';
const template=(key:HomeTemplateKey,body:string,priority=10):HomeTemplate=>({version:1,key,enabled:true,priority,text:Object.fromEntries(locales.map(locale=>[locale,body])) as HomeTemplate['text']});
describe('Employee Home deterministic presentation',()=>{
 it('validates complete six-language template versions and refuses arbitrary placeholders or executable properties',()=>{
  const value=template('tasksPending','Waiting for you: {count}');expect(validateHomeTemplate(value)).toEqual(value);
  expect(()=>validateHomeTemplate({...value,text:{en:'Waiting: {count}'}})).toThrow();
  for(const body of ['{salary}','{medicalReason}','{count, plural, one {task}}','<script>alert(1)</script>','Broken {count','Line\nBreak'])
   expect(()=>validateHomeTemplate(template('tasksPending',body))).toThrow();
  expect(()=>validateHomeTemplate({...value,extra:true})).toThrow();
  expect(()=>validateHomeTemplate({...value,get text(){throw Error('getter must not execute');}})).toThrow('template');
 });
 it('renders truthful task counts beyond ten thousand without changing anniversary bounds',()=>{
  const pending=template('tasksPending','Waiting: {count}');
  for(const count of [10001,20000,1000000,Number.MAX_SAFE_INTEGER])expect(renderHomeTemplate(pending,'en',{count})).toBe('Waiting: '+new Intl.NumberFormat('en').format(count));
  for(const count of [-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])expect(()=>renderHomeTemplate(pending,'en',{count})).toThrow();
  const anniversary=template('greetingAnniversary','{name}: {years}');
  expect(renderHomeTemplate(anniversary,'en',{name:'Fictional colleague',years:200})).toBe('Fictional colleague: 200');
  expect(()=>renderHomeTemplate(anniversary,'en',{name:'Fictional colleague',years:201})).toThrow();
 });
 it('substitutes only approved fields once and preserves values as literal text',()=>{
  expect(renderHomeTemplate(template('greetingMorning','Good morning, {name}'),'en',{name:'{count} <A&B>'})).toBe('Good morning, {count} <A&B>');
  expect(renderHomeTemplate(template('tasksPending','Waiting: {count}'),'en',{count:1234})).toBe('Waiting: 1,234');
  expect(()=>renderHomeTemplate(template('tasksPending','Waiting: {count}'),'en',{})).toThrow();
  expect(()=>renderHomeTemplate(template('tasksPending','Waiting: {count}'),'en',{count:Infinity})).toThrow();
  expect(()=>renderHomeTemplate(template('tasksPending','Waiting: {count}'),'en',{count:1,salary:5000})).toThrow();
 });
 it('uses preferred or given name without guessing which part of a full name is a first name',()=>{
  expect(employeeHomeGreetingName({preferredName:'  Mei  ',firstName:'Other',fullName:'Family Full'})).toBe('Mei');
  expect(employeeHomeGreetingName({firstName:'Arjun',fullName:'Family Full'})).toBe('Arjun');
  expect(employeeHomeGreetingName({fullName:'王小明'})).toBe('王小明');
  expect(employeeHomeGreetingName({})).toBeNull();
 });
 it('selects the display day and greeting from an explicit timezone without changing the business-day owner',()=>{
  const now=new Date('2026-10-20T00:30:00Z');
  expect(homeDisplayClock(now,'Asia/Kuala_Lumpur')).toMatchObject({date:'2026-10-20',hour:8});
  expect(homeDisplayClock(now,'America/New_York')).toMatchObject({date:'2026-10-19',hour:20});
  expect(()=>homeDisplayClock(now,'invalid/timezone')).toThrow();
  const base={birthday:false,firstDay:false,anniversary:false,returnedFromLeave:false};
  expect(homeGreetingKey({...base,hour:0})).toBe('greetingEvening');
  expect(homeGreetingKey({...base,hour:8})).toBe('greetingMorning');
  expect(homeGreetingKey({...base,hour:12})).toBe('greetingAfternoon');
  expect(homeGreetingKey({...base,hour:18})).toBe('greetingEvening');
  expect(homeGreetingKey({...base,hour:18,birthday:true,firstDay:true})).toBe('greetingBirthday');
  expect(homeGreetingKey({...base,hour:8,returnedFromLeave:true})).toBe('greetingReturn');
 });
 it('caps configured actions at six and treats visibility separately from owner authorization',()=>{
  expect(validateHomeQuickActions(DEFAULT_HOME_QUICK_ACTIONS)).toEqual(['leave','claim','payslip','profile']);
  expect(visibleHomeQuickActions(DEFAULT_HOME_QUICK_ACTIONS,new Set(['profile']))).toEqual(['profile']);
  expect(()=>validateHomeQuickActions(['leave','leave'])).toThrow();
  expect(()=>validateHomeQuickActions(['https://outside.invalid'])).toThrow();
  expect(()=>validateHomeQuickActions(['leave','claim','payslip','profile','calendar','notices','leave'])).toThrow();
 });
 it('falls back from disabled special greetings and applies configured priority to simultaneous events',()=>{
  const facts={hour:8,birthday:true,firstDay:false,anniversary:true,returnedFromLeave:false};
  const ordinary=template('greetingMorning','Morning, {name}');
  const birthday=template('greetingBirthday','Happy birthday, {name}',20);
  const anniversary=template('greetingAnniversary','{years} years, {name}',5);
  expect(homeGreetingTemplate(facts,[ordinary,birthday,anniversary])?.key).toBe('greetingAnniversary');
  expect(homeGreetingTemplate(facts,[ordinary,{...birthday,enabled:false},{...anniversary,enabled:false}])?.key).toBe('greetingMorning');
  expect(homeGreetingTemplate(facts,[ordinary])?.key).toBe('greetingMorning');
  expect(homeGreetingTemplate({...facts,anniversary:false},[ordinary,birthday])?.key).toBe('greetingBirthday');
  expect(homeGreetingTemplate(facts,[{...ordinary,enabled:false}])).toBeNull();
  expect(()=>homeGreetingTemplate(facts,[ordinary,ordinary])).toThrow('duplicates');
  expect(()=>homeGreetingTemplate({...facts,birthday:undefined as never},[ordinary])).toThrow('events');
 });
 it('orders real facts urgent/reminder/good-news, respects disabled templates and never pads missing facts',()=>{
  const templates=[template('tasksPending','Waiting: {count}',1000),template('holidayComing','{name}: {date}',0),template('leaveApproved','Approved: {dates}',0)];
  const values:HomeSummaryCandidate[]=[{key:'leave',templateKey:'leaveApproved',importance:'goodNews',values:{dates:'21–22 October'},destination:'leave'},
   {key:'holiday',templateKey:'holidayComing',importance:'reminder',values:{name:'Fictional holiday',date:'23 October'},destination:'calendar'},
   {key:'tasks',templateKey:'tasksPending',importance:'urgent',values:{count:2},destination:'tasks'}];
  expect(homeSummaryCandidates(values,templates).map(item=>item.key)).toEqual(['tasks','holiday','leave']);
  expect(homeSummaryCandidates([...values].reverse(),templates).map(item=>item.key)).toEqual(['tasks','holiday','leave']);
  expect(homeSummaryCandidates(values,[{...templates[0],enabled:false},...templates.slice(1)]).map(item=>item.key)).toEqual(['holiday','leave']);
  expect(homeSummaryCandidates(values.slice(0,1),templates)).toHaveLength(1);
  expect(homeSummaryCandidates([],templates)).toEqual([]);
  const privateFact={...values[0],values:{dates:'21 October',medicalReason:'must not reach a client'}};
  expect(()=>homeSummaryCandidates([privateFact as never],templates)).toThrow();
 });
});
