import {readFileSync} from 'node:fs';
import {AI_CENTRE_OPERATIONS} from '../lib/ai/centre-operations';
import {describe,expect,it} from 'vitest';
import {aiCentreFunctions,aiCentreReadKeys} from '../core/ai-centre-inventory';
import {AI_FEATURES} from '../lib/ai/features';
import {AGENT_ACTIONS} from '../lib/ai/agent-action-registry';
import {registeredWorkers} from '../core/agent-registry/workers';
import {SEMANTIC_READS} from '../core/semantic-model/entities';
import {TERAS_READS} from '../core/semantic-model/generate';
import {ASSISTANT_TOOL_CATALOGUE} from '../lib/ai/assistant-tool-catalogue';

describe('complete AI centre function inventory',()=>{
 it('covers features, actions, workers and every declared read with unique stable keys',()=>{
  const rows=aiCentreFunctions(),keys=new Set(rows.map(row=>row.key));
  expect(keys.size).toBe(rows.length);
  for(const feature of AI_FEATURES)expect(keys.has('feature:'+feature.id),feature.id).toBe(true);
  for(const worker of registeredWorkers())expect(keys.has('worker:'+worker.id),worker.id).toBe(true);
  for(const action of AGENT_ACTIONS)expect(keys.has('action:'+action.id),action.id).toBe(true);
  for(const read of [...SEMANTIC_READS,...TERAS_READS,...ASSISTANT_TOOL_CATALOGUE])expect(keys.has('read:'+read.name),read.name).toBe(true);
  for(const row of rows)expect(row.href).toBeTruthy();
 });
 it('binds every standalone draft or analysis operation to its declared child control',()=>{
  for(const operation of AI_CENTRE_OPERATIONS){
   expect(aiCentreReadKeys()).toContain('read:operation_'+operation.id);
   expect(readFileSync(operation.owner.split('#')[0],'utf8')).toContain("'read:operation_"+operation.id+"'");
  }
 });
 it('provides separate controls for all five explanation topics and preserves required services',()=>{
  const keys=aiCentreReadKeys();
  for(const name of ['explain_pay_difference','explain_payslip_statutory','explain_claim_limit','explain_leave_entitlement','explain_attendance_day'])expect(keys).toContain('read:'+name);
  for(const id of ['audit','privacy','validation'])expect(aiCentreFunctions().find(row=>row.key==='system:'+id)?.control).toBe('required');
  expect(keys).not.toContain('system:validation');
 });
});
