import {describe,expect,it} from 'vitest';
import {literalCareerProposal,literalSettingProposal,literalReviewProposal,literalEvidenceProposal} from '../packs/performance/onehr/literal-command-parser';
import {adjudicateSettingCommands,type SettingCommandFacts} from '../packs/performance/onehr/setting-command-model';
import {adjudicateCareerCommands,type CareerCommandFacts} from '../packs/performance/onehr/career-command-model';
import {adjudicateReviewCommands,type ReviewCommandFacts} from '../packs/performance/onehr/review-command-model';
import {adjudicateEvidenceCommands,type EvidenceCommandFacts} from '../packs/performance/onehr/evidence-command-model';
import {kpiSchema,careerSchema} from '../packs/performance/onehr/model';
const id='00000000-0000-4000-8000-000000000001';
const kpi=()=>kpiSchema.parse({id,title:'Delivery 🧑🏽‍💻 100',description:'',weightBp:10000,unit:'units',scoring:{mechanism:'A',method:'more',rates:[0,50,100,150,200]},moderatorEmploymentId:null});
const setting=(text:string):SettingCommandFacts=>({text,kpis:[kpi()],library:[],moderatorEmploymentId:null});
const career=(text:string):CareerCommandFacts=>({text,career:careerSchema.parse({aspiration:'',mobility:null,mobilityNote:'',targetProfileId:null}),careerRevision:null,planRevision:null,goals:[],roles:[],canEditCareer:true,canEditGoals:true});
const review=(text:string):ReviewCommandFacts=>({text,draft:{kind:'results',lines:[{id,actual:null,note:''}],remark:''},targets:[{id,label:kpi().title}]});
describe('explicit local Performance command grammar and original adjudicators',()=>{
 it('retains original Unicode spans and the actual numeric value after a title containing the same number',()=>{
  const facts=review('Record Delivery 🧑🏽‍💻 100 at 100'),proposal=literalReviewProposal(facts)!;expect(proposal).toBeTruthy();const checked=adjudicateReviewCommands(JSON.stringify(proposal),facts);expect(checked).toMatchObject({ok:true,changed:true,draft:{kind:'results',lines:[{id,actual:100}]}});const actual=proposal.commands[0].actual as {start:number;end:number};expect(actual.start).toBe(facts.text.lastIndexOf('100'));expect(facts.text.slice(actual.start,actual.end)).toBe('100');
 });
 it.each(['Set','Tetapkan','设置','Đặt','அமை','ตั้งค่า'])('accepts explicit %s command prefix against one actual assigned target',verb=>{
  const facts=setting(`${verb} Delivery 🧑🏽‍💻 100 weight to 35`),proposal=literalSettingProposal(facts)!;expect(adjudicateSettingCommands(JSON.stringify(proposal),facts)).toMatchObject({ok:true,kpis:[{weightBp:3500}]});
 });
 it('restores compound explicit career fields and goal actions atomically from the human message',()=>{
  const facts=career('Aspiration: Lead operations. Goal: Facilitation. On the job: Run a workshop.'),proposal=literalCareerProposal(facts)!;expect(adjudicateCareerCommands(JSON.stringify(proposal),facts)).toMatchObject({ok:true,career:{aspirationNow:'Lead operations.'},goals:[{area:'Facilitation',onJob:'Run a workshop.',dueOn:''}]});
 });
 it('honors actual shared-plan edit capabilities before producing any career command',()=>{
  expect(literalCareerProposal({...career('Strengths: Patient facilitation.'),canEditCareer:false})).toBeNull();expect(literalCareerProposal({...career('Goal: Facilitation'),canEditGoals:false})).toBeNull();
 });
 it('retains explicit private feedback answers/comments without introducing submission or ratings',()=>{
  const text='Record Supports the team as yes. Collaboration comment: Clear follow-through.',facts:ReviewCommandFacts={text,draft:{kind:'feedback',answers:{},comments:{},remark:''},targets:[{id:'statement-1',label:'Supports the team'},{id:'principle:Collaboration',label:'Collaboration'}]},proposal=literalReviewProposal(facts)!;expect(adjudicateReviewCommands(JSON.stringify(proposal),facts)).toMatchObject({ok:true,draft:{kind:'feedback',answers:{'statement-1':'yes'},comments:{Collaboration:'Clear follow-through.'}}});
 });
 it('keeps actual explicit evidence/check-in permission and native validation',()=>{
  const facts:EvidenceCommandFacts={text:'Log evidence: I resolved the deployment issue with the team.',canLog:true,canCheckIn:false,kpis:[]};expect(adjudicateEvidenceCommands(JSON.stringify(literalEvidenceProposal(facts)),facts)).toMatchObject({ok:true,commands:[{action:'log_evidence',fields:{body:'I resolved the deployment issue with the team.'}}]});expect(literalEvidenceProposal({...facts,canLog:false})).toBeNull();
  const check:EvidenceCommandFacts={text:'Set Delivery 🧑🏽‍💻 100 to off track',canLog:false,canCheckIn:true,kpis:[{id,label:kpi().title,approved:true,note:'Preserve own note'}]};expect(adjudicateEvidenceCommands(JSON.stringify(literalEvidenceProposal(check)),check)).toMatchObject({ok:true,commands:[{action:'checkin',answer:'off_track',note:'Preserve own note'}]});expect(literalEvidenceProposal({...check,kpis:[{...check.kpis[0],approved:false}]})).toBeNull();
 });
 it.each(['Do not set Delivery 🧑🏽‍💻 100 weight to 35','Set Alice weight to 35','Set Delivery 🧑🏽‍💻 100 weight to 35 and approve','Record Delivery 🧑🏽‍💻 100 at 50+50','What if I record Delivery 🧑🏽‍💻 100 at 100?','Approve my career plan'])('does not infer effects, polarity, identity or arithmetic: %s',text=>{
  expect(literalSettingProposal(setting(text))).toBeNull();expect(literalReviewProposal(review(text))).toBeNull();expect(literalCareerProposal(career(text))).toBeNull();
 });
 it('refuses ambiguous exact labels rather than picking an assigned item',()=>{
  const facts=setting('Set Delivery 🧑🏽‍💻 100 weight to 35');facts.kpis.push({...kpi(),id:'00000000-0000-4000-8000-000000000002'});expect(literalSettingProposal(facts)).toBeNull();
 });
});
