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
  // Spec v13/v14 (AI v2 W1): drawn from product_capabilities' areas for this person, naming nothing it does not list.
  expect(instructions).toMatch(/When asked what you can help with, call product_capabilities with no filter and answer with four to six short bullets from its areas, then one example question\. Never name anything it does not list\./);
  expect(instructions).not.toMatch(/short plain reply/);
  // Owner, 3 November 2026: ask rather than guess, and offer to do it rather than point at a page. Spec v13: the options
  // are the catalogue's entries for this person, numbered by title.
  expect(instructions).toMatch(/a request that could mean several things this person can do \(such as "help me import data"\), call product_capabilities/);
  // Spec v14 and v15: at most five numbered, the most common first, then "Something else"; one entry named is acted on without asking.
  expect(instructions).toMatch(/If several fit, start with "Yes, I can …" and ask one short question numbering at most five, as listed \(most common first\), then "Something else"; never guess\./);
  // Spec v11: "Yes, I can …" when an action is listed; the card carries the page (test/teras-harness-v11.test.ts).
  expect(instructions).toMatch(/start with "Yes, I can …" and call suggest_action with the action from its list \(an action's id, or an import's action\), so its card comes with your reply; never open with "I can't" when an action is listed, and do not link that page in your text/);
  expect(instructions).toMatch(/anything else is not available to them here\./);
  expect(instructions).toMatch(/If a capability is not available, say so in one line/);
  // Issue 13: a pay refusal links where this person can already see pay, and sends only those without access elsewhere.
  expect(instructions).toMatch(/Individual pay never reaches you, so never give or estimate anyone's pay/);
  // Spec v11: someone else's pay links only the page the harness names for this caller, never their own payslips.
  expect(instructions).toMatch(/for their own pay, their own payslips page if product_destinations lists it; for someone else's pay, only the page a note in this conversation names, never their own payslips/);
  expect(instructions).toMatch(/Never send someone with access to "contact the payroll team"/);
  // Issue 18: "Medical Leave: 0 (withheld)" misread the ESS flag; a hidden part is never shown as 0.
  expect(instructions).toMatch(/withheld:true means the company hides some parts of that row; every figure that is present is real/);
  expect(instructions).toMatch(/never show a hidden part as 0/);
  // Spec v10, issue 10: a leave application with a missing or unclear detail is one numbered question, never a guess.
  expect(instructions).toMatch(/If suggest_action reports missing details, ask for them in one short question, numbering any options it lists as given; never guess them\./);
  expect(HARNESS_SPEC.version).toBeGreaterThanOrEqual(10);
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
