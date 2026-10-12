import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import fixtures from './fixtures/onehr/source-golden.json';
import framework from '../packs/performance/onehr/framework.json';
import { assertWindow, bandFor, defaultPolicy, frameworkFor, policySchema, potential, referenceCurve, resolveBand, scoreAnswers, scoreKPI, scorecard, talentCategory, talentCell9, validateScorecard, type KPI, type PMBand, type PotentialBand, type Scoring } from '../packs/performance/onehr/model';
import { emptyFacts, factsFromOnehr } from '../packs/rewards/model';
const policy=defaultPolicy(framework);
describe('OneHR source-derived assessment rules',()=>{
  it('matches executed source functions across threshold boundaries, both directions, multiplier and excellence variants',()=>{
    expect(fixtures.scoring.length).toBeGreaterThan(150);
    for(const c of fixtures.scoring)expect(scoreKPI(c.actual,c.scoring as Scoring),JSON.stringify(c)).toBeCloseTo(c.expected,10);
  });
  it('preserves the exhaustive person-category table independently from the 9-box display labels',()=>{
    for(const c of fixtures.talent)expect(talentCategory(c.performance as PMBand,c.potential as PotentialBand)).toBe(c.expected);
    expect(talentCategory('UA','High')).toBe('PIP/Improvement');expect(talentCell9('low','High')).toBe('Solid Core');
    expect(talentCategory(null,'High')).toBeNull();
  });
  it('normalizes the actual scorecard weight and rejects a proposal that is not exactly 100%',()=>{
    const k=(actual:number,weightBp:number):KPI=>({id:randomUUID(),title:'KPI',description:'',weightBp,unit:'',scoring:{mechanism:'A',method:'more',rates:[1,2,3,4,5]},moderatorEmploymentId:null,setting:'approved',settingRemark:'',actual,note:'',approvedActual:actual,moderationRemark:'',locked:true});
    const rows=[k(3,5000),k(5,5500)];expect(scorecard(rows,policy,randomUUID(),true).score).toBeCloseTo(425/105);expect(()=>validateScorecard(rows)).toThrow(/100%/);
    expect(bandFor(100.6,[0,51,81,101,121])).toBe('ME');
    expect(()=>scorecard([{...rows[0],scoring:{mechanism:'B',method:'more',variant:'base',threshold:0,target:100,multiple:100,excellence:null}}],policy,randomUUID(),true)).toThrow(/Configure/);
  });
  it('requires exact answers, preserves future weighting, and treats missing reviewed technical inputs as absent',()=>{
    const statements=[{id:'current',principle:'P',text:'Current',future:false},{id:'future',principle:'P',text:'Future',future:true}];
    expect(scoreAnswers(statements,{current:'no',future:'yes'})).toEqual({score:1.5,max:2.5});
    expect(()=>scoreAnswers(statements,{current:'yes'})).toThrow(/every/);
    expect(potential(Array(4).fill({score:17.5,max:35}),{score:2.5,max:2.5},policy,'12')).toMatchObject({pct:80,band:'High',valid:true});
    expect(potential(Array(4).fill({score:17.5,max:35}),null,policy,'12')).toMatchObject({pct:50,band:'Mid'});
    expect(potential(Array(3).fill({score:35,max:35}),null,policy,'12').valid).toBe(false);
    expect(potential([{score:35,max:35}],null,policy,'H').valid).toBe(true);
    expect(frameworkFor(policy,'H')).toEqual(frameworkFor(policy,'12'));
  });
  it('uses the highest locked tier and keeps a final human override immediate',()=>{
    expect(resolveBand('ME',[{tier:'hod',band:'AE',locked:true},{tier:'bu',band:'OU',locked:false}])).toEqual({band:'AE',source:'hod'});
    expect(resolveBand('ME',[{tier:'bu',band:'AE',locked:true},{tier:'final',band:'BE',locked:false}])).toEqual({band:'BE',source:'final'});
    expect(referenceCurve(69).UA).toBe(10);expect(referenceCurve(70).UA).toBe(5);expect(referenceCurve(130).OU).toBe(5);expect(referenceCurve(131).OU).toBe(10);
  });
  it('enforces Malaysia offset windows with an exclusive close',()=>{
    const p=policySchema.parse({...policy,windows:{pm_results:{opensAt:'2026-10-12T09:00:00+08:00',closesAt:'2026-10-12T17:00:00+08:00'}}});
    expect(()=>assertWindow(p,'pm_results',new Date('2026-10-12T01:00:00Z'))).not.toThrow();
    expect(()=>assertWindow(p,'pm_results',new Date('2026-10-12T09:00:00Z'))).toThrow(/closed/);
  });
  it('maps improvement to IMPRO, leaves case decisions pending, and never treats a category as confirmation of PIP',()=>{
    const result={id:randomUUID(),reviewId:randomUUID(),cycleId:randomUUID(),digest:'digest',frozenAt:'2026-10-12T00:00:00Z',performance:'UA' as const,potential:'High' as const,talent:'PIP/Improvement' as const,pip:false,promotion:true,specialReward:true,policyDigest:'policy'};
    const facts=factsFromOnehr(result,{...emptyFacts(),reviewed:true});expect(facts).toMatchObject({performance:'UA',talent:'IMPRO',pipCase:false,pipDecision:'pending',reviewed:false});
    expect(factsFromOnehr({...result,pip:true},emptyFacts())).toMatchObject({talent:'PIP',pipCase:true,pipDecision:'pending',reviewed:false});
  });
});
