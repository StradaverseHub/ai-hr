/** Spec v29 (50d9b809, owner decision of 10 November 2026) — operations_status gains one topic, shared_leave_groups, the
 * Shared Leave Groups page under Leave Settings. Nothing else changes: no instruction line (the topic's own generated
 * description says what the read returns), no new tool, and every earlier digest is kept. */
import {describe,expect,it} from 'vitest';
import {HARNESS_SPEC,HARNESS_SPEC_DIGESTS,harnessSpecDigest} from '../core/harness/spec';
import {FOLDED_READS,TOPIC_TOOLS,topicRead,topicToolSpec} from '../core/semantic-model/topic-tools';
import {TERAS_CAPABILITIES} from '../core/explainers/capabilities';
import {KIT_CAPABILITIES} from '../core/improvement/kit-registry';
import {terasEntity,terasToolSpecs} from '../core/semantic-model/generate';
import {LINKABLE_PAGES} from '../lib/product-context/destinations';
import {V29_TOPIC,v28ShapedSpec} from './harness-spec-shapes';

describe('spec v29',()=>{
 it('is v28 with one operations_status topic appended, and keeps every earlier digest',()=>{
  const v28=v28ShapedSpec();
  expect(harnessSpecDigest(v28)).toBe(HARNESS_SPEC_DIGESTS[28]);
  expect(HARNESS_SPEC_DIGESTS[28]).toBe('8201900d74c1c75410f36439f671ba498f671c5ad647a746b6b3917a7c825cd0');
  expect(HARNESS_SPEC.version).toBe(29);expect(harnessSpecDigest()).toBe(HARNESS_SPEC_DIGESTS[29]);
  expect(HARNESS_SPEC).toEqual({...v28,version:29,offer:{...v28.offer,topicTools:{...v28.offer.topicTools,
   operations_status:[...v28.offer.topicTools.operations_status,V29_TOPIC]}}});
  // No instruction line was added or changed.
  expect(HARNESS_SPEC.instructions).toEqual(v28.instructions);
  expect(Object.keys(HARNESS_SPEC_DIGESTS).map(Number).at(-1)).toBe(29);
 });
 it('binds the topic to shared_leave_groups only: an administrators\' leave read with its kit entry and its page',()=>{
  const operations=TOPIC_TOOLS.find(tool=>tool.name==='operations_status')!;
  expect(operations.topics.at(-1)).toEqual({topic:'shared_leave_groups',read:'shared_leave_groups'});
  expect(topicRead('operations_status','shared_leave_groups')?.name).toBe('shared_leave_groups');
  expect(FOLDED_READS.get('shared_leave_groups')).toEqual({tool:'operations_status',topic:'shared_leave_groups'});
  expect(TERAS_CAPABILITIES.find(row=>row.name==='shared_leave_groups')).toMatchObject({admin:true,module:'leave',worker:null});
  expect(KIT_CAPABILITIES.some(row=>row.read.name==='shared_leave_groups')).toBe(true);
  const page=terasEntity('shared_leave_group').page;
  expect(page).toBe('/admin/leave-config/shared-groups');
  expect(LINKABLE_PAGES.find(([path])=>path===page)?.[1]).toBe('admin');
  // Its own description, word for word, under its topic; the read itself is never a tool of its own.
  const own=terasToolSpecs().find(spec=>spec.name==='shared_leave_groups')!;
  expect(topicToolSpec('operations_status')!.description).toContain(`[shared_leave_groups] ${own.description}`);
  expect(own.description).toMatch(/^Administrators only: the shared leave groups/);
  expect(own.description).toContain('never an employee, a balance or a leave request');
 });
});
