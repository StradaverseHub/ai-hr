/** Real built browser actions, replayed over HTTPS; owner DB access is a read-only oracle. */
import assert from 'node:assert/strict';
import {setTimeout as pause} from 'node:timers/promises';
export async function prepareMixedWorkflows({context,visit,fixture,employee,hr,db,request,base,report,save,thinkTimeMs}){
 const templates={},evidence=[];report.mixedWorkflows={baseline:evidence,completed:{leave:0,personnel:0,attendance:0,payroll:0,payrollExport:0,clockingImport:0},failures:[]};
 async function capture(page,click,kind){
  report.mixedWorkflows.currentStage=kind;save();
  const marker={leaveCreate:'PERF_LEAVE_BROWSER',leaveEdit:'PERF_LEAVE_BROWSER_EDITED',personnelCreate:'PERF_PERSONNEL_BROWSER',personnelEdit:'PERF_PERSONNEL_BROWSER_EDITED'}[kind];
  const waiting=page.waitForResponse(r=>r.request().method()==='POST'&&Boolean(r.request().headers()['next-action'])&&(!marker||r.request().postDataBuffer()?.includes(Buffer.from(marker))),{timeout:90000});
  let response;
  try{[response]=await Promise.all([waiting,click()]);}
  catch(error){report.mixedWorkflows.error={stage:kind,message:String(error.message).slice(0,350)};save();throw error;}
  await response.finished();
  const req=response.request(),headers={};
  for(const key of ['accept','next-action','next-router-state-tree'])if(req.headers()[key])headers[key]=req.headers()[key];
  const type=req.headers()['content-type'];let fields,fieldOrder=[];
  if(type.startsWith('text/plain')){fields=JSON.parse(req.postDataBuffer().toString());assert(Array.isArray(fields));}
  else{
   const form=await new Request(req.url(),{method:'POST',headers:{'Content-Type':type},body:req.postDataBuffer()}).formData();
   const pairs=[...form].filter(([,v])=>typeof v==='string');fieldOrder=pairs.map(([k])=>k);
   assert.equal(new Set(fieldOrder).size,fieldOrder.length,'fixture replay does not support repeated string fields');fields=Object.fromEntries(pairs);
  }
  const redirect=response.headers()['x-action-redirect']??response.headers().location;
  const actionUrl=new URL(req.url());
  const template={path:actionUrl.pathname+actionUrl.search,fields,fieldOrder,headers,status:response.status()};
  if(redirect){const target=new URL(String(redirect).split(';')[0],base);if(target.searchParams.has('error')){report.mixedWorkflows.error={stage:kind,message:target.searchParams.get('error')};save();throw Error('Browser mutation refused: '+target.searchParams.get('error'));}}
  templates[kind]=template;return template;
 }
 const formFields=(template,values)=>{
  const fields={...template.fields};
  for(const [name,value] of Object.entries(values)){
   const key=Object.keys(fields).find(k=>k===name||k.endsWith('_'+name));
   fields[key??name]=value;
  }
  return fields;
 };
 async function send(user,template,fields,record=true){
  const response=await request(user,template.path,fields,template.status,record,template.headers,template.fieldOrder);
  const target=response.headers['x-action-redirect']??response.headers.location;
  if(target){const url=new URL(String(target).split(';')[0],base);assert(!url.searchParams.has('error'),'mutation returned a business refusal');}
  assert(!/(?:^|\n)[0-9a-f]+:E\{/.test(response.content),'server action returned an exception record');return response;
 }
 // Use an ordinary future weekday; dates and type IDs come from the fictional fixture.
 const day=new Date(fixture.today+'T12:00:00Z');do{day.setUTCDate(day.getUTCDate()+1);}while([0,6].includes(day.getUTCDay()));
 const leaveDate=day.toISOString().slice(0,10);
 {
  const ctx=await context(employee),page=await ctx.newPage();
  try{
   await visit(page,employee,'/leave');await page.locator('[data-tour="leave-request"]').click();
   const dialog=page.getByRole('dialog');await dialog.locator('[name="leaveTypeId"]').selectOption(employee.leaveTypeId);
   await dialog.locator('[name="startDate"]').fill(leaveDate);await dialog.locator('[name="endDate"]').fill(leaveDate);
   await dialog.locator('[name="reason"]').fill('PERF_LEAVE_BROWSER');
   await capture(page,()=>dialog.locator('button[type="submit"]').click(),'leaveCreate');
   await page.waitForLoadState('networkidle');
   const [row]=await db`select id,status from leave_request where employment_id=${employee.employmentId}::uuid and reason='PERF_LEAVE_BROWSER'`;
   assert(row&&row.status==='pending','browser Leave submission did not persist pending state');
   await page.goto(base+'/leave/history',{waitUntil:'networkidle'});
   await page.getByTestId('leave-history-row').first().getByRole('button').click();
   await page.getByRole('button',{name:'Edit',exact:true}).click();
   const edit=page.getByRole('dialog').filter({has:page.locator('[name="leaveRequestId"]')});
   await edit.locator('[name="reason"]').fill('PERF_LEAVE_BROWSER_EDITED');
   await capture(page,()=>edit.locator('button[type="submit"]').click(),'leaveEdit');await page.waitForLoadState('networkidle');
   const [edited]=await db`select reason from leave_request where id=${row.id}::uuid`;assert.equal(edited.reason,'PERF_LEAVE_BROWSER_EDITED');
   await page.goto(base+'/leave/history',{waitUntil:'networkidle'});await page.getByTestId('leave-history-row').first().getByRole('button').click();
   await page.getByRole('button',{name:'Cancel leave',exact:true}).click();
   const cancel=page.getByRole('dialog').filter({has:page.locator('[name="leaveRequestId"]')});
   await capture(page,()=>cancel.locator('button[type="submit"]').click(),'leaveCancel');await page.waitForLoadState('networkidle');
   const [cancelled]=await db`select status from leave_request where id=${row.id}::uuid`;assert.equal(cancelled.status,'cancelled');
   evidence.push({workflow:'leave create/edit/withdraw',persisted:true,physicalDeletion:false});save();
  }finally{await ctx.close();}
 }
 {
  const ctx=await context(hr),page=await ctx.newPage();
  try{
   await visit(page,hr,'/admin/personnel/new');
   await page.locator('select[data-personnel-field="employment.organisation_assignment.companyname"]').selectOption(hr.companyId);
   await page.locator('input[data-personnel-field="profile.personal_details.employeecode"]').fill('PFD-BROWSER');
   await page.locator('input[data-personnel-field="profile.personal_details.fullname"]').fill('PERF_PERSONNEL_BROWSER');
   await page.locator('input[data-personnel-field="profile.contact_and_permanent_address.primaryemail"]').fill('perf-browser@example.invalid');
   await capture(page,()=>page.getByRole('button',{name:'Create employee',exact:true}).click(),'personnelCreate');
   await page.waitForURL(url=>url.searchParams.has('draft'),{timeout:90000});const id=new URL(page.url()).searchParams.get('draft');
   const [created]=await db`select label,company_id from employee_draft where id=${id}::uuid`;assert.equal(created.label,'PERF_PERSONNEL_BROWSER');assert.equal(created.company_id,hr.companyId);
   await page.locator('input[data-personnel-field="profile.personal_details.fullname"]').fill('PERF_PERSONNEL_BROWSER_EDITED');
   await capture(page,()=>page.getByRole('button',{name:'Save draft',exact:true}).click(),'personnelEdit');await page.waitForLoadState('networkidle');
   const [edited]=await db`select label from employee_draft where id=${id}::uuid`;assert.equal(edited.label,'PERF_PERSONNEL_BROWSER_EDITED');
   await page.getByRole('button',{name:'Delete Record',exact:true}).click();
   await capture(page,()=>page.getByRole('alertdialog').getByRole('button',{name:'Yes, Delete',exact:true}).click(),'personnelDelete');
   await page.waitForURL(url=>url.pathname==='/admin/personnel',{timeout:90000});
   assert.equal((await db`select id from employee_draft where id=${id}::uuid`).length,0);
   for(const key of ['personnelCreate','personnelEdit','personnelDelete'])assert(Array.isArray(templates[key].fields),'typed action transport changed');
   evidence.push({workflow:'personnel draft create/edit/delete',persisted:true});save();
  }finally{await ctx.close();}
 }
 // A real correction workflow and Payroll processing/export, not page-render timing.
 const approverFor=user=>fixture.users.find(actor=>actor.tenant===user.tenant&&actor.company===user.company&&['companyHR','groupHR'].includes(actor.role));
 async function assertProcessed(batchId){
  const [batch]=await db`select status,employee_count from payroll_batch where id=${batchId}::uuid`;
  assert.equal(batch.status,'processed');assert.equal(batch.employee_count,50);
  const rows=await db`select employment_id,basic_salary,gross_pay,total_deductions,net_pay from payslip where batch_id=${batchId}::uuid`;
  assert.equal(rows.length,50);assert.equal(new Set(rows.map(row=>row.employment_id)).size,50);
  for(const row of rows){assert.equal(Number(row.basic_salary),100);assert(Number.isFinite(Number(row.net_pay)));assert.equal(Math.round(Number(row.gross_pay)*100)-Math.round(Number(row.total_deductions)*100),Math.round(Number(row.net_pay)*100));}
 }
 async function exportPayroll(user,batchId,company){
  const response=await request(user,`/payroll/${batchId}/export?format=csv`,undefined,200,true);
  assert(String(response.headers['content-type']).includes('text/csv'));assert(String(response.headers['content-disposition']).includes('attachment'));
  const expected=fixture.users.filter(actor=>actor.tenant===user.tenant&&actor.company===company);
  for(const actor of expected)assert(response.content.includes(actor.name),'payroll export omitted an expected fictional employee');
  for(const actor of fixture.users.filter(actor=>actor.tenant!==user.tenant||actor.company!==company))assert(!response.content.includes(actor.name),'payroll export crossed company/tenant scope');
  report.mixedWorkflows.completed.payrollExport++;
 }
 {
  const ctx=await context(employee),page=await ctx.newPage();let correction;
  try{
   await visit(page,employee,'/attendance/my-records/'+fixture.today);
   await page.locator('[name="checkIn"]').fill('09:15');await page.locator('[name="checkOut"]').fill('18:15');await page.locator('[name="reason"]').fill('PERF_ATTENDANCE_BROWSER');
   await capture(page,()=>page.locator('form').filter({has:page.locator('[name="checkIn"]')}).locator('button[type="submit"]').click(),'attendanceCreate');await page.waitForLoadState('networkidle');
   [correction]=await db`select id,status from attendance_correction where employment_id=${employee.employmentId}::uuid and reason='PERF_ATTENDANCE_BROWSER'`;
   assert(correction&&correction.status==='pending');
  }finally{await ctx.close();}
  const approver=approverFor(employee),reviewCtx=await context(approver),review=await reviewCtx.newPage();
  try{
   await visit(review,approver,'/attendance/application-history/'+correction.id);
   const form=review.locator('form').filter({has:review.locator('[name="action"][value="approved"]')});
   await capture(review,()=>form.locator('button[type="submit"]').click(),'attendanceApprove');await review.waitForLoadState('networkidle');
   const [row]=await db`select status from attendance_correction where id=${correction.id}::uuid`;assert.equal(row.status,'approved');
   const [day]=await db`select check_in_at,check_out_at from attendance where employment_id=${employee.employmentId}::uuid and attendance_date=${fixture.today}::date`;assert.equal(day.check_in_at,'09:15:00');assert.equal(day.check_out_at,'18:15:00');
   evidence.push({workflow:'attendance correction/approval/applied punches',persisted:true});save();
  }finally{await reviewCtx.close();}
 }
 {
  const actor=fixture.users.find(user=>user.role==='groupHR'),batchId=fixture.tenants[actor.tenant].companies[1].batchId;
  const ctx=await context(actor),page=await ctx.newPage();
  try{
   await visit(page,actor,'/payroll/'+batchId);
   await page.getByRole('button',{name:'Process Payroll',exact:true}).click();
   await capture(page,()=>page.getByRole('alertdialog').getByRole('button',{name:'Process anyway',exact:true}).click(),'payrollProcess');await page.waitForLoadState('networkidle');
   await assertProcessed(batchId);await exportPayroll(actor,batchId,1);
   evidence.push({workflow:'payroll calculation and scoped CSV export',persisted:true,employees:50});save();
  }finally{await ctx.close();}
 }
 const importDate=offset=>new Date(Date.parse(fixture.today+'T12:00:00Z')-offset*86400000).toISOString().slice(0,10);
 const importText=(user,date)=>{const [year,month,day]=date.split('-');return fixture.users.filter(actor=>actor.tenant===user.tenant&&actor.company===user.company).flatMap(actor=>[['08','31','IN'],['16','31','OUT']].map(parts=>['PERF'+String(actor.index).padStart(4,'0'),day,month,year,...parts].join(','))).join('\n');};
 async function assertImported(user,fileName,date){
  const rows=await db`select id,total_lines,imported_lines,failure_reason from clocking_import_run where tenant_id=${fixture.tenants[user.tenant].tenantId}::uuid and file_name=${fileName}`;
  assert.equal(rows.length,1);const row=rows[0];assert.equal(row.failure_reason,null);assert.equal(row.total_lines,100);assert.equal(row.imported_lines,100);
  const lines=await db`select employment_id,result from clocking_import_line where run_id=${row.id}::uuid`;
  assert.equal(lines.length,100);const expected=new Set(fixture.users.filter(actor=>actor.tenant===user.tenant&&actor.company===user.company).map(actor=>actor.employmentId));
  for(const line of lines){assert(expected.has(line.employment_id),'import line crossed company/tenant scope');assert.equal(line.result,'imported');}
  const punches=await db`select p.employment_id,p.punch_at::text as punch_at from attendance_punch p join attendance a on a.id=p.attendance_id where a.employment_id=any(${[...expected]}::uuid[])and a.attendance_date=${date}::date and p.method='import' and p.voided_at is null`;
  assert.equal(punches.length,100);for(const id of expected)assert.equal(punches.filter(punch=>punch.employment_id===id).length,2);
 }
 {
  const ctx=await context(hr),page=await ctx.newPage(),date=importDate(2),text=importText(hr,date),fileName='PERF_IMPORT_BROWSER.csv';
  try{
   await visit(page,hr,'/attendance/import');await page.locator('main select').selectOption(fixture.tenants[hr.tenant].clockingMappingId);
   await page.locator('input[type="file"]').setInputFiles({name:fileName,mimeType:'text/csv',buffer:Buffer.from(text)});
   const before=await db`select count(*)::int as count from clocking_import_run`;
   await capture(page,()=>page.getByRole('button',{name:'Validate',exact:true}).click(),'importValidate');await page.waitForLoadState('networkidle');
   assert.equal((await db`select count(*)::int as count from clocking_import_run`)[0].count,before[0].count,'import preview wrote a run');
   await capture(page,()=>page.getByRole('button',{name:'Import 100 valid records',exact:true}).click(),'importCommit');
   await page.waitForURL(url=>url.pathname.startsWith('/attendance/import/logs/'),{timeout:90000});await assertImported(hr,fileName,date);
   evidence.push({workflow:'clocking file validate/import',persisted:true,lines:100,employees:50});save();
  }finally{await ctx.close();}
 }
 return async function run(user,iteration){
  const marker=`PERF_MIXED_${user.index}_${iteration}`;
  if(user.role==='groupHR'&&iteration===0){
   await send(user,{...templates.payrollProcess,path:'/payroll/'+user.batchId},formFields(templates.payrollProcess,{batchId:user.batchId}));
   await assertProcessed(user.batchId);report.mixedWorkflows.completed.payroll++;await pause(thinkTimeMs);await exportPayroll(user,user.batchId,user.company);return true;
  }
  if(user.role==='employee'&&user.index%2===1){
   const checkIn=iteration%2?'09:30':'09:15',checkOut=iteration%2?'18:30':'18:15';
   await send(user,{...templates.attendanceCreate,path:'/attendance/my-records/'+fixture.today},formFields(templates.attendanceCreate,{date:fixture.today,employmentId:user.employmentId,checkIn,checkOut,reason:marker}));
   const rows=await db`select id,status from attendance_correction where employment_id=${user.employmentId}::uuid and reason=${marker}`;assert.equal(rows.length,1);assert.equal(rows[0].status,'pending');
   await pause(thinkTimeMs);const approver=approverFor(user);assert(approver);
   await send(approver,{...templates.attendanceApprove,path:'/attendance/application-history/'+rows[0].id},formFields(templates.attendanceApprove,{id:rows[0].id,action:'approved',workflowStage:'0',workflowParticipant:'0:0',reason:marker+'_APPROVED'}));
   const [approved]=await db`select status from attendance_correction where id=${rows[0].id}::uuid`;assert.equal(approved.status,'approved');
   const [day]=await db`select check_in_at,check_out_at from attendance where employment_id=${user.employmentId}::uuid and attendance_date=${fixture.today}::date`;assert.equal(day.check_in_at,checkIn+':00');assert.equal(day.check_out_at,checkOut+':00');
   report.mixedWorkflows.completed.attendance++;return true;
  }
  if(user.role==='companyHR'||user.role==='groupHR'){
   const create=templates.personnelCreate,args=structuredClone(create.fields);
   assert.equal(args.length,1);Object.assign(args[0],{companyId:user.companyId,fullName:marker,primaryEmail:`perf-${user.index}-${iteration}@example.invalid`,employeeCode:`PFD-${user.index}-${iteration}`,employeeIdMode:'manual'});
   await send(user,create,args);
   const rows=await db`select id,data,company_id,reserved_employee_code from employee_draft where tenant_id=${fixture.tenants[user.tenant].tenantId}::uuid and label=${marker}`;
   assert.equal(rows.length,1);const row=rows[0];assert.equal(row.company_id,user.companyId);assert(row.reserved_employee_code,'Personnel ID was not reserved');
   await pause(thinkTimeMs);const editArgs=structuredClone(templates.personnelEdit.fields);editArgs[0]=row.id;editArgs[1]=row.data;editArgs[1].profile.fullName=marker+'_EDITED';
   await send(user,{...templates.personnelEdit,path:'/admin/personnel/new?draft='+row.id},editArgs);const [edited]=await db`select label from employee_draft where id=${row.id}::uuid`;assert.equal(edited.label,marker+'_EDITED');
   await pause(thinkTimeMs);await send(user,{...templates.personnelDelete,path:'/admin/personnel/new?draft='+row.id},[row.id]);assert.equal((await db`select id from employee_draft where id=${row.id}::uuid`).length,0);
   report.mixedWorkflows.completed.personnel++;
   // One company owner per cohort avoids submitting the same file twice concurrently.
   if(user.index%50===1){
    const date=importDate(3+iteration),text=importText(user,date),fileName=marker+'.csv';
    await pause(thinkTimeMs);await send(user,templates.importValidate,[fixture.tenants[user.tenant].clockingMappingId,text]);
    await pause(thinkTimeMs);await send(user,templates.importCommit,[fixture.tenants[user.tenant].clockingMappingId,text,fileName,Buffer.byteLength(text)]);
    await assertImported(user,fileName,date);report.mixedWorkflows.completed.clockingImport++;
   }
   return true;
  }
  if(user.role==='employee'&&user.index%2===0){
   const fields=formFields(templates.leaveCreate,{employmentId:user.employmentId,leaveTypeId:user.leaveTypeId,startDate:leaveDate,endDate:leaveDate,reason:marker,durationType:'full_day'});
   await send(user,templates.leaveCreate,fields);
   const rows=await db`select id,status from leave_request where employment_id=${user.employmentId}::uuid and reason=${marker}`;assert.equal(rows.length,1);assert.equal(rows[0].status,'pending');
   await pause(thinkTimeMs);await send(user,templates.leaveEdit,formFields(templates.leaveEdit,{leaveRequestId:rows[0].id,leaveTypeId:user.leaveTypeId,startDate:leaveDate,endDate:leaveDate,reason:marker+'_EDITED',durationType:'full_day'}));
   const [edited]=await db`select reason from leave_request where id=${rows[0].id}::uuid`;assert.equal(edited.reason,marker+'_EDITED');
   await pause(thinkTimeMs);await send(user,templates.leaveCancel,formFields(templates.leaveCancel,{leaveRequestId:rows[0].id}));
   const [cancelled]=await db`select status from leave_request where id=${rows[0].id}::uuid`;assert.equal(cancelled.status,'cancelled');report.mixedWorkflows.completed.leave++;return true;
  }
  return false;
 };
}
