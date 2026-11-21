import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export async function compareRewardsRosterReads({ctx,target,owner,withRewardsTenant,sql}){
 const [first,second]=target.expectedEmploymentIds;
 assert(first&&second,'Two roster subjects are required for independent lookup witnesses');
 const {year}=target;
 const from=year+'-01-01',to=year+'-12-31',date=target.snapshotDate;
 const olderCycle=randomUUID(),latestCycle=randomUUID(),openCycle=randomUUID(),outsideCycle=randomUUID();
 const olderReview=randomUUID(),latestReview=randomUUID();
 const tenant=ctx.tenantId;
 const company=target.companyId;
 await owner.client.begin(async tx=>{
  await tx`insert into review_cycle(id,tenant_id,company_id,name,period_start,period_end,status,rating_scale)
   values
    (${olderCycle}::uuid,${tenant}::uuid,${company}::uuid,'Fictional older closed cycle',${from}::date,${to}::date,'closed','[]'),
    (${latestCycle}::uuid,${tenant}::uuid,${company}::uuid,'Fictional latest closed cycle',${from}::date,${to}::date,'closed','[]'),
    (${openCycle}::uuid,${tenant}::uuid,${company}::uuid,'Fictional open cycle',${from}::date,${to}::date,'open','[]'),
    (${outsideCycle}::uuid,${tenant}::uuid,${company}::uuid,'Fictional following cycle',${(year+1)+'-01-01'}::date,${(year+1)+'-12-31'}::date,'closed','[]')`;
  await tx`insert into performance_review(id,tenant_id,cycle_id,employment_id,status,overall_rating,closed_at)
   values
    (${olderReview}::uuid,${tenant}::uuid,${olderCycle}::uuid,${first}::uuid,'submitted',2,${date}::date-interval '1 day'),
    (${latestReview}::uuid,${tenant}::uuid,${latestCycle}::uuid,${first}::uuid,'submitted',4,${date}::date),
    (gen_random_uuid(),${tenant}::uuid,${openCycle}::uuid,${first}::uuid,'manager_review',3,null),
    (gen_random_uuid(),${tenant}::uuid,${outsideCycle}::uuid,${first}::uuid,'submitted',5,${date}::date+interval '1 day')`;
 });
 const compare=async(asOf,samples)=>withRewardsTenant(ctx,async tx=>{
  // Use the native visible roster of the approved unit plus the independent seeded expectation.
  const allowed=Array.from(await tx.execute(sql`select employment_id as id from reward_entry
   where unit_id=${target.unitId}::uuid and tenant_id=app.current_tenant_id() order by employment_id`));
  const ids=allowed.map(row=>row.id);
  assert.deepEqual(ids,[...target.expectedEmploymentIds].sort());
  const requested=sql.join(ids.map(id=>sql`${id}::uuid`),sql`, `);
  const payProjection=sql`c.id,c.basic_salary::text as salary,c.currency,c.pay_mode,c.valid_from::text`;
  const payWindow=sql`c.valid_from<=${asOf}::date and (c.valid_to is null or c.valid_to>${asOf}::date) and c.superseded_at is null`;
  const reviewWindow=sql`cycle.period_start<=${to}::date and cycle.period_end>=${from}::date and p.closed_at is not null`;
  const reviewOrder=sql`p.closed_at desc,p.id desc`;
  const serial=async()=>{
   const compensation=[],reviews=[];
   for(const id of ids){
    const [pay]=await tx.execute(sql`select c.employment_id,${payProjection} from compensation c
     where c.employment_id=${id}::uuid and ${payWindow} order by c.valid_from desc limit 1`);
    const [review]=await tx.execute(sql`select p.employment_id,p.id,p.overall_rating from performance_review p
     join review_cycle cycle on cycle.id=p.cycle_id
     where p.employment_id=${id}::uuid and ${reviewWindow} order by ${reviewOrder} limit 1`);
    if(pay)compensation.push(pay);
    if(review)reviews.push(review);
   }
   return {compensation,reviews};
  };
  const batch=async()=>{
   const compensation=Array.from(await tx.execute(sql`select distinct on (c.employment_id) c.employment_id,${payProjection}
    from compensation c where c.employment_id in (${requested}) and ${payWindow}
    order by c.employment_id,c.valid_from desc`));
   const reviews=Array.from(await tx.execute(sql`select distinct on (p.employment_id) p.employment_id,p.id,p.overall_rating
    from performance_review p join review_cycle cycle on cycle.id=p.cycle_id
    where p.employment_id in (${requested}) and ${reviewWindow} order by p.employment_id,${reviewOrder}`));
   return {compensation,reviews};
  };
  const timings={serial:[],batch:[]};
  for(let sample=0;sample<samples;sample++){
   const outputs={};
   for(const mode of sample%2?['batch','serial']:['serial','batch']){
    const started=performance.now();
    outputs[mode]=await (mode==='serial'?serial():batch());
    timings[mode].push(performance.now()-started);
   }
   assert.deepEqual(outputs.batch,outputs.serial);
   assert.deepEqual(outputs.batch.reviews,[{employment_id:first,id:latestReview,overall_rating:4}]);
   if(asOf===date){
    assert(outputs.batch.compensation.length===ids.length&&outputs.batch.compensation.every(row=>row.salary==='5000.00'));
    assert(outputs.batch.compensation.some(row=>row.employment_id===second));
   }else assert.deepEqual(outputs.batch.compensation,[]);
  }
  const median=values=>{
   const ordered=[...values].sort((a,b)=>a-b),mid=Math.floor(ordered.length/2);
   return Math.round((ordered[mid]+ordered[Math.ceil(ordered.length/2)-1])*50)/100;
  };
  return {employees:ids.length,pairedSamples:samples,serialStatements:ids.length*2,batchStatements:2,
   serialMedianMs:median(timings.serial),batchMedianMs:median(timings.batch)};
 });
 return {snapshot:await compare(date,6),beforeHire:await compare('1900-01-01',1)};
}
