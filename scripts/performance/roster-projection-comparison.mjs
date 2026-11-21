/** Compare two read shapes over the same authorized roster in a disposable hosted fixture. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {writeFileSync} from 'node:fs';

const recordFields=['employmentId','name','employeeCode','company','companyId','department','position'];

export async function compareRosterProjection({source,owner,fixture,ctx}){
 const [{withTenant},{listEmployeesTx}]=await Promise.all([source('db/client.ts'),source('core/read.ts')]);
 const {sql}=createRequire(resolve('package.json'))('drizzle-orm');
 const [group,company]=fixture.users;
 const subject=fixture.users[4];
 const sibling=fixture.users[54];
 const foreign=fixture.users[254];
 assert(group.role==='groupHR'&&company.role==='companyHR'&&subject.companyId===company.companyId);
 assert(subject.companyId!==sibling.companyId&&subject.tenantId===sibling.tenantId&&subject.tenantId!==foreign.tenantId);
 const [identity]=await owner.client`select tenant_id,grants from app.principal(${company.userId}::uuid)`;
 assert(identity?.tenant_id===company.tenantId&&Array.isArray(identity.grants));
 const companyCtx={...ctx,userId:company.userId,personId:company.personId,grants:identity.grants,
  roles:[...new Set(identity.grants.map(grant=>grant.role))]};
 const rosterCompanies=(await owner.client`select id from company
  where tenant_id=${group.tenantId}::uuid and archived_at is null order by id`).map(row=>row.id);
 assert.equal(rosterCompanies.length,70);
 const project=record=>record?Object.fromEntries(recordFields.map(key=>[key,record[key]])):null;
 const identifiers=keys=>sql.join(keys.map(key=>sql.identifier(key)),sql`, `);
 const makeRead=(tx,scope,target)=>{
  const legacy=listEmployeesTx(tx,scope);
  const columns=Object.keys(legacy.getSelectedFields());
  assert(recordFields.every(field=>columns.includes(field)),'Roster no longer supplies all fixed pay record fields');
  // Explicit aliases preserve the native projection and disambiguate physical column names such as name.
  const single=sql`select ${identifiers(recordFields)} from (${legacy.getSQL()}) as roster(${identifiers(columns)})
    where "employmentId"=${target}::uuid limit 1`;
  return {legacy,single};
 };
 const readLegacy=(actor,scope,target)=>withTenant(actor,async tx=>{
  const rows=await listEmployeesTx(tx,scope);
  return {count:rows.length,record:project(rows.find(row=>row.employmentId===target))};
 });
 const readSingle=(actor,scope,target)=>withTenant(actor,async tx=>{
  const rows=await tx.execute(makeRead(tx,scope,target).single);
  assert(rows.length<=1);
  return {count:rows.length,record:rows[0]??null};
 });
 const employmentRows=async(tx,statement)=>{
  const [row]=await tx.execute(sql`explain (analyze, format json, timing off) ${statement}`);
  const result=typeof row['QUERY PLAN']==='string'?JSON.parse(row['QUERY PLAN']):row['QUERY PLAN'];
  const visit=node=>(node['Relation Name']==='employment'?node['Actual Rows']*node['Actual Loops']:0)
   +(node.Plans??[]).reduce((total,child)=>total+visit(child),0);
  return visit(result[0].Plan);
 };
 const median=values=>{
  const ordered=[...values].sort((a,b)=>a-b);
  return Math.round((ordered[5]+ordered[6])/2*100)/100;
 };
 const comparisons=[];
 for(const [scopeName,actor,scope,minimum] of [
  ['group',ctx,rosterCompanies,1000],
  ['company',companyCtx,[company.companyId],50],
 ]){
  const target=subject.employmentId;
  const first=await readLegacy(actor,scope,target);
  assert(first.count>=minimum&&first.record?.name===subject.name&&first.record.companyId===subject.companyId);
  assert.deepEqual(await readSingle(actor,scope,target),{count:1,record:first.record});
  const durations={legacy:[],single:[]};
  for(let pass=0;pass<12;pass++){
   for(const kind of pass%2?['single','legacy']:['legacy','single']){
    const started=performance.now();
    const value=await (kind==='legacy'?readLegacy:readSingle)(actor,scope,target);
    durations[kind].push(performance.now()-started);
    assert.deepEqual(value,{count:kind==='legacy'?first.count:1,record:first.record});
   }
  }
  const [rosterEmploymentRows,singleEmploymentRows]=await withTenant(actor,async tx=>{
   const {legacy,single}=makeRead(tx,scope,target);
   return [await employmentRows(tx,legacy.getSQL()),await employmentRows(tx,single)];
  });
  comparisons.push({scope:scopeName,pairedSamples:12,rosterRows:first.count,selectedRows:1,
   rosterEmploymentRows,singleEmploymentRows,rosterMedianMs:median(durations.legacy),selectedMedianMs:median(durations.single)});
 }
 for(const [actor,scope,target] of [
  [ctx,[company.companyId],sibling.employmentId],
  [companyCtx,[company.companyId],sibling.employmentId],
  [ctx,rosterCompanies,foreign.employmentId],
 ]){
  assert.equal((await readLegacy(actor,scope,target)).record,null);
  assert.deepEqual(await readSingle(actor,scope,target),{count:0,record:null});
 }
 writeFileSync(resolve(process.env.PERF_PRIVATE_DIR,'roster-projection.json'),
  JSON.stringify({comparisons,deniedSelections:3,projectedFields:recordFields.length}),{mode:0o600});
}
