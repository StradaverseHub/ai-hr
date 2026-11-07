/** Fixed fictional wire cases shared by pure diagnosis and native refusal controls. */
export const rejectedAssessmentTaskChanges:readonly Record<string,unknown>[]=[
   ...['1','NaN','Infinity',null,true,0,-1,1.5,1000001].map(count=>({count})),
   ...['infinity','-infinity','tomorrow','now','NaN','2026-02-29T12:00:00Z','2100-02-29T12:00:00Z','2026-04-31T12:00:00Z',
    '2026-13-01T12:00:00Z','2026-01-01T24:00:00Z','2026-01-01T12:60:00Z','2026-01-01T12:00:60Z','2026-01-01T12:00Z',
    '2026-01-01 12:00:00Z','2026-01-01T12:00:00','2026-01-01T12:00:00+0800','2026-01-01T12:00:00+24:00','2026-01-01T12:00:00+08:60'].map(closesAt=>({closesAt})),
   {people:['\u00a0\ufeff']},{people:['😀'.repeat(101)]},{people:[1]},{people:['a','b','c','d']},{extra:'not canonical'},
  ];
