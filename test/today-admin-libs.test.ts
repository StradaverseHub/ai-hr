/** HR administrator and manager Today: the pure rules (lib/today/admin.ts). Expected values are written out from the
 * fixtures, never re-derived from the functions under test. */
import {describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {ADMIN_ASK_PROMPTS,NEEDS_SHOWN,needsEntries,needsTag,oldestFirst,rankNeedsYou,rankedNeeds,readinessShares,taskGroupHref,todayLayoutFor,urgencyTier,
 type NeedsEntry,type NeedsInput} from '../lib/today/admin';

const TODAY='2026-11-12';
const empty:NeedsInput={today:TODAY,nextCutOff:null,statutory:null,exceptions:null,tasks:[],claimTotal:null,prepared:[],findings:[],loops:[]};
const task=(id:string,kind:string,createdAt:string)=>({id,kind,createdAt,linkPath:`/approvals?category=${kind}&requestId=${id}#row-${id}`});
const entry=(key:string,over:Partial<NeedsEntry>):NeedsEntry=>({key,source:{kind:'finding',finding:'setup'},count:1,due:null,since:null,consequence:3,blocksPayroll:false,href:'/x',...over});

describe('which Today a person lands on',()=>{
 it('gives an administrator the administrator page whatever else they hold, a manager the team page, an employee the one-pager, and a partner the earlier page',()=>{
  expect(todayLayoutFor(['hr_admin','manager'],true)).toBe('administrator');
  expect(todayLayoutFor(['manager'],false)).toBe('manager');
  expect(todayLayoutFor(['manager','employee'],false)).toBe('manager');
  expect(todayLayoutFor(['employee'],false)).toBe('employee');
  expect(todayLayoutFor([],false)).toBe('employee');
  expect(todayLayoutFor(null,false)).toBe('employee');
  expect(todayLayoutFor(['payroll_partner'],false)).toBe('other');
  expect(todayLayoutFor(['performance_comp_partner','employee'],false)).toBe('other');
 });
});

describe('Needs you: one list',()=>{
 const input:NeedsInput={...empty,nextCutOff:'2026-11-25',
  statutory:{overdue:1,dueSoon:2,earliestDue:'2026-11-10'},exceptions:{blocking:38},
  tasks:[task('a1','attendance','2026-10-15T02:00:00Z'),task('a2','attendance','2026-11-01T17:30:00Z'),task('l1','leave','2026-11-11T02:00:00Z'),
   task('c1','claim','2026-11-11T03:00:00Z'),task('n1','noticeAcknowledgement','2026-11-01T02:00:00Z')],
  claimTotal:40,
  prepared:[{kind:'leaveDecision',expiresAt:'2026-11-13T15:00:00Z',href:'/assistant/approvals?review=one'}],
  findings:[{key:'readiness',count:12,href:'/control-tower/readiness'},{key:'setup',count:0,href:'/payroll/setup'}],
  loops:[{kind:'probation',endDate:'2026-11-19',overdue:false,href:'/admin/personnel/e1'},{kind:'probation',endDate:'2026-11-17',overdue:false,href:'/admin/personnel/e2'},
   {kind:'payroll',cutOff:'2026-11-24',blockers:0,href:'/control-tower/loops/payroll-cycle?company=co-a&period=2026-11'},
   {kind:'passports',count:3,first:'2026-12-01',href:'/personnel'},
   {kind:'acted',workerId:'loop_missed_clock_outs',href:'/control-tower/loops/loop_missed_clock_outs'},{kind:'acted',workerId:'loop_missed_clock_outs',href:'/control-tower/loops/loop_missed_clock_outs'},
   // The viewer's own cards belong to "Your own record", not here.
   {kind:'clockOut',href:'/attendance/my-records/2026-11-11'},{kind:'record',href:'/me?tab=profile'},{kind:'passport',href:'/me?tab=profile'},{kind:'autoFixed'}]};

 it('groups each source into one entry with its owner\'s own count and date, and leaves out what counts nothing',()=>{
  const entries=needsEntries(input);
  const by=new Map(entries.map(item=>[item.key,item]));
  expect([...by.keys()].sort()).toEqual(['exceptions','finding:readiness','loop:acted:loop_missed_clock_outs','loop:passports','loop:payrollInputs','loop:probation',
   'prepared:leaveDecision','statutory','task:attendance','task:claim','task:leave','task:noticeAcknowledgement']);
  expect(by.get('statutory')).toMatchObject({count:3,due:'2026-11-10',consequence:0});
  expect(by.get('exceptions')).toMatchObject({count:38,due:'2026-11-25',blocksPayroll:true});
  // Claims carry the queue's exact total; their oldest is unknown because only the newest were listed.
  expect(by.get('task:claim')).toMatchObject({count:40,due:'2026-11-25',since:null,source:{kind:'tasks',task:'claim',exact:false},href:'/approvals?category=claim'});
  // 17:30 UTC on 1 November is 2 November in Malaysia: the day each decision was sent is the HR day.
  expect(by.get('task:attendance')).toMatchObject({count:2,due:'2026-11-25',since:'2026-10-15',consequence:1,href:'/approvals?category=all'});
  expect(by.get('task:leave')).toMatchObject({count:1,due:null,since:'2026-11-11',consequence:2,href:'/approvals?category=leave&requestId=l1#row-l1'});
  expect(by.get('task:noticeAcknowledgement')).toMatchObject({consequence:4,href:'/approvals?category=noticeAcknowledgement&requestId=n1#row-n1'});
  expect(by.get('prepared:leaveDecision')).toMatchObject({count:1,due:'2026-11-13',href:'/assistant/approvals?review=one'});
  expect(by.get('loop:probation')).toMatchObject({count:2,due:'2026-11-17',href:'/control-tower/loops/loop_probation_ending'});
  expect(by.get('loop:payrollInputs')).toMatchObject({count:1,due:'2026-11-24',blocksPayroll:false,href:'/control-tower/loops/payroll-cycle?company=co-a&period=2026-11'});
  expect(by.get('loop:passports')).toMatchObject({count:3,due:'2026-12-01'});
  expect(by.get('loop:acted:loop_missed_clock_outs')).toMatchObject({count:2,consequence:4});
 });

 it('ranks overdue first, then what blocks a payroll, then what is due within a week, then by consequence, date and age',()=>{
  expect(rankNeedsYou(needsEntries(input),TODAY).map(item=>item.key)).toEqual([
   'statutory',                             // overdue since 10 Nov
   'exceptions',                            // blocks the payroll
   'prepared:leaveDecision',                // due 13 Nov
   'loop:probation',                        // due 17 Nov
   'loop:payrollInputs','task:attendance','task:claim',   // pay: consequence 1, then due 24 before 25 Nov, then oldest
   'task:leave','finding:readiness',        // people: consequence 2, oldest first, unknown age last
   'loop:passports',                        // records
   'task:noticeAcknowledgement','loop:acted:loop_missed_clock_outs', // everything else: oldest first, unknown age last
  ]);
 });

 it('is the same order whatever order the owners returned their facts in',()=>{
  const entries=needsEntries(input);
  const reversed=[...entries].reverse();
  expect(rankNeedsYou(reversed,TODAY).map(item=>item.key)).toEqual(rankNeedsYou(entries,TODAY).map(item=>item.key));
 });

 it('counts the one list for the heading and for "See all": the 29-against-27 defect cannot recur',()=>{
  const ranked=rankedNeeds(input);
  expect(ranked.total).toBe(12);
  expect(ranked.entries).toHaveLength(12);
  expect(ranked.overdue).toBe(1);
  expect(NEEDS_SHOWN).toBe(5);
  // The earlier Today added prepared cards, findings and loop cards to the heading but named only the decisions in the
  // link. Every entry here is a row of the same list, so each kind adds exactly one to both.
  const decisionsOnly=rankedNeeds({...empty,tasks:input.tasks,claimTotal:input.claimTotal});
  expect(decisionsOnly.total).toBe(4);
  expect(rankedNeeds(empty)).toEqual({entries:[],total:0,overdue:0});
 });

 it('tags an entry by how urgent it is, in whole HR days',()=>{
  expect(needsTag(entry('a',{due:'2026-11-10'}),TODAY)).toEqual({kind:'overdue',days:2});
  expect(needsTag(entry('b',{due:'2026-11-30',blocksPayroll:true}),TODAY)).toEqual({kind:'blocksPayroll'});
  expect(needsTag(entry('c',{due:TODAY}),TODAY)).toEqual({kind:'dueIn',days:0});
  expect(needsTag(entry('d',{due:'2026-11-19'}),TODAY)).toEqual({kind:'dueIn',days:7});
  expect(needsTag(entry('e',{due:'2026-11-20'}),TODAY)).toEqual({kind:'none'});
  expect(needsTag(entry('f',{since:'2026-11-04'}),TODAY)).toEqual({kind:'waiting',days:8});
  expect(needsTag(entry('g',{since:'2026-11-05'}),TODAY)).toEqual({kind:'none'});
  // Overdue outranks blocking: an overdue payroll blocker says it is overdue.
  expect(urgencyTier(entry('h',{due:'2026-11-11',blocksPayroll:true}),TODAY)).toBe(0);
 });

 it('sends a group of the same decisions to the approvals page filtered to that kind, and one decision to its own page',()=>{
  expect(taskGroupHref('leave',['/approvals?x=1'],1)).toBe('/approvals?x=1');
  expect(taskGroupHref('leave',['/a','/b'],2)).toBe('/approvals?category=leave');
  expect(taskGroupHref('resignation',['/a','/b'],2)).toBe('/approvals?category=resignations');
  expect(taskGroupHref('profile',['/admin/personnel/profile-changes?assigned=1&requestId=1#request-1','/b'],2)).toBe('/admin/personnel/profile-changes?assigned=1');
  expect(taskGroupHref('performanceReview',['/performance/reviews/1#r','/performance/reviews/2'],2)).toBe('/performance/reviews/1');
  expect(taskGroupHref('claim',[],40)).toBe('/approvals?category=claim');
 });
});

describe('payroll readiness bar',()=>{
 it('shares the bar in whole percentages that always add up to 100',()=>{
  expect(readinessShares({companies:71,ready:12,waiting:33,notStarted:26})).toEqual({ready:17,waiting:46,notStarted:37});
  expect(readinessShares({companies:3,ready:1,waiting:1,notStarted:1})).toEqual({ready:34,waiting:33,notStarted:33});
  expect(readinessShares({companies:0,ready:0,waiting:0,notStarted:0})).toEqual({ready:0,waiting:0,notStarted:0});
  for(const n of [1,7,70,71,72,999]){
   const s=readinessShares({companies:n,ready:Math.floor(n/3),waiting:Math.floor(n/5),notStarted:n-Math.floor(n/3)-Math.floor(n/5)});
   expect(s.ready+s.waiting+s.notStarted).toBe(100);
  }
 });
});

describe('manager decisions',()=>{
 it('are oldest first, the id settling a tie',()=>{
  expect(oldestFirst([{id:'b',createdAt:'2026-11-02T00:00:00Z'},{id:'c',createdAt:'2026-11-01T00:00:00Z'},{id:'a',createdAt:'2026-11-02T00:00:00Z'}]).map(item=>item.id)).toEqual(['c','a','b']);
 });
});

describe('copy',()=>{
 const LOCALES=['en','ms','zh','ta','th','vi'];
 const read=(locale:string)=>JSON.parse(readFileSync(`messages/ai-centre/${locale}.json`,'utf8')) as {today:{admin:Record<string,unknown>;manager:Record<string,unknown>}};
 const flat=(value:unknown,prefix=''):Record<string,string>=>Object.entries(value as Record<string,unknown>).reduce<Record<string,string>>((out,[key,inner])=>
  typeof inner==='string'?{...out,[prefix+key]:inner}:{...out,...flat(inner,`${prefix}${key}.`)},{});
 it('has every administrator and manager string in every shipped locale, with the same arguments',()=>{
  const en=flat(read('en').today);
  const args=(s:string)=>[...new Set([...s.matchAll(/\{([a-zA-Z]+)\s*[,}]/g)].map(match=>match[1]))].sort();
  const keys=Object.keys(en).filter(key=>key.startsWith('admin.')||key.startsWith('manager.'));
  expect(keys.length).toBeGreaterThan(80);
  for(const locale of LOCALES){
   const other=flat(read(locale).today);
   for(const key of keys){
    expect(other[key],`${locale} ${key}`).toBeTruthy();
    expect(args(other[key]),`${locale} ${key}`).toEqual(args(en[key]));
   }
  }
 });
 it('names AI Centre, never an internal name, id or field, and every Ask prompt is a question',()=>{
  for(const locale of LOCALES){
   const all=JSON.stringify({admin:read(locale).today.admin,manager:read(locale).today.manager});
   expect(all,locale).not.toMatch(/Noveri|Autopilot|verdict|detector|harness|agent principal|loop_[a-z_]+|[a-z]+[A-Z][a-zA-Z]*Id\b/);
  }
  const en=read('en').today.admin.ask as Record<string,string>;
  expect(Object.keys(en)).toEqual([...ADMIN_ASK_PROMPTS]);
  for(const key of ADMIN_ASK_PROMPTS)expect(en[key].endsWith('?')).toBe(true);
 });
});
