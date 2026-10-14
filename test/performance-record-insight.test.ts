import {describe,it,expect} from 'vitest';
import {recordFigure,recordCycleSource,plainRecordCycle,recordPresentSource,plainRecordPresent,recordTrendSource,plainRecordTrend,recordInsightError,tidyRecordInsight} from '../packs/performance/onehr/record-insight-model';
import figures from './fixtures/onehr/record-figures-golden.json';
import cycles from './fixtures/onehr/record-cycle-golden.json';
import present from './fixtures/onehr/record-present-golden.json';
import trends from './fixtures/onehr/record-trend-golden.json';
describe('Personal record source parity',()=>{
 it('preserves source significant figures in current KPI context',()=>{for(const f of figures)expect(recordFigure(f.value)).toBe(f.text);});
 it('matches every original released-cycle source and plain snapshot',()=>{expect(cycles.length).toBe(32);for(const c of cycles){expect(recordCycleSource(c.panel)).toBe(c.source);expect(plainRecordCycle(c.panel)).toBe(c.plain);}});
 it('matches every current-cycle source and plain snapshot',()=>{expect(present.length).toBe(24);for(const c of present){expect(recordPresentSource(c.panel)).toBe(c.source);expect(plainRecordPresent(c.panel)).toBe(c.plain);}});
 it('uses only the six newest records before filtering released ratings for trends',()=>{expect(trends.length).toBe(20);for(const c of trends){expect(recordTrendSource(c.rows)).toBe(c.source);expect(plainRecordTrend(c.rows)).toBe(c.plain);}});
 it('refuses unreleased bands, new figures, pay advice and missing-record narration',()=>{
 const source='Your line manager has approved 1 (one) of your 2 (two) KPI lines.';
 expect(recordInsightError(source,'Your line manager has approved one of your two KPI lines.','present')).toBeNull();
 for(const text of ['Your potential band is High.','You are Outstanding.','You should get a promotion.','Your line manager approved 9 KPI lines.'])expect(recordInsightError(source,text,'present')).toBeTruthy();
 expect(tidyRecordInsight('Your final performance band was Meets Expectation. No development plan details were provided.')).toBe('Your final performance band was Meets Expectation.');
 });
});
