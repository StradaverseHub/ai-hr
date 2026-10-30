import {expect,it} from 'vitest';
import {SNAPSHOT_ANALYSIS_DESCRIPTOR as policy,adjudicateSnapshotAnalysis,snapshotShareBand,SNAPSHOT_DOMAIN_METRICS} from '../lib/ai/provider-snapshot-policy';
const source=()=>({version:1,domain:'attendance',window:'current_snapshot',cohorts:[{cohort:'cohort_a',population:100,metrics:[{metric:'lateness_prevalence',support:100,numeratorPeople:25,slices:[]},{metric:'absence_prevalence',support:100,numeratorPeople:75,slices:[]}]}]});
const point=(metric:string)=>({cohort:'cohort_a',metric});
it('preserves useful independent metric comparisons while withholding exact counts and dates',()=>{
 const captured=policy.capture(source()),prompt='prompt' in captured.args?captured.args.prompt:'';
 expect(prompt).toContain('under_quarter');expect(prompt).toContain('half_to_three_quarters');
 expect(prompt).not.toMatch(/numeratorPeople|population":100|support":100|2026-|employee|personId|salary/);
 const raw=JSON.stringify({observations:[point('lateness_prevalence')],comparisons:[{left:point('absence_prevalence'),right:point('lateness_prevalence'),relationship:'higher_share'}]});
 const answer=adjudicateSnapshotAnalysis(raw,captured.local);expect(answer).toContain('up to a quarter');expect(answer).toContain('is higher');expect(answer).not.toContain('25');
});
it('classifies exact share boundaries without rounded false equality',()=>{
 expect([0,1,25,26,50,51,75,76,99,100].map(n=>snapshotShareBand(n,100))).toEqual(['none','under_quarter','under_quarter','quarter_to_half','quarter_to_half','half_to_three_quarters','half_to_three_quarters','over_three_quarters','over_three_quarters','all']);
 for(const [n,d] of [[-1,100],[101,100],[1,0],[1.5,100],[NaN,20]])expect(()=>snapshotShareBand(n,d)).toThrow();
});
it('supports actual current native metrics in every additional domain, without inventing history',()=>{
 for(const [domain,metrics] of Object.entries(SNAPSHOT_DOMAIN_METRICS)){
  const input={...source(),domain,cohorts:[{cohort:'cohort_a',population:40,metrics:metrics.map(metric=>({metric,support:40,numeratorPeople:10,slices:[]}))}]};
  const captured=policy.capture(input);expect('prompt' in captured.args?captured.args.prompt:'').toContain('current_snapshot');expect('prompt' in captured.args?captured.args.prompt:'').not.toContain('trend');expect(policy.fingerprint(input)).toMatch(/^[a-f0-9]{64}$/);
 }
});
it('blocks tiny supported groups, rare numerators and complements, hidden fields and source mutation',()=>{
 for(const n of [1,4,96,99]){const input=source();input.cohorts[0].metrics[0].numeratorPeople=n;expect(()=>policy.capture(input)).toThrow();}
 const small=source();small.cohorts[0].metrics[0].support=19;expect(()=>policy.capture(small)).toThrow();
 const raw=source();Object.assign(raw,{privateName:'PRIVATE_SENTINEL'});expect(()=>policy.capture(raw)).toThrow();
 const before=source(),digest=policy.fingerprint(before);before.cohorts[0].metrics[0].numeratorPeople=26;expect(policy.fingerprint(before)).not.toBe(digest);
 let accessed=false;expect(()=>policy.capture({get version(){accessed=true;return 1;}})).toThrow();
 expect(()=>policy.capture(new Proxy(source(),{getPrototypeOf(){accessed=true;return Object.prototype;}}))).toThrow();expect(accessed).toBe(false);
});
it('refuses invented prose, ratings, references, causes and invalid comparison direction',()=>{
 const captured=policy.capture(source());
 for(const value of ['PRIVATE_SENTINEL salary 9999',{observations:[],comparisons:[]},{observations:[point('invented_metric')],comparisons:[]},{observations:[point('lateness_prevalence')],comparisons:[],cause:'manager'},{observations:[],comparisons:[{left:point('absence_prevalence'),right:point('lateness_prevalence'),relationship:'lower_share'}]}])expect(()=>adjudicateSnapshotAnalysis(JSON.stringify(value),captured.local)).toThrow();
});
it('preserves same-range uncertainty and states exact shared endpoints truthfully',()=>{
 const input=source();input.cohorts[0].metrics[0].numeratorPeople=26;input.cohorts[0].metrics[1].numeratorPeople=40;
 const raw=JSON.stringify({observations:[],comparisons:[{left:point('absence_prevalence'),right:point('lateness_prevalence'),relationship:'same_range'}]});
 expect(adjudicateSnapshotAnalysis(raw,policy.capture(input).local)).toContain('exact values may differ');
 for(const n of [0,100]){input.cohorts[0].metrics.forEach(metric=>metric.numeratorPeople=n);expect(adjudicateSnapshotAnalysis(raw,policy.capture(input).local)).toContain('equal at the stated endpoint');}
});

it('keeps admitted local comparison evidence deeply immutable',()=>{
 const captured=policy.capture(source()),local=captured.local as {cohorts:{metrics:{levelBand:string}[]}[]};
 expect(Object.isFrozen(local)).toBe(true);expect(Object.isFrozen(local.cohorts)).toBe(true);expect(Object.isFrozen(local.cohorts[0])).toBe(true);expect(Object.isFrozen(local.cohorts[0].metrics)).toBe(true);expect(Object.isFrozen(local.cohorts[0].metrics[0])).toBe(true);
 expect(()=>{local.cohorts[0].metrics[0].levelBand='all';}).toThrow();
 expect(adjudicateSnapshotAnalysis(JSON.stringify({observations:[point('lateness_prevalence')],comparisons:[]}),local)).toContain('up to a quarter');
});
