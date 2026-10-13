import { randomUUID } from 'node:crypto';
import { describe,expect,it } from 'vitest';
import { adjudicateEvidenceCommands,type EvidenceCommandFacts } from '../packs/performance/onehr/evidence-command-model';
import { todayInKualaLumpur } from '../lib/hr-date';
const id=randomUUID(),span=(text:string,value:string)=>({start:text.indexOf(value),end:text.indexOf(value)+value.length});
const facts=(text:string):EvidenceCommandFacts=>({text,canLog:true,canCheckIn:true,kpis:[{id,label:'Delivery',approved:true,note:'Retain this check-in note'}]});
describe('evidence and check-in commands',()=>{
 it('logs only supplied event words against one owned KPI with today as the default date',()=>{
  const text='Log for Delivery: I resolved the deployment issue with the team.';
  const c={action:'log_evidence',body:span(text,'I resolved the deployment issue with the team.'),kpi:{id,target:span(text,'Delivery')}};
  expect(adjudicateEvidenceCommands(JSON.stringify({commands:[c]}),facts(text))).toMatchObject({ok:true,commands:[{fields:{body:'I resolved the deployment issue with the team.',occurredOn:todayInKualaLumpur(),kind:'recognition'},links:[{kind:'kpi',id}]}]});
  for(const context of [{...facts(text),canLog:false},{...facts(text),kpis:[]}])expect(adjudicateEvidenceCommands(JSON.stringify({commands:[c]}),context).ok).toBe(false);
 });
 it('records explicit status without overwriting absent notes or inferring ratings',()=>{
  const text='Set Delivery to at risk',c={action:'checkin',id,target:span(text,'Delivery'),answer:span(text,'at risk')};
  expect(adjudicateEvidenceCommands(JSON.stringify({commands:[c]}),facts(text))).toMatchObject({ok:true,commands:[{id,answer:'at_risk',note:'Retain this check-in note'}]});
  for(const context of [{...facts(text),canCheckIn:false},{...facts(text),kpis:[{...facts(text).kpis[0],approved:false}]}])expect(adjudicateEvidenceCommands(JSON.stringify({commands:[c]}),context).ok).toBe(false);
  expect(adjudicateEvidenceCommands(JSON.stringify({commands:[c,c]}),facts(text)).ok).toBe(false);
 });
 it('rejects agreement stubs, invented prose, foreign targets, future dates and unsupported actions atomically',()=>{
  for(const text of ['yes','I can share','okay'])expect(adjudicateEvidenceCommands(JSON.stringify({commands:[{action:'log_evidence',body:span(text,text)}]}),facts(text)).ok).toBe(false);
  const text='Delivery: I resolved an incident. 9999-01-01',base={action:'log_evidence',body:span(text,'I resolved an incident.')};
  for(const command of [{...base,occurredOn:span(text,'9999-01-01')},{...base,kpi:{id:randomUUID(),target:span(text,'Delivery')}},{...base,wording:'invented'},{action:'submit'}])expect(adjudicateEvidenceCommands(JSON.stringify({commands:[command]}),facts(text)).ok).toBe(false);
 });
});
