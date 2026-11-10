/** Controller-only aggregate instrumentation for exact fictional Everything diagnostics. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export const originalImportSha='8c87931c1b861b1a5478b85f9c25f597e10ba53b8d4abb7f90b085c13b72644c';
export const phaseNames=['prepare-start','outside-analysis-start','outside-org-lookup-start','outside-org-lookup-end','outside-analysis-end','prepare-end','history-start','history-end','transaction-request','transaction-enter','access-held','leave-held',
 'revalidate-start','revalidate-org-lookup-start','revalidate-org-lookup-end','revalidate-end','effects-start','effects-end','completion-audit-start','completion-audit-end','deferred-commit-start','deferred-commit-end','transaction-refused','request-end'];
const rowNames=['hire','statutory','compensation','history'];

export function instrumentImport(original){
 assert.equal(hash(original),originalImportSha);
 const boundary=original.indexOf('export async function commitEmployeeImport('),end=original.indexOf('/** Rows as CSV text',boundary);
 assert(boundary>0&&end>boundary);
 let prefix=original.slice(0,boundary);const suffix=original.slice(end);
 const prefixInsert=(before,after)=>{assert.equal(prefix.split(before).length,2);prefix=prefix.replace(before,after);};
 prefixInsert('  outerTx?:Tx,\n): Promise<{ preview: ImportPreview;',
  "  outerTx?:Tx,\n  profileOrganisation?:(edge:'start'|'end')=>void,\n): Promise<{ preview: ImportPreview;");
 prefixInsert('  const derivedOrganisationRows=await read(async tx=>{',"  profileOrganisation?.('start');\n  const derivedOrganisationRows=await read(async tx=>{");
 prefixInsert('    return rows;\n  });\n  records.forEach((rawRecord, idx) => {',
  "    return rows;\n  });\n  profileOrganisation?.('end');\n  records.forEach((rawRecord, idx) => {");
 let segment=original.slice(boundary,end);
 const insert=(before,after)=>{assert.equal(segment.split(before).length,2);segment=segment.replace(before,after);};
 const append=(anchor,statement)=>insert(anchor,anchor+'\n'+statement);
 const prepend=(anchor,statement)=>insert(anchor,statement+'\n'+anchor);
 append('): Promise<ImportResult & {evaluationReceipt?:EmployeeImportEvaluationReceipt}> {',`  const profileStart=performance.now();
  const profileRows:Record<string,{calls:number;ms:number}>={};
  const profileMark=(phase:string)=>console.info('[personnel-import-profile] '+JSON.stringify({phase,elapsedMs:Math.round(performance.now()-profileStart),epochMs:Date.now(),...(phase==='effects-end'?{rows:profileRows}:{})}));
  const profileAdd=(key:string,started:number)=>{const row=profileRows[key]??={calls:0,ms:0};row.calls++;row.ms+=performance.now()-started;};
  profileMark('prepare-start');`);
 prepend('  let { preview, resolved, dependents,registers } = await analyze(',"  profileMark('outside-analysis-start');");
 insert('    p.registerRecords,\n  );',"    p.registerRecords,undefined,edge=>profileMark('outside-org-lookup-'+edge),\n  );");
 prepend('  const nominationPack=resolved.map(row=>row.pack);',"  profileMark('outside-analysis-end');");
 prepend('  const attemptId=await recordEmployeeImportAttempt(ctx,p,preview,resolved);',"  profileMark('prepare-end');profileMark('history-start');");
 append('  const attemptId=await recordEmployeeImportAttempt(ctx,p,preview,resolved);',"  profileMark('history-end');");
 prepend('    await withTenant(ctx,async tx=>{',"    profileMark('transaction-request');");
 append('    await withTenant(ctx,async tx=>{',"  profileMark('transaction-enter');");
 append('  await tx.execute(sql`select app.access_workforce_write_lock()`);',"  profileMark('access-held');");
 append('  await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);',"  profileMark('leave-held');");
 prepend('  const fresh=await analyze(ctx,p.companyId,p.records,p.dependentRecords??[],p.registerRecords,tx);',"  profileMark('revalidate-start');");
 insert('  const fresh=await analyze(ctx,p.companyId,p.records,p.dependentRecords??[],p.registerRecords,tx);',
  "  const fresh=await analyze(ctx,p.companyId,p.records,p.dependentRecords??[],p.registerRecords,tx,edge=>profileMark('revalidate-org-lookup-'+edge));");
 prepend('  for (const [index, row] of resolved.entries()) {\n    if (!row.result.ok) continue;',"  profileMark('revalidate-end');profileMark('effects-start');");
 prepend('      const { employmentId, personId } = await hireEmployee(ctx, {...row.hire,initialTaxScheme:row.initialTaxScheme}, tx);','      const hireStart=performance.now();');
 append('      const { employmentId, personId } = await hireEmployee(ctx, {...row.hire,initialTaxScheme:row.initialTaxScheme}, tx);',"      profileAdd('hire',hireStart);");
 prepend('      await (pack.statutory.initializeForHire??pack.statutory.set)(ctx, { personId, ...row.statutory }, tx);','      const statutoryStart=performance.now();');
 append('      await (pack.statutory.initializeForHire??pack.statutory.set)(ctx, { personId, ...row.statutory }, tx);',"      profileAdd('statutory',statutoryStart);");
 prepend('      await setCompensation(ctx, {','      const compensationStart=performance.now();');
 prepend('      // ── Item 2983802f — the new blocks',"      profileAdd('compensation',compensationStart);");
 prepend('      if(attemptId){\n        const [created]', '      const historyStart=performance.now();');
 prepend('      return {employmentId,personId,familyCount};',"      profileAdd('history',historyStart);");
 prepend("  if(attemptId)await recordImportEventTx(tx,ctx,{attemptId,kind:'confirmed'", "  profileMark('effects-end');profileMark('completion-audit-start');");
 insert('    });\n  } catch(error) {\n    evaluationReceipt=undefined;',"  profileMark('completion-audit-end');profileMark('deferred-commit-start');\n    });\n    profileMark('deferred-commit-end');\n  } catch(error) {\n    profileMark('transaction-refused');\n    evaluationReceipt=undefined;");
 prepend('  return {\n    companyId: p.companyId,\n    imported,',"  profileMark('request-end');");
 return prefix+segment+suffix;
}

export function projectServerPhases(privateDir){
 const content=readFileSync(join(privateDir,'server-0.log'),'utf8');assert(content.length<=8*1024**2);
 const phases=[];
 for(const line of content.split('\n')){
  const marker='[personnel-import-profile] ';
  const index=line.indexOf(marker);if(index<0)continue;
  const row=JSON.parse(line.slice(index+marker.length));
  assert(phaseNames.includes(row.phase)&&Number.isSafeInteger(row.elapsedMs)&&row.elapsedMs>=0&&row.elapsedMs<=600000);
  assert(Number.isSafeInteger(row.epochMs)&&row.epochMs>=1_700_000_000_000);
  const values={phase:row.phase,elapsedMs:row.elapsedMs,epochMs:row.epochMs};
  if(row.rows){assert(row.phase==='effects-end'&&Object.keys(row.rows).every(key=>rowNames.includes(key)));values.rows={};
   for(const [key,{calls,ms}] of Object.entries(row.rows)){assert(Number.isInteger(calls)&&calls>0&&calls<=500&&Number.isFinite(ms)&&ms>=0&&ms<=600000);values.rows[key]={calls,ms:Math.round(ms)};}}
  assert(phases.length<phaseNames.length&&!phases.some(item=>item.phase===row.phase));phases.push(values);
 }
 for(let i=1;i<phases.length;i++)assert(phases[i-1].elapsedMs<=phases[i].elapsedMs);
 return phases;
}

export function sqlFamily(value){
 const query=String(value).toLowerCase().replaceAll('"','');
 for(const [name,pattern] of [
  ['recovery-administrator',/access_assert_administrator|access_recovery_available|system_administrator and/],
  ['live-principal',/principal_snapshot_current|actor_account_available|login_blocked/],
  ['workforce-authority',/access_workforce_|access_allowed_for|access_effective_membership/],
  ['access-generation',/access_profile_write_generation|update (?:public\.)?access_configuration/],
  ['organisation-epoch',/company_organisation_source_epoch|company_org_source_changed/],
  ['audit-chain',/domain_event_chain_tg|chain_seq|domain_event_hash/],
  ['advisory-lock',/pg_(?:try_)?advisory_xact_lock/],
  ['person',/(?:insert into|update|from) (?:public\.)?person\b/],
  ['employment',/(?:insert into|update|from) (?:public\.)?employment\b/],
  ['assignment',/(?:insert into|update|from) (?:public\.)?assignment\b/],
  ['compensation',/(?:insert into|update|from) (?:public\.)?compensation\b/],
  ['statutory',/employee_statutory|payroll_tax_scheme/],
  ['import-history',/import_attempt|employee_import_run/],
  ['domain-event',/domain_event/],
  ['labels-criteria',/system_label|label_criteria/],
  ['leave-dependency',/leave_dependency|leave_ledger|leave_type/],
  ['entitlements',/tenant_module|tenant_setting|org_entitlement/],
 ])if(pattern.test(query))return name;
 return 'other';
}

function projectNodes(root){
 const entries=[];let count=0;
 function visit(node,depth){
  assert(node&&typeof node==='object'&&depth<=32&&++count<=1024);
  if(entries.length<12){
   const type=node['Node Type'];assert(typeof type==='string'&&/^[A-Za-z][A-Za-z ]{0,39}$/.test(type));
   const projected={type};
   for(const [label,key] of [['Actual Rows','rows'],['Actual Loops','loops'],['Shared Hit Blocks','sharedHit'],['Shared Read Blocks','sharedRead'],['Plan Rows','estimatedRows']]){
    const n=node[label];if(Number.isFinite(n)&&n>=0&&n<=1e10)projected[key]=n;
   }
   entries.push(projected);
  }
  for(const child of node.Plans??[])visit(child,depth+1);
 }
 visit(root,0);return {nodeCount:count,firstNodes:entries};
}

export function projectPostgresPlans(log,privateDir){
 const target=JSON.parse(readFileSync(join(privateDir,'personnel-import-plan-pid.json'),'utf8'));
 assert(Number.isSafeInteger(target.pid)&&target.pid>1);
 const lines=log.split('\n');const rows=[];let seen=0,malformed=0;
 for(let i=0;i<lines.length;i++){
  const line=lines[i];
  const match=line.match(/^\d{4}-\d{2}-\d{2} \d\d:\d\d:\d\d\.\d+ [A-Z0-9+-]+ \[(\d+)\] [a-f0-9.]+ ai_hr_app@ai_hr_dev LOG:\s+duration: ([0-9.]+) ms\s+plan:/);
  if(!match||Number(match[1])!==target.pid)continue;
  const stamp=line.match(/^(\d{4}-\d{2}-\d{2}) (\d\d:\d\d:\d\d\.\d+) (UTC|GMT|[+-]\d{2}(?::?\d{2})?) /);
  assert(stamp);
  const zone=stamp[3],offset=zone==='UTC'||zone==='GMT'?'Z':zone.length===3?zone+':00':zone.length===5?zone.slice(0,3)+':'+zone.slice(3):zone;
  const millis=Date.parse(stamp[1]+'T'+stamp[2]+offset);assert(Number.isFinite(millis));
  if(millis<target.startedEpochMs||millis>target.endedEpochMs)continue;
  seen++;if(seen>4000)throw new Error('Owned diagnostic plan count exceeded');
  const json=[];let bytes=0;
  while(i+1<lines.length&&/^\s/.test(lines[i+1])){const part=lines[++i];bytes+=part.length;assert(bytes<=256*1024);json.push(part);}
  try{
   const value=JSON.parse(json.join('\n'));
   const document=Array.isArray(value)?value[0]:value;
   const ms=Number(match[2]);assert(Number.isFinite(ms)&&ms>=0&&ms<=600000);
   rows.push({family:sqlFamily(document['Query Text']),ms:Math.round(ms),...projectNodes(document.Plan)});
  }catch{malformed++;}
 }
 rows.sort((a,b)=>b.ms-a.ms);
 return {profile:'auto-explain nested statements >= 15ms, 10% sample; ANALYZE/buffers on, node timing off',seen,malformed,top:rows.slice(0,15)};
}

export async function configureNativeProfile(client){
 const [identity]=await client`select current_user as role,session_user as login,current_database() as db,host(inet_server_addr()) as addr,inet_server_port() as port`;
 assert.deepEqual({...identity},{role:'postgres',login:'postgres',db:'ai_hr_dev',addr:'127.0.0.1',port:5433});
 await client`create extension if not exists pg_stat_statements`;
 const options={session_preload_libraries:'auto_explain',track_functions:'pl','auto_explain.log_min_duration':'15ms','auto_explain.log_parameter_max_length':'0',
  'auto_explain.log_analyze':'on','auto_explain.log_buffers':'on','auto_explain.log_format':'json','auto_explain.log_timing':'off','auto_explain.log_nested_statements':'on','auto_explain.sample_rate':'0.1'};
 await client.begin(async tx=>{
  const [existing]=await tx`select count(*)::int as n from pg_db_role_setting where setdatabase=(select oid from pg_database where datname='ai_hr_dev') and setrole=0`;
  assert.equal(existing.n,0);
  for(const [key,value] of Object.entries(options))await tx.unsafe(`alter database ai_hr_dev set "${key}" to '${value}'`);
 });
}
