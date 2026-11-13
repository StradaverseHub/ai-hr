/** Spec v30 (96a54ed2, owner decision of 12 November 2026) — operations_status gains two topics, attendance_on_behalf_subjects
 * and attendance_on_behalf_approvers, the Request On Behalf and Approve On Behalf pages under Attendance. Nothing else
 * changes: no instruction line (each topic's own generated description says what the read returns), no new tool, and every
 * earlier digest is kept. Neither topic is an action: filing and deciding on behalf stay human-only. */
import {describe,expect,it} from 'vitest';
import {HARNESS_SPEC,HARNESS_SPEC_DIGESTS,harnessSpecDigest} from '../core/harness/spec';
import {FOLDED_READS,TOPIC_TOOLS,topicRead,topicToolSpec} from '../core/semantic-model/topic-tools';
import {TERAS_CAPABILITIES} from '../core/explainers/capabilities';
import {KIT_CAPABILITIES} from '../core/improvement/kit-registry';
import {terasEntity,terasToolSpecs} from '../core/semantic-model/generate';
import {LINKABLE_PAGES} from '../lib/product-context/destinations';
import {V30_TOPICS,v29ShapedSpec} from './harness-spec-shapes';

const PAGES={attendance_on_behalf_subjects:'/attendance/on-behalf/request',attendance_on_behalf_approvers:'/attendance/on-behalf/approve'} as const;
const ENTITIES={attendance_on_behalf_subjects:'attendance_on_behalf_subject',attendance_on_behalf_approvers:'attendance_on_behalf_approver'} as const;

describe('spec v30',()=>{
 it('is v29 with two operations_status topics appended, and keeps every earlier digest',()=>{
  const v29=v29ShapedSpec();
  expect(harnessSpecDigest(v29)).toBe(HARNESS_SPEC_DIGESTS[29]);
  expect(HARNESS_SPEC_DIGESTS[29]).toBe('e5108db742b9e4fcc58f0a341477390f3f2fd977f4f686cebf31e068ee8fc13c');
  expect(HARNESS_SPEC.version).toBe(30);expect(harnessSpecDigest()).toBe(HARNESS_SPEC_DIGESTS[30]);
  expect(HARNESS_SPEC).toEqual({...v29,version:30,offer:{...v29.offer,topicTools:{...v29.offer.topicTools,
   operations_status:[...v29.offer.topicTools.operations_status,...V30_TOPICS]}}});
  expect(HARNESS_SPEC.instructions).toEqual(v29.instructions);
  expect(Object.keys(HARNESS_SPEC_DIGESTS).map(Number).at(-1)).toBe(30);
 });
 it('binds each topic to its own read, a managers\' and administrators\' attendance read with its kit entry and its page',()=>{
  const operations=TOPIC_TOOLS.find(tool=>tool.name==='operations_status')!;
  expect(operations.topics.slice(-2)).toEqual(V30_TOPICS.map(topic=>({topic,read:topic})));
  for(const topic of V30_TOPICS){
   expect(topicRead('operations_status',topic)?.name).toBe(topic);
   expect(FOLDED_READS.get(topic)).toEqual({tool:'operations_status',topic});
   expect(TERAS_CAPABILITIES.find(row=>row.name===topic)).toMatchObject({admin:false,access:'team',module:'attendance',worker:null});
   expect(KIT_CAPABILITIES.find(row=>row.read.name===topic)?.binding).toMatchObject({admin:false,access:'team',module:'attendance',owner:'core/attendance-on-behalf.ts#searchAttendanceOnBehalfSubjects'});
   const page=terasEntity(ENTITIES[topic]).page;
   expect(page).toBe(PAGES[topic]);
   expect(LINKABLE_PAGES.find(([path])=>path===page)?.[2]).toBe('attendance');
   // Its own description, word for word, under its topic; the read itself is never a tool of its own.
   const own=terasToolSpecs().find(spec=>spec.name===topic)!;
   expect(topicToolSpec('operations_status')!.description).toContain(`[${topic}] ${own.description}`);
   expect(own.description).toMatch(/Read only: .* never here\./);
  }
 });
});
