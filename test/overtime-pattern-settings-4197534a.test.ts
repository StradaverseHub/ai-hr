/** Board 4197534a — the Overtime Settings table and the plain Eligibility criteria, as pure projections onto the
 * existing formula definition and assignment targets. No database. Every figure is invented. */
import {describe,expect,it} from 'vitest';
import {analyzeOvertimePattern,validateOvertimePattern,validateOvertimePatternDraft,validateOvertimeAssignmentTarget} from '../lib/overtime-pattern-schema';
import {evaluateOvertimePattern,resolveOvertimePattern} from '../lib/overtime-pattern-evaluate';
import {blankOvertimePattern} from '../lib/overtime-pattern-editor-scope';
import {withOvertimeDayTypes} from '../lib/overtime-pattern-guided';
import {prepareOvertimeStarter} from '../lib/overtime-pattern-starters';
import {definitionToOvertimeSettings,overtimeHoursToMinutes,overtimeMinutesToHours,overtimeSettingsProblems,overtimeSettingsToDefinition,parseOvertimeSettings,type OvertimeSettings} from '../lib/overtime-pattern-settings';
import {parsePlannedEligibility,plannedEligibilityFromAssignments,plannedEligibilityTargets,selectionOnlyCriteria} from '../lib/overtime-pattern-eligibility';
import type {OvertimeFact,OvertimeInput,OvertimeCandidate} from '../lib/overtime-pattern-model';

const uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const date='2026-03-02',currency={code:'MYR',minorScale:2};
const fact=<T,>(value:T,owner:'attendance'|'approval'|'personnel'|'payroll'='attendance'):OvertimeFact<T>=>({state:'known',value,provenance:{owner,reference:'fixture',asOf:date,basis:'recorded'}});
/** Activation needs explicit day types (an empty eligibility group is refused), as the editor's checkboxes give. */
const allDays=()=>withOvertimeDayTypes(blankOvertimePattern(currency),['workday','off_day','rest_day','holiday']);
const settings=():OvertimeSettings=>({rows:[{from:'0:00',to:'2:00',rate:'1.5',restRate:'2',phRate:'3',rounding:'down',roundTo:'0:15'},{from:'2:00',to:'',rate:'2',restRate:'',phRate:'3',rounding:'none',roundTo:''}],monthlyHours:'208',earningItemId:uuid(20)});
function day(minutes:string,dayType='workday'):OvertimeInput {
 return {mode:'actual',sessionGranularity:'recorded',layer:'raw',source:{tenantId:uuid(1),employmentId:uuid(2),attendanceId:uuid(3),date,inputDigest:'a'.repeat(64),approvalDigest:'b'.repeat(64)},patternVersionId:uuid(4),assignmentId:uuid(5),currency:{...currency},
  facts:{employmentId:fact(uuid(2),'personnel'),companyId:fact(uuid(10),'personnel'),dayType:fact(dayType),actualWorkingMinutes:fact(minutes),requiredWorkingMinutes:fact('0'),lateMinutes:fact('0'),basicSalary:fact('2000','payroll'),calculationBase:fact('2080','payroll')},
  resources:[],approval:{status:'approved',minutes:fact(minutes,'approval'),provenance:{owner:'approval',reference:uuid(6),asOf:date,basis:'recorded'}},
  segments:[{id:'segment_1',sessionId:'session_1',dayType:fact(dayType),clock:{state:'unknown',reason:'fixture'},rawMinutes:fact(minutes),approvedMinutes:fact(minutes,'approval')}]};
}

describe('Overtime Settings table (board 4197534a)',()=>{
 it('round-trips the table through the canonical definition and activates with the owner-decided duration policies',()=>{
  const definition=overtimeSettingsToDefinition(allDays(),settings());
  expect(definition).toMatchObject({eligibilityBasis:'day',durationAllocation:'earliest',durationRounding:null,paymentCap:null,deductions:[],definitions:[]});
  expect(definition.rates.map(rate=>rate.id)).toEqual(['ot_normal','ot_rest','ot_holiday']);
  const valid=validateOvertimePattern(definition);
  expect(analyzeOvertimePattern(valid).issues.filter(issue=>issue.severity==='error')).toEqual([]);
  expect(definitionToOvertimeSettings(valid)).toEqual(settings());
  expect(definitionToOvertimeSettings(validateOvertimePatternDraft(JSON.parse(JSON.stringify(definition))))).toEqual(settings());
 });
 it('pays each row at basic plus fixed allowance divided by the entered monthly hours, with a blank column using the OT Rate',()=>{
  // 2,080 / 208 hours = 10.00 an hour. Workday 3 h: 2 h x 1.5 + 1 h x 2.0 = 50.00.
  const definition=validateOvertimePattern(overtimeSettingsToDefinition(allDays(),settings()));
  const workday=evaluateOvertimePattern(definition,day('180'));
  expect(workday.status).toBe('ready');if(workday.status!=='ready')throw new Error(JSON.stringify(workday.status==='refused'?workday.issues:workday.status));
  expect(workday.amountMinorUnits).toBe('5000');
  // Rest day 3 h: 2 h x 2.0 + 1 h x 2.0 (blank rest rate = OT Rate 2.0) = 60.00. Public holiday: 3 h x 3.0 = 90.00.
  const rest=evaluateOvertimePattern(definition,day('180','rest_day')),holiday=evaluateOvertimePattern(definition,day('180','holiday'));
  if(rest.status!=='ready'||holiday.status!=='ready')throw new Error('Expected rest and holiday results');
  expect(rest.amountMinorUnits).toBe('6000');expect(holiday.amountMinorUnits).toBe('9000');
  // Row rounding: 1 h 10 min in the first row rounds down to 1 h at 1.5 = 15.00.
  const rounded=evaluateOvertimePattern(definition,day('70'));if(rounded.status!=='ready')throw new Error('Expected a rounded result');
  expect(rounded.amountMinorUnits).toBe('1500');
 });
 it('recognises an unchanged starting template as one editable row and keeps any other saved definition read-only',()=>{
  expect(definitionToOvertimeSettings(prepareOvertimeStarter('ot30','day','earliest'))).toMatchObject({rows:[{from:'0:00',to:'',rate:'3',restRate:'',phRate:''}],monthlyHours:'',earningItemId:''});
  expect(definitionToOvertimeSettings(blankOvertimePattern(currency))?.rows).toHaveLength(1);
  const custom=overtimeSettingsToDefinition(allDays(),settings());
  expect(definitionToOvertimeSettings({...custom,durationRounding:{step:'15',mode:'down'}})).toBeNull();
  expect(definitionToOvertimeSettings({...custom,rates:custom.rates.map(rate=>rate.id==='ot_rest'?{...rate,timeBand:{fromMinute:1320,toMinute:360,endDayOffset:1}}:rate)})).toBeNull();
  expect(definitionToOvertimeSettings({...custom,rates:custom.rates.slice(0,2)})).toBeNull();
 });
 it('converts monthly hours exactly, flags incomplete rows and refuses a malformed posted table',()=>{
  expect(overtimeHoursToMinutes('208')).toBe('12480');expect(overtimeHoursToMinutes('173.33')).toBe('10399.8');expect(overtimeMinutesToHours('10399.8')).toBe('173.33');
  expect(overtimeHoursToMinutes('abc')).toBe('abc');
  expect(overtimeSettingsProblems(settings())).toEqual([]);
  expect(overtimeSettingsProblems({...settings(),monthlyHours:'',earningItemId:''})).toEqual(['monthlyHours','earningItem']);
  expect(overtimeSettingsProblems({...settings(),rows:[{...settings().rows[0],from:'0:30'},settings().rows[1]]})).toContain('firstFrom');
  expect(()=>parseOvertimeSettings({rows:[{from:'0:00',to:'',rate:'1',restRate:'',phRate:'',rounding:'sideways',roundTo:''}],monthlyHours:'1',earningItemId:''})).toThrow();
  expect(()=>parseOvertimeSettings({rows:[],monthlyHours:'1',earningItemId:'not-an-id'})).toThrow();
  expect(parseOvertimeSettings(settings())).toEqual(settings());
 });
});

describe('plain Eligibility criteria (board 4197534a)',()=>{
 const gradeA=uuid(31),gradeB=uuid(32),named=uuid(41);
 it('normalises criteria and compiles them to a selection-only group target plus a named-employee target',()=>{
  const planned=parsePlannedEligibility({v:1,criteria:{gradeId:[gradeA,gradeB,gradeA],employmentType:['full_time'],orgTeam:[]},employmentIds:[named],priority:100,from:'2026-12-01'});
  expect(planned.criteria).toEqual({gradeId:[gradeA,gradeB],employmentType:['full_time']});
  const targets=plannedEligibilityTargets(planned);
  expect(validateOvertimeAssignmentTarget(targets.group)).toEqual(targets.group);
  expect(targets.individual).toEqual({type:'individual',employmentIds:[named]});
  expect(targets.group.type==='group'&&selectionOnlyCriteria(targets.group.condition)).toEqual(planned.criteria);
  expect(plannedEligibilityTargets({...planned,criteria:{},employmentIds:[]})).toEqual({group:{type:'group',condition:{id:'eligibility',type:'constant',value:true}},individual:null});
 });
 it('refuses unknown fields, bad ids, priorities and dates',()=>{
  for(const raw of [{v:1,criteria:{companyId:[uuid(1)]}},{v:1,criteria:{gradeId:['grade-a']}},{v:1,priority:10000},{v:1,priority:1.5},{v:1,from:'2026-02-30'},{v:2},{v:1,extra:true}])
   expect(()=>parsePlannedEligibility(raw),JSON.stringify(raw)).toThrow();
 });
 it('lets a named employee win over a group, a higher priority win between groups, and refuses an equal-priority tie',()=>{
  const facts={companyId:fact(uuid(10),'personnel'),employmentId:fact(named,'personnel'),gradeId:fact(gradeA,'personnel')};
  const candidate=(n:number,priority:number,target:OvertimeCandidate['target']):OvertimeCandidate=>({assignmentId:uuid(100+n),patternVersionId:uuid(200+n),priority,from:date,to:null,companyIds:[uuid(10)],target});
  const group=(criteria:Record<string,string[]>)=>plannedEligibilityTargets(parsePlannedEligibility({v:1,criteria})).group;
  const groupHigh=candidate(1,200,group({gradeId:[gradeA]})),groupLow=candidate(2,100,group({})),person=candidate(3,1,{type:'individual',employmentIds:[named]});
  expect(resolveOvertimePattern([groupHigh,groupLow,person],facts,date)).toMatchObject({status:'selected',assignmentId:person.assignmentId});
  expect(resolveOvertimePattern([groupHigh,groupLow],facts,date)).toMatchObject({status:'selected',assignmentId:groupHigh.assignmentId});
  const tie=resolveOvertimePattern([groupHigh,candidate(4,200,group({}))],facts,date);
  expect(tie.status).toBe('refused');if(tie.status==='refused')expect(tie.issues[0].code).toBe('conflict');
 });
 it('rebuilds the Eligibility of a live version only from one plain group target and at most one named list',()=>{
  const planned=parsePlannedEligibility({v:1,criteria:{gradeId:[gradeA]},employmentIds:[named],priority:150});
  const targets=plannedEligibilityTargets(planned);
  expect(plannedEligibilityFromAssignments([{target:targets.group,priority:150,validFrom:date},{target:targets.individual!,priority:150,validFrom:date}])).toEqual({...planned,from:null});
  expect(plannedEligibilityFromAssignments([{target:{type:'group',condition:{id:'or',type:'group',logic:'or',children:[]}},priority:1,validFrom:date}])).toBeNull();
  expect(plannedEligibilityFromAssignments([{target:targets.individual!,priority:1,validFrom:date}])).toBeNull();
 });
});
