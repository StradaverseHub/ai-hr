/** Private SQL calculator vs the independent native TypeScript oracle; no fabricated receipts. */
import {afterAll,beforeAll,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {defaultPolicy,emptyFacts,emptyRecommendation,policySchema,type RewardEntry} from '../packs/rewards/model';
import {calculateOffcycle} from '../packs/rewards/offcycle';
import {calculateRewards,increase,ratio} from '../packs/rewards/engine';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule} from './harness';
let ctx:SessionContext;
beforeAll(async()=>{await migrateTestDb();await resetDb();const b=await seedBase();await setModule(b.tenantId,'rewards','active');ctx=await entitledCtx(b);});
afterAll(closeAll);
const entry=(id:string,basicCents=500000):RewardEntry=>({id,source:{employmentId:id,personId:'person-'+id,compensationId:'salary-'+id,gradeId:null,employeeCode:id,name:'Fictional '+id,grade:'12',basicCents,currency:'MYR',payMode:'monthly',hiredOn:'2020-01-01',confirmedOn:'2020-04-01',notice:false,lastPayChange:null,confirmationPayChange:false,performanceReviewId:null,performanceRating:null},facts:{...emptyFacts(),reviewed:true},recommendation:{...emptyRecommendation(),meritBp:100,reason:'Actual expanded responsibilities'}});
async function native(entries:RewardEntry[],kind:'adhoc'|'midyear',details:{exceptionReason:string;bgOrigin:boolean},funding:{standard:number;h:number}){
 const [row]=await owner.db.execute<{value:unknown}>(sql`select app.reward_calc_offcycle(${JSON.stringify(entries)}::jsonb,${kind},${JSON.stringify(details)}::jsonb,${JSON.stringify(funding)}::jsonb)as value`);return row.value;
}
it('keeps the unredacted calculator and all arithmetic helpers private',async()=>{
 for(const query of [sql`select app.reward_calc_integer(1)`,sql`select app.reward_calc_ratio(1,1,1)`,sql`select app.reward_calc_offcycle('[]','adhoc','{"exceptionReason":"","bgOrigin":false}','{"standard":0,"h":0}')`])await expect(withTenant(ctx,tx=>tx.execute(query))).rejects.toThrow();
});
it('matches BigInt safe-integer ratios, half-up RM rounding and invalid arithmetic refusals',async()=>{
 for(const [n,a,b]of [[0,10000,10000],[1,1,2],[149,10000,1000000],[150,10000,1000000],[9007199254740991,1,9007199254740991],[100000000000,100000,1000000],[9007199254740991,9007199254740991,9007199254740991]])for(const nearest of [false,true]){
  const [row]=await owner.db.execute<{value:number}>(sql`select to_jsonb(app.reward_calc_ratio(${n}::numeric,${a}::numeric,${b}::numeric,${nearest}))as value`);expect(row.value).toBe(ratio(n,a,b,nearest?'nearest':'floor'));
 }
 for(const cents of [0,1,4999,5000,5001,100000000000])for(const bp of [0,1,999,1000,100000]){
  const [row]=await owner.db.execute<{value:number}>(sql`select to_jsonb(app.reward_calc_increase(${cents}::numeric,${bp}::numeric))as value`);expect(row.value).toBe(increase(cents,bp));
 }
 for(const [n,a,b]of [[-1,1,1],[1.5,1,1],[1,1,0],[9007199254740991,2,1]]){
  expect(()=>ratio(n,a,b)).toThrow();await expect(owner.db.execute(sql`select app.reward_calc_ratio(${n}::numeric,${a}::numeric,${b}::numeric)`)).rejects.toThrow();
 }
});
it('matches native numeric grade conversion without PostgreSQL text coercion shortcuts',async()=>{
 for(const value of ['22','0x16','0b10110','0o26',' 22 ','22e0','1e309','1e-999','H','Infinity','-0x1','',null]){
  const expected=Number(value),[row]=await owner.db.execute<{value:number|string|null}>(sql`select to_jsonb(app.reward_calc_number(${value}))as value`);
  expect({input:value,result:row.value}).toEqual({input:value,result:Number.isNaN(expected)?null:Number.isFinite(expected)?expected:String(expected)});
 }
});
it('matches actual off-cycle rows, independent H/standard funding, all ordered flags and malformed refusals',async()=>{
 const ordinary=entry('ordinary'),h=entry('h'),ec=entry('ec'),own=entry('left');h.source.grade='H';h.source.basicCents=200000;ec.facts.confidentiality='ec';ec.recommendation={...ec.recommendation,bonusCents:123,lumpCents:0,multiplierBp:0};own.source.leftOn='2026-01-01';
 const ineligible=entry('held');ineligible.facts={...ineligible.facts,reviewed:false,erCase:true,pipCase:true};ineligible.source.notice=true;ineligible.source.compensationId=null;ineligible.source.basicCents=0;ineligible.recommendation.reason='';
 const promotion=entry('promotion');promotion.recommendation={...promotion.recommendation,promotionGrade:'14',promotionBp:1500,specialBp:300,reason:'A supported real promotion business case',currentRoleSummary:'Current analyst responsibilities for one operating team.',proposedRoleSummary:'Lead analyst responsibilities across three operating teams.'};
 const invalidPromotion=structuredClone(promotion);invalidPromotion.id='invalid';invalidPromotion.source.grade='H';invalidPromotion.recommendation.currentRoleSummary=' SAME '+ 'X'.repeat(40);invalidPromotion.recommendation.proposedRoleSummary='same '+ 'x'.repeat(40);
 const utf16=entry('utf16');utf16.recommendation={...utf16.recommendation,reason:'😀'.repeat(5),promotionGrade:'13',currentRoleSummary:'😀'.repeat(15),proposedRoleSummary:'😀'.repeat(15)+'x'};
 const cases=[[],[ordinary],[h],[ec],[own],[ineligible],[promotion],[invalidPromotion],[utf16],[ordinary,h,ec,own,ineligible,promotion]];
 for(const entries of cases)for(const kind of ['adhoc','midyear']as const)for(const details of [{exceptionReason:'',bgOrigin:false},{exceptionReason:'Actual separately reviewed budget exception',bgOrigin:true},{exceptionReason:'short',bgOrigin:false}])for(const funding of [{standard:0,h:100000},{standard:100000,h:0}])expect(await native(entries,kind,details,funding)).toEqual(calculateOffcycle(entries,defaultPolicy(2026),kind,details,funding));
 for(const bad of [{meritBp:-1},{meritBp:0.1},{bonusCents:100000000001},{unknown:true},{reason:'x'.repeat(4001)}]){
  const malformed=entry('malformed');malformed.recommendation={...malformed.recommendation,...bad};expect(()=>calculateOffcycle([malformed],defaultPolicy(2026),'adhoc',{exceptionReason:'',bgOrigin:false},{standard:0,h:0})).toThrow();await expect(native([malformed],'adhoc',{exceptionReason:'',bgOrigin:false},{standard:0,h:0})).rejects.toThrow();
 }
});
it('matches locale-independent native Unicode casing, context and UTF16 lengths before any consumer cutover',async()=>{
 const contexts=['İ','I','ΟΣ','ΟΣΑ','AΣ\u0301','𐐀','Straße','Σ\u0345','\u1f88','\u212a','😀'.repeat(15)];
 for(const text of contexts){const [row]=await owner.db.execute<{value:string;units:number}>(sql`select app.reward_calc_lower(${text})as value,to_jsonb(app.reward_calc_units(${text}))as units`);expect({text,value:row.value,units:row.units}).toEqual({text,value:text.toLowerCase(),units:text.length});}
 // Valid PostgreSQL text excludes NUL and isolated UTF16 surrogates. Every other Unicode
 // scalar is compared in bounded blocks, independent of the database default LC_CTYPE.
 for(let start=1;start<=0x10ffff;start+=0x10000){let text='';for(let cp=start;cp<Math.min(start+0x10000,0x110000);cp++)if(cp<0xd800||cp>0xdfff)text+=String.fromCodePoint(cp);const [row]=await owner.db.execute<{value:string}>(sql`select app.reward_calc_lower(${text})as value`);const expected=text.toLowerCase(),expectedPoints=[...expected];const mismatch=[...row.value].findIndex((ch,i)=>ch!==expectedPoints[i]);expect({block:start,mismatch,units:row.value.length}).toEqual({block:start,mismatch:-1,units:expected.length});}
});

it('normalizes the annual native policy exactly and refuses malformed stored policies',async()=>{
 const policy=defaultPolicy(2026);policy.exemptReason='  Actual approved exemption  ';policy.lumpReason='  Actual withheld provision  ';policy.payWindowKeep={example:'  Real approved retained eligibility  '};
 const [row]=await owner.db.execute<{value:unknown}>(sql`select app.reward_calc_policy(${JSON.stringify(policy)}::jsonb)as value`);expect(row.value).toEqual(policySchema.parse(policy));
 for(const changed of [{year:1999},{patTarget:0},{blockedFrom:'2026-12-01',blockedTo:'2026-01-01'},{joinedBefore:'2026-02-30'},{unknown:true},{lumpStepCents:500},{standardPools:[1,2]},{ranges:{bad:[100,99,101]}},{payWindowKeep:{bad:'short'}}]){
  const malformed={...policy,...changed};expect(()=>policySchema.parse(malformed)).toThrow();await expect(owner.db.execute(sql`select app.reward_calc_policy(${JSON.stringify(malformed)}::jsonb)`)).rejects.toThrow();
 }
});
it('matches the annual first-pass eligibility, source windows, native row amounts and ordered first-pass flags',async()=>{
 const policy=defaultPolicy(2026);policy.ranges={'12':[300000,500000,700000],H:[100000,200000,300000]};
 const firstPassCodes=new Set(['DATA-01','DATA-02','DATA-03','DATA-04','ELIG-02','PRO-01','PRO-02','PRO-03']);
 const stable=['id','source','facts','recommendation','activeInReview','plan','incrementEligible','bonusEligible','lumpEligible','incrementReason','bonusReason','payChange','payWindowKept','bonusBasicCents'];
 const scenarios:RewardEntry[]=[];
 for(const talent of [null,'SSTAR','STAR','SCORE','IMPRO','PIP']as const)for(const performance of [null,'UA','ME','OU']as const){const value=entry('rating-'+talent+'-'+performance);value.facts={...value.facts,talent,performance};scenarios.push(value);}
 for(const source of [{notice:true},{confirmedOn:null},{hiredOn:'2026-12-31'},{leftOn:'2025-12-31'},{leftOn:'2027-01-01'},{compensationId:null,basicCents:0},{grade:'H',basicCents:200000},{grade:'21'},{lastPayChange:policy.blockedFrom},{payChanges:[],lastPayChange:policy.blockedFrom},{payChanges:[{on:policy.blockedFrom,basicCents:550000,kind:'merit'},{on:policy.blockedTo,basicCents:560000,kind:'promotion'}]}]){const value=entry('source-'+scenarios.length);value.facts={...value.facts,talent:'SCORE',performance:'ME'};value.source={...value.source,...source};scenarios.push(value);}
 for(const erDecision of ['pending','in','out']as const)for(const pipDecision of ['pending','lift','confirm']as const){const value=entry('case-'+erDecision+'-'+pipDecision);value.facts={...value.facts,talent:'STAR',performance:'AE',erCase:true,pipCase:true,erDecision,pipDecision,caseReason:'😀'.repeat(5)};scenarios.push(value);}
 const promotion=entry('ec-promotion');promotion.facts={...promotion.facts,confidentiality:'ec',seniorPlan:true};promotion.recommendation={...promotion.recommendation,promotionGrade:'H',promotionBp:2000,reason:'short'};scenarios.push(promotion);
 for(const controls of [{},{minimumBonusRating:'AE' as const,excludeNotice:false,excludeErCase:false},{activeAsOf:'2026-01-01',payWindowKeep:Object.fromEntries(scenarios.map(value=>[value.source.employmentId,'Actual reviewed retained eligibility']))}]){
  const input={...policy,...controls},[native]=await owner.db.execute<{value:{rows:Record<string,unknown>[];flags:unknown[]}}>(sql`select app.reward_calc_annual_seed(${JSON.stringify(scenarios)}::jsonb,${JSON.stringify(input)}::jsonb)as value`),expected=calculateRewards(scenarios,input);
  expect(native.value.rows.map(row=>Object.fromEntries(stable.map(key=>[key,row[key]])))).toEqual(expected.rows.map(row=>Object.fromEntries(stable.map(key=>[key,(row as unknown as Record<string,unknown>)[key]]))));
  expect(native.value.flags).toEqual(expected.flags.filter(flag=>firstPassCodes.has(flag.code)||flag.code==='POOL-05'&&(flag.message==='Individual merit differs from the matrix.'||flag.message==='Promotion differs from the standard 10%.')));
  for(let n=0;n<scenarios.length;n++)if(!scenarios[n].facts.seniorPlan&&!input.seniorGrades.includes(scenarios[n].source.grade))for(const key of ['meritBp','promotionBp','meritCents','promotionCents'])expect(native.value.rows[n][key]).toBe((expected.rows[n]as unknown as Record<string,unknown>)[key]);
 }
});
