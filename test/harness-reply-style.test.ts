/** Spec v9 reply style (owner, staging acceptance 3 November 2026: "too wordy ... bullet points, numbering"): the model
 * is asked for a short structured Markdown reply, and that markup never gets past the reply checks. Pure. */
import {describe,expect,it} from 'vitest';
import {HARNESS_SPEC} from '../core/harness/spec';
import {checkReply} from '../core/harness/reply-checks';
import type {SessionContext} from '../db/client';
import {destinationsFor} from '../lib/product-context/destinations';

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
  // Owner, 3 November 2026: ask rather than guess, and offer to do it rather than point at a page.
  expect(instructions).toMatch(/could mean more than one action, ask one short question with a numbered list of the matching options available_actions returns/);
  expect(instructions).toMatch(/start with "Yes, I can …" and offer the choice: you prepare it here with them, or they open the page themselves\. Do not link that page in your text/);
  expect(instructions).toMatch(/When you cannot do it, say so in one line/);
  // Issue 13: a pay refusal links where this person can already see pay, and sends only those without access elsewhere.
  expect(instructions).toMatch(/Individual pay never reaches you, so never give or estimate anyone's pay/);
  expect(instructions).toMatch(/if product_destinations lists a payroll page this person can open, link it/);
  expect(instructions).toMatch(/Never send someone with access to "contact the payroll team"/);
  // Issue 18: "Medical Leave: 0 (withheld)" misread the ESS flag; a hidden part is never shown as 0.
  expect(instructions).toMatch(/withheld:true means the company hides some parts of that row; every figure that is present is real/);
  expect(instructions).toMatch(/never show a hidden part as 0/);
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
 it('gives a payroll administrator a payroll page to link and an employee none, so the refusal can follow the rule',()=>{
  const base={tenantId:'00000000-0000-4000-8000-000000000001',userId:'00000000-0000-4000-8000-000000000002'};
  const admin=destinationsFor({...base,roles:['hr_admin']} as SessionContext,['payroll']).map(row=>row.href);
  const employee=destinationsFor({...base,roles:['employee']} as SessionContext,['payroll']).map(row=>row.href);
  expect(admin.some(href=>href.startsWith('/payroll'))).toBe(true);
  expect(employee.some(href=>href.startsWith('/payroll'))).toBe(false);
  // Neither list carries a figure: the model has nothing to quote.
  expect(JSON.stringify([admin,employee])).not.toMatch(/\d{3,}/);
 });
});
