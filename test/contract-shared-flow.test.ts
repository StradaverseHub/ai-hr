import {describe, expect, it} from 'vitest';
import {approveContractFlowPosting, confirmContractFlowPay, contractFlowDisplay, contractPostingKindMatches, newContractFlow, recordContractFlowDecline, rejectContractFlowDecision, submitContractFlowDecision, validateContractFlowDecision, validateContractFlowSettings, DEFAULT_CONTRACT_FLOW_SETTINGS, type ContractFlow, type ContractFlowActor, type ContractFlowDecisionDraft} from '../lib/contract-case-flow';
const at = '2026-11-16T02:00:00Z';
const actor: ContractFlowActor = {userId: 'manager', permissions: ['view', 'decide'], postingApprover: false, admin: false};
const approver: ContractFlowActor = {...actor, userId: 'peopleops', postingApprover: true};
const draft: ContractFlowDecisionDraft = {kind: 'renew', months: 12, payChanges: true, basicSalary: '7200.05', reason: 'Continue project'};
const fresh = () => newContractFlow({id: 'period1', startOn: '2026-01-01', endOn: '2026-12-31', number: 'CT-108-02', sourceRevision: 'source1'}, at);
const submitted = (changes: Partial<ContractFlowDecisionDraft> = {}) => submitContractFlowDecision(fresh(), {actor, expectedRevision: 1, draft: {...draft, ...changes}, at, preflightProblems: []});
const posting = (changes: Partial<ContractFlowDecisionDraft> = {}): ContractFlow => ({...submitted(changes), stage: 'posting', posting: {id: 'posting1', approvedBy: null, approvedAt: null}});
describe('Contract shared decision ownership', () => {
  it('keeps cents exact and supports date overrides rather than silently overwriting them', () => {
    expect(submitted().decision).toMatchObject({kind: 'renew', startOn: '2027-01-01', endOn: '2027-12-31', salaryCents: '720005', months: 12});
    expect(submitted({startOn: '2027-02-01', endOn: '2027-07-31', months: 12}).decision).toMatchObject({startOn: '2027-02-01', endOn: '2027-07-31', months: null});
    expect(() => submitted({basicSalary: '7200.001'})).toThrow();
    expect(() => submitted({startOn: '2026-12-31'})).toThrow('after');
    expect(() => submitted({endOn: '2027-03-30'})).toThrow('3 months');
  });
  it('supports permanent conversion without a contract end, term or probation', () => {
    const converted = submitted({kind: 'convert', startOn: '2027-01-01', payChanges: false});
    expect(converted.decision).toMatchObject({kind: 'convert', endOn: null, months: null, salaryCents: null});
    expect(converted).not.toHaveProperty('probation');
    expect(contractPostingKindMatches(converted, 'Conversion to permanent')).toBe(true);
    expect(contractPostingKindMatches(converted, 'Renewal')).toBe(false);
  });
  it('requires an ending reason and never treats an End decision as a renewal posting', () => {
    expect(() => submitted({kind: 'end'})).toThrow('reason for ending');
    const ended = submitted({kind: 'end', reason: '', endReason: 'Contract Expiry'});
    expect(ended.decision).toMatchObject({payChanges: false, salaryCents: null, startOn: null, endOn: null});
    expect(contractPostingKindMatches(ended, 'Contract end')).toBe(false);
  });
  it('checks permission, source revision and preflight without consuming the decision', () => {
    const input = {actor, expectedRevision: 1, draft, at, preflightProblems: ['CEO routing resolves nobody.']};
    expect(() => submitContractFlowDecision(fresh(), input)).toThrow('Can’t submit');
    expect(() => submitContractFlowDecision(fresh(), {...input, actor: {...actor, permissions: []}})).toThrow('unavailable');
    expect(() => submitContractFlowDecision(fresh(), {...input, expectedRevision: 2})).toThrow('changed');
    expect(fresh().decision).toBeNull();
    expect(() => submitContractFlowDecision(submitted(), {...input, expectedRevision: 2, preflightProblems: []})).toThrow('fixed');
  });
  it('archives a rejected decision and increments the resubmitted decision revision', () => {
    const returned = rejectContractFlowDecision({...submitted(), stage: 'approval'}, {expectedRevision: 2, reason: 'Revise dates', at});
    expect(returned.stage).toBe('open');
    const next = submitContractFlowDecision(returned, {actor, expectedRevision: 3, draft: {...draft, months: 6}, at, preflightProblems: []});
    expect(next.decision?.revision).toBe(2);
    expect(next.decisionHistory[0].months).toBe(12);
  });
});
describe('Posting approval and separate manual Payroll confirmation', () => {
  it('requires the posting approver; same-pay approval closes without a compensation effect', () => {
    const record = posting({payChanges: false});
    expect(() => approveContractFlowPosting(record, {actor, expectedRevision: 2, postingId: 'posting1', at})).toThrow('approver');
    const approved = approveContractFlowPosting(record, {actor: approver, expectedRevision: 2, postingId: 'posting1', at});
    expect(approved.stage).toBe('renewed');
    expect(approved.payConfirmation).toBeNull();
    expect(approved).not.toHaveProperty('payroll');
    expect(approveContractFlowPosting(approved, {actor: approver, expectedRevision: 2, postingId: 'posting1', at})).toBe(approved);
  });
  it('retains pay pending until an authorized explicit confirmation, with an idempotent receipt', () => {
    const approved = approveContractFlowPosting(posting(), {actor: approver, expectedRevision: 2, postingId: 'posting1', at});
    expect(approved.stage).toBe('pay');
    expect(approved.flags).toContain('pay_pending');
    expect(() => confirmContractFlowPay(approved, {actor, expectedRevision: 3, confirmed: true, at})).toThrow('approver');
    expect(() => confirmContractFlowPay(approved, {actor: approver, expectedRevision: 3, confirmed: false, at})).toThrow('confirm');
    const done = confirmContractFlowPay(approved, {actor: approver, expectedRevision: 3, confirmed: true, at});
    expect(done.stage).toBe('renewed');
    expect(done.flags).not.toContain('pay_pending');
    expect(done.payConfirmation).toEqual({by: 'peopleops', at});
    expect(confirmContractFlowPay(done, {actor: approver, expectedRevision: 3, confirmed: true, at})).toBe(done);
  });
  it('does not confirm pay before posting approval and closes conversion under its own state', () => {
    expect(() => confirmContractFlowPay(posting(), {actor: approver, expectedRevision: 2, confirmed: true, at})).toThrow('Approve');
    expect(approveContractFlowPosting(posting({kind: 'convert', payChanges: false}), {actor: approver, expectedRevision: 2, postingId: 'posting1', at}).stage).toBe('converted');
  });
  it('only HR with decline permission records a pending employee renewal decline', () => {
    const record: ContractFlow = {...submitted(), stage: 'document'};
    const input = {actor, expectedRevision: 2, employeeStepPending: true, reason: 'Resignation', notes: 'Reported to BP', at};
    expect(() => recordContractFlowDecline(record, input)).toThrow('unavailable');
    const hr = {...actor, permissions: ['decline'] as const};
    expect(recordContractFlowDecline(record, {...input, actor: hr}).declined).toMatchObject({by: 'manager', reason: 'Resignation'});
    expect(() => recordContractFlowDecline(record, {...input, actor: hr, employeeStepPending: false})).toThrow('pending');
  });
});
describe('Tracker business status and settings', () => {
  const options = {today: '2026-11-16', firstReminderOn: '2026-12-01', stallEnabled: true, stallDays: 5};
  it('projects status without terminating an expired employment', () => {
    expect(contractFlowDisplay(fresh(), options).status).toBe('Upcoming');
    expect(contractFlowDisplay(fresh(), {...options, today: '2026-12-01'}).status).toBe('Decision needed');
    expect(contractFlowDisplay(fresh(), {...options, today: '2027-01-01', firstReminderOn: null}).status).toBe('Decision needed');
    expect(fresh().stage).toBe('open');
  });
  it('flags stalled active work only; excludes open and closed cases', () => {
    const idle = {...submitted(), lastActivityAt: '2026-11-01T00:00:00+08:00'};
    expect(contractFlowDisplay(idle, options)).toEqual({status: 'In progress', stalledDays: 15});
    expect(contractFlowDisplay({...idle, stage: 'offboarding'}, options)).toEqual({status: 'Closed', stalledDays: null});
    expect(contractFlowDisplay(idle, {...options, stallEnabled: false}).stalledDays).toBeNull();
  });
  it('keeps module administration out of automatic team access', () => {
    expect(() => validateContractFlowSettings({...DEFAULT_CONTRACT_FLOW_SETTINGS, automaticSuperior: {enabled: true, permissions: ['access']}})).toThrow('module administration');
    expect(() => validateContractFlowSettings({...DEFAULT_CONTRACT_FLOW_SETTINGS, stallDays: 0})).toThrow('between');
    expect(() => validateContractFlowSettings(DEFAULT_CONTRACT_FLOW_SETTINGS)).not.toThrow();
    expect(validateContractFlowDecision(fresh(), {...draft, payChanges: false}).salaryCents).toBeNull();
  });
});
