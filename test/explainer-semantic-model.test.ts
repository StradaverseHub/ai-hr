/** ADR-0170 step 4 — the explainers and setup co-pilot are declared in the semantic model: every returned
 * field has a disclosure class, every owner exists, and the production catalogue outputs are unchanged.
 * Pure: owners are imported and checked for their declared export; no database. */
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe,expect,it} from 'vitest';
import {ASSISTANT_TOOL_CATALOGUE} from '../lib/ai/assistant-tool-catalogue';
import {SEMANTIC_ENTITIES} from '../core/semantic-model/entities';
import * as explainModel from '../core/semantic-model/entities-explain';
import {EXPLAIN_ENTITIES,EXPLAIN_READS} from '../core/semantic-model/entities-explain';
import {SETUP_ENTITIES,SETUP_READS} from '../core/semantic-model/entities-setup';
import {capabilityRegistry,contextToolSpecs,disclosureOf,TERAS_READS,terasCapabilityRegistry,terasEntities,terasEntity,terasToolSpecs} from '../core/semantic-model/generate';
import type {OwnerAnchor,SemanticField} from '../core/semantic-model/types';
import {TERAS_CAPABILITIES} from '../core/explainers/capabilities';
import * as capabilities from '../core/explainers/capabilities';
import * as read from '../core/read';
import * as statutoryExplain from '../core/statutory-explain';
import * as payslipRecompute from '../core/payslip-recompute';
import * as leaveProjection from '../core/assistant-leave-projection';
import * as attendance from '../core/attendance';
import * as attendanceExplain from '../core/attendance-explain';
import * as attendanceDerive from '../core/attendance-derive';
import * as setupReadiness from '../core/product-context/setup-readiness';
import * as coverageReadiness from '../core/product-context/coverage-readiness';
import * as copilot from '../core/setup-copilot/copilot';

const OWNER_MODULES:Readonly<Record<string,Record<string,unknown>>>={'core/read.ts':read,'core/statutory-explain.ts':statutoryExplain,'core/payslip-recompute.ts':payslipRecompute,
 'core/assistant-leave-projection.ts':leaveProjection,'core/attendance.ts':attendance,'core/attendance-explain.ts':attendanceExplain,'core/attendance-derive.ts':attendanceDerive,
 'core/product-context/setup-readiness.ts':setupReadiness,'core/product-context/coverage-readiness.ts':coverageReadiness,'core/setup-copilot/copilot.ts':copilot,'core/explainers/capabilities.ts':capabilities};
const root=fileURLToPath(new URL('..',import.meta.url));
const resolve=(anchor:OwnerAnchor)=>{const [file,name]=anchor.split('#');expect(existsSync(root+file),anchor).toBe(true);const owned=OWNER_MODULES[file];expect(owned,anchor+' not imported here').toBeDefined();return owned![name];};
const walk=(fields:readonly SemanticField[]):SemanticField[]=>fields.flatMap(field=>[field,...(field.of?walk(field.of):[])]);
const STEP4=[...EXPLAIN_ENTITIES,...SETUP_ENTITIES];

describe('step 4 capabilities in the semantic model',()=>{
 it('declares one read per capability, each over a step 4 entity, and binds each to a runner',()=>{
  // Main's Password Policy and Correction Controls guides follow setup_copilot (SETUP_READS). Issue 13b appends the governed pay averages (core/semantic-model/entities-metrics.ts; test/pay-averages.test.ts);
  // AI v2 W7 the workforce metrics (test/workforce-metrics.test.ts); AI v2 W5 appends the pay difference and claim limit
  // explainers (core/semantic-model/entities-why.ts; test/why-explainers.test.ts); AI v2 W8 the loops overview
  // (core/semantic-model/entities-loops.ts; test/loops-overview-read.test.ts).
  expect(TERAS_READS.map(row=>row.name)).toEqual(['explain_payslip_statutory','explain_leave_entitlement','explain_attendance_day','setup_copilot','password_policy_guidance','correction_controls_guidance','organisation_tagging_guidance','pay_aggregates','workforce_metrics','explain_pay_difference','explain_claim_limit','loops_overview',
   // AI v2 Phase 2 P2-3 appends the "Before payroll" checklist (core/semantic-model/entities-payroll-readiness.ts; test/before-payroll-items.test.ts).
   'my_payroll_readiness',
   // AI v2 Phase 2 (wave 1 integration): the payroll-cycle loop pages, administrators only.
   'payroll_cycle_status','salary_payroll_checks','payroll_loop_settings','payroll_audit_status',
   // AI v2 Phase 2 P2-5 appends the Living Handbook's approved policies in force (core/semantic-model/entities-handbook.ts; test/handbook-policies.test.ts).
   'my_policy_handbook',
   // AI v2 Phase 2 P2-6 appends AI quality for administrators (core/semantic-model/entities-quality.ts; test/learning-loops.test.ts).
   'ai_quality_summary',
   // Payroll history learning (P2) appends "Learned this cycle" (core/semantic-model/entities-payroll-learning.ts; test/payroll-learning.test.ts).
   'payroll_learning_status']);
  expect(TERAS_CAPABILITIES.map(row=>row.name)).toEqual(TERAS_READS.map(row=>row.name));
  expect([...EXPLAIN_READS,...SETUP_READS].map(row=>row.entity)).toEqual(STEP4.map(entity=>entity.id));
  expect(TERAS_READS.some(row=>row.input.some(input=>input.identifier)),'no step 4 capability takes a record handle').toBe(false);
 });
 it('leaves the production catalogue outputs untouched',()=>{
  expect(contextToolSpecs().map(spec=>spec.name)).toEqual(ASSISTANT_TOOL_CATALOGUE.map(spec=>spec.name));
  expect(capabilityRegistry().some(row=>TERAS_READS.some(read=>read.name===row.name))).toBe(false);
 });
 it('classes identifiers and typed free text never, every pay figure as a band, and every count as a band',()=>{
  for(const entity of STEP4)for(const field of walk(entity.fields)){
   if(['id','code','text'].includes(field.type))expect(field.disclosure,entity.id+'.'+field.name).toBe('never');
   if(entity.sensitivity==='pay'&&['number','integer'].includes(field.type))expect(field.disclosure,entity.id+'.'+field.name).toBe('bands');
   if(entity.id==='setup_copilot'&&field.name==='count')expect(field.disclosure).toBe('bands');
  }
 });
 it('settles the entitlement explainer fields as bands and bands pay figures inside module work',()=>{
  const entitlement=terasEntity('leave_entitlement'),names=new Map(walk(entitlement.fields).map(field=>[field.name,field.disclosure]));
  for(const name of ['currentYearEntitlement','currentYearEntitlementRounded','eligibleDays','monthlyAccruedToDate','carriedForward','carryForwardRemaining','configAdjustments','systemAdjustments','balance'])expect(names.get(name),name).toBe('bands');
  // Folded into ./entities.ts at integration (ADR-0170 §3.15): the declaration is the model, with no generator patch.
  expect(terasEntity('leave_entitlement')).toBe(SEMANTIC_ENTITIES.find(row=>row.id==='leave_entitlement'));
  expect(terasEntity('module_work')).toBe(SEMANTIC_ENTITIES.find(row=>row.id==='module_work'));
  const data=terasEntity('module_work').fields.find(field=>field.name==='data')!;
  // Privacy fixes (November 2026): module rows are closed; every field a module reader returns is declared.
  expect(data.disclosure).toBe('minimum');expect('open' in data).toBe(false);
  const declared=Object.fromEntries((data.of??[]).map(field=>[field.name,field.disclosure]));
  expect(declared).toMatchObject({gross:'bands',deductions:'bands',net:'bands',amount:'bands',employeeCode:'never',employmentId:'never',name:'minimum'});
  expect((data.of??[]).find(field=>field.name==='name')?.type).toBe('name');
  expect('ENTITY_FIELD_EXTENSIONS' in explainModel).toBe(false);
  // The entitlement explainer's rows are the leave_entitlement declaration (less the employment handle) plus proration.
  const rows=EXPLAIN_ENTITIES.find(row=>row.id==='entitlement_explanation')!.fields.find(field=>field.name==='employments')!.of!.map(field=>field.name);
  expect(rows).toEqual([...entitlement.fields.filter(field=>field.name!=='employmentId').map(field=>field.name),'proration']);
 });
 it('names every field once, carries a provenance block, and resolves every owner and rule version',()=>{
  for(const entity of STEP4){
   const names=entity.fields.map(field=>field.name);expect(new Set(names).size,entity.id).toBe(names.length);expect(names).toContain('provenance');
   for(const anchor of entity.owners)expect(typeof resolve(anchor),anchor).toBe('function');
   if(entity.ruleVersion)expect(resolve(entity.ruleVersion),entity.ruleVersion).not.toBeUndefined();
   expect(existsSync(root+'app'+entity.page+'/page.tsx'),entity.page).toBe(true);
   for(const relation of entity.relations)expect(terasEntities().some(row=>row.id===relation.to),relation.to).toBe(true);
  }
  expect(EXPLAIN_ENTITIES.find(row=>row.id==='statutory_explanation')!.ruleVersion).toBe('core/payslip-recompute.ts#payslipProvenance');
 });
 it('generates specs whose required inputs exclude the optional ones and whose descriptions name no never field',()=>{
  const specs=terasToolSpecs();expect(specs.map(spec=>spec.name)).toEqual(TERAS_READS.map(row=>row.name));
  const required=Object.fromEntries(specs.map(spec=>[spec.name,(spec.inputSchema as {required:string[]}).required]));
  expect(required).toEqual({explain_payslip_statutory:[],explain_leave_entitlement:['leave_type'],explain_attendance_day:['date'],setup_copilot:[],password_policy_guidance:[],correction_controls_guidance:[],organisation_tagging_guidance:[],pay_aggregates:[],workforce_metrics:['metric'],
   explain_pay_difference:[],explain_claim_limit:['claim_type'],loops_overview:[],my_payroll_readiness:[],
   payroll_cycle_status:[],salary_payroll_checks:[],payroll_loop_settings:[],payroll_audit_status:[],my_policy_handbook:[],ai_quality_summary:[],payroll_learning_status:[]});
  const never=[...new Set(STEP4.flatMap(entity=>walk(entity.fields)).filter(field=>field.disclosure==='never').map(field=>field.name))];
  for(const spec of specs)for(const name of never)expect(spec.description).not.toMatch(new RegExp(`(^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_]|$)`));
 });
 it('summarises every capability row from the extended model, the step 4 rows included',()=>{
  const rows=terasCapabilityRegistry();expect(rows.map(row=>row.name)).toEqual([...capabilityRegistry().map(row=>row.name),...TERAS_READS.map(row=>row.name)]);
  for(const row of rows)expect(row.disclosure).toEqual(disclosureOf(terasEntity(row.entity).fields));
  for(const name of ['setup_copilot','password_policy_guidance','correction_controls_guidance','organisation_tagging_guidance'])expect(rows.find(row=>row.name===name)!.audience).toBe('admin');
  expect(rows.find(row=>row.name==='password_policy_guidance')!.module).toBeNull();expect(rows.find(row=>row.name==='correction_controls_guidance')!.module).toBe('payroll');
 });
});
