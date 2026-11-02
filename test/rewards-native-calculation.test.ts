/** Private SQL calculator vs the independent native TypeScript oracle; no fabricated receipts. */
import {afterAll,beforeAll,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {defaultPolicy,emptyFacts,emptyRecommendation,policySchema,type RewardEntry} from '../packs/rewards/model';
import {calculateOffcycle} from '../packs/rewards/offcycle';
import {emptyGovernance,effectiveRewardPolicy,governanceBasis,seniorSourceFingerprint} from '../packs/rewards/governance-model';
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
it('matches complete annual independent pools, shared cohorts, bonus/lump distribution and confirmed Senior overrides',async()=>{
 const policy=defaultPolicy(2026);policy.patActual=100;policy.patTarget=100;policy.ranges={'12':[300000,500000,700000],H:[100000,200000,300000],'14':[400000,600000,900000]};
 const ordinary=entry('annual');ordinary.facts={...ordinary.facts,talent:'SCORE',performance:'ME'};ordinary.recommendation=emptyRecommendation();
 const h=structuredClone(ordinary);h.id='annual-h';h.source={...h.source,employmentId:h.id,grade:'H',basicCents:200000};h.facts.performance='OU';
 const star=structuredClone(ordinary);star.id='star';star.source={...star.source,employmentId:star.id,basicCents:300000};star.facts.talent='STAR';
 const promoted=structuredClone(star);promoted.id='promotion';promoted.source={...promoted.source,employmentId:promoted.id};promoted.recommendation={...emptyRecommendation(),promotionGrade:'14',promotionBp:1500,specialBp:300,reason:'A supported real annual promotion business case'};
 const ec=structuredClone(ordinary);ec.id='annual-ec';ec.source={...ec.source,employmentId:ec.id};ec.facts.confidentiality='ec';ec.recommendation={...emptyRecommendation(),meritBp:9000,specialBp:1000,bonusCents:9999999,lumpCents:10000};
 const senior=structuredClone(ec);senior.id='annual-senior';senior.source={...senior.source,employmentId:senior.id,grade:'21'};senior.facts.seniorPlan=true;
 const withheld=structuredClone(ordinary);withheld.id='withheld';withheld.source={...withheld.source,employmentId:withheld.id,notice:true};withheld.recommendation={...emptyRecommendation(),lumpCents:0};
 const hWithheld=structuredClone(h);hWithheld.id='withheld-h';hWithheld.source={...hWithheld.source,employmentId:hWithheld.id,notice:true};
 const leaver=structuredClone(ordinary);leaver.id='future-left';leaver.source={...leaver.source,employmentId:leaver.id,leftOn:'2027-01-01'};
 const branch=structuredClone(ordinary);branch.id='branch';branch.facts={...branch.facts,branch:'Fictional branch',segment:'Fictional segment'};branch.recommendation.multiplierBp=10000;
 const cohorts=[[],[ordinary],[h],[ordinary,h,ec],[star,promoted,ordinary],[ordinary,withheld,h,hWithheld],[senior,ec,ordinary],[leaver,ordinary],[branch]];
 const policies=[policy,{...policy,patActual:0,multiplierBp:10000,lumpUnitCents:0,lumpReason:'Actual withheld provision'},{...policy,multiplierBp:10000,lumpCapCents:10000,lumpUnitCents:20000,exemptReason:'Actual approved budget exemption'},{...policy,activeAsOf:'2026-12-31',seniorMembershipMode:'named-members' as const,bonusStructure:'branch' as const,branchRatings:{'Fictional branch':'UA' as const},branchFactors:{'Fictional segment':[0,5000,10000,15000,20000]as[number,number,number,number,number]}}];
 const controls=[{},{poolStatus:'final' as const,bonusPools:{standard:100000,h:50000}},{poolStatus:'not-set' as const,seniorAwards:{'annual-senior':{newBasicCents:550000,bonusCents:123456}}},{poolStatus:'provisional' as const,seniorAwards:{'annual-senior':{newBasicCents:499999,bonusCents:0}}}];
 for(const entries of cohorts)for(const input of policies)for(const control of controls){const [row]=await owner.db.execute<{value:unknown}>(sql`select app.reward_calc_annual(${JSON.stringify(entries)}::jsonb,${JSON.stringify(input)}::jsonb,${JSON.stringify(control)}::jsonb)as value`);expect(row.value).toEqual(calculateRewards(entries,input,control));}
 // Leap-year proration uses actual calendar days and floors each quotient in the same order.
 const leapPolicy={...policy,year:2024,effectiveFrom:'2024-12-31',joinedBefore:'2025-01-01',confirmedBy:'2024-12-31',blockedFrom:'2025-01-01',blockedTo:'2025-12-31'},leap=structuredClone(ordinary);leap.source.hiredOn='2024-02-29';leap.source.confirmedOn='2024-04-01';
 const [leapResult]=await owner.db.execute<{value:unknown}>(sql`select app.reward_calc_annual(${JSON.stringify([leap])}::jsonb,${JSON.stringify(leapPolicy)}::jsonb)as value`);expect(leapResult.value).toEqual(calculateRewards([leap],leapPolicy));
});

it('preserves actual PostgreSQL JSON round-trip governance and Senior receipts instead of jsonb text hashes',async()=>{
 const jsonValues=[{source:{name:'Fictional / Unicode İΣ😀',value:0.30000000000000004,other:null},indexed:{'1':'one','01':'zero one','10':'ten','2':'two'},nested:[true,false,null,'\\\"\n']},...[1e-7,1e-6,1e20,1e21,1000000000000000100,0.30000000000000004,Number.MIN_VALUE,Number.MAX_VALUE]];
 for(const value of jsonValues){const encoded=JSON.stringify(value),[row]=await owner.db.execute<{stored:unknown;serialized:string}>(sql`select ${encoded}::jsonb as stored,app.reward_calc_json_stringify(${encoded}::jsonb)as serialized`);expect(row.serialized).toBe(JSON.stringify(row.stored));}
 const policy=defaultPolicy(2026);policy.payWindowKeep={'1':'Actual first eligibility reason','01':'Actual second eligibility reason'};
 const a=entry('00000000-0000-4000-8000-000000000002'),b=entry('00000000-0000-4000-8000-000000000001');a.source.performanceRating=3.85;
 const [roundtrip]=await owner.db.execute<{policy:typeof policy;entries:RewardEntry[]}>(sql`select ${JSON.stringify(policy)}::jsonb as policy,${JSON.stringify([a,b])}::jsonb as entries`);
 const [receipt]=await owner.db.execute<{basis:string;senior:string}>(sql`select app.reward_calc_governance_basis(${JSON.stringify(roundtrip.policy)}::jsonb,${JSON.stringify(roundtrip.entries)}::jsonb)as basis,app.reward_calc_senior_fingerprint(${JSON.stringify(roundtrip.entries[0])}::jsonb)as senior`);
 expect(receipt).toEqual({basis:governanceBasis(roundtrip.policy,roundtrip.entries),senior:seniorSourceFingerprint(roundtrip.entries[0])});
 for(const values of [null,{forecastCents:1000000,actualCents:null,targetCents:1000000,targetMonthsBp:20000,multiplierBp:10000,branchRatings:{}},{forecastCents:2000000,actualCents:1500000,targetCents:1000000,targetMonthsBp:30000,multiplierBp:null,branchRatings:{}},{forecastCents:2000000,actualCents:0,targetCents:1000000,targetMonthsBp:20000,multiplierBp:10000,branchRatings:{}},{forecastCents:1000000,actualCents:null,targetCents:null,targetMonthsBp:20000,multiplierBp:10000,branchRatings:{}}]){
  const state={...emptyGovernance(),inputs:values},[row]=await owner.db.execute<{value:unknown}>(sql`select app.reward_calc_effective_policy(${JSON.stringify(policy)}::jsonb,${JSON.stringify(state)}::jsonb)as value`);expect(row.value).toEqual(effectiveRewardPolicy(policy,state));
 }
});

it('uses proleptic Gregorian day differences and an input-independent numeric serialization setting',async()=>{
 for(const [a,b]of [['0000-01-01','0001-01-01'],['2000-02-28','2000-03-01'],['2100-02-28','2100-03-01'],['2024-02-29','2024-12-31']]){
  const [row]=await owner.db.execute<{days:number}>(sql`select app.reward_calc_day(${b})-app.reward_calc_day(${a})as days`);expect(row.days).toBe((Date.parse(b+'T00:00:00Z')-Date.parse(a+'T00:00:00Z'))/86400000);
 }
 await owner.db.transaction(async tx=>{await tx.execute(sql`set local extra_float_digits=0`);const [row]=await tx.execute<{value:string}>(sql`select app.reward_calc_json_number(9007199254740991)as value`);expect(row.value).toBe('9007199254740991');});
});
