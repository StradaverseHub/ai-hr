/** Fixed fictional wire cases shared by pure diagnosis and native refusal controls. */
export const rejectedAssessmentTaskChanges:readonly Record<string,unknown>[]=[
   ...['1','NaN','Infinity',null,true,0,-1,1.5,1000001].map(count=>({count})),
   ...['infinity','-infinity','tomorrow','now','NaN','2026-02-29T12:00:00Z','2100-02-29T12:00:00Z','2026-04-31T12:00:00Z',
    '2026-13-01T12:00:00Z','2026-01-01T24:00:00Z','2026-01-01T12:60:00Z','2026-01-01T12:00:60Z','2026-01-01T12:00Z',
    '2026-01-01 12:00:00Z','2026-01-01T12:00:00','2026-01-01T12:00:00+0800','2026-01-01T12:00:00+24:00','2026-01-01T12:00:00+08:60'].map(closesAt=>({closesAt})),
   {people:['\u00a0\ufeff']},{people:['😀'.repeat(201)]},{people:['人'.repeat(201)]},{people:['e\u0301'.repeat(101)]},
   {people:[1]},{people:['a','b','c','d']},{extra:'not canonical'},
  ];

/** Zod4.6.7 measures code points, including each combining mark separately. */
export const acceptedAssessmentPeopleEdges=[
 ['😀'.repeat(101)],['😀'.repeat(200)],['人'.repeat(200)],['e\u0301'.repeat(100)],
 [' \u00a0\ufeffFictional 😀\u202f\n'],
] as const;
export const rejectedAssessmentWords=[
 {subject:'😀'.repeat(20001),opening:'valid'},
 {subject:'valid',opening:'😀'.repeat(30001)},
 {subject:'x'.repeat(20001),opening:'valid'},
 {subject:'valid',opening:'x'.repeat(30001)},
 {subject:'line\nbreak',opening:'valid'},
] as const;
