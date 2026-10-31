/** The action receives only finite reason/field tokens. Captured values and infrastructure faults stay private. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DRAFT_ACTIVATION_CODES, DRAFT_ACTIVATION_FIELDS_BY_TAB, draftActivationValidation,
  DraftActivationValidationError, DraftPayrollSetupError, DraftStatutorySetupError,
  type DraftActivationValidationCode, type DraftActivationProblem,
} from '../core/employee-draft';
import { DependentValidationError } from '../core/dependents';
import { MissingBankForTransferError, PersonProfileCatalogError } from '../core/org';
import {ProfileOptionValueError} from '../core/profile-options';
import { IncompleteCustomHolderError } from '../lib/custom-holder';
import { DRAFT_TABS } from '../lib/employee-draft-schema';

const privateValue = 'Private Person, account 0000123456';
function safe(problem: DraftActivationProblem | null) {
  expect(problem).not.toBeNull();
  expect(DRAFT_ACTIVATION_CODES).toContain(problem!.code);
  for (const pointer of problem!.fields) {
    expect(DRAFT_TABS).toContain(pointer.tab);
    expect(DRAFT_ACTIVATION_FIELDS_BY_TAB[pointer.tab] as readonly string[]).toContain(pointer.field);
  }
  expect(Object.keys(problem!).sort()).toEqual(['code', 'fields']);
  expect(JSON.stringify(problem)).not.toContain(privateValue);
}

describe('safe Draft activation validation projection', () => {
  it('exports a finite union and filters unexpected runtime field/code tokens', () => {
    const error = new DraftActivationValidationError('invented' as DraftActivationValidationCode, [
      { tab: 'profile', field: 'fullName' },
      { tab: 'profile', field: privateValue as never },
      { tab: 'invented' as never, field: 'fullName' },
      { tab: 'payroll', field: 'fullName' },
    ]);
    expect(draftActivationValidation(error)).toEqual({ code: 'invalid_data', fields: [{ tab: 'profile', field: 'fullName' }] });
    safe(draftActivationValidation(error));
  });

  it('preserves existing catalog messages while projecting only actual finite field metadata',()=>{
    const owner=new ProfileOptionValueError('state',privateValue),wrapped=new PersonProfileCatalogError('correspondenceState',owner);
    expect(owner.message).toBe(`"${privateValue}" is not an active state option`);expect(wrapped.message).toBe(owner.message);
    expect(draftActivationValidation(wrapped)).toEqual({code:'profile_invalid',fields:[{tab:'profile',field:'correspondenceState'}]});
    const legacy=new PersonProfileCatalogError('state',owner);expect(draftActivationValidation(legacy)).toBeNull();
  });

  it.each([
    [new DraftPayrollSetupError('policy_inactive'), 'payroll_invalid', 'payroll', 'payrollPolicyId'],
    [new DraftPayrollSetupError('payment_method_invalid'), 'payroll_invalid', 'payroll', 'paymentMethod'],
    [new DraftStatutorySetupError('tax_residency_invalid'), 'statutory_invalid', 'bankStatutory', 'taxResidency'],
    [new MissingBankForTransferError(), 'payroll_invalid', 'payroll', 'paymentMethodBank'],
    [new IncompleteCustomHolderError('id'), 'statutory_invalid', 'bankStatutory', 'customHolderId'],
    [new DependentValidationError(privateValue), 'family_invalid', 'family', 'familyMemberRelationship'],
    [new PersonProfileCatalogError('salutation',new ProfileOptionValueError('salutation',privateValue)), 'profile_invalid', 'profile', 'salutation'],
    [new PersonProfileCatalogError('correspondenceState',new ProfileOptionValueError('state',privateValue)), 'profile_invalid', 'profile', 'correspondenceState'],
    [new PersonProfileCatalogError('correspondenceCountry',new ProfileOptionValueError('country',privateValue)), 'profile_invalid', 'profile', 'correspondenceCountry'],
    [new Error(`Employee ID "${privateValue}" is already in use`), 'employee_code_invalid', 'profile', 'employeeCode'],
  ])('maps owner refusal %s without exposing its message', (error, code, tab, field) => {
    const problem = draftActivationValidation(error);
    expect(problem).toEqual({ code, fields: [{ tab, field }] });
    safe(problem);
  });

  it.each(['toString', '__proto__', 'fullName.private', privateValue])('refuses forged Family metadata %s without reflecting it', field => {
    const error = new DependentValidationError(privateValue, field as never);
    expect(draftActivationValidation(error)).toEqual({ code: 'family_invalid', fields: [{ tab: 'family', field: 'familyMemberRelationship' }] });
    safe(draftActivationValidation(error));
  });

  it('allowlists an EPF owner pointer rather than reflecting an arbitrary field', () => {
    const error = Object.assign(new Error(privateValue), { name: 'InvalidEpfElectionError', field: privateValue });
    expect(draftActivationValidation(error)).toEqual({ code: 'statutory_invalid', fields: [{ tab: 'bankStatutory', field: 'epfMode' }] });
    error.field = 'epfManualReason';
    expect(draftActivationValidation(error)?.fields).toEqual([{ tab: 'bankStatutory', field: 'epfManualReason' }]);
  });

  it.each([
    new Error(privateValue),
    new Error(`"${privateValue}" is not an active state option`),
    new Error('toString'),
    { code: '42501', message: privateValue },
    Object.assign(new Error(`Failed query: insert into person values (${privateValue})`), { name: 'DrizzleQueryError' }),
    new Error('TaxSelectionError', { cause: { code: '23514', message: privateValue } }),
    Object.assign(new DraftActivationValidationError('profile_invalid', []), { cause: { code: '42501', message: privateValue } }),
    null,
  ])('returns no validation payload for an unknown or wrapped database fault %s', error => {
    expect(draftActivationValidation(error)).toBeNull();
  });

  it('returns a fresh safe payload, without message, stack, cause or mutable field aliases', () => {
    const error = new DraftActivationValidationError('required_fields', [{ tab: 'job', field: 'department' }]);
    const projected = draftActivationValidation(error)!;
    projected.fields[0].field = 'position';
    expect(error.fields).toEqual([{ tab: 'job', field: 'department' }]);
    expect(Object.keys(projected).sort()).toEqual(['code', 'fields']);
  });
});

describe('activation transaction composition boundary', () => {
  it('passes its explicit transaction to every canonical owner, including the late Family and audit writes', () => {
    const source = readFileSync(new URL('../core/employee-draft.ts', import.meta.url), 'utf8');
    const start = source.indexOf('export async function completeEmployeeDraft(');
    const end = source.indexOf('export function draftFamilyToDependents(', start);
    expect(start).toBeGreaterThanOrEqual(0); expect(end).toBeGreaterThan(start);
    const activation = source.slice(start, end);
    expect(activation.length).toBeGreaterThan(15000);
    expect(activation.match(/withTenant\(/g)).toHaveLength(1);
    expect(activation).toContain(".for('update')");
    expect(activation).not.toMatch(/\.insert\((person|employment|employeeDependent|compensation)\)/);
    expect(activation).toMatch(/materialiseDependents\(ctx,[\s\S]*?\},\s*tx\)/);
    expect(activation).toMatch(/setPersonComplianceFields\(ctx,[\s\S]*?\},\s*tx\)/);
    expect(activation).toMatch(/appendEvent\(tx,[\s\S]*?employee-draft\.completed/);
    const compliance = activation.slice(activation.indexOf('await setPersonComplianceFields'), activation.indexOf('const profileFields'));
    expect(compliance.length).toBeGreaterThan(200);
    expect(compliance).not.toContain('catch');
  });
  it('takes canonical Criteria coordination before label share locks used by assignment creation',()=>{
    const source=readFileSync(new URL('../core/employee-draft.ts',import.meta.url),'utf8');
    const start=source.indexOf('export async function completeEmployeeDraft(');expect(start).toBeGreaterThanOrEqual(0);
    const activation=source.slice(start),lock=activation.indexOf('await lockLabelCriteriaTx(tx,ctx.tenantId)'),references=activation.indexOf('const references=');
    expect(activation.length).toBeGreaterThan(15000);expect(lock).toBeGreaterThanOrEqual(0);expect(references).toBeGreaterThan(lock);
    expect(activation.slice(references)).toContain(".for('share')");
  });

});


describe('one action owns its exact saved Draft input',()=>{
 it('delegates once and retains the Draft lock across save and the activation savepoint',()=>{
  const action=readFileSync(new URL('../app/(app)/admin/personnel/new/actions.ts',import.meta.url),'utf8');
  const start=action.indexOf('export async function createEmployeeAction(');expect(start).toBeGreaterThanOrEqual(0);const body=action.slice(start);expect(body.length).toBeGreaterThan(300);
  expect(body).toContain('await saveAndCompleteEmployeeDraft(session,');expect(body).not.toContain('await saveEmployeeDraft(');expect(body).not.toContain('await completeEmployeeDraft(');
  const source=readFileSync(new URL('../core/employee-draft.ts',import.meta.url),'utf8');const combined=source.indexOf('export async function saveAndCompleteEmployeeDraft('),next=source.indexOf('export async function completeEmployeeDraft(',combined);expect(combined).toBeGreaterThanOrEqual(0);expect(next).toBeGreaterThan(combined);const owner=source.slice(combined,next);expect(owner.length).toBeGreaterThan(800);
  expect(owner).toContain('await saveEmployeeDraft(ctx,p,tx)');expect(owner).toContain('tx.transaction(activationTx=>completeEmployeeDraftTx(activationTx,ctx,saved.id))');expect(owner.indexOf('if(!outcome.ok)throw outcome.error')).toBeGreaterThan(owner.indexOf('return {ok:false as const,error}'));
  const saveStart=source.indexOf('export async function saveEmployeeDraft('),saveEnd=source.indexOf('/**',saveStart);expect(saveStart).toBeGreaterThanOrEqual(0);expect(saveEnd).toBeGreaterThan(saveStart);const save=source.slice(saveStart,saveEnd);expect(save.length).toBeGreaterThan(1500);expect(save.indexOf(".for('update')")).toBeLessThan(save.indexOf('.update(employeeDraft)'));
 });
});
