import {expect,it} from 'vitest';
import {analysisPercentageBand,analysisCountChangeBand,ANALYSIS_CHANGE_INTERVALS} from '../lib/ai/provider-analysis-bands';
it.each([['-25.000001','decrease_over_25_percent'],['-25','decrease_10_to_25_percent'],['-10.000001','decrease_10_to_25_percent'],['-10','decrease_5_to_10_percent'],['-5.000001','decrease_5_to_10_percent'],['-5','decrease_up_to_5_percent'],['-0.000001','decrease_up_to_5_percent'],['0','unchanged'],['-0.00','unchanged'],['0.000001','increase_up_to_5_percent'],['5','increase_up_to_5_percent'],['5.000001','increase_5_to_10_percent'],['10','increase_5_to_10_percent'],['10.000001','increase_10_to_25_percent'],['25','increase_10_to_25_percent'],['25.000001','increase_over_25_percent']])('assigns native percentage %s to exactly one disjoint band', (value,band)=>{
 expect(analysisPercentageBand(value)).toBe(band);const n=Number(value);
 expect(ANALYSIS_CHANGE_INTERVALS.filter(row=>(row.lower===null||(row.lowerInclusive?n>=row.lower:n>row.lower))&&(row.upper===null||(row.upperInclusive?n<=row.upper:n<row.upper))).map(row=>row.band)).toEqual([band]);
});
it('uses exact count ratios without floating boundary drift',()=>{
 expect(analysisCountChangeBand(100,105)).toBe('increase_up_to_5_percent');expect(analysisCountChangeBand(100,106)).toBe('increase_5_to_10_percent');expect(analysisCountChangeBand(100,95)).toBe('decrease_up_to_5_percent');expect(analysisCountChangeBand(100,94)).toBe('decrease_5_to_10_percent');expect(analysisCountChangeBand(100,100)).toBe('unchanged');
 expect(analysisCountChangeBand(9007199254740000,9007199254740001)).toBe('increase_up_to_5_percent');
});
it('refuses missing baselines, malformed percentages, nonfinite values and noninteger counts',()=>{
 for(const value of ['', 'Infinity', 'NaN', '5%', ' 5', '+5','1e2','0.0000001'])expect(()=>analysisPercentageBand(value)).toThrow();
 for(const [previous,current] of [[0,20],[-1,20],[20,-1],[1.5,20],[20,Infinity]])expect(()=>analysisCountChangeBand(previous,current)).toThrow();
});
