import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {owner,resetDb,closeAll} from './harness';
import {goalSchema,statementSchema} from '../packs/performance/onehr/model';
beforeAll(resetDb);afterAll(closeAll);
it('matches the unchanged native goal schema including source normalization, UUID text and ISO boundaries',async()=>{
 const base={id:randomUUID(),area:' \ufeffDevelopment\u3000',dueOn:'',onJob:'  Practise\u2028',fromOthers:'',formalLearning:'',status:'not_started',managerComment:'  Captured feedback  '};
 const cases:unknown[]=[base,{...base,unknownSourceField:'stripped'},...['2024-02-29','1900-02-29','2000-02-29','0000-02-29','0000-02-30','0001-02-29','9999-12-31','10000-01-01','2026-11-31','2026-00-01','2026-01-00'].map(dueOn=>({...base,dueOn})),...['2026-11-03T04:00:00Z','2026-11-03T04:00:00.123456789Z','2026-11-03T04:00Z','2026-11-03T04:00:00+00:00','0000-02-29T00:00:00Z','2026-11-03T24:00:00Z','2026-11-03T04:00:60Z'].map(progressAt=>({...base,progressAt})),...['00000000-0000-0000-0000-000000000000','ffffffff-ffff-ffff-ffff-ffffffffffff','FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF',randomUUID().toUpperCase(),'not-a-uuid'].map(id=>({...base,id})),{...base,area:'😀'.repeat(150)},{...base,area:'😀'.repeat(151)},{...base,onJob:'😀'.repeat(2000)},{...base,onJob:'😀'.repeat(2001)},{...base,progressNote:'\ufeffCaptured\u3000',editedAt:'2026-11-03T04:00:00Z',editedByName:'  Native editor  '},{...base,checkins:[]},{...base,checkins:[{status:'in_progress',note:'\ufeffCaptured history\u3000',at:'2026-11-03T04:00:00Z',unknown:'stripped'}]},{...base,checkins:Array.from({length:201},()=>({status:'in_progress',note:'History',at:'2026-11-03T04:00:00Z'}))},{...base,checkins:[{status:'unrecognized',note:'',at:'2026-11-03T04:00:00Z'}]},{...base,checkins:[{status:'done',note:'',at:'2026-11-03T04:00Z'}]},{...base,progressNote:null},{...base,managerComment:undefined}];
 for(const field of ['area','onJob','fromOthers','formalLearning','managerComment','progressNote','editedByName']){const max=field==='area'||field==='editedByName'?300:4000;for(const size of [max,max+1])cases.push({...base,[field]:'😀'.repeat(size)});cases.push({...base,[field]:'e\u0301😀'.repeat(Math.floor(max/3))});}
 for(const size of [4000,4001])cases.push({...base,checkins:[{status:'done',note:'😀'.repeat(size),at:'2026-11-03T04:00:00Z'}]});
 for(const input of cases){const expected=goalSchema.safeParse(input);const read=()=>owner.db.execute<{value:unknown}>(sql`select app.financial_onehr_goal(${JSON.stringify(input)}::jsonb) as value`);if(expected.success){const [actual]=await read();expect(actual.value,JSON.stringify(input)).toEqual(expected.data);}else await expect(read(),JSON.stringify(input)).rejects.toThrow();}
 const [privilege]=await owner.db.execute<{allowed:boolean}>(sql`select has_function_privilege('ai_hr_app','app.financial_onehr_goal(jsonb)','EXECUTE') or has_function_privilege('ai_hr_app','app.financial_onehr_iso_date(text)','EXECUTE') or has_function_privilege('ai_hr_app','app.financial_onehr_iso_datetime(text)','EXECUTE') or has_function_privilege('ai_hr_app','app.financial_onehr_uuid_text(text)','EXECUTE') as allowed`);expect(privilege.allowed).toBe(false);
});

it('matches the unchanged competency statement schema at Unicode codepoint boundaries',async()=>{
 const base={id:'native-id',principle:'Native principle',text:'Original source statement',future:false};
 const fields={id:100,principleId:100,skillCode:100,principle:200,principleDescription:2000,text:2000,skillTitle:300,skillType:300,knowledge:10000,ability:10000};
 const cases:unknown[]=[base];for(const [field,max] of Object.entries(fields))for(const size of [max,max+1])cases.push({...base,[field]:'😀'.repeat(size)});
 for(const size of [200,201])cases.push({...base,principleAliases:['😀'.repeat(size)]});
 cases.push({...base,skillTitle:'\ufeff'+'😀'.repeat(300)+'\u3000'}, {...base,text:'e\u0301😀'.repeat(666)});
 for(const input of cases){const expected=statementSchema.safeParse(input);const read=()=>owner.db.execute<{value:unknown}>(sql`select app.financial_onehr_statement(${JSON.stringify(input)}::jsonb) as value`);if(expected.success){const [actual]=await read();expect(actual.value,JSON.stringify(input)).toEqual(expected.data);}else await expect(read(),JSON.stringify(input)).rejects.toThrow();}
});
