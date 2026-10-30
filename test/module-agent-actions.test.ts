/** Authored UNRUN. Pure source declarations/refusals only; no runtime, permissions or effect proof. */
import {expect,it} from 'vitest';
import {readFileSync,existsSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {MODULE_CATALOG} from '../packs/catalog';
import {MODULE_AGENT_CAPABILITIES} from '../lib/ai/module-agents';
import {MODULE_AGENT_ACTIONS,getModuleAgentAction,parseModuleAgentActionNomination,moduleAgentActionCoverage} from '../lib/ai/module-agent-actions';
const expected={employees:'employees.import',org:'org.reporting.change',leave:'leave.apply',ess:'ess.profile.request',approvals:'approvals.leave.decide',knowledge_base:'knowledge_base.article.create',payroll:'payroll.close',attendance:'attendance.correction.request',claims:'claims.submit',performance:'performance.review.acknowledge',rewards:'rewards.post',lifecycle:'lifecycle.acknowledgement.submit',toil:'toil.replacement.request',multi_cycle_payroll:'multi_cycle_payroll.create_run',typed_pay_components:'typed_pay_components.create','country-my':'country-my.statutory.update',notifications:'notifications.email_preferences.save',system_explorer:null,assistant:null,system_testing:'system_testing.execution.save'};
it('declares all twenty canonical module identities without treating pending action coverage as completion',()=>{expect(Object.keys(MODULE_AGENT_ACTIONS).sort()).toEqual(Object.keys(expected).sort());expect(Object.keys(expected)).toHaveLength(20);expect(moduleAgentActionCoverage().closed).toBe(true);expect(moduleAgentActionCoverage().coverage).toBe('source_declaration_only');for(const [code,action] of Object.entries(expected)){const row=MODULE_AGENT_ACTIONS[code as keyof typeof MODULE_AGENT_ACTIONS];expect(row.module).toBe(code);expect(row.phases.read).toBe('implemented');expect(row.phases.explain).toBe('read_context_only');expect(Object.isFrozen(row)).toBe(true);expect(Object.isFrozen(row.actions)).toBe(true);if(action)expect(getModuleAgentAction(code,action)?.id).toBe(action);}});
it('keeps Leave application owned by Leave, with submission distinct from approval and human confirmation never model-callable',()=>{const action=getModuleAgentAction('leave','leave.apply');expect(action).toMatchObject({owner:'leave',outcome:'submitted_not_approved',human:'canonical_workflow_required',prepare:{status:'implemented',adapter:'leave_own_review_v1'},confirm:{status:'implemented',inputSchema:'OwnLeaveConfirmation'}});expect(parseModuleAgentActionNomination({module:'leave',action:'leave.apply',phase:'prepare'})).toEqual({kind:'prepare',module:'leave',action:'leave.apply',adapter:'leave_own_review_v1',requiresHumanSelection:true,effect:'none'});expect(()=>parseModuleAgentActionNomination({module:'leave',action:'leave.apply',phase:'confirm'})).toThrow();expect(()=>parseModuleAgentActionNomination({module:'approvals',action:'approvals.leave.decide',phase:'confirm'})).toThrow();expect(getModuleAgentAction('assistant','leave.apply')).toBeNull();});
it('classifies actual Employee Master import as a separate human workflow rather than a generic Assistant executor',()=>{expect(getModuleAgentAction('employees','employees.import')).toMatchObject({owner:'personnel',publicBoundary:'core/import.ts#commitEmployeeImport',prepare:{status:'human_workflow_only',adapter:null},confirm:{status:'human_workflow_only',adapter:null}});expect(()=>parseModuleAgentActionNomination({module:'employees',action:'employees.import',phase:'prepare'})).toThrow();expect(MODULE_AGENT_ACTIONS.assistant.coverage).toBe('orchestration_only');expect(MODULE_AGENT_ACTIONS.assistant.actions).toEqual([]);});
it('permits only closed current read nominations and refuses service strings, selectors, SQL, role carriers, unknown effects and unsupported explain methods',()=>{for(const [module,capability] of MODULE_AGENT_CAPABILITIES)expect(parseModuleAgentActionNomination({module,action:capability,phase:'read'})).toEqual({kind:'read',module,capability,adapter:'canonical_module_read_v1'});for(const extra of [{service:'core/payroll.ts'},{sql:'select private'},{employeeId:'other'},{roles:['super_admin']},{tenantId:'other'},{input:{reason:'invented'}},{confirm:true}])expect(()=>parseModuleAgentActionNomination({module:'leave',action:'leave.apply',phase:'prepare',...extra})).toThrow('not available');for(const value of [{module:'payroll',action:'payroll.calculate',phase:'prepare'},{module:'leave',action:'requestLeave',phase:'prepare'},{module:'payroll',action:'own_released_payslips',phase:'explain'}])expect(()=>parseModuleAgentActionNomination(value)).toThrow();});
it('keeps System Explorer read-only and leaves money/process/test-outcome effects unavailable to models',()=>{expect(MODULE_AGENT_ACTIONS.system_explorer).toMatchObject({coverage:'read_only',actions:[],phases:{prepare:'unavailable',confirm:'unavailable'}});expect(MODULE_AGENT_ACTIONS.payroll.money).toBe('stored_kernel_amounts_only');expect(MODULE_AGENT_ACTIONS.multi_cycle_payroll.money).toBe('stored_kernel_amounts_only');expect(MODULE_AGENT_ACTIONS.typed_pay_components.money).toBe('stored_kernel_amounts_only');for(const module of ['payroll','rewards'] as const){const action=MODULE_AGENT_ACTIONS[module].actions[0];expect(action).toMatchObject({human:'canonical_workflow_required',outcome:'canonical_receipt_required'});expect(()=>parseModuleAgentActionNomination({module,action:action.id,phase:'confirm'})).toThrow();}expect(()=>parseModuleAgentActionNomination({module:'system_explorer',action:'system_explorer.execute_sql',phase:'prepare'})).toThrow();});
it('flags future/unmapped modules, duplicate modules/actions, omitted actions and changed canonical boundaries/contracts',()=>{const rows=Object.values(MODULE_AGENT_ACTIONS),catalogue=MODULE_CATALOG.map(row=>({code:row.code}));expect(moduleAgentActionCoverage([...catalogue,{code:'future_module'}]).issues).toContainEqual({code:'missing_module',module:'future_module'});expect(moduleAgentActionCoverage([...catalogue,catalogue[0]]).issues.some(i=>i.code==='duplicate_catalogue_module')).toBe(true);expect(moduleAgentActionCoverage(catalogue,[...rows,rows[0]]).issues.some(i=>i.code==='duplicate_declaration_module')).toBe(true);const leave=MODULE_AGENT_ACTIONS.leave;for(const changed of [{...leave,actions:[]},{...leave,phases:{...leave.phases,confirm:'unavailable'}},{...leave,read:{...leave.read,adapter:'arbitrary_callable'}},{...leave,actions:[{...leave.actions[0],outcome:'approved'}]},{...leave,actions:[leave.actions[0],leave.actions[0]]},{...leave,publicBoundary:'arbitrary/function'},{...leave,actions:[{...leave.actions[0],contractVersion:999}]},{...leave,actions:[{...leave.actions[0],prepare:{...leave.actions[0].prepare,status:'pending_adapter'}}]}])expect(moduleAgentActionCoverage(catalogue,rows.map(row=>row.module==='leave'?changed:row)).closed).toBe(false);});

/** Source closure inspects real modules without importing server owners, executing functions or
 * treating the declaration's own strings as proof. Named and star public re-exports are followed. */
function publicExport(file:string,name:string,visited=new Set<string>()):boolean {
 const key=file+'#'+name;if(visited.has(key)||!existsSync(file))return false;visited.add(key);
 const ast=ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
 for(const node of ast.statements){
  if(ts.isExportDeclaration(node)){
   const target=node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier)?node.moduleSpecifier.text:null;
   if(target&&!target.startsWith('.'))continue;
   if(!node.exportClause&&target&&publicExport(resolve(dirname(file),target+'.ts'),name,visited))return true;
   if(node.exportClause&&ts.isNamedExports(node.exportClause))for(const spec of node.exportClause.elements){
    if(spec.name.text!==name||spec.isTypeOnly||node.isTypeOnly)continue;
    const original=spec.propertyName?.text??spec.name.text;
    if(target){if(publicExport(resolve(dirname(file),target+'.ts'),original,visited))return true;}
    else if(ast.statements.some(local=>(ts.isFunctionDeclaration(local)||ts.isClassDeclaration(local))&&local.name?.text===original))return true;
   }
  }
  const modifiers=ts.canHaveModifiers(node)?ts.getModifiers(node):undefined;
  if(!modifiers?.some(mod=>mod.kind===ts.SyntaxKind.ExportKeyword))continue;
  if((ts.isFunctionDeclaration(node)||ts.isClassDeclaration(node))&&node.name?.text===name)return true;
  if(ts.isVariableStatement(node)&&node.declarationList.declarations.some(decl=>ts.isIdentifier(decl.name)&&decl.name.text===name))return true;
 }
 return false;
}
it('closes every declared canonical public boundary and source anchor against actual exported source or public re-exports',()=>{
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
 for(const row of Object.values(MODULE_AGENT_ACTIONS))for(const anchor of [row.publicBoundary,row.source,...row.actions.map(action=>action.publicBoundary)]){
  expect(anchor).toMatch(/^[a-zA-Z0-9_/-]+\.ts#[A-Za-z_$][A-Za-z0-9_$]*(?:\+[A-Za-z_$][A-Za-z0-9_$]*)*$/);
  const [path,names]=anchor.split('#');for(const name of names.split('+'))expect(publicExport(resolve(root,path),name),anchor).toBe(true);
 }
 // Negative controls reject real-file private/nonexistent names and a removed public file.
 expect(publicExport(resolve(root,'core/profile.ts'),'notAnExportedCanonicalOwner')).toBe(false);
 expect(publicExport(resolve(root,'core/does-not-exist.ts'),'requestProfileChange')).toBe(false);
});

it('rejects deliberately disabled legacy testing owners even when their export still exists and declares the versioned human-observation workflow',()=>{
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
 const row=MODULE_AGENT_ACTIONS.system_testing;
 expect(row.publicBoundary).toBe('core/system-testing-workspace.ts#saveTestingExecution');
 expect(row.source).toBe('core/system-testing-workspace.ts#ownTestingWorkStatusesTx');
 expect(publicExport(resolve(root,'core/system-testing-workspace.ts'),'ownTestingWorkStatusesTx')).toBe(true);
 expect(row.actions[0]).toMatchObject({id:'system_testing.execution.save',observations:'human_actual_only',prepare:{status:'implemented'},confirm:{status:'implemented'}});
 const forbidden='core/system-testing.ts#recordTestRun';
 for(const declaration of Object.values(MODULE_AGENT_ACTIONS))expect([declaration.publicBoundary,declaration.source,...declaration.actions.map(action=>action.publicBoundary)]).not.toContain(forbidden);
 expect(moduleAgentActionCoverage(MODULE_CATALOG,Object.values(MODULE_AGENT_ACTIONS).map(value=>value.module==='system_testing'?{...value,publicBoundary:forbidden,actions:[{...value.actions[0],publicBoundary:forbidden}]}:value)).closed).toBe(false);
 expect(()=>parseModuleAgentActionNomination({module:'system_testing',action:'system_testing.record_result',phase:'prepare'})).toThrow();
});
it('declares the public country factory and typed statutory.set member separately from its internal MY implementation',()=>{
 const row=MODULE_AGENT_ACTIONS['country-my'];
 expect(row).toMatchObject({publicBoundary:'localization/registry.ts#requirePackFor',publicMember:'statutory.set',source:'core/assistant-actions/country-statutory-review-store.ts#prepareCountryStatutoryReview+confirmCountryStatutoryReview'});
 expect(row.actions[0]).toMatchObject({publicBoundary:'localization/registry.ts#requirePackFor',publicMember:'statutory.set',prepare:{status:'implemented',adapter:'module_country_statutory_review_v1'}});
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
 const ast=ts.createSourceFile('my/index.ts',readFileSync(resolve(root,'localization/my/index.ts'),'utf8'),ts.ScriptTarget.Latest,true);
 let memberBound=false;function visit(node:ts.Node){if(ts.isPropertyAssignment(node)&&node.name.getText(ast)==='statutory'&&ts.isObjectLiteralExpression(node.initializer))memberBound=node.initializer.properties.some(member=>ts.isPropertyAssignment(member)&&member.name.getText(ast)==='set'&&ts.isIdentifier(member.initializer)&&member.initializer.text==='setStatutoryProfileMY');ts.forEachChild(node,visit);}visit(ast);
 expect(memberBound).toBe(true);
 expect(parseModuleAgentActionNomination({module:'country-my',action:'country-my.statutory.update',phase:'prepare'})).toMatchObject({kind:'prepare',requiresHumanSelection:true,effect:'none'});
 expect(()=>parseModuleAgentActionNomination({module:'country-my',action:'country-my.statutory.update',phase:'confirm'})).toThrow();
});

it('connects Notifications to its closed human review lifecycle without admitting model preferences, identity or confirmation',()=>{
 const action='notifications.email_preferences.save';
 expect(getModuleAgentAction('notifications',action)).toMatchObject({owner:'notifications',prepare:{status:'implemented',adapter:'module_notification_review_v1'},confirm:{status:'implemented',inputSchema:'ModuleActionConfirmation'}});
 expect(parseModuleAgentActionNomination({module:'notifications',action,phase:'prepare'})).toEqual({kind:'prepare',module:'notifications',action,adapter:'module_notification_review_v1',requiresHumanSelection:true,effect:'none'});
 for(const value of [{module:'notifications',action,phase:'confirm'},{module:'assistant',action,phase:'prepare'},...[
  {intent:{enabledCategories:['claims']}},{employmentId:'other'},{verifiedIdentity:{issuer:'invented'}},{actionId:'forged'},{reviewedDigest:'a'.repeat(64)},{api:'/api/assistant/module-actions'},
 ].map(extra=>({module:'notifications',action,phase:'prepare',...extra}))])expect(()=>parseModuleAgentActionNomination(value)).toThrow();
 expect(MODULE_AGENT_ACTIONS.notifications.source).toBe('core/assistant-actions/module-action-review-store.ts#prepareModuleActionReview+confirmModuleActionReview');
});

it('keeps ESS human selection distinct from requests for approval and refuses model-authored profile proposals or confirmation',()=>{
 const action='ess.profile.request';expect(getModuleAgentAction('ess',action)).toMatchObject({owner:'profile',outcome:'submitted_not_approved',prepare:{status:'implemented',adapter:'module_profile_review_v1'}});
 expect(parseModuleAgentActionNomination({module:'ess',action,phase:'prepare'})).toEqual({kind:'prepare',module:'ess',action,adapter:'module_profile_review_v1',requiresHumanSelection:true,effect:'none'});
 for(const extra of [{proposal:{v:2,fields:[],registers:[]}},{employmentId:'other'},{roles:['hr_admin']},{reviewedDigest:'a'.repeat(64)},{actionId:'posted'}])expect(()=>parseModuleAgentActionNomination({module:'ess',action,phase:'prepare',...extra})).toThrow();expect(()=>parseModuleAgentActionNomination({module:'ess',action,phase:'confirm'})).toThrow();
});
it('keeps explicit Claims submission distinct from draft saving and declares the modern Performance acknowledgement separately',()=>{
 expect(MODULE_AGENT_ACTIONS.claims.actions.map(row=>row.id)).toEqual(['claims.submit','claims.draft.save','claims.cancel']);expect(getModuleAgentAction('claims','claims.submit')).toMatchObject({publicBoundary:'packs/claims/service.ts#submitDraftClaims',outcome:'submitted_not_approved',prepare:{status:'implemented',adapter:'module_claim_submission_review_v1'}});expect(MODULE_AGENT_ACTIONS.claims.money).toBe('canonical_engine_only');
 expect(MODULE_AGENT_ACTIONS.performance.actions.map(row=>row.id)).toEqual(['performance.review.acknowledge','performance.onehr.plan.acknowledge']);
 expect(parseModuleAgentActionNomination({module:'claims',action:'claims.draft.save',phase:'prepare'})).toEqual({kind:'prepare',module:'claims',action:'claims.draft.save',adapter:'module_claim_draft_review_v1',requiresHumanSelection:true,effect:'none'});
 for(const extra of [{enteredAmount:100},{draftId:'posted'},{expectedDraftRevision:'1'},{fieldValues:{private:'posted'}},{confirm:true}])expect(()=>parseModuleAgentActionNomination({module:'claims',action:'claims.draft.save',phase:'prepare',...extra})).toThrow();
 expect(()=>parseModuleAgentActionNomination({module:'claims',action:'claims.draft.save',phase:'confirm'})).toThrow();
});

it('routes both Performance acknowledgement kinds only to human source selection, never model ratings or effects',()=>{
 for(const [action,adapter] of [['performance.review.acknowledge','module_standard_review_v1'],['performance.onehr.plan.acknowledge','module_onehr_plan_review_v1']]){
  expect(parseModuleAgentActionNomination({module:'performance',action,phase:'prepare'})).toEqual({kind:'prepare',module:'performance',action,adapter,requiresHumanSelection:true,effect:'none'});
  expect(getModuleAgentAction('performance',action)?.confirm.status).toBe('implemented');expect(()=>parseModuleAgentActionNomination({module:'performance',action,phase:'confirm'})).toThrow();
  for(const extra of [{reviewId:'posted'},{planId:'posted'},{acknowledge:true},{rating:5},{promotion:true},{input:{reviewId:'posted'}},{reviewedDigest:'a'.repeat(64)}])expect(()=>parseModuleAgentActionNomination({module:'performance',action,phase:'prepare',...extra})).toThrow();
 }
});

it('offers Testing only a human selection handoff and refuses model-written observations or confirmations',()=>{
 expect(parseModuleAgentActionNomination({module:'system_testing',action:'system_testing.execution.save',phase:'prepare'})).toEqual({kind:'prepare',module:'system_testing',action:'system_testing.execution.save',adapter:'module_testing_execution_review_v1',requiresHumanSelection:true,effect:'none'});
 for(const extra of [{status:'passed'},{observation:{status:'passed'}},{executionId:'posted'},{humanObserved:true},{reviewedDigest:'a'.repeat(64)},{roles:['hr_admin']}])expect(()=>parseModuleAgentActionNomination({module:'system_testing',action:'system_testing.execution.save',phase:'prepare',...extra})).toThrow();
 expect(()=>parseModuleAgentActionNomination({module:'system_testing',action:'system_testing.execution.save',phase:'confirm'})).toThrow();
});

it('routes Claims submission only to a human selection, never model values, receipts or a submit confirmation',()=>{
 expect(parseModuleAgentActionNomination({module:'claims',action:'claims.submit',phase:'prepare'})).toEqual({kind:'prepare',module:'claims',action:'claims.submit',adapter:'module_claim_submission_review_v1',requiresHumanSelection:true,effect:'none'});
 for(const extra of [{draftId:'posted'},{employmentId:'other'},{amount:1},{receiptIds:['invented']},{submitForApproval:true},{reviewedDigest:'a'.repeat(64)},{confirm:true}])expect(()=>parseModuleAgentActionNomination({module:'claims',action:'claims.submit',phase:'prepare',...extra})).toThrow();
 expect(()=>parseModuleAgentActionNomination({module:'claims',action:'claims.submit',phase:'confirm'})).toThrow();
});

it('offers Org only a human reporting selection without model-picked employees, managers or authority',()=>{
 expect(parseModuleAgentActionNomination({module:'org',action:'org.reporting.change',phase:'prepare'})).toEqual({kind:'prepare',module:'org',action:'org.reporting.change',adapter:'module_org_reporting_review_v1',requiresHumanSelection:true,effect:'none'});
 for(const extra of [{subordinateEmploymentId:'posted'},{managerEmploymentId:'other'},{lineType:'delegate'},{validFrom:'2026-01-01'},{movement:{type:'promotion'}},{roles:['hr_admin']},{reviewedDigest:'a'.repeat(64)}])expect(()=>parseModuleAgentActionNomination({module:'org',action:'org.reporting.change',phase:'prepare',...extra})).toThrow();
 expect(()=>parseModuleAgentActionNomination({module:'org',action:'org.reporting.change',phase:'confirm'})).toThrow();
});

it('offers only the connected human Knowledge Base review page, never model-authored content or publication',()=>{
 expect(getModuleAgentAction('knowledge_base','knowledge_base.article.create')).toMatchObject({owner:'knowledge_base',publicBoundary:'core/knowledge-base.ts#createArticle',prepare:{status:'implemented',inputSchema:'KnowledgeArticleReviewPrepare'},confirm:{status:'implemented',inputSchema:'KnowledgeArticleReviewConfirmation'}});
 expect(parseModuleAgentActionNomination({module:'knowledge_base',action:'knowledge_base.article.create',phase:'prepare'})).toEqual({kind:'prepare',module:'knowledge_base',action:'knowledge_base.article.create',adapter:'module_knowledge_article_review_v1',requiresHumanSelection:true,effect:'none'});
 for(const extra of [{title:'generated policy'},{body:'model HR claims'},{audience:'all'},{authorId:'posted'},{upload:'bytes'},{reviewedDigest:'a'.repeat(64)}])expect(()=>parseModuleAgentActionNomination({module:'knowledge_base',action:'knowledge_base.article.create',phase:'prepare',...extra})).toThrow();
 expect(()=>parseModuleAgentActionNomination({module:'knowledge_base',action:'knowledge_base.article.create',phase:'confirm'})).toThrow();
});

it('connects human equipment acknowledgement without granting lifecycle provisioning or model confirmation',()=>{
 expect(getModuleAgentAction('lifecycle','lifecycle.acknowledgement.submit')).toMatchObject({owner:'lifecycle',publicBoundary:'core/lifecycle-self.ts#submitMyAcknowledgement',prepare:{status:'implemented',adapter:'module_lifecycle_ack_review_v1'},confirm:{status:'implemented',inputSchema:'LifecycleAckReviewConfirmation'}});
 expect(parseModuleAgentActionNomination({module:'lifecycle',action:'lifecycle.acknowledgement.submit',phase:'prepare'})).toEqual({kind:'prepare',module:'lifecycle',action:'lifecycle.acknowledgement.submit',adapter:'module_lifecycle_ack_review_v1',requiresHumanSelection:true,effect:'none'});
 for(const extra of [{caseId:'posted'},{serialNumber:'invented'},{acknowledged:true},{employmentId:'other'},{allocateAsset:true},{reviewedDigest:'a'.repeat(64)}])expect(()=>parseModuleAgentActionNomination({module:'lifecycle',action:'lifecycle.acknowledgement.submit',phase:'prepare',...extra})).toThrow();
 expect(()=>parseModuleAgentActionNomination({module:'lifecycle',action:'lifecycle.acknowledgement.submit',phase:'confirm'})).toThrow();
});

it('connects the TOIL human request without treating submission as earned credit, cash or approval',()=>{
 expect(getModuleAgentAction('toil','toil.replacement.request')).toMatchObject({owner:'leave',publicBoundary:'packs/leave/service.ts#submitReplacementLeaveRequest',outcome:'submitted_not_approved',prepare:{status:'implemented',adapter:'module_toil_request_review_v1'},confirm:{status:'implemented',inputSchema:'ToilRequestReviewConfirmation'}});
 expect(parseModuleAgentActionNomination({module:'toil',action:'toil.replacement.request',phase:'prepare'})).toEqual({kind:'prepare',module:'toil',action:'toil.replacement.request',adapter:'module_toil_request_review_v1',requiresHumanSelection:true,effect:'none'});
 for(const extra of [{employmentId:'other'},{rows:[]},{reason:'invented work'},{firstScheduleConsent:true},{approved:true},{creditDays:10}])expect(()=>parseModuleAgentActionNomination({module:'toil',action:'toil.replacement.request',phase:'prepare',...extra})).toThrow();
 expect(()=>parseModuleAgentActionNomination({module:'toil',action:'toil.replacement.request',phase:'confirm'})).toThrow();
});

it('connects assigned Leave decisions without granting models decision inputs or confirmation',()=>{
 expect(getModuleAgentAction('approvals','approvals.leave.decide')).toMatchObject({owner:'leave',outcome:'canonical_receipt_required',prepare:{status:'implemented',adapter:'module_leave_decision_review_v1'},confirm:{status:'implemented',inputSchema:'LeaveDecisionReviewConfirmation'}});
 expect(parseModuleAgentActionNomination({module:'approvals',action:'approvals.leave.decide',phase:'prepare'})).toEqual({kind:'prepare',module:'approvals',action:'approvals.leave.decide',adapter:'module_leave_decision_review_v1',requiresHumanSelection:true,effect:'none'});
 for(const extra of [{leaveRequestId:'other'},{currentStepId:null},{decision:'approved'},{rejectReason:'invented'},{confirmAssignedDecision:true},{reviewedDigest:'a'.repeat(64)}])expect(()=>parseModuleAgentActionNomination({module:'approvals',action:'approvals.leave.decide',phase:'prepare',...extra})).toThrow();
 expect(()=>parseModuleAgentActionNomination({module:'approvals',action:'approvals.leave.decide',phase:'confirm'})).toThrow();
});

it('connects ADR-0151 wave 1b overtime requests and assigned decisions as human-selected, model-uncallable reviews',()=>{
 expect(MODULE_AGENT_ACTIONS.approvals.actions.map(row=>row.id)).toEqual(['approvals.leave.decide','approvals.claim.decide','approvals.attendance.decide','approvals.toil.decide']);
 expect(MODULE_AGENT_ACTIONS.attendance.actions.map(row=>row.id)).toEqual(['attendance.correction.request','attendance.overtime.request']);
 const rows=[['attendance','attendance.overtime.request','module_overtime_request_review_v1','attendance','submitted_not_approved'],['approvals','approvals.claim.decide','module_claim_decision_review_v1','claims','canonical_receipt_required'],
  ['approvals','approvals.attendance.decide','module_attendance_decision_review_v1','attendance','canonical_receipt_required'],['approvals','approvals.toil.decide','module_toil_decision_review_v1','leave','canonical_receipt_required']] as const;
 for(const [module,action,adapter,owner,outcome] of rows){
  expect(getModuleAgentAction(module,action)).toMatchObject({owner,outcome,prepare:{status:'implemented',adapter},confirm:{status:'implemented',adapter}});
  expect(parseModuleAgentActionNomination({module,action,phase:'prepare'})).toEqual({kind:'prepare',module,action,adapter,requiresHumanSelection:true,effect:'none'});
  for(const extra of [{subjectId:'other'},{employmentId:'other'},{decision:'approved'},{note:'model words'},{reviewedDigest:'a'.repeat(64)},{plannedStartTime:'18:00'}])expect(()=>parseModuleAgentActionNomination({module,action,phase:'prepare',...extra})).toThrow();
  expect(()=>parseModuleAgentActionNomination({module,action,phase:'confirm'})).toThrow();
 }
 // An action is only nominated under its own module.
 expect(()=>parseModuleAgentActionNomination({module:'claims',action:'approvals.claim.decide',phase:'prepare'})).toThrow();
});

it('connects ADR-0151 HR-prepared leave adjustment, movement and Leave Credit as human-selected reviews the model cannot fill in',()=>{
 expect(MODULE_AGENT_ACTIONS.toil.actions.map(row=>row.id)).toEqual(['toil.replacement.request','toil.credit.grant']);
 expect(MODULE_AGENT_ACTIONS.leave.actions.map(row=>row.id)).toEqual(['leave.apply','leave.cancel','leave.edit','leave.adjustment.apply']);
 expect(MODULE_AGENT_ACTIONS.employees.actions.map(row=>row.id)).toEqual(['employees.import','employees.movement.transfer','employees.compensation.maintain','employees.profile_request.reject','employees.code.maintain','employees.workforce_profile.maintain','employees.bank.maintain','employees.document_metadata.maintain','employees.fixed_item.archive','employees.cost_allocation.maintain','employees.payment_method.maintain','employees.tp3_opening.maintain','employees.passport.maintain','employees.emergency_contact.maintain','employees.family.maintain','employees.qualification.maintain','employees.draft.discard','employees.draft.activate']);
 const rows=[['leave','leave.adjustment.apply','module_leave_adjustment_review_v1','leave'],['employees','employees.movement.transfer','module_movement_transfer_review_v1','personnel'],['toil','toil.credit.grant','module_leave_credit_review_v1','leave']] as const;
 for(const [module,action,adapter,owner] of rows){
  expect(getModuleAgentAction(module,action)).toMatchObject({owner,outcome:'canonical_receipt_required',prepare:{status:'implemented',adapter},confirm:{status:'implemented',adapter}});
  expect(parseModuleAgentActionNomination({module,action,phase:'prepare'})).toEqual({kind:'prepare',module,action,adapter,requiresHumanSelection:true,effect:'none'});
  for(const extra of [{employmentId:'other'},{days:'5'},{reason:'model words'},{departmentId:'other'},{effectiveOn:'2026-01-01'},{workedDate:'2026-01-01'},{firstScheduleConsent:true},{reviewedDigest:'a'.repeat(64)}])expect(()=>parseModuleAgentActionNomination({module,action,phase:'prepare',...extra})).toThrow();
  expect(()=>parseModuleAgentActionNomination({module,action,phase:'confirm'})).toThrow();
 }
 expect(()=>parseModuleAgentActionNomination({module:'employees',action:'leave.adjustment.apply',phase:'prepare'})).toThrow();
});

it('connects human Attendance review without accepting model clocks, work evidence or approvals',()=>{
 expect(getModuleAgentAction('attendance','attendance.correction.request')).toMatchObject({owner:'attendance',outcome:'submitted_not_approved',prepare:{status:'implemented',adapter:'module_attendance_review_v1'},confirm:{status:'implemented',inputSchema:'AttendanceCorrectionReviewConfirmation'}});
 expect(parseModuleAgentActionNomination({module:'attendance',action:'attendance.correction.request',phase:'prepare'})).toEqual({kind:'prepare',module:'attendance',action:'attendance.correction.request',adapter:'module_attendance_review_v1',requiresHumanSelection:true,effect:'none'});
 for(const extra of [{employmentId:'other'},{date:'2026-01-01'},{requestedOtMinutes:60},{clockChanges:{}},{unclockedWork:{}},{intent:{}},{approved:true},{reviewedDigest:'a'.repeat(64)}])expect(()=>parseModuleAgentActionNomination({module:'attendance',action:'attendance.correction.request',phase:'prepare',...extra})).toThrow();
 expect(()=>parseModuleAgentActionNomination({module:'attendance',action:'attendance.correction.request',phase:'confirm'})).toThrow();
});

it('connects pay-code human setup without granting model rates, classifications, assignments or payroll execution',()=>{
 expect(getModuleAgentAction('typed_pay_components','typed_pay_components.create')).toMatchObject({owner:'payroll',outcome:'canonical_receipt_required',prepare:{status:'implemented',adapter:'module_pay_component_review_v1'},confirm:{status:'implemented',inputSchema:'PayComponentReviewConfirmation'}});
 expect(parseModuleAgentActionNomination({module:'typed_pay_components',action:'typed_pay_components.create',phase:'prepare'})).toEqual({kind:'prepare',module:'typed_pay_components',action:'typed_pay_components.create',adapter:'module_pay_component_review_v1',requiresHumanSelection:true,effect:'none'});
 for(const extra of [{input:{}},{code:'INVENTED'},{rule:{kind:'per_hour',rate:10}},{includedInEpf:true},{assignToEmployee:'other'},{runPayroll:true},{reviewedDigest:'a'.repeat(64)}])expect(()=>parseModuleAgentActionNomination({module:'typed_pay_components',action:'typed_pay_components.create',phase:'prepare',...extra})).toThrow();
 expect(()=>parseModuleAgentActionNomination({module:'typed_pay_components',action:'typed_pay_components.create',phase:'confirm'})).toThrow();
});

it('connects whole-unit Rewards human review without allowing model awards, salaries, partial employees or posting confirmation',()=>{
 expect(getModuleAgentAction('rewards','rewards.post')).toMatchObject({owner:'rewards',outcome:'canonical_receipt_required',prepare:{status:'implemented',adapter:'module_rewards_post_review_v1'},confirm:{status:'implemented',inputSchema:'RewardsPostReviewConfirmation'}});
 expect(parseModuleAgentActionNomination({module:'rewards',action:'rewards.post',phase:'prepare'})).toEqual({kind:'prepare',module:'rewards',action:'rewards.post',adapter:'module_rewards_post_review_v1',requiresHumanSelection:true,effect:'none'});
 for(const extra of [{unitId:'other'},{revision:1},{batchId:'other'},{awards:[]},{newBasic:100},{employeeIds:[]},{approved:true},{reviewedDigest:'a'.repeat(64)}])expect(()=>parseModuleAgentActionNomination({module:'rewards',action:'rewards.post',phase:'prepare',...extra})).toThrow();
 expect(()=>parseModuleAgentActionNomination({module:'rewards',action:'rewards.post',phase:'confirm'})).toThrow();
});

it('routes Payroll close only to human processed-run review and refuses model financial inputs or execution consent',()=>{
 expect(getModuleAgentAction('payroll','payroll.close')).toMatchObject({owner:'payroll',outcome:'canonical_receipt_required',prepare:{status:'implemented',adapter:'module_payroll_close_review_v1'},confirm:{status:'implemented',inputSchema:'PayrollCloseReviewConfirmation'}});
 expect(parseModuleAgentActionNomination({module:'payroll',action:'payroll.close',phase:'prepare'})).toEqual({kind:'prepare',module:'payroll',action:'payroll.close',adapter:'module_payroll_close_review_v1',requiresHumanSelection:true,effect:'none'});
 for(const extra of [{batchId:'other'},{salary:100},{totalNet:100},{releaseTiming:{}},{processed:true},{override:true},{confirmCloseProcessedRun:true},{reviewedDigest:'a'.repeat(64)}])expect(()=>parseModuleAgentActionNomination({module:'payroll',action:'payroll.close',phase:'prepare',...extra})).toThrow();
 expect(()=>parseModuleAgentActionNomination({module:'payroll',action:'payroll.close',phase:'confirm'})).toThrow();
});

it('keeps the Country specialist a literal human statutory-section handoff without model identity, country, rates or protected fields',()=>{
 expect(getModuleAgentAction('country-my','country-my.statutory.update')).toMatchObject({owner:'country_pack_my',prepare:{status:'implemented'},confirm:{status:'implemented',inputSchema:'CountryStatutoryReviewConfirmation'}});
 for(const extra of [{employmentId:'other'},{personId:'other'},{country:'MY'},{input:{}},{epfEmployeeRate:13},{bankAccountNo:'private'},{taxNumber:'private'},{confirmSharedPersonWrite:true},{reviewedDigest:'a'.repeat(64)}])expect(()=>parseModuleAgentActionNomination({module:'country-my',action:'country-my.statutory.update',phase:'prepare',...extra})).toThrow();
});

it('offers human additional-run creation without model dates, cycles, company scope, salaries or confirmation',()=>{
 expect(getModuleAgentAction('multi_cycle_payroll','multi_cycle_payroll.create_run')).toMatchObject({owner:'payroll',outcome:'canonical_receipt_required',prepare:{status:'implemented',adapter:'module_multi_cycle_run_review_v1'},confirm:{status:'implemented',inputSchema:'MultiCycleRunReviewConfirmation'}});
 expect(parseModuleAgentActionNomination({module:'multi_cycle_payroll',action:'multi_cycle_payroll.create_run',phase:'prepare'})).toEqual({kind:'prepare',module:'multi_cycle_payroll',action:'multi_cycle_payroll.create_run',adapter:'module_multi_cycle_run_review_v1',requiresHumanSelection:true,effect:'none'});
 for(const extra of [{input:{}},{companyId:'other'},{scope:{}},{payPeriod:'2026-01'},{paymentDate:'2026-01-28'},{payrollCycleId:'other'},{runType:'bonus'},{salary:100},{confirmDraftCreation:true},{reviewedDigest:'a'.repeat(64)}])expect(()=>parseModuleAgentActionNomination({module:'multi_cycle_payroll',action:'multi_cycle_payroll.create_run',phase:'prepare',...extra})).toThrow();
 expect(()=>parseModuleAgentActionNomination({module:'multi_cycle_payroll',action:'multi_cycle_payroll.create_run',phase:'confirm'})).toThrow();
});
