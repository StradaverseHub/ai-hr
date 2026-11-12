/**
 * Recruitment slice 14 — the pure rules and the static shape of 5215 (no database). The database behaviour of cases 95–100 is
 * test/recruitment-custom-fields.test.ts; case 101 is the lead's rendered check.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CUSTOM_FIELD_LOCALES, CUSTOM_FIELD_TYPES, CUSTOM_FORM_MARKER, SENSITIVE_CATEGORIES, SENSITIVE_WORDS, answerable, compareDecimal, customFilterKey, customInputName,
  customValuesFromForm, decimalText, formValue, labelFor, moveInOrder, parseCustomFilter, sameValue, sensitiveCategory, validateCustomFieldInput,
  validateCustomOptionInput, validateCustomValues, type FieldRule,
} from '../packs/recruitment/custom-field-model';
import { RECRUITMENT_ERROR_CODES } from '../packs/recruitment/model';
import { locales } from '../i18n/config';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(`${root}${rel}`, 'utf8');
const F1 = '11111111-1111-4111-8111-111111111111';
const F2 = '22222222-2222-4222-8222-222222222222';
const O1 = '33333333-3333-4333-8333-333333333333';
const O2 = '44444444-4444-4444-8444-444444444444';
const O3 = '55555555-5555-4555-8555-555555555555';
const rule = (over: Partial<FieldRule>): FieldRule => ({ id: F1, type: 'short_text', required: false, enabled: true, numberMin: null, numberMax: null, numberDecimals: null, options: [], ...over });

describe('definitions', () => {
  it('needs an English name, a known kind and type; other labels optional; help text ≤200; restricted only on candidate fields', () => {
    expect(validateCustomFieldInput({ kind: 'candidate', type: 'short_text', label_ms: 'Nama' })).toEqual({ ok: false, code: 'missing_fields', fields: ['label_en'] });
    expect(validateCustomFieldInput({ kind: 'person', type: 'file', label_en: 'Portfolio link', helpText: 'h'.repeat(201), label_zh: 'x'.repeat(81) }))
      .toEqual({ ok: false, code: 'invalid_input', fields: ['label_zh', 'kind', 'type', 'helpText'] });
    expect(validateCustomFieldInput({ kind: 'job', type: 'yes_no', label_en: 'Remote allowed', restricted: 'on' }))
      .toEqual({ ok: false, code: 'invalid_input', fields: ['restricted'] });
    const ok = validateCustomFieldInput({ kind: 'candidate', type: 'short_text', label_en: '  Portfolio   link ', label_ms: 'Pautan portfolio', label_ta: '', helpText: ' ', required: 'on', restricted: 'on' });
    expect(ok).toEqual({ ok: true, value: {
      kind: 'candidate', type: 'short_text', labels: { en: 'Portfolio link', ms: 'Pautan portfolio', ta: null, th: null, vi: null, zh: null }, helpText: null,
      required: true, restricted: true, enabled: true, numberMin: null, numberMax: null, numberDecimals: null,
    } });
  });

  it('number settings: decimals 0–4 (blank = 0), min ≤ max, limits within the decimals; ignored for other types', () => {
    const n = (over: Record<string, unknown>) => validateCustomFieldInput({ kind: 'job', type: 'number', label_en: 'Headcount budget', ...over });
    expect(n({})).toMatchObject({ ok: true, value: { numberMin: null, numberMax: null, numberDecimals: 0 } });
    expect(n({ numberMin: '10', numberMax: '2' })).toEqual({ ok: false, code: 'invalid_input', fields: ['numberMax'] });
    expect(n({ numberDecimals: '5' })).toEqual({ ok: false, code: 'invalid_input', fields: ['numberDecimals'] });
    expect(n({ numberMin: '0.25', numberDecimals: '1' })).toEqual({ ok: false, code: 'invalid_input', fields: ['numberMin'] });
    expect(n({ numberMin: 'ten' })).toEqual({ ok: false, code: 'invalid_input', fields: ['numberMin'] });
    expect(n({ numberMin: '-1.50', numberMax: '1,000', numberDecimals: '2' })).toMatchObject({ ok: true, value: { numberMin: '-1.5', numberMax: '1000', numberDecimals: 2 } });
    expect(validateCustomFieldInput({ kind: 'job', type: 'date', label_en: 'Target start', numberMin: '1', numberDecimals: '9' }))
      .toMatchObject({ ok: true, value: { numberMin: null, numberMax: null, numberDecimals: null } });
  });

  it('every type the spec lists, and no file, image or region type (D-051); the six locales are i18n/config.ts\'s', () => {
    expect([...CUSTOM_FIELD_TYPES]).toEqual(['short_text', 'long_text', 'number', 'date', 'year_month', 'single_choice', 'multiple_choice', 'yes_no']);
    expect([...CUSTOM_FIELD_LOCALES].sort()).toEqual([...locales].sort());
    for (const code of ['sensitive_field', 'field_in_use', 'option_in_use', 'custom_field_required', 'custom_value_invalid', 'custom_field_limit']) {
      expect(RECRUITMENT_ERROR_CODES).toContain(code);
    }
  });

  it('options: English name required, ≤80 per locale', () => {
    expect(validateCustomOptionInput({ label_en: '' }, 'candidate')).toEqual({ ok: false, code: 'missing_fields', fields: ['label_en'] });
    expect(validateCustomOptionInput({ label_en: 'Diploma', label_vi: 'v'.repeat(81) }, 'candidate')).toEqual({ ok: false, code: 'invalid_input', fields: ['label_vi'] });
    expect(validateCustomOptionInput({ label_en: 'Diploma', label_zh: '文凭', enabled: false }, 'candidate'))
      .toEqual({ ok: true, value: { labels: { en: 'Diploma', ms: null, ta: null, th: null, vi: null, zh: '文凭' }, enabled: false } });
  });

  it('labels fall back to English for a missing or unknown locale (case 99)', () => {
    const labels = { en: 'Shift preference', ms: 'Pilihan syif', ta: null, th: '  ', vi: null, zh: '班次偏好' };
    expect(labelFor(labels, 'ms')).toBe('Pilihan syif');
    expect(labelFor(labels, 'zh')).toBe('班次偏好');
    expect(labelFor(labels, 'ta')).toBe('Shift preference');
    expect(labelFor(labels, 'th')).toBe('Shift preference');
    expect(labelFor(labels, 'fr')).toBe('Shift preference');
  });
});

describe('the sensitive-category word list (D-052, case 99)', () => {
  const refused = (texts: string[]) => sensitiveCategory(texts);
  it('refuses each category by an English name, whole words, case and spacing folded', () => {
    expect(refused(['Race'])).toBe('race');
    expect(refused(['Ethnic  group'])).toBe('race');
    expect(refused(['RELIGION'])).toBe('religion');
    expect(refused(['Medical history'])).toBe('health');
    expect(refused(['Any disability?'])).toBe('health');
    expect(refused(['Are you pregnant'])).toBe('pregnancy');
    expect(refused(['Criminal record'])).toBe('criminal_record');
    expect(refused(['Marital status'])).toBe('family');
    expect(refused(['Number of children'])).toBe('family');
  });
  it('refuses by any locale\'s label and by help text, in every script', () => {
    expect(refused(['Background', 'Agama'])).toBe('religion');
    expect(refused(['Notes', null as unknown as string, 'Please state your kaum'])).toBe('race');
    expect(refused(['宗教信仰'])).toBe('religion');
    expect(refused(['婚姻状况'])).toBe('family');
    expect(refused(['是否怀孕'])).toBe('pregnancy');
    expect(refused(['ประวัติอาชญากรรม'])).toBe('criminal_record');
    expect(refused(['สุขภาพ'])).toBe('health');
    expect(refused(['Tình trạng hôn nhân'])).toBe('family');
    expect(refused(['Tôn giáo'])).toBe('religion');
    expect(refused(['குடும்ப விவரங்கள்'])).toBe('family');
    expect(refused(['மதம்'])).toBe('religion');
    expect(refused(['Rekod jenayah'])).toBe('criminal_record');
  });
  it('does not refuse ordinary fields, including words that merely contain a listed word', () => {
    for (const ok of ['Portfolio link', 'Preferred shift', 'Notice period (weeks)', 'Racecourse experience', 'Faithfully served?', 'Healthcare sector experience',
      'Graduate programme', 'Lãnh đạo nhóm', 'Mengandungi sijil', 'Anak syarikat', 'Kepercayaan pelanggan', 'Languages spoken', 'Driving licence class']) {
      expect(refused([ok]), ok).toBeNull();
    }
  });
  it('the definition and option validators use it for CANDIDATE fields only, with a plain category code (the lead\'s ruling on D-052)', () => {
    expect(validateCustomFieldInput({ kind: 'candidate', type: 'single_choice', label_en: 'Background', label_zh: '种族' }))
      .toEqual({ ok: false, code: 'sensitive_field', fields: ['label_en'], category: 'race' });
    expect(validateCustomFieldInput({ kind: 'candidate', type: 'short_text', label_en: 'Benefits', helpText: 'Your health condition' }))
      .toMatchObject({ ok: false, code: 'sensitive_field', category: 'health' });
    // A job field describes the job, not a person: not checked.
    expect(validateCustomFieldInput({ kind: 'job', type: 'short_text', label_en: 'Benefits', helpText: 'Health screening offered' }))
      .toMatchObject({ ok: true, value: { kind: 'job', helpText: 'Health screening offered' } });
    expect(validateCustomFieldInput({ kind: 'job', type: 'yes_no', label_en: 'Medical insurance', label_zh: '家庭医疗保险' })).toMatchObject({ ok: true });
    expect(validateCustomOptionInput({ label_en: 'Married' }, 'candidate')).toMatchObject({ ok: false, code: 'sensitive_field', category: 'family' });
    expect(validateCustomOptionInput({ label_en: 'Married couples housing' }, 'job')).toMatchObject({ ok: true });
  });
  it('the list is fixed and covers the six categories slice 5 excludes', () => {
    expect([...SENSITIVE_CATEGORIES]).toEqual(['race', 'religion', 'health', 'pregnancy', 'criminal_record', 'family']);
    for (const c of SENSITIVE_CATEGORIES) {
      const w = SENSITIVE_WORDS[c];
      expect(w.words.length + w.exact.length + w.anywhere.length).toBeGreaterThan(5);
    }
  });
  it('refuses each category in each of the six locales (positives)', () => {
    const POSITIVES: Record<string, Record<string, string>> = {
      race: { en: 'Race or ethnicity', ms: 'Kaum', ta: 'சாதி', th: 'เชื้อชาติ', vi: 'Dân tộc', zh: '民族' },
      religion: { en: 'Religion', ms: 'Agama', ta: 'மதம்', th: 'ศาสนา', vi: 'Tôn giáo', zh: '宗教信仰' },
      health: { en: 'Health condition', ms: 'Tahap kesihatan', ta: 'நோய் வரலாறு', th: 'ประวัติสุขภาพ', vi: 'Tình trạng sức khỏe', zh: '健康状况' },
      pregnancy: { en: 'Are you pregnant?', ms: 'Status kehamilan', ta: 'கர்ப்பம்', th: 'การตั้งครรภ์', vi: 'Có thai không', zh: '是否怀孕' },
      criminal_record: { en: 'Criminal record', ms: 'Rekod jenayah', ta: 'குற்றப் பதிவு', th: 'ประวัติอาชญากรรม', vi: 'Tiền án', zh: '无犯罪记录证明' },
      family: { en: 'Marital status', ms: 'Status perkahwinan', ta: 'திருமண நிலை', th: 'สถานภาพสมรส', vi: 'Tình trạng hôn nhân', zh: '婚否' },
    };
    for (const [category, byLocale] of Object.entries(POSITIVES)) {
      expect(Object.keys(byLocale).sort()).toEqual([...CUSTOM_FIELD_LOCALES].sort());
      for (const [locale, name] of Object.entries(byLocale)) expect(refused([name]), `${category} ${locale} ${name}`).toBe(category);
    }
    // Whole everyday words are refused when they ARE the name; phrases that name the category anywhere in it.
    for (const [name, category] of [['Race', 'race'], ['Health?', 'health'], ['Family', 'family'], ['Medical history', 'health'], ['Number of dependants', 'family'],
      ['Dependents', 'family'], ['Blood group', 'health'], ['Vaccination status', 'health'], ['COVID-19 vaccinated', 'health'], ['婚否', 'family'],
      ['Family members', 'family'], ['Vợ/chồng', 'family'], ['Gia đình', 'family'], ['Kesihatan', 'health'], ['sức khỏe', 'health']] as const) {
      expect(refused([name]), name).toBe(category);
    }
  });
  it('is not bypassed by invisible characters or hyphens', () => {
    expect(refused(['Reli\u200Bgion'])).toBe('religion');
    expect(refused(['Reli\u00ADgion'])).toBe('religion');
    expect(refused(['R\u2060ace'])).toBe('race');
    expect(refused(['宗\u200B教'])).toBe('religion');
    expect(refused(['Marital-status'])).toBe('family');
    expect(refused(['Criminal-record check'])).toBe('criminal_record');
    expect(refused(['ethnic-group'])).toBe('race');
    expect(refused(['\u200B\u00AD'])).toBeNull();
  });
  it('does not refuse everyday names that only share a word with a category (negatives)', () => {
    for (const ok of ['Family name', 'Experience teaching children', 'Pengalaman mengajar anak-anak', '家庭住址', '家庭电话', 'சம்மதம்', 'பின்னணி சரிபார்ப்புக்கு சம்மதம்',
      'Bệnh viện', 'Chồng chéo lịch', 'Health and safety certificate (OSH)', 'Medical check-up', 'Medical sales experience', 'race car driver licence',
      'Financial crime compliance', 'Raced competitively', 'Nama keluarga', 'Experience working with kids']) {
      expect(refused([ok]), ok).toBeNull();
    }
  });
});

describe('values (case 96)', () => {
  it('checks text lengths, numbers by range and decimals, real dates, year and month, yes or no', () => {
    const check = (r: FieldRule, v: string | string[]) => validateCustomValues([r], { [r.id]: v });
    expect(check(rule({ type: 'short_text' }), 's'.repeat(201))).toEqual({ ok: false, code: 'custom_value_invalid', fields: [F1] });
    expect(check(rule({ type: 'short_text' }), ' Fictional   link ')).toEqual({ ok: true, values: new Map([[F1, { type: 'short_text', text: 'Fictional link' }]]) });
    expect(check(rule({ type: 'long_text' }), 'l'.repeat(4001))).toMatchObject({ ok: false });
    const num = rule({ type: 'number', numberMin: '1', numberMax: '10', numberDecimals: 1 });
    expect(check(num, '10.5')).toMatchObject({ ok: false, code: 'custom_value_invalid' });
    expect(check(num, '0.9')).toMatchObject({ ok: false });
    expect(check(num, '2.25')).toMatchObject({ ok: false });
    expect(check(num, 'seven')).toMatchObject({ ok: false });
    expect(check(num, '9.50')).toEqual({ ok: true, values: new Map([[F1, { type: 'number', number: '9.5' }]]) });
    expect(check(rule({ type: 'date' }), '2026-02-30')).toMatchObject({ ok: false });
    expect(check(rule({ type: 'date' }), '2028-02-29')).toEqual({ ok: true, values: new Map([[F1, { type: 'date', date: '2028-02-29' }]]) });
    expect(check(rule({ type: 'year_month' }), '2026-13')).toMatchObject({ ok: false });
    expect(check(rule({ type: 'year_month' }), '2026-11')).toEqual({ ok: true, values: new Map([[F1, { type: 'year_month', date: '2026-11-01' }]]) });
    expect(check(rule({ type: 'yes_no' }), 'maybe')).toMatchObject({ ok: false });
    expect(check(rule({ type: 'yes_no' }), 'no')).toEqual({ ok: true, values: new Map([[F1, { type: 'yes_no', bool: false }]]) });
  });

  it('choices: options of the field only, enabled ones (a disabled one may stay chosen), one for single choice, ids for multiple', () => {
    const options = [{ id: O1, enabled: true }, { id: O2, enabled: false }];
    const single = rule({ type: 'single_choice', options });
    expect(validateCustomValues([single], { [F1]: O3 })).toMatchObject({ ok: false, code: 'custom_value_invalid' });
    expect(validateCustomValues([single], { [F1]: [O1, O2] })).toMatchObject({ ok: false });
    expect(validateCustomValues([single], { [F1]: O2 })).toMatchObject({ ok: false });
    expect(validateCustomValues([single], { [F1]: O2 }, new Map([[F1, { type: 'single_choice', optionIds: [O2] }]])))
      .toEqual({ ok: true, values: new Map([[F1, { type: 'single_choice', optionIds: [O2] }]]) });
    const multi = rule({ type: 'multiple_choice', options: [...options, { id: O3, enabled: true }] });
    expect(validateCustomValues([multi], { [F1]: [O3, O1, O3] })).toEqual({ ok: true, values: new Map([[F1, { type: 'multiple_choice', optionIds: [O3, O1] }]]) });
  });

  it('required on this save only for enabled fields; disabled fields are not touched; invalid wins over missing', () => {
    const fields = [rule({ id: F1, required: true }), rule({ id: F2, type: 'number', required: true, enabled: false, numberDecimals: 0 })];
    expect(validateCustomValues(fields, {})).toEqual({ ok: false, code: 'custom_field_required', fields: [F1] });
    expect(validateCustomValues(fields, { [F1]: '  ' })).toEqual({ ok: false, code: 'custom_field_required', fields: [F1] });
    const ok = validateCustomValues(fields, { [F1]: 'Fictional', [F2]: 'not a number' });
    expect(ok).toEqual({ ok: true, values: new Map([[F1, { type: 'short_text', text: 'Fictional' }]]) });
    expect(validateCustomValues([rule({ id: F1, required: true }), rule({ id: F2, type: 'yes_no' })], { [F2]: 'perhaps' }))
      .toEqual({ ok: false, code: 'custom_value_invalid', fields: [F2] });
    // An optional field left empty clears its value.
    expect(validateCustomValues([rule({})], { [F1]: '' })).toEqual({ ok: true, values: new Map([[F1, null]]) });
  });

  it('decimals compare exactly (no floating point); same-value and form round trips', () => {
    expect(decimalText('007.10')).toBe('7.1');
    expect(decimalText('-0.000')).toBe('0');
    expect(decimalText('1e3')).toBeNull();
    expect(compareDecimal('0.1', '0.10')).toBe(0);
    expect(compareDecimal('-2', '1')).toBe(-1);
    expect(compareDecimal('123456789012345.9', '123456789012345.89')).toBe(1);
    expect(sameValue({ type: 'multiple_choice', optionIds: [O1, O2] }, { type: 'multiple_choice', optionIds: [O2, O1] })).toBe(true);
    expect(sameValue({ type: 'number', number: '1' }, { type: 'number', number: '1.5' })).toBe(false);
    expect(sameValue(null, undefined)).toBe(true);
    expect(formValue({ type: 'year_month', date: '2026-11-01' })).toBe('2026-11');
    expect(formValue({ type: 'yes_no', bool: true })).toBe('yes');
  });

  it('a required choice field with no usable option is not enforced; one the record already chose keeps it answerable', () => {
    const none = rule({ type: 'single_choice', required: true, options: [{ id: O1, enabled: false }] });
    expect(validateCustomValues([none], {})).toEqual({ ok: true, values: new Map([[F1, null]]) });
    expect(answerable(none)).toBe(false);
    expect(answerable(none, { type: 'single_choice', optionIds: [O1] })).toBe(true);
    expect(validateCustomValues([none], {}, new Map([[F1, { type: 'single_choice', optionIds: [O1] }]])))
      .toEqual({ ok: false, code: 'custom_field_required', fields: [F1] });
    const multi = rule({ type: 'multiple_choice', required: true, options: [] });
    expect(validateCustomValues([multi], { [F1]: [] })).toEqual({ ok: true, values: new Map([[F1, null]]) });
    expect(validateCustomValues([rule({ type: 'single_choice', required: true, options: [{ id: O1, enabled: true }] })], {}))
      .toEqual({ ok: false, code: 'custom_field_required', fields: [F1] });
  });

  it('a stored number stays acceptable unchanged after the range or decimals narrow; a changed one is checked', () => {
    const narrowed = rule({ type: 'number', numberMin: '0', numberMax: '5', numberDecimals: 0 });
    const prev = new Map([[F1, { type: 'number', number: '9.5' } as const]]);
    expect(validateCustomValues([narrowed], { [F1]: '9.50' }, prev)).toEqual({ ok: true, values: new Map([[F1, { type: 'number', number: '9.5' }]]) });
    expect(validateCustomValues([narrowed], { [F1]: '9.6' }, prev)).toMatchObject({ ok: false, code: 'custom_value_invalid' });
    expect(validateCustomValues([narrowed], { [F1]: '4' }, prev)).toEqual({ ok: true, values: new Map([[F1, { type: 'number', number: '4' }]]) });
  });

  it('long text counts line breaks after normalising them; invisible characters alone are empty', () => {
    const long = rule({ type: 'long_text' });
    expect(validateCustomValues([long], { [F1]: `${'x'.repeat(3998)}\r\ny` })).toMatchObject({ ok: true });
    expect(validateCustomValues([long], { [F1]: `${'x'.repeat(3999)}\r\ny` })).toMatchObject({ ok: false, code: 'custom_value_invalid' });
    expect(validateCustomValues([rule({ required: true })], { [F1]: '\u200B \u00AD' })).toEqual({ ok: false, code: 'custom_field_required', fields: [F1] });
    expect(validateCustomValues([rule({})], { [F1]: '\u200B' })).toEqual({ ok: true, values: new Map([[F1, null]]) });
  });

  it('decimals take a point; commas only as thousands separators', () => {
    expect(decimalText('1234.5')).toBe('1234.5');
    expect(decimalText('1,234.5')).toBe('1234.5');
    expect(decimalText('-1,000,000')).toBe('-1000000');
    for (const bad of ['2,5', '12,34', '1,2345', ',100', '1,,000', '1.000,5']) expect(decimalText(bad), bad).toBeNull();
    expect(validateCustomValues([rule({ type: 'number', numberDecimals: 1 })], { [F1]: '2,5' })).toMatchObject({ ok: false, code: 'custom_value_invalid' });
  });

  it('reads a form\'s cf.<id> entries only when the form carried its custom fields', () => {
    const f = new FormData();
    f.append('title', 'x');
    f.append(customInputName(F1), 'Fictional');
    expect(customValuesFromForm(f)).toBeUndefined();
    f.append(CUSTOM_FORM_MARKER, '1');
    f.append(customInputName(F2), O1);
    f.append(customInputName(F2), O2);
    f.append('cf.not-a-uuid', 'x');
    expect(customValuesFromForm(f)).toEqual({ [F1]: ['Fictional'], [F2]: [O1, O2] });
  });
});

describe('filters and ordering', () => {
  it('parses one field and answer; anything else is no filter', () => {
    expect(parseCustomFilter(`${F1}:${O1}`)).toEqual({ fieldId: F1, optionId: O1 });
    expect(parseCustomFilter(`${F1}:yes`)).toEqual({ fieldId: F1, bool: true });
    expect(parseCustomFilter(`${F1}:no`)).toEqual({ fieldId: F1, bool: false });
    for (const bad of [undefined, '', F1, `${F1}:maybe`, `x:${O1}`, `${F1}:${O1}:${O2}`]) expect(parseCustomFilter(bad)).toBeNull();
    expect(customFilterKey({ fieldId: F1, bool: false })).toBe(`${F1}:no`);
  });
  it('moves an item one place', () => {
    expect(moveInOrder([F1, F2, O1], F2, 'up')).toEqual([F2, F1, O1]);
    expect(moveInOrder([F1, F2, O1], F2, 'down')).toEqual([F1, O1, F2]);
    expect(moveInOrder([F1, F2], F1, 'up')).toBeNull();
    expect(moveInOrder([F1, F2], F2, 'sideways')).toBeNull();
  });
});

describe('5215 static shape', () => {
  const sql = read('db/migrations/5215_recruitment_custom_fields.sql');
  const journal = JSON.parse(read('db/migrations/meta/_journal.json')) as { entries: { idx: number; when: number; tag: string }[] };
  it('is journalled once at idx 4615 / when 1793330004915, after 5214', () => {
    const entries = journal.entries.filter((e) => e.tag === '5215_recruitment_custom_fields');
    expect(entries).toEqual([expect.objectContaining({ idx: 4615, when: 1793330004915 })]);
    // The entry before it (5216, slice 15, follows it since).
    expect(journal.entries[journal.entries.findIndex((e) => e.tag === '5215_recruitment_custom_fields') - 1]?.tag).toBe('5214_recruitment_consume_invitation_access_lock');
  });
  it('restates 5213\'s removal and company delete byte for byte with added steps only', () => {
    const prior = read('db/migrations/5213_recruitment_talent_pools_blocked_list.sql');
    const body = (src: string, start: string, end: string) => src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start)) + end.length);
    for (const [start, end] of [
      ['CREATE OR REPLACE FUNCTION app.recruitment_destroy_candidate(p_candidate uuid)', 'GRANT EXECUTE ON FUNCTION app.recruitment_destroy_candidate(uuid) TO ai_hr_app;'],
      ['CREATE OR REPLACE FUNCTION app.recruitment_delete_company_setup(p_company uuid)', 'GRANT EXECUTE ON FUNCTION app.recruitment_delete_company_setup(uuid) TO ai_hr_app;'],
    ]) {
      const before = body(prior, start, end).split('\n');
      const after = body(sql, start, end).split('\n');
      expect(before.length).toBeGreaterThan(50);
      // Every line of the earlier body is still there, in order; only lines were added.
      let j = 0;
      for (const line of after) if (j < before.length && line === before[j]) j++;
      expect(j, start).toBe(before.length);
      const added = after.filter((l) => !before.includes(l));
      expect(added.length).toBeGreaterThan(3);
      expect(added.every((l) => /^\s*--|recruitment_(candidate|job)_custom|recruitment_custom_field|GET DIAGNOSTICS/.test(l)), added.join('\n')).toBe(true);
    }
  });
  it('forces row security on the five tables and grants nothing to PUBLIC', () => {
    expect(sql).toMatch(/FORCE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/REVOKE ALL ON public\.%I FROM PUBLIC, ai_hr_app/);
    expect(sql).not.toMatch(/TO PUBLIC/);
  });
});
