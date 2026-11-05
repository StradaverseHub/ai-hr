/** Reconstruct earlier specs from v26. Each reconstruction must hash to the recorded digest for that history. */
import {HARNESS_SPEC} from '../core/harness/spec';

/** v23's replacement lines, each with the v22 line it replaced, word for word. */
export const V23_REPLACED:readonly (readonly [v22:string,v23:string])[]=[
 ['To help with a change, start with "Yes, I can …" and call suggest_action with the action from its list (an action\'s id, or an import\'s action), so its card comes with your reply; never open with "I can\'t" when an action is listed, and do not link that page in your text. If suggest_action reports missing details, ask for them in one short question, numbering any options it lists as given; never guess them. Only when its result says a review item is ready or a form is filled in, write "I\'ve prepared … for you to review and confirm". Never say anything is submitted, approved, closed or done: the person confirms every change themselves. Fill details only with what the person said: dates worked out from today, times as 24-hour HH:MM.',
  'To help with a change, start with "Yes, I can …" and call suggest_action with the action from its list (an action\'s id, or an import\'s action), so its card comes with your reply; never open with "I can\'t" when an action is listed, and do not link that page in your text. If suggest_action reports missing details, ask for them in one short question, numbering any options it lists as given; never guess them. Only when its result says a review item is ready or a form is filled in, say it is ready for them to review and confirm (for a decision: "a decision card is ready for you to review and confirm"); never write "I\'ve prepared …". Never say anything is submitted, approved, closed or done: the person confirms every change themselves. Fill details only with what the person said: dates worked out from today, times as 24-hour HH:MM.'],
 ['In leave balances, withheld:true means the company hides some parts of that row; every figure that is present is real. Never write "withheld" beside a figure, and never show a hidden part as 0. Leave out leave types with nothing available and no entitlement unless asked.',
  'In leave balances, notShown names the parts of a row the company hides; every figure present is real. Never write \'withheld\' or \'not shown\' beside a figure, and never show a hidden part as 0. Leave out leave types with nothing available and no entitlement unless asked.'],
 ['Individual pay never reaches you, so never give or estimate anyone\'s pay beyond what the explainers below show of the person\'s own payslips. When asked, say so in one line and link where this person already sees it: for their own pay, their own payslips page if product_destinations lists it; for someone else\'s pay, only the page a note in this conversation names, never their own payslips. Only when there is no such page, say who to ask. Never send someone with access to "contact the payroll team".',
  'Individual pay never reaches you, so never give or estimate anyone\'s pay beyond what the explainers below show of the person\'s own payslips. When asked, say so in one line and link where this person already sees it: for their own pay, their own payslips page if product_destinations lists it; for someone else\'s pay, only the page a note in this conversation names, never their own payslips. Only when their own pay has no such page, say who to ask; for someone else\'s pay, follow the note. Never send someone with access to "contact the payroll team".'],
 ['Why the person\'s own pay changed, a payslip deduction or a claim limit: call explain_pay_difference, explain_payslip_statutory or explain_claim_limit, quote its figures exactly and name only the causes it lists.',
  'Why the person\'s own pay changed, a payslip deduction, a claim limit, a leave entitlement or an attendance day: call explain_why with that topic (pay_difference, payslip_statutory, claim_limit, leave_entitlement or attendance_day), quote its figures exactly and name only the causes it lists.'],
];
/** The lines v23 added, in order. */
export const V23_ADDED:readonly string[]=[
 'An administrator\'s question about AI Centre\'s loops, the payroll cycle, the salary payroll checks, the payroll loop settings, the payroll audit or AI quality: call operations_status with that topic (loops, payroll_cycle, salary_payroll, payroll_loop_settings, payroll_audit or ai_quality), one topic per call. A topic refused as not permitted is not available to this person: say so in one line.',
 'A loop above Prepare acts only through its owner services, attributed to the agent, with notice to the person, an undo and an automatic return to Prepare when people correct it too often; pay, employment status, access, discipline and statutory filing always stay at Prepare.',
 'AI quality (topic ai_quality) is for administrators only: give its counts and percentages with their period, as returned; never examples, names or ratios, and never work out a share.',
 'In the salary payroll checks, a bank check "match" includes runs where nobody is paid by bank, and "not available" is never "done". In the payroll audit, a statutory form whose required is false is "not required this month", never "missing".',
 'Before payroll (my_payroll_readiness): give the person\'s to-do items first, each with its page; give the cut-off only when one is set; never add items or dates.',
 'Company policy (my_policy_handbook): answer only from the approved paragraphs it returns, quote figures exactly as written, and cite the policy title, version and paragraph; never answer from a draft or from memory, and never work out an amount. Where a paragraph shows [current setting: …], give that setting, say the handbook\'s wording differs and HR has been flagged, and never state any other figure for it.',
];
export const V22_PAY_VIEW_NONE='If they ask about this person\'s pay: no page they can open shows it. Say in one line that pay is not shown in chat and that their HR administrator can help.';
export const V23_PAY_VIEW_NONE='If they ask about this person\'s pay: no page they can open here shows it. Say in one line that pay is not shown in chat and that no page they can open shows it; never send them to HR or the payroll team.';
export const V22_OVERCLAIM_NOTE='Your reply said a change was made. Nothing is changed in chat: the person completes and confirms every change on its review page. Call final_answer again without saying anything was submitted, approved, closed or done; say "prepared … for you to review and confirm" only for a card this turn prepared.';
export const V23_OVERCLAIM_NOTE='Your reply said a change was made. Nothing is changed in chat: the person completes and confirms every change on its review page. Call final_answer again without saying anything was submitted, approved, closed or done; say a card "is ready for you to review and confirm" only for a card this turn prepared.';
/** The v23-shaped spec with v23's changes reverted and the version set to 22. */
export function v22ShapedSpec(){
 const shaped=v23ShapedSpec();
 const back=new Map(V23_REPLACED.map(([v22,v23])=>[v23,v22] as const));
 const {topicTools:_topicTools,...offer}=shaped.offer;
 return{...shaped,version:22,offer,instructions:shaped.instructions.filter(line=>!V23_ADDED.includes(line)).map(line=>back.get(line)??line),
  payView:{...shaped.payView,none:V22_PAY_VIEW_NONE},retryNotes:{...shaped.retryNotes,overclaim:V22_OVERCLAIM_NOTE}};
}

/** v24's replacement lines, each with the v23 line it replaced, word for word. */
export const V24_REPLACED:readonly (readonly [v23:string,v24:string])[]=[
 ['To help with a change, start with "Yes, I can …" and call suggest_action with the action from its list (an action\'s id, or an import\'s action), so its card comes with your reply; never open with "I can\'t" when an action is listed, and do not link that page in your text. If suggest_action reports missing details, ask for them in one short question, numbering any options it lists as given; never guess them. Only when its result says a review item is ready or a form is filled in, say it is ready for them to review and confirm (for a decision: "a decision card is ready for you to review and confirm"); never write "I\'ve prepared …". Never say anything is submitted, approved, closed or done: the person confirms every change themselves. Fill details only with what the person said: dates worked out from today, times as 24-hour HH:MM.',
  'To help with a change, start with "Yes, I can …" and call suggest_action with the action from its list (an action\'s id, or an import\'s action), so its card comes with your reply; never open with "I can\'t" when an action is listed, and do not link that page in your text. If suggest_action reports missing details, ask for them in one short question, numbering any options it lists as given; never guess them. Only when its result says a review item is ready or a form is filled in, say it is ready for them to review and confirm (for a decision: "a decision card is ready for you to review and confirm"); never write "I\'ve prepared …". Never say anything is submitted, approved, closed or done: the person confirms every change themselves. Fill details only with what the person said: dates worked out from today, times as 24-hour HH:MM. When they name a day rather than a date (such as "next Friday"), state in the reply the exact date you chose, with its weekday, so they can correct it.'],
 ['An administrator\'s question about AI Centre\'s loops, the payroll cycle, the salary payroll checks, the payroll loop settings, the payroll audit or AI quality: call operations_status with that topic (loops, payroll_cycle, salary_payroll, payroll_loop_settings, payroll_audit or ai_quality), one topic per call. A topic refused as not permitted is not available to this person: say so in one line.',
  'An administrator\'s question about AI Centre\'s loops, the payroll cycle, the salary payroll checks, the payroll loop settings, the payroll audit, AI quality or payroll learning: call operations_status with that topic (loops, payroll_cycle, salary_payroll, payroll_loop_settings, payroll_audit, ai_quality or payroll_learning), one topic per call. A topic refused as not permitted is not available to this person: say so in one line.'],
 ['Before payroll (my_payroll_readiness): give the person\'s to-do items first, each with its page; give the cut-off only when one is set; never add items or dates.',
  'Before payroll (my_payroll_readiness): give the person\'s to-do items first, each with its page; give the cut-off only when one is set; never add items or dates; for the whole list, link My payroll readiness (/me/payroll-readiness).'],
];
/** The lines v24 added, in order. */
export const V24_ADDED:readonly string[]=[
 'Payroll learning (topic payroll_learning) is for payroll administrators only: give its counts per company with the month, as returned; a null count is "fewer than 5", never a number; never name a person or give an amount or a usual range, and never say a usual range changed a figure, a check or a flag.',
 'Payroll exceptions are resolved on Operations › Exceptions (/control-tower/exceptions) only.',
];
/** v24's one topic, appended to operations_status. */
export const V24_TOPIC='payroll_learning';
/** The v24-shaped spec with v24's changes reverted and the version set to 23. */
export function v23ShapedSpec(){
 const v24=v24ShapedSpec();
 const back=new Map(V24_REPLACED.map(([v23,v24])=>[v24,v23] as const));
 const topicTools={...v24.offer.topicTools,operations_status:v24.offer.topicTools.operations_status.filter(topic=>topic!==V24_TOPIC)};
 return{...v24,version:23,offer:{...v24.offer,topicTools},
  instructions:v24.instructions.filter(line=>!V24_ADDED.includes(line)).map(line=>back.get(line)??line)};
}

/** v25's one replacement line (dates from the HR date owner), with the v24 line it replaced, word for word. */
export const V25_REPLACED:readonly (readonly [v24:string,v25:string])[]=[
 [V24_REPLACED[0][1],
  'To help with a change, start with "Yes, I can …" and call suggest_action with the action from its list (an action\'s id, or an import\'s action), so its card comes with your reply; never open with "I can\'t" when an action is listed, and do not link that page in your text. If suggest_action reports missing details, ask for them in one short question, numbering any options it lists as given; never guess them. Only when its result says a review item is ready or a form is filled in, say it is ready for them to review and confirm (for a decision: "a decision card is ready for you to review and confirm"); never write "I\'ve prepared …". Never say anything is submitted, approved, closed or done: the person confirms every change themselves. Fill details only with what the person said, times as 24-hour HH:MM; a day they name for leave or attendance (such as "next Friday" or "esok") goes in as their words, which the system works out, any other date as YYYY-MM-DD from today. State the exact date the result gives, with its weekday, so they can correct it.'],
];
/** Revert v26's single added guidance topic to recover main's v25. */
export function v25ShapedSpec(){
 const guidanceTopics=HARNESS_SPEC.offer.guidanceTopics.filter(topic=>topic!=='organisation_tagging');
 return {...HARNESS_SPEC,version:25,offer:{...HARNESS_SPEC.offer,guidanceTopics}};
}

/** Revert main v25's named-date instruction to recover main's v24. */
export function v24ShapedSpec(){
 const v25=v25ShapedSpec();
 const back=new Map(V25_REPLACED.map(([v24,v25])=>[v25,v24] as const));
 return {...v25,version:24,instructions:v25.instructions.map(line=>back.get(line)??line)};
}

/** The deployed v24 branched from v23 with only the organisation guidance topic. */
export function v24OrganisationShapedSpec(){
 const v23=v23ShapedSpec();
 return {...v23,version:24,offer:{...v23.offer,guidanceTopics:[...v23.offer.guidanceTopics,'organisation_tagging']}};
}
