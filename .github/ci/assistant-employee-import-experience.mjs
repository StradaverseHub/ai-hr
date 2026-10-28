/** IMPORT-SAFE, UNRUN real English employee full-import experience. Parent supplies an admitted
 * disposable fictional app and an operator already logged in through actual native authentication.
 * Only native browser typing/selecting/file chooser/clicks; no request interception, HTTP action
 * calls, storage/cookie/session injection, provider access or external rewritten source CSV.
 * Native verifier must be createAiDeliveryEmployeeImportNativeReadback (or independently reviewed
 * equivalent actual fresh app-role implementation), NEVER an expected-facts echo. Private input and
 * returned callback facts must not be included in public reports. One fresh fixture per source mode. */
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const fail=code=>{throw Error('assistant_employee_import_experience:'+code);};
const requireFact=(condition,code)=>{if(!condition)fail(code);};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const closed=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&same(Object.keys(value).sort(),[...keys].sort());
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const original='Employee ID,Full Name,Personal Email,Join Date,Unresolved Heading\nAI-IMPORT-NEW,Fictional Imported Human,fictional-import@example.test,,human must map or exclude\n';
const humanKeys=['employeeCode','fullName','email','department','employmentType','basicSalary','hiredOn'];
/** Future hire date is an explicitly fixture-authored fictional scenario, checked against the actual
 * canonical clock by the native reader. It is not a date discovered from this source or model output. */
export async function runAssistantEmployeeImportEnglishExperience({page,fixture,input,verifyCanonical}){
 requireFact(page&&typeof page.goto==='function'&&typeof verifyCanonical==='function','actual_page_and_native_verifier_required');
 requireFact(fixture?.state==='native_prerequisites_prepared_not_experienced'&&fixture.limits?.uiTargetEffects==='not_executed','fictional_fixture_required');
 const captured=structuredClone(input),{sourceMode,pastedText,human,expected}=captured??{};
 requireFact(closed(captured,['sourceMode','pastedText','human','expected'])&&['paste','csv','xlsx'].includes(sourceMode)&&pastedText===original&&closed(human,humanKeys)&&human.employeeCode==='AI-IMPORT-NEW'&&human.fullName==='Fictional Imported Human'&&human.email==='fictional-import@example.test'&&human.employmentType==='full_time'&&human.basicSalary==='3000.00'&&typeof human.department==='string'&&human.department.length>0&&/^\d{4}-\d{2}-\d{2}$/.test(human.hiredOn)&&human.hiredOn.slice(0,7)>fixture.period&&closed(expected,['userId','companyId','sourceMode','human'])&&uuid(expected.userId)&&expected.userId===fixture.actors?.operator?.userId&&expected.companyId===fixture.companyId&&expected.sourceMode===sourceMode&&same(expected.human,human),'closed_explicit_human_inputs_required');
 const current=new URL(page.url());requireFact(['http:','https:'].includes(current.protocol)&&['localhost','127.0.0.1','[::1]'].includes(current.hostname)&&current.port,'admitted_loopback_page_required');
 let stage='native_baseline',unexpectedAssistantRequest=false;
 const observe=request=>{try{const u=new URL(request.url());if(request.method()==='POST'&&u.origin===current.origin&&/^\/api\/(?:assistant|ai)(?:\/|$)/.test(u.pathname))unexpectedAssistantRequest=true;}catch{unexpectedAssistantRequest=true;}};
 page.on('request',observe);
 try{
  const before=await verifyCanonical({phase:'baseline',expected});requireFact(before.currentActorUserId===expected.userId&&before.employee===null,'native_baseline');
  await page.goto(new URL('/admin/personnel/import',current.origin).href,{waitUntil:'domcontentloaded'});
  if(await page.locator('html').getAttribute('lang')!=='en'){await page.getByRole('button',{name:'Change language',exact:true}).click();await page.getByRole('button',{name:'English',exact:true}).click();}
  await page.getByRole('heading',{name:'Import employees',exact:true}).waitFor({state:'visible'});
  await page.getByLabel('Target company',{exact:true}).selectOption(expected.companyId);
  stage='actual_messy_source_intake';
  if(sourceMode==='paste'){
   const paste=page.getByText('Or paste CSV instead',{exact:true});if(await paste.locator('..').getAttribute('open')===null)await paste.click();
   await page.getByLabel('CSV data',{exact:true}).fill(original);await page.getByRole('button',{name:'Prepare pasted or current text',exact:true}).click();
  }else{
   await page.getByRole('checkbox',{name:/^Prepare messy files locally/}).check();
   let buffer=Buffer.from(original,'utf8');
   if(sourceMode==='xlsx'){
    // Generated source has exactly the SAME messy original cells. No supplemented date, salary,
    // department or employment type is smuggled into a rewritten workbook.
    // Approved controller proves cwd is the exact clean SOURCE checkout; automation has no deps.
    // Resolve this one literal package there, never a caller path/module/URL.
    const xlsx=createRequire(resolve(process.cwd(),'package.json'))('xlsx');
    const book=xlsx.utils.book_new(),sheet=xlsx.utils.aoa_to_sheet([['Employee ID','Full Name','Personal Email','Join Date','Unresolved Heading'],['AI-IMPORT-NEW','Fictional Imported Human','fictional-import@example.test','','human must map or exclude']]);xlsx.utils.book_append_sheet(book,sheet,'Messy source');buffer=Buffer.from(xlsx.write(book,{type:'buffer',bookType:'xlsx'}));
   }
   const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:/Drop a file here or click to browse/}).click();await(await chooser).setFiles({name:'fictional-messy-employees.'+sourceMode,mimeType:sourceMode==='csv'?'text/csv':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer});
   if(sourceMode==='xlsx'){
    const sheets=page.getByRole('region',{name:'Choose the sheets for this import',exact:true});await sheets.waitFor({state:'visible'});await sheets.getByLabel('Use this sheet as: Messy source',{exact:true}).selectOption('employee');await sheets.getByRole('checkbox',{name:'I acknowledge that unassigned and excluded nonempty sheets will not be imported in this run and need separate review.',exact:true}).check();await sheets.getByRole('button',{name:'Review selected employee data',exact:true}).click();
   }
  }
  const review=page.getByRole('region',{name:'Review and prepare your data',exact:true});await review.waitFor({state:'visible'});
  const validate=page.getByRole('button',{name:'Validate',exact:true}),commit=page.getByRole('button',{name:'Import 1 valid',exact:true});
  requireFact(await validate.isDisabled()&&await commit.count()===0,'unresolved_source_must_not_commit');
  await review.getByRole('button',{name:'Create reviewed revision',exact:true}).click();await review.getByRole('alert').waitFor({state:'visible'});requireFact(await validate.isDisabled()&&await commit.count()===0,'unreviewed_apply_must_not_adopt');
  const unresolved=await verifyCanonical({phase:'unresolved',expected});requireFact(unresolved.employee===null&&same(unresolved.counts,before.counts),'unresolved_no_native_effect');
  stage='explicit_human_mapping_and_exclusion';
  await review.getByRole('checkbox',{name:'I reviewed the proposed record boundaries and structure.',exact:true}).check();const record=review.locator('article');requireFact(await record.count()===1,'one_actual_source_record');await record.getByLabel('Use this record?',{exact:true}).selectOption('include');
  // Each original group is matched by its ACTUAL source evidence, never by a candidate's inferred
  // identity. Personal Email is an explicit HUMAN remapping to primary email for this fictional case.
  const originalGroups=record.locator('fieldset');requireFact(await originalGroups.count()===5,'actual_original_fields');
  const choices=[['Employee ID','employee_code'],['Full Name','full_name'],['Personal Email','email'],['Join Date','exclude'],['Unresolved Heading','exclude']];
  for(const [heading,field] of choices){const group=record.locator('fieldset').filter({has:page.locator('legend').filter({hasText:new RegExp('^'+heading+'$')})});requireFact(await group.count()===1,'original_field_identity');await group.getByLabel('Destination field',{exact:true}).selectOption(field);await group.getByRole('checkbox',{name:field==='exclude'?'I reviewed this exclusion. Keep the original as evidence.':'I reviewed this field, its original evidence and the value shown.',exact:true}).check();}
  // Header row is preserved as original evidence. It is not silently treated as an imported person.
  const extras=review.locator('details');for(let n=0;n<await extras.count();n++){const detail=extras.nth(n);if(await detail.getAttribute('open')===null)await detail.locator('summary').click();}
  for(const checkbox of await review.getByRole('checkbox',{name:'I reviewed this row and will retain it as evidence, outside the normalized records.',exact:true}).all())await checkbox.check();
  await review.getByRole('button',{name:'Create reviewed revision',exact:true}).click();await review.getByRole('alert').waitFor({state:'visible'});requireFact(await validate.isDisabled(),'missing_hired_on_still_blocks_adoption');
  stage='human_supplied_missing_fields';
  const additions=[['department',human.department],['employment_type',human.employmentType],['basic_salary',human.basicSalary],['hired_on',human.hiredOn]];
  for(let n=0;n<additions.length;n++){
   await record.getByRole('button',{name:'Add a field',exact:true}).click();const group=record.getByRole('group',{name:'Human-added field '+(n+1),exact:true}),destination=group.getByLabel('Destination field',{exact:true}),value=group.getByLabel('Your value',{exact:true}),consent=group.getByRole('checkbox',{name:'I confirm this value and its destination field.',exact:true});
   requireFact(await destination.inputValue()===''&&await value.inputValue()===''&&!await consent.isChecked(),'human_addition_starts_blank');await destination.selectOption(additions[n][0]);await value.fill(additions[n][1]);await consent.check();
   if(n===0){await value.fill(additions[n][1]+' ');requireFact(!await consent.isChecked(),'edit_invalidates_human_review');await value.fill(additions[n][1]);await consent.check();}
  }
  // No provider/model action is used to decide missing facts, normalize salary or invent dates.
  await review.getByRole('button',{name:'Create reviewed revision',exact:true}).click();await review.waitFor({state:'detached'});requireFact(await validate.isEnabled(),'reviewed_revision_not_adopted');
  await page.getByText('Originals and reviewed changes (1 revisions)',{exact:true}).click();await page.getByText('Revision 1 · Reviewed structure and values · Current accepted text',{exact:true}).click();
  await page.getByText('Human supplied — absent from the original source.',{exact:true}).first().waitFor({state:'visible'});
  const prepared=await verifyCanonical({phase:'prepared',expected});requireFact(prepared.employee===null&&same(prepared.counts,before.counts),'local_preparation_changed_native_effects');
  stage='native_fresh_preview';await validate.click();await commit.waitFor({state:'visible'});requireFact(await commit.isEnabled(),'native_preview_refused');
  const previewRow=page.getByRole('row').filter({hasText:human.email}).filter({hasText:human.fullName});requireFact(await previewRow.count()===1&&(await previewRow.innerText()).includes(before.companyName),'native_preview_exact_target');
  const previewed=await verifyCanonical({phase:'previewed',expected});requireFact(previewed.employee===null&&same(previewed.counts,before.counts),'preview_changed_native_effects');
  stage='single_explicit_human_commit';await commit.click();await page.getByRole('heading',{name:/Imported 1 employee$/}).waitFor({state:'visible'});const written=await verifyCanonical({phase:'committed',expected});requireFact(written.employee?.employeeCode===human.employeeCode&&written.employee.fullName===human.fullName&&written.employee.email===human.email&&written.employee.hiredOn===human.hiredOn&&written.assignment?.employmentType===human.employmentType&&written.compensation?.basicSalary===human.basicSalary&&uuid(written.hireEvent?.id)&&uuid(written.importEvent?.id)&&uuid(written.run?.id),'native_graph_receipt');
  stage='reload_native_import_history';await page.reload({waitUntil:'domcontentloaded'});const history=page.getByRole('heading',{name:'Import history',exact:true}).locator('../..'),row=history.locator('tbody > tr').filter({has:page.getByRole('cell',{name:sourceMode==='paste'?'Pasted CSV':'fictional-messy-employees.'+sourceMode,exact:true})}).filter({has:page.getByRole('cell',{name:before.companyName,exact:true})}).filter({has:page.getByRole('cell',{name:before.operatorName,exact:true})}).filter({has:page.getByRole('cell',{name:/^Succeeded\s*·\s*1 imported, 0 failed$/})});await row.waitFor({state:'visible'});requireFact(await row.count()===1,'history_ui_exact_unique_native_run');
  const reopened=await verifyCanonical({phase:'reopened',expected});requireFact(same(reopened.counts,written.counts)&&reopened.employee?.employmentId===written.employee.employmentId&&reopened.run?.id===written.run.id&&reopened.importEvent?.id===written.importEvent.id&&!unexpectedAssistantRequest,'reopen_duplicate_or_unexpected_ai_request');
  return{journey:'english_employee_import_'+sourceMode,checks:['actual_messy_source_local_intake','unresolved_and_unreviewed_prevent_commit','explicit_original_mapping_and_exclusions','blank_human_added_fields_explicit_review','editing_clears_human_review','local_preparation_and_native_preview_no_effects','single_human_commit_native_graph_events','separate_native_history_reopen_no_duplicate'].map(id=>({id,passed:true})),coverage:'fictional_'+sourceMode+'_full_employee_creation_only',notCovered:['other_source_modes_require_separate_fresh_fixture_runs','real_user_dataset_baseline_vs_assisted_savings','production_hr_provider_transfer_or_capability','cross_scope_revocation_concurrency_rollback_retention','all_locales_viewports_accessibility_or_combined_final_gate']};
 }catch{fail(stage);}finally{page.off('request',observe);}
}
