/** Spec v9 reply style (owner, staging acceptance 3 November 2026: "too wordy ... bullet points, numbering"): the model
 * is asked for a short structured Markdown reply, and that markup never gets past the reply checks. Pure. */
import {describe,expect,it} from 'vitest';
import {HARNESS_SPEC} from '../core/harness/spec';
import {checkReply} from '../core/harness/reply-checks';

const instructions=HARNESS_SPEC.instructions.join(' ');
const allowed=new Set(['/admin/personnel','/admin/payroll/settings','/leave']);
const failed=(reply:string)=>checkReply(reply,allowed,HARNESS_SPEC.replyChecks.order,{question:'What is wrong with payroll?'}).filter(result=>!result.ok).map(result=>result.check);

describe('reply style (spec v9)',()=>{
 it('asks for a direct first sentence, short bullets or numbered steps, bold only for the key term, and pages as links',()=>{
  expect(instructions).toMatch(/one short direct sentence first/);
  expect(instructions).toMatch(/"-" bullets \(at most about five\)/);
  expect(instructions).toMatch(/"1\." numbered steps/);
  expect(instructions).toMatch(/Bold only the key figure or term/);
  expect(instructions).toMatch(/\[Page name\]\(path\), using only paths product_destinations returns/);
  expect(instructions).toMatch(/four to six short bullets of what you can do for this person in their role, then one example question/);
  expect(instructions).not.toMatch(/short plain reply/);
 });
 it('passes a structured reply that links only to this person\'s destinations',()=>{
  const reply='Payroll for November is **not ready**.\n\n- **Blocking:** 8 records flagged → [Personnel](/admin/personnel)\n- **Warning:** no pay day set → [Payroll settings](/admin/payroll/settings)\n\n1. Fix the records.\n2. Set the pay day.';
  expect(failed(reply)).toEqual([]);
 });
 it('still refuses an invented page, a web address, an identifier or Feedback inside list or bold markup',()=>{
  expect(failed('- Open [Secret page](/admin/secret-page)')).toContain('destination_links');
  expect(failed('1. Go to [Help](https://evil.example)')).toContain('destination_links');
  expect(failed('- **IC:** 900101-14-5678')).toContain('identifiers');
  expect(failed('- Report it on **Feedback** → [Feedback](/feedback)')).toEqual(expect.arrayContaining(['workplace_channel']));
 });
});
