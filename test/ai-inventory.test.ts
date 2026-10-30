/** WP12 (R8, R20, R21): the AI inventory covers every owner's entries, the per-action pause key, alert thresholds,
 *  switch drift, run range/paging, the provider data register, six-locale copy and the static wiring. No database. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {capturePrivateAssistantTask,privateAssistantCatalogue} from '../lib/ai/provider-assistant-policy';
import type {AssistantAnswerRead} from '../lib/ai/assistant-answer-plan';
import {PROVIDER_WORKLOAD_CONTRACT_IDS,getProviderWorkloadDescriptor} from '../lib/ai/provider-workload-policy';
import {WORKLOAD_DISCLOSURE_FIELDS,providerDisclosureForFeature} from '../lib/ai/provider-disclosure-inventory';
import {providerDataReviewStatus} from '../lib/ai/provider-data-reviews';
import {assertProviderPrivacyRequest} from '../lib/ai/provider-privacy-request';
import type {ResolvedAiConfig} from '../lib/ai/types';
import { AI_FEATURES } from '../lib/ai/features';
import { AGENT_ACTIONS, agentActionPauseKey } from '../lib/ai/agent-action-registry';
import { MODULE_JOBS } from '../lib/ai/module-jobs';
import { AGENT_PRINCIPAL_SPECIALISTS } from '../lib/ai/agent-capability-inventory';
import { JOB_KEYS } from '../core/job-run';
import {
  AI_ALERT_THRESHOLDS, AI_COMPONENT_KINDS, AI_DATA_FIELDS, AI_DATA_REGISTER, AI_RUN_MAX_RANGE_DAYS, AI_RUN_PAGE_SIZE, AI_SCHEDULED_JOBS,
  ORCHESTRATOR_STEPS, SWEEP_DRIFT_REASONS, aiInventoryComponents, staleOverrideDisagrees, aiRunPageOffset, aiRunRangeBounds, evaluateAiAlerts, parseAiRunRange, registryRow, switchDrift,
  type AiAlertInput,
} from '../lib/ai/ai-inventory';
import { withAgentActionPauseScope, currentAgentActionScope } from '../core/agent-action-pause-scope';

const read = (p: string) => readFileSync(p, 'utf8');
const rows = aiInventoryComponents();
const quiet: AiAlertInput = { runs24h: { admitted: 0, failed: 0 }, principalRefusals24h: 0, spend: null, allowancesNear: 0, allowancesAt: 0, drift: [] };

describe('one AI inventory (R8)', () => {
  it('lists every owner entry exactly once per kind, with unique keys', () => {
    expect(new Set(rows.map(r => r.key)).size).toBe(rows.length);
    const ids = (kind: string) => rows.filter(r => r.kind === kind).map(r => r.id);
    expect(ids('chat')).toEqual(['hr_assistant']);
    expect(ids('read_binding')).toEqual(MODULE_JOBS.map(([m]) => m));
    expect(ids('action')).toEqual(AGENT_ACTIONS.map(a => a.id));
    expect(ids('specialist')).toEqual(AI_FEATURES.filter(f => f.kind === 'agent').map(f => f.id));
    for (const id of Object.keys(AGENT_PRINCIPAL_SPECIALISTS)) expect(ids('specialist')).toContain(id);
    expect(ids('orchestrator_step')).toEqual(['observe', 'readiness', 'claims']);
    expect(ids('scheduled_job')).toEqual(AI_SCHEDULED_JOBS.map(j => j.id));
    for (const j of AI_SCHEDULED_JOBS) if (j.jobKey) expect(JOB_KEYS as readonly string[]).toContain(j.jobKey);
    // Every gateway feature that can call a model is reachable from at least one row.
    for (const f of AI_FEATURES) expect(rows.some(r => r.featureId === f.id), f.id).toBe(true);
    expect(new Set(rows.map(r => r.kind))).toEqual(new Set(AI_COMPONENT_KINDS));
  });

  it('marks only the operator improve loop out of band', () => {
    expect(rows.filter(r => r.outOfBand).map(r => r.key)).toEqual(['operator_loop:improve']);
  });

  it('carries each action tier from the registry and a per-action pause key under hr_assistant', () => {
    for (const a of AGENT_ACTIONS) {
      const row = rows.find(r => r.key === `action:${a.id}`)!;
      expect(row.tier).toBe(a.policy.tier); expect(row.category).toBe(a.policy.category);
      expect(row.pauseKey).toBe(`hr_assistant:${a.id}`); expect(agentActionPauseKey(a)).toBe(row.pauseKey);
      expect(a.pauseKey).toBe('automatic' in a?a.automatic.specialist:'hr_assistant');
      expect(row.featureId).toBe('automatic' in a?a.automatic.specialist:'hr_assistant');
    }
  });

  it('follows the orchestrator pass order in core/hr-orchestrator.ts', () => {
    const src = read('core/hr-orchestrator.ts'), at = src.indexOf('export async function runHrOrchestrator');
    const body = src.slice(at, src.indexOf('recordTrace', at));
    const order = ['observe:', 'readiness:', 'claims:'].map(k => body.indexOf(k));
    expect(order.every(i => i > 0)).toBe(true); expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(ORCHESTRATOR_STEPS.map(s => s.id)).toEqual(['observe', 'readiness', 'claims']);
  });

  it('gives company HR a registry row with no runtime facts', () => {
    const r = registryRow(rows.find(x => x.kind === 'action')!);
    expect(Object.keys(r).sort()).toEqual(['category', 'id', 'key', 'kind', 'module', 'outOfBand', 'pauseKey', 'tier']);
  });
});

describe('alert thresholds (R20)', () => {
  it('stays quiet below the thresholds', () => {
    expect(evaluateAiAlerts(quiet)).toEqual([]);
    expect(evaluateAiAlerts({ ...quiet, runs24h: { admitted: AI_ALERT_THRESHOLDS.minRuns - 1, failed: 4 } })).toEqual([]);
    expect(evaluateAiAlerts({ ...quiet, runs24h: { admitted: 10, failed: 1 } })).toEqual([]);
    expect(evaluateAiAlerts({ ...quiet, spend: { usedNanos: BigInt(79), capNanos: BigInt(100) } })).toEqual([]);
    expect(evaluateAiAlerts({ ...quiet, spend: { usedNanos: BigInt(10 ** 12), capNanos: null } })).toEqual([]);
  });
  it('raises failure rate at 20% (warning) and 50% (critical) once five calls ran', () => {
    expect(evaluateAiAlerts({ ...quiet, runs24h: { admitted: 10, failed: 2 } })).toEqual([{ kind: 'failure_rate', level: 'warning', count: 2, detail: '20%' }]);
    expect(evaluateAiAlerts({ ...quiet, runs24h: { admitted: 10, failed: 5 } })[0]).toMatchObject({ level: 'critical', detail: '50%' });
    expect(evaluateAiAlerts({ ...quiet, runs24h: { admitted: 5, failed: 1 } })[0]).toMatchObject({ kind: 'failure_rate', level: 'warning' });
  });
  it('treats any scheduled-agent refusal as critical', () => {
    expect(evaluateAiAlerts({ ...quiet, principalRefusals24h: 1 })).toEqual([{ kind: 'principal_refusals', level: 'critical', count: 1, detail: null }]);
  });
  it('raises spend near the cap at 80% and critical at the cap, on breach or on an allowance at its limit', () => {
    expect(evaluateAiAlerts({ ...quiet, spend: { usedNanos: BigInt(80), capNanos: BigInt(100) } })).toEqual([{ kind: 'spend_near_cap', level: 'warning', count: 1, detail: null }]);
    expect(evaluateAiAlerts({ ...quiet, spend: { usedNanos: BigInt(100), capNanos: BigInt(100) } })[0]).toMatchObject({ level: 'critical' });
    expect(evaluateAiAlerts({ ...quiet, spend: { usedNanos: BigInt(0), capNanos: BigInt(0) } })[0]).toMatchObject({ level: 'critical' });
    expect(evaluateAiAlerts({ ...quiet, spendBreached: true })[0]).toMatchObject({ kind: 'spend_near_cap', level: 'critical' });
    expect(evaluateAiAlerts({ ...quiet, allowancesNear: 2 })).toEqual([{ kind: 'spend_near_cap', level: 'warning', count: 2, detail: null }]);
    expect(evaluateAiAlerts({ ...quiet, allowancesNear: 2, allowancesAt: 1 })).toEqual([{ kind: 'spend_near_cap', level: 'critical', count: 3, detail: null }]);
  });
  it('orders alerts deterministically', () => {
    const all = evaluateAiAlerts({ runs24h: { admitted: 10, failed: 9 }, principalRefusals24h: 2, spend: null, allowancesNear: 1, allowancesAt: 0, drift: [{ featureId: 'performance_pm', reason: 'stale_override' }] });
    expect(all.map(a => a.kind)).toEqual(['failure_rate', 'principal_refusals', 'spend_near_cap', 'switch_drift']);
  });
});

describe('configured-vs-effective switch drift', () => {
  const f = (over: Partial<Parameters<typeof switchDrift>[0][number]>) => ({ id: 'claims_triage', enabled: true, state: 'ready', staleOverride: null, configured: true, ...over });
  it('reports only a switch someone set that does not take effect', () => {
    expect(switchDrift([f({})])).toEqual([]);
    expect(switchDrift([f({ state: 'module' })])).toEqual([{ featureId: 'claims_triage', reason: 'module_off' }]);
    expect(switchDrift([f({ state: 'restricted' })])).toEqual([{ featureId: 'claims_triage', reason: 'platform_restricted' }]);
    // A default nobody chose is not drift, nor is a switch that is off.
    expect(switchDrift([f({ state: 'module', configured: false }), f({ enabled: false, state: 'paused' })])).toEqual([]);
  });
  it('shares one stale-override rule between the banner and the cron sweep', () => {
    expect(staleOverrideDisagrees(true, false)).toBe(true); expect(staleOverrideDisagrees(false, false)).toBe(false);
    expect(SWEEP_DRIFT_REASONS).toEqual(['stale_override']);
    const sweep = read('core/ai-alert-sweep.ts');
    expect(sweep).toContain('staleOverrideDisagrees(r.override_on===true,r.switch_on===true)');
    expect(read('lib/ai/ai-inventory.ts')).toContain('if(f.staleOverride&&staleOverrideDisagrees(f.staleOverride.enabled,f.enabled))');
  });
  it('reports a stale override that disagrees with the real switch, and an unattributed agent', () => {
    expect(switchDrift([f({ staleOverride: { enabled: false } })])).toEqual([{ featureId: 'claims_triage', reason: 'stale_override' }]);
    expect(switchDrift([f({ staleOverride: { enabled: true } })])).toEqual([]);
    expect(switchDrift([f({})], { claims_triage: { state: 'unattributed' } })).toEqual([{ featureId: 'claims_triage', reason: 'unattributed_agent' }]);
    expect(switchDrift([f({})], { claims_triage: { state: 'attributed' } })).toEqual([]);
  });
});

describe('run history range and paging', () => {
  const today = '2026-10-30';
  it('defaults to the last 30 Kuala Lumpur days, page 1', () => {
    expect(parseAiRunRange({}, today)).toEqual({ from: '2026-10-01', to: today, page: 1 });
    expect(aiRunRangeBounds({ from: '2026-10-01', to: today, page: 1 })).toEqual({ fromTs: '2026-10-01T00:00:00+08:00', toTs: '2026-10-31T00:00:00+08:00' });
  });
  it('accepts a valid range and page, and refuses malformed, future, reversed or oversized input', () => {
    expect(parseAiRunRange({ from: '2026-09-01', to: '2026-09-30', page: '3' }, today)).toEqual({ from: '2026-09-01', to: '2026-09-30', page: 3 });
    expect(aiRunPageOffset({ from: 'x', to: 'y', page: 3 })).toBe(2 * AI_RUN_PAGE_SIZE);
    expect(parseAiRunRange({ from: '2026-02-30', to: 'nope', page: '-1' }, today)).toEqual({ from: '2026-10-01', to: today, page: 1 });
    expect(parseAiRunRange({ to: '2027-01-01' }, today).to).toBe(today);
    expect(parseAiRunRange({ from: '2026-10-20', to: '2026-10-10' }, today)).toEqual({ from: '2026-09-11', to: '2026-10-10', page: 1 });
    const wide = parseAiRunRange({ from: '2020-01-01' }, today);
    expect(wide.from).toBe('2025-10-30'); expect(AI_RUN_MAX_RANGE_DAYS).toBe(366);
    expect(parseAiRunRange({ page: '1e3' }, today).page).toBe(1);
    expect(() => parseAiRunRange({}, '30/10/2026')).toThrow();
  });
});

describe('provider data register (R21)', () => {
  it('covers every gateway feature with closed field codes and a source anchor that exists', () => {
    expect(Object.keys(AI_DATA_REGISTER).sort()).toEqual(AI_FEATURES.map(f => f.id).sort());
    for (const [id, e] of Object.entries(AI_DATA_REGISTER)) {
      if(['approval_chasers','review_chasers','clock_reminders','document_reminders','lifecycle_chasers'].includes(id)){expect(e.fields,id).toEqual([]);expect(e.principalSendsNothing,id).toBe(true);expect(e.redaction,id).toBe('not_needed');expect(e.review,id).toBe('template_only');}else expect(e.contracts.length,id).toBeGreaterThan(0);
      for (const field of e.fields) expect(AI_DATA_FIELDS as readonly string[]).toContain(field);
      const first = e.anchor.split(/[ ,(]/)[0];
      expect(() => read(first), `${id} anchor ${first}`).not.toThrow();
      expect(e.images,id).toBe(false);expect(e.fields,id).not.toContain('image_attachments');
    }
  });
  it('derives outgoing categories and feature bindings from every closed descriptor, with no raw-field default',()=>{
    expect(Object.keys(WORKLOAD_DISCLOSURE_FIELDS).sort()).toEqual([...PROVIDER_WORKLOAD_CONTRACT_IDS].sort());
    for(const id of PROVIDER_WORKLOAD_CONTRACT_IDS){const descriptor=getProviderWorkloadDescriptor(id)!;for(const feature of descriptor.features){const entry=AI_DATA_REGISTER[feature];expect(entry.contracts.map(row=>row.id),id).toContain(id);expect(entry.fields,id).toContain(WORKLOAD_DISCLOSURE_FIELDS[id]);}}
    for(const feature of AI_FEATURES){const entry=AI_DATA_REGISTER[feature.id];expect(entry.fields).toEqual(providerDisclosureForFeature(feature.id).fields);for(const contract of entry.contracts)expect(contract.reviewStatus).toBe(providerDataReviewStatus(contract.id));}
    for(const field of ['question_text','scoped_hr_records','full_names','image_attachments','payroll_figures'])expect(AI_DATA_FIELDS as readonly string[]).not.toContain(field);
    expect(AI_DATA_REGISTER.hr_assistant.fields).toContain('pseudonymous_person_bands');
    expect(AI_DATA_REGISTER.performance_calib.fields).toContain('closed_references');
    expect(AI_DATA_REGISTER.performance_pm.remaining).toContain('raw_images');
  });
  it('matches actual Assistant outgoing references while the native names, dates, values and raw language stay local',()=>{
    const source:AssistantAnswerRead={read:0,presentation:{module:'leave',cards:[{title:{kind:'text',value:'PRIVATE Alice'},facts:[{field:'available',value:13.75,format:'number'},{field:'employeeCode',value:'PRIVATE-EMP-27',format:'text'},{field:'asOf',value:'2026-11-01',format:'date'}]}],truncated:false},explanations:[]};
    const payload=privateAssistantCatalogue('leave_available',[source]),captured=capturePrivateAssistantTask(payload),outgoing=JSON.stringify(captured.args);
    for(const raw of ['PRIVATE','Alice','13.75','2026-11-01','EMP-27'])expect(outgoing).not.toContain(raw);
    expect(outgoing).toContain('available');expect(AI_DATA_REGISTER.hr_assistant.fields).toContain('closed_references');
    expect(source.presentation.cards[0].facts[0].value).toBe(13.75);
    expect(()=>capturePrivateAssistantTask({...payload,question:'PRIVATE raw question'})).toThrow();
  });
  it('discloses calibration selection instead of names and refuses raw images or unknown import headings',()=>{
    const person={id:'10000000-0000-4000-8000-000000000001',name:'PRIVATE Alice'};
    const calibration=getProviderWorkloadDescriptor('performance_calibration_read_v1')!.capture({message:'explain PRIVATE Alice',axis:'performance',people:[person],units:[]});
    const outgoing=JSON.stringify(calibration.args);expect(outgoing).toContain('person');expect(outgoing).not.toContain(person.name);expect(outgoing).not.toContain(person.id);
    expect(calibration.local).toMatchObject({query:{reviewId:person.id}});
    expect(()=>getProviderWorkloadDescriptor('personnel_header_mapping_v1')!.capture({columns:[{columnIndex:0,candidates:[],heading:'PRIVATE salary'}]})).toThrow();
    expect(()=>getProviderWorkloadDescriptor('performance_narrative_selection_v1')!.capture({task:'manager_review',passages:[],images:['PRIVATE image']})).toThrow();
  });
  it('does not turn register metadata into provider admission or scheduled model permission',()=>{
    providerDisclosureForFeature('hr_assistant');
    expect(()=>assertProviderPrivacyRequest({} as ResolvedAiConfig,'conversation','a'.repeat(64),'hr_assistant')).toThrow();
    expect(AI_DATA_REGISTER.readiness_reminders.principalSendsNothing).toBe(true);expect(AI_DATA_REGISTER.claims_triage.principalSendsNothing).toBe(true);
  });
});

describe('six-locale copy', () => {
  const locales = ['en', 'ms', 'zh', 'vi', 'th', 'ta'];
  it('translates every kind, tier, field, redaction, alert, job and step in each locale', () => {
    for (const locale of locales) {
      const m = JSON.parse(read(`messages/${locale}.json`)), inv = m.aiManagement.inv;
      expect(typeof m.nav.aiManagementInventory, locale).toBe('string');
      for (const k of AI_COMPONENT_KINDS) expect(inv.kinds[k], `${locale} ${k}`).toBeTruthy();
      for (const k of ['automatic', 'confirm', 'approve', 'handoff']) expect(inv.tiers[k]).toBeTruthy();
      for (const k of AI_DATA_FIELDS) expect(inv.register.fields[k], `${locale} ${k}`).toBeTruthy();
      for (const k of ['protected_contract','not_needed']) expect(inv.register.redaction[k]).toBeTruthy();
      for(const k of ['approved','pending','unsupported','template_only'])expect(inv.register.review[k],`${locale} ${k}`).toBeTruthy();
      for (const k of ['failure_rate', 'principal_refusals', 'spend_near_cap', 'switch_drift']) expect(inv.alerts[k]).toContain('{count}');
      for (const k of ['help', 'unavailable']) expect(inv.alerts[k], `${locale} alerts.${k}`).toBeTruthy();
      expect(inv.pausedTitle).toBeTruthy();
      expect(m.scheduledActions.jobs['ai-alerts'].name).toBeTruthy();
      for (const j of AI_SCHEDULED_JOBS) expect(inv.jobs[j.id.replace('.', '-')]).toBeTruthy();
      for (const s of ORCHESTRATOR_STEPS) expect(inv.steps[s.id]).toBeTruthy();
      if (locale !== 'en') expect(inv.title).not.toBe(JSON.parse(read('messages/en.json')).aiManagement.inv.title);
    }
  });
});

describe('static wiring', () => {
  it('scopes Assistant review commands to their registry action and checks the action pause after the module pause', async () => {
    expect(read('core/assistant-actions/module-action-server.ts')).toContain('{publicOrigin,scope:moduleActionPauseScope}');
    expect(read('core/assistant-actions/own-leave-runtime.ts')).toContain("withAgentActionPauseScope('leave.apply'");
    const gov = read('core/ai-governance.ts'), at = gov.indexOf('export async function assertAiActionUnpausedTx');
    const body = gov.slice(at, gov.indexOf('\n}\n', at));
    expect(body.indexOf('app.ai_action_unpaused')).toBeLessThan(body.indexOf('assertAgentActionUnpausedTx'));
    expect(currentAgentActionScope()).toBeUndefined();
    await withAgentActionPauseScope('leave.cancel', async () => { expect(currentAgentActionScope()).toEqual({ action: 'leave.cancel' }); });
    await withAgentActionPauseScope(null, async () => { expect(currentAgentActionScope()).toEqual({ action: null }); });
    expect(currentAgentActionScope()).toBeUndefined();
    // A review-route packet that names no registry action still runs in a (fail-closed) scope.
    expect(read('core/assistant-actions/module-action-server.ts')).toContain('withAgentActionPauseScope(isAgentActionId(actionId)?actionId:null,work)');
    expect(body).toContain("if(route&&route.action===null)throw new AiAllowanceError('paused');");
    await expect(withAgentActionPauseScope('no.such_action', async () => 1)).rejects.toThrow('Unknown agent action');
  });
  it('appends mapped migration 0816 with grants, RLS and a definer-only writer', () => {
    const journal = JSON.parse(read('db/migrations/meta/_journal.json')).entries;
    const position=journal.findIndex((entry:{tag:string})=>entry.tag==='0816_ai_agent_action_pause'),last=journal[position];
    expect(position).toBeGreaterThan(journal.findIndex((entry:{tag:string})=>entry.tag==='0813_assistant_action_kind'));
    expect(last).toMatchObject({ idx: 702, when: 1793330000216, tag: '0816_ai_agent_action_pause' });
    expect(journal.filter((entry:{tag:string})=>entry.tag==='0816_ai_agent_action_pause')).toHaveLength(1);
    const src = read('db/migrations/0816_ai_agent_action_pause.sql');
    expect(src).toContain('ALTER TABLE app.ai_agent_action_pause ENABLE ROW LEVEL SECURITY;');
    expect(src).toContain('REVOKE ALL ON app.ai_agent_action_pause FROM PUBLIC,ai_hr_app;');
    expect(src).toContain('GRANT SELECT ON app.ai_agent_action_pause TO ai_hr_app;');
    expect(src).not.toMatch(/GRANT (INSERT|UPDATE|DELETE)[^;]*ai_agent_action_pause/);
    expect(src).toContain("IF app.principal_snapshot_current() IS NOT TRUE THEN RAISE EXCEPTION");
    expect(src.indexOf('app.principal_snapshot_current() IS NOT TRUE')).toBeLessThan(src.indexOf("IF app.is_group_admin() IS NOT TRUE THEN RAISE EXCEPTION"));
    // Full rows for group administrators only; everyone else gets (action_id, paused) through the narrow definer.
    expect(src).toContain('USING(tenant_id=app.current_tenant_id() AND app.is_group_admin());');
    expect(src).toContain('RETURNS TABLE(action_id text,paused boolean)');
    expect(src).toContain('GRANT EXECUTE ON FUNCTION app.ai_agent_action_pauses() TO ai_hr_app;');
    expect(src).toContain("PERFORM pg_advisory_xact_lock(hashtext('ai-control'),hashtext(tid::text));");
    expect(src).toContain('REFERENCES app.assistant_action_kind(id)');
  });
  it('lists the inventory page in the permission registry and first in the AI management menu', () => {
    expect(read('lib/permissions.ts')).toContain("'/control-tower/agents/inventory'");
    expect(read('app/control-tower/agents/inventory/page.tsx')).toContain('requireAdmin');
    const sidebar = read('components/sidebar.tsx'), node = sidebar.slice(sidebar.indexOf('const AI_MANAGEMENT_NODE'));
    expect(node.indexOf('/control-tower/agents/inventory')).toBeLessThan(node.indexOf("'/control-tower/agents', labelKey"));
  });
});
