import {describe,expect,it} from 'vitest';
import {assessmentIssues,blankProbationAssessment,createProbationCase,DEFAULT_PROBATION_CONFIG,editProbationPart,managerSubmissionIssues,probationReminderDue,probationRoute,probationScore,probationSuggestion,type Assessment} from '../lib/probation-model';
const calendar=(day:string)=>![0,6].includes(new Date(day+'T00:00:00Z').getUTCDay())&&day!=='2026-11-04';
function record(months:number|null=6){let id=0;return createProbationCase({id:'case',employmentId:'employment',companyId:'company',sourceKey:'onboarding-event',startOn:'2026-11-02',endOn:'2027-05-01',months,grade:'14',explicitNoProbation:false,config:structuredClone(DEFAULT_PROBATION_CONFIG),nextId:()=>String(++id),isWorking:calendar})!;}
function ratings(all:number):Assessment{const a=blankProbationAssessment();for(const item of Object.values(a)){item.rating=all;item.evidence='Observed evidence';}return a;}
describe('probation deterministic policy',()=>{
  it('matches all five independent scoring examples and band boundaries',()=>{
    expect(probationScore(ratings(3))).toMatchObject({hundredths:300,band:3});
    const b=ratings(3);b.kpi.rating=2;b.knowledge.rating=2;expect(probationScore(b)).toMatchObject({hundredths:250,band:2});
    const c=ratings(4);c.kpi.rating=5;c.knowledge.rating=5;expect(probationScore(c)).toMatchObject({hundredths:450,band:4});
    c.standards.rating=5;expect(probationScore(c)).toMatchObject({hundredths:458,band:5});expect(probationScore(ratings(1))).toMatchObject({hundredths:100,band:1});
  });
  it('starts blank, requires low-result evidence and never invents a suggestion before completion',()=>{
    expect(probationScore(blankProbationAssessment())).toBeNull();expect(assessmentIssues(blankProbationAssessment())).toHaveLength(9);
    const a=ratings(2);a.standards.evidence=' ';expect(assessmentIssues(a)).toEqual(['standards:evidence_required']);
    expect(probationSuggestion(2,2)).toBe('development');expect(probationSuggestion(3,2)).toBe('extend');expect(record().parts[2].outcome).toBeNull();
  });
  it('selects plan from employee period and resolves employee working dates',()=>{
    const six=record();expect(six.parts.map(p=>p.type)).toEqual([1,2,3]);expect(six.parts[0].dueOn).toBe('2026-11-10');
    expect(six.parts[2].dueOn).toBe('2027-04-30');expect(record(3).parts.map(p=>p.type)).toEqual([1,3]);expect(record(4).planFlag).toBe(true);
  });
  it('does not admit explicitly excluded employees or Grade H without its approved form',()=>{
    const input={id:'case',employmentId:'employment',companyId:'company',sourceKey:'source',startOn:'2026-11-02',endOn:null,months:null,grade:'14',explicitNoProbation:true,config:structuredClone(DEFAULT_PROBATION_CONFIG),nextId:()=> 'part',isWorking:calendar};
    expect(createProbationCase(input)).toBeNull();expect(createProbationCase({...input,explicitNoProbation:false,grade:'H'})).toBeNull();
    expect(()=>createProbationCase({...input,explicitNoProbation:false,grade:'H',config:{...input.config,gradeHEnabled:true}})).toThrow('form content');
  });
  it('protects field ownership and acknowledged KPI content',()=>{
    const r=record(),part=r.parts[0];part.state='issued';expect(()=>editProbationPart(r,part.id,'lm',{employeeComments:'forged'})).toThrow('field owner');
    expect(()=>editProbationPart(r,part.id,'pbp',{support:{coaching:'x',access:'x',checkins:'x',other:'x'}})).toThrow('field owner');
    r.kpiAcknowledged=true;expect(()=>editProbationPart(r,part.id,'lm',{kpis:[]})).toThrow('locked');
  });
  it('counts unrated/required fields and rejects a third extension',()=>{
    const r=record(),p=r.parts[2];expect(managerSubmissionIssues(p,r)).toContain('outcome');expect(managerSubmissionIssues(p,r)).toContain('kpi:unrated');
    p.manager=ratings(3);p.reviewOn='2027-04-30';p.conductedBy='lm';p.staffSubmittedAt='2027-04-20';p.outcome='extend';p.extensionMonths=3;p.justification='More development';r.extensionCount=2;expect(managerSubmissionIssues(p,r)).toContain('extension');
  });
  it('uses only pending parties and never catches up past occurrences at activation',()=>{
    const r=record(),p=r.parts[2];p.state='issued';expect(probationReminderDue(p,r.config,'2027-04-16','2027-04-01','employee')).toBe(true);
    expect(probationReminderDue(p,r.config,'2027-04-16','2027-04-17','employee')).toBe(false);expect(probationReminderDue(p,r.config,'2027-05-01','2027-04-01','employee')).toBe(false);
    p.staffSubmittedAt='2027-04-16';expect(probationReminderDue(p,r.config,'2027-04-23','2027-04-01','employee')).toBe(false);
  });
  it('does not add HOD approval to the default midpoint route',()=>{const holders={lm:'lm',employee:'staff',hod:'head',pbp:'bp',gbs:'ops'};expect(probationRoute(2,holders).steps.map(s=>s.role)).toEqual(['lm','employee']);expect(probationRoute(3,holders).steps.map(s=>s.role)).toEqual(['lm','employee','hod','pbp']);});
});
