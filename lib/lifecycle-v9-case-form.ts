import { z } from 'zod';
import { isCalendarDate } from './calendar-date';
export type CaseFormModule = 'onb' | 'off';
export type CaseFieldRules = Partial<Record<'businessGroup' | 'company' | 'department', string[]>>;
export type CaseField = { key: string; label: string; type: 'text' | 'long' | 'dropdown' | 'date'; show: boolean; required: boolean; hrOnly: boolean; rules: CaseFieldRules; options: string[]; help: string; when?: { field: string; value: string } };
export type CaseFieldDefinition = CaseField & { source: 'personnel' | 'case'; system: boolean; custom: boolean; values?: string[]; fixedWhen?: { field: string; value: string } };
export const v9CaseFieldSchema = z.object({ key: z.string().min(1).max(120).regex(/^[A-Za-z][A-Za-z0-9_]*$/).refine(value=>!Object.prototype.hasOwnProperty.call(Object.prototype,value)&&value!=='prototype','Choose a distinct custom field identifier.'), label: z.string().max(200), type: z.enum(['text','long','dropdown','date']), show: z.boolean(), required: z.boolean(), hrOnly: z.boolean(), rules: z.object({ businessGroup: z.array(z.string().min(1).max(120)).max(200).optional(), company: z.array(z.string().min(1).max(120)).max(200).optional(), department: z.array(z.string().min(1).max(120)).max(200).optional() }).strict(), options: z.array(z.string().max(500)).max(200), help: z.string().max(2000), when: z.object({ field: z.string().min(1).max(120), value: z.string().max(500) }).strict().optional() }).strict();
const base = (key: string, label: string, source: CaseFieldDefinition['source'], extra: Partial<CaseFieldDefinition> = {}): CaseFieldDefinition => ({ key, label, source, system: false, custom: false, type: 'text', show: true, required: false, hrOnly: false, rules: {}, options: [], help: '', ...extra });
/** Source keys are stable merge identifiers. Personnel values retain their existing system owner. */
function definitions(module: CaseFormModule): CaseFieldDefinition[] {
  return module === 'onb' ? [
    base('name','Full name','personnel',{ system: true }), base('empNo','Employee no.','personnel'), base('joinInput','Join date','personnel',{ system: true, type: 'date' }),
    base('position','Job title','personnel',{ system: true }), base('dept','Department','personnel',{ system: true }), base('company','Company','personnel',{ system: true }), base('group','Business Group','personnel',{ system: true }),
    base('supervisor','Supervisor','personnel'), base('ta','GBS TA name','personnel'),
    base('hireType','New hire or replacement','case',{ type: 'dropdown', options: ['New hire','Replacement'], values: ['new_hire','replacement'], required: true }),
    base('replacing','Employee being replaced','case',{ required: true, when: { field: 'hireType', value: 'replacement' } }),
    base('email','New hire email','case'), base('floor','Floor / building','case'),
    base('costCentre','Cost centre','personnel',{ hrOnly: true }), base('icNo','IC no.','personnel',{ hrOnly: true }), base('passportNo','Passport no.','personnel',{ hrOnly: true }), base('notes','Additional notes','case',{ type: 'long' }),
  ] : [
    base('empNo','Employee no.','personnel'), base('lastDay','Last working day','personnel',{ system: true, type: 'date' }), base('supervisor','Supervisor','personnel'),
    base('type','Case type','case',{ type: 'dropdown', options: ['Resignation','Termination','Contract end','Retirement','Non-confirmation'], required: true }),
    base('notice','Notice date','case',{ type: 'date', required: true }),
    base('revokeMode','Revoke access','case',{ system: true, type: 'dropdown', options: ['End of last working day','On a specific date'], values: ['lastday','date'], required: true }),
    base('revokeDate','Revoke access on','case',{ system: true, type: 'date', required: true, fixedWhen: { field: 'revokeMode', value: 'date' } }),
    base('pbp','People Business Partner','case'),
  ];
}
export function defaultV9CaseFields(module: CaseFormModule): CaseField[] {
  return definitions(module).map(({ source: _source, system: _system, custom: _custom, values: _values, fixedWhen: _fixedWhen, ...field }) => structuredClone(field));
}
export function resolveV9CaseFields(module: CaseFormModule, configured?: CaseField[]): CaseFieldDefinition[] {
  const original = definitions(module), values = configured ?? defaultV9CaseFields(module);
  return values.map(value => {
    const standard = original.find(field => field.key === value.key);
    const field: CaseFieldDefinition = { ...structuredClone(value), source: standard?.source ?? 'case', system: standard?.system ?? false, custom: !standard };
    if (standard?.type === 'date') field.type = 'date';
    if (standard?.source === 'personnel') { field.type = standard.type; field.required = false; }
    if (standard?.system) { field.show = true; field.required = standard.source === 'case' && standard.required; field.rules = {}; field.type = standard.type; field.options = standard.options; field.values = standard.values; field.fixedWhen = standard.fixedWhen; delete field.when; }
    // These business choices retain their canonical values even when their displayed labels change.
    if (standard?.values || value.key === 'type' && module === 'off') { field.type = standard!.type; field.options = standard!.options; field.values = standard!.values; }
    return field;
  });
}
export function validateV9CaseFields(module: CaseFormModule, values: CaseField[]) {
  const keys = new Set(values.map(field => field.key));
  if (values.length > 100 || keys.size !== values.length) throw Error('Keep distinct case field identifiers and at most 100 fields.');
  if (definitions(module).some(field => !keys.has(field.key))) throw Error('Keep the standard case fields. Hide optional fields instead of deleting them.');
  const fields = resolveV9CaseFields(module, values);
  for (const field of fields) if (field.when) {
    const parent = fields.find(candidate => candidate.key === field.when!.field);
    if (!parent || parent.key === field.key || parent.source !== 'case' || parent.type !== 'dropdown' || !(parent.values ?? parent.options).includes(field.when.value)) throw Error('Choose another case dropdown and one of its values for the condition.');
  }
  return fields;
}
export function v9CaseFieldShown(field: CaseFieldDefinition, facts: Partial<Record<keyof CaseFieldRules,string>>, values: Record<string,string>, hr: boolean) {
  if (!field.show || field.hrOnly && !hr) return false;
  if (Object.entries(field.rules).some(([key, selected]) => selected?.length && !selected.includes(facts[key as keyof CaseFieldRules] ?? ''))) return false;
  const when = field.fixedWhen ?? field.when;
  return !when || values[when.field] === when.value;
}
export function missingV9CaseFields(fields: CaseFieldDefinition[], facts: Partial<Record<keyof CaseFieldRules,string>>, values: Record<string,string>, hr: boolean) {
  return fields.filter(field => field.source === 'case' && field.required && v9CaseFieldShown(field, facts, values, hr) && (!values[field.key]?.trim() || field.type === 'date' && !isCalendarDate(values[field.key])));
}
export function validateV9CaseValue(field: CaseFieldDefinition, value: string) {
  if (value.length > 10000 || field.type === 'date' && value && !isCalendarDate(value) || field.type === 'dropdown' && value && !(field.values ?? field.options).includes(value)) throw Error(`Enter a valid value for ${field.label || 'this field'}.`);
}

export function offCaseFormValues(c: { facts: { employeeNo: string; lastDay: string; supervisorUserId: string | null; caseType: string; noticeDate: string; pbpUserId: string | null }; revokeDate: string; revokeMode?: 'lastday' | 'date'; caseValues?: Record<string,string> }): Record<string,string> {
  return { ...c.caseValues, empNo: c.facts.employeeNo, lastDay: c.facts.lastDay, supervisor: c.facts.supervisorUserId ?? '', type: c.facts.caseType, notice: c.facts.noticeDate, revokeMode: c.revokeMode ?? (c.revokeDate === c.facts.lastDay ? 'lastday' : 'date'), revokeDate: c.revokeDate, pbp: c.facts.pbpUserId ?? '' };
}
