/**
 * Recruitment slice 14 rules — custom candidate and job fields (docs/recruitment-reconstruction/specification.md "Slice 14").
 * Pure, deterministic and client-safe: no database, no clock, no model.
 *
 * packs/recruitment/custom-fields.ts reads definitions and values under the viewer's own row security and hands them to these
 * helpers; nothing here decides who may see or do what (the database does, 5715). What is decided here: a definition's shape,
 * the fixed sensitive-category word list (D-052), how a typed value is read from a form and checked against its field, the
 * label in the viewer's locale (English when a locale has none), and the one-field filter.
 */
import { isUuid } from './model';

/** Whose record a field belongs to. */
export const CUSTOM_FIELD_KINDS = ['candidate', 'job'] as const;
export type CustomFieldKind = (typeof CUSTOM_FIELD_KINDS)[number];
/** The types (D-051: no file, image, region or cascading types). */
export const CUSTOM_FIELD_TYPES = ['short_text', 'long_text', 'number', 'date', 'year_month', 'single_choice', 'multiple_choice', 'yes_no'] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];
export const CHOICE_TYPES: readonly CustomFieldType[] = ['single_choice', 'multiple_choice'];
/** The types a board, talent pool or job list may filter by (one field at a time). */
export const FILTER_TYPES: readonly CustomFieldType[] = ['single_choice', 'multiple_choice', 'yes_no'];
/** AI HR's six locales; English is required, the others fall back to it. Same set as i18n/config.ts (a test pins it). */
export const CUSTOM_FIELD_LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
export type CustomFieldLocale = (typeof CUSTOM_FIELD_LOCALES)[number];
export type CustomLabels = Record<CustomFieldLocale, string | null>;

export const CUSTOM_LABEL_MAX = 80;
export const CUSTOM_HELP_MAX = 200;
export const CUSTOM_SHORT_TEXT_MAX = 200;
export const CUSTOM_LONG_TEXT_MAX = 4000;
export const CUSTOM_DECIMALS_MAX = 4;
/** |number| stays below this (the database's own CHECK). */
export const CUSTOM_NUMBER_LIMIT = 1e15;
/** At most this many ENABLED fields per company and record kind (keeps forms and filters small), at most this many fields in all
 *  (disabled ones included: stops runaway growth), and at most this many options per field. */
export const CUSTOM_FIELDS_MAX = 50;
export const CUSTOM_FIELDS_TOTAL_MAX = 500;
export const CUSTOM_OPTIONS_MAX = 100;
/** The form's marker that its custom fields were on the page (a form without them leaves the values untouched). */
export const CUSTOM_FORM_MARKER = 'cf.present';
/** The form name of a field's value: `cf.<field id>` (a multiple-choice field sends one per ticked option). */
export const customInputName = (fieldId: string) => `cf.${fieldId}`;

// ── The sensitive-category word list (D-052) ──────────────────────────────────────────────────────────────────

/**
 * The categories slice 5 does not collect about candidates (D-013) — a CANDIDATE field naming one is refused, by its labels in
 * every locale, its help text and its options' labels (job fields describe a job, not a person, and are not checked: the lead's
 * ruling on D-052). A FIXED list, checked deterministically, never a model:
 *   - `words`: words and phrases matched as whole words in scripts written with spaces (Latin, Vietnamese, Tamil), after removing
 *     default-ignorable characters (zero-width space, soft hyphen, …), Unicode NFKC and case folding; a hyphenated word matches
 *     both whole ("anak-anak") and split at its hyphens ("Marital-status" is "marital status");
 *   - `exact`: everyday words refused only when they are the WHOLE name ("Race", "Health?", "Family"), so "race car driver
 *     licence", "Health and safety certificate" and "Family name" pass;
 *   - `anywhere`: terms in Chinese and Thai (written without spaces) and Tamil stems, matched anywhere in the text — phrases
 *     where the bare character pair is common (家庭住址 is an address, so 家庭成员 / 家庭情况 / 家庭背景, not 家庭).
 * Out of scope (D-052): look-alike letters from other scripts and letters spaced apart. A field the list misses is still the
 * administrator's responsibility; a field it refuses by mistake can be renamed. The owner and legal decide on any sensitive field.
 */
export const SENSITIVE_CATEGORIES = ['race', 'religion', 'health', 'pregnancy', 'criminal_record', 'family'] as const;
export type SensitiveCategory = (typeof SENSITIVE_CATEGORIES)[number];
type WordList = { words: readonly string[]; exact: readonly string[]; anywhere: readonly string[] };
export const SENSITIVE_WORDS: Readonly<Record<SensitiveCategory, WordList>> = {
  race: {
    words: ['racial', 'race or ethnicity', 'race ethnicity', 'your race', 'ethnic', 'ethnicity', 'ethnicities', 'ethnic group', 'ethnic origin', 'caste',
      'tribe', 'tribal', 'skin colour', 'skin color', 'bumiputera', 'bumiputra', 'kaum', 'bangsa', 'keturunan', 'etnik', 'chủng tộc', 'dân tộc',
      'sắc tộc', 'இனம்', 'சாதி', 'ஜாதி'],
    exact: ['race', 'races'],
    anywhere: ['种族', '民族', '族裔', '人种', '種族', 'เชื้อชาติ', 'ชาติพันธุ์'],
  },
  religion: {
    words: ['religion', 'religions', 'religious', 'religious belief', 'religious faith', 'your faith', 'faith or religion', 'place of worship',
      'denomination', 'agama', 'kepercayaan agama', 'tôn giáo', 'đạo giáo', 'மதம்'],
    exact: ['faith', 'beliefs'],
    anywhere: ['宗教', '信仰', 'ศาสนา'],
  },
  health: {
    words: ['health condition', 'health conditions', 'health status', 'health problem', 'health problems', 'health issues', 'health declaration',
      'state of health', 'mental health', 'medical history', 'medical condition', 'medical conditions', 'medical record', 'medical records', 'illness',
      'illnesses', 'chronic illness', 'disease', 'diseases', 'disability', 'disabilities', 'diagnosis', 'medication', 'medications', 'blood type',
      'blood group', 'hiv', 'vaccination', 'vaccinations', 'vaccinated', 'vaccination status', 'tahap kesihatan', 'status kesihatan', 'masalah kesihatan',
      'rekod kesihatan', 'sejarah kesihatan', 'penyakit', 'kecacatan', 'oku', 'sejarah perubatan', 'vaksinasi', 'tình trạng sức khỏe',
      'tình trạng sức khoẻ', 'bệnh tật', 'bệnh lý', 'bệnh mãn tính', 'tiền sử bệnh', 'khuyết tật', 'tiêm chủng'],
    exact: ['health', 'medical', 'kesihatan', 'sức khỏe', 'sức khoẻ'],
    anywhere: ['健康', '疾病', '病史', '残疾', '殘疾', '残障', '疫苗', '血型', 'สุขภาพ', 'โรค', 'ความพิการ', 'หมู่เลือด', 'วัคซีน', 'உடல்நல', 'ஆரோக்கிய',
      'நோய்', 'ஊனம்', 'மாற்றுத்திறன்', 'தடுப்பூசி'],
  },
  pregnancy: {
    words: ['pregnant', 'pregnancy', 'pregnancies', 'expecting a baby', 'hamil', 'kehamilan', 'mang thai', 'có thai', 'thai sản'],
    exact: [],
    anywhere: ['怀孕', '懷孕', '孕', 'ตั้งครรภ์', 'கர்ப்ப'],
  },
  criminal_record: {
    words: ['criminal record', 'criminal records', 'criminal history', 'criminal background', 'criminal conviction', 'criminal convictions',
      'criminal offence', 'criminal offences', 'criminal offense', 'criminal offenses', 'conviction', 'convictions', 'convicted', 'arrested',
      'arrest record', 'police record', 'prison', 'jail', 'imprisonment', 'rekod jenayah', 'kesalahan jenayah', 'sejarah jenayah', 'sabitan',
      'penjara', 'tiền án', 'tiền sự', 'án tích'],
    exact: ['crime', 'crimes', 'criminal', 'offences', 'offenses', 'jenayah'],
    anywhere: ['犯罪', '刑事', '前科', '案底', '定罪', 'อาชญากรรม', 'ต้องโทษ', 'குற்ற', 'சிறை'],
  },
  family: {
    words: ['family members', 'family member', 'family background', 'family details', 'family status', 'family information', 'family size', 'marital',
      'marital status', 'married', 'marriage', 'spouse', 'husband', 'wife', 'number of children', 'how many children', 'ages of children',
      'children ages', 'dependants', 'dependents', 'number of dependants', 'number of dependents', 'maiden name', 'next of kin', 'ahli keluarga',
      'latar belakang keluarga', 'maklumat keluarga', 'butiran keluarga', 'perkahwinan', 'status perkahwinan', 'suami', 'isteri', 'bilangan anak',
      'jumlah anak', 'umur anak', 'tanggungan', 'thành viên gia đình', 'hoàn cảnh gia đình', 'thông tin gia đình', 'hôn nhân', 'tình trạng hôn nhân',
      'vợ', 'vợ chồng', 'tên chồng', 'họ tên chồng', 'con cái', 'số con', 'người phụ thuộc', 'குடும்பம்', 'மனைவி', 'கணவர்'],
    exact: ['family', 'families', 'children', 'kids', 'keluarga', 'gia đình'],
    anywhere: ['家庭成员', '家庭情况', '家庭背景', '家庭状况', '家庭成員', '婚姻', '婚否', '婚育', '配偶', '子女', '孩子数量', '几个孩子', '已婚',
      'ครอบครัว', 'สมรส', 'บุตร', 'குடும்ப விவர', 'குடும்ப உறுப்பினர', 'திருமண', 'குழந்தைகளின் எண்ணிக்கை', 'எத்தனை குழந்தை'],
  },
};

/** Default-ignorable code points (zero-width space and joiners, soft hyphen, variation selectors, …): invisible, so removed first. */
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;
export const stripIgnorable = (text: string) => text.replace(IGNORABLE, '');
const fold = (text: string) => stripIgnorable(text).normalize('NFKC').toLocaleLowerCase('en');
/** Words of a text in scripts written with spaces: letters, marks and digits (and inner hyphens) only. */
const wordsOf = (text: string) => fold(text).split(/[^\p{L}\p{M}\p{N}-]+/u).map((w) => w.replace(/^-+|-+$/g, '')).filter(Boolean);
/** The same words with every hyphenated word also split at its hyphens. */
const splitWords = (words: readonly string[]) => words.flatMap((w) => w.split('-').filter(Boolean));
const hasPhrase = (ws: readonly string[], p: readonly string[]) => p.length > 0 && ws.some((_, i) => p.every((w, k) => ws[i + k] === w));

/** The first sensitive category any of the texts names (labels in every locale, help text, option labels), or null. */
export function sensitiveCategory(texts: readonly (string | null | undefined)[]): SensitiveCategory | null {
  const present = texts.filter((t): t is string => typeof t === 'string' && stripIgnorable(t).trim() !== '');
  if (!present.length) return null;
  const whole = present.map(wordsOf);
  const split = whole.map(splitWords);
  const joined = present.map(fold);
  for (const category of SENSITIVE_CATEGORIES) {
    const { words, exact, anywhere } = SENSITIVE_WORDS[category];
    for (const phrase of words) {
      const p = wordsOf(phrase);
      if (whole.some((ws) => hasPhrase(ws, p)) || split.some((ws) => hasPhrase(ws, splitWords(p)))) return category;
    }
    for (const term of exact) {
      const t = splitWords(wordsOf(term)).join(' ');
      if (split.some((ws) => ws.join(' ') === t)) return category;
    }
    if (anywhere.some((term) => joined.some((x) => x.includes(fold(term))))) return category;
  }
  return null;
}

// ── Definitions ──────────────────────────────────────────────────────────────────────────────────────────────

export type CustomFieldInput = {
  kind?: unknown; type?: unknown; helpText?: unknown; required?: unknown; restricted?: unknown; enabled?: unknown;
  numberMin?: unknown; numberMax?: unknown; numberDecimals?: unknown;
} & Partial<Record<`label_${CustomFieldLocale}`, unknown>>;
export type ValidCustomField = {
  kind: CustomFieldKind; type: CustomFieldType; labels: CustomLabels; helpText: string | null; required: boolean; restricted: boolean; enabled: boolean;
  numberMin: string | null; numberMax: string | null; numberDecimals: number | null;
};
type Refusal = { ok: false; code: 'missing_fields' | 'invalid_input' | 'sensitive_field'; fields: string[]; category?: SensitiveCategory };

const text = (v: unknown) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');
const flag = (v: unknown) => v === true || v === 'on' || v === 'true' || v === '1';
/**
 * A decimal as typed: digits, an optional minus sign and a decimal POINT, with optional thousands commas ("1,234.5": groups of
 * exactly three digits after each comma). Its canonical text, or null when it is not one — a comma that is not a thousands
 * separator ("2,5") is refused rather than guessed at.
 */
export function decimalText(v: unknown): string | null {
  const raw = typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' ? stripIgnorable(v).trim() : '';
  if (!/^-?(\d+|\d{1,3}(,\d{3})+)(\.\d+)?$/.test(raw)) return null;
  const s = raw.replace(/,/g, '');
  if (!/^-?(\d{1,15})(\.\d+)?$/.test(s)) return null;
  const [int, frac = ''] = s.replace(/^-/, '').split('.');
  const intPart = int.replace(/^0+(?=\d)/, '');
  const fracPart = frac.replace(/0+$/, '');
  const body = fracPart ? `${intPart}.${fracPart}` : intPart;
  return s.startsWith('-') && body !== '0' ? `-${body}` : body;
}
const decimalsOf = (d: string) => (d.includes('.') ? d.split('.')[1].length : 0);
/** Compare two canonical decimal texts exactly (no floating point). */
export function compareDecimal(a: string, b: string): number {
  const neg = (x: string) => x.startsWith('-');
  if (neg(a) !== neg(b)) return neg(a) ? -1 : 1;
  const sign = neg(a) ? -1 : 1;
  const [ai, af = ''] = a.replace(/^-/, '').split('.');
  const [bi, bf = ''] = b.replace(/^-/, '').split('.');
  if (ai.length !== bi.length) return sign * (ai.length < bi.length ? -1 : 1);
  if (ai !== bi) return sign * (ai < bi ? -1 : 1);
  const n = Math.max(af.length, bf.length);
  const x = af.padEnd(n, '0'); const y = bf.padEnd(n, '0');
  return x === y ? 0 : sign * (x < y ? -1 : 1);
}

/** A field as typed by an administrator: labels (English required, ≤80 each), help text (≤200), type, flags and number settings.
 *  Refuses a CANDIDATE field whose labels or help text name a sensitive category (D-052; job fields are not checked). */
export function validateCustomFieldInput(input: CustomFieldInput): { ok: true; value: ValidCustomField } | Refusal {
  const labels = Object.fromEntries(CUSTOM_FIELD_LOCALES.map((l) => [l, text(input[`label_${l}`]) || null])) as CustomLabels;
  if (!labels.en) return { ok: false, code: 'missing_fields', fields: ['label_en'] };
  const fields: string[] = [];
  for (const l of CUSTOM_FIELD_LOCALES) if ((labels[l]?.length ?? 0) > CUSTOM_LABEL_MAX) fields.push(`label_${l}`);
  const kind = (CUSTOM_FIELD_KINDS as readonly unknown[]).includes(input.kind) ? (input.kind as CustomFieldKind) : null;
  if (!kind) fields.push('kind');
  const type = (CUSTOM_FIELD_TYPES as readonly unknown[]).includes(input.type) ? (input.type as CustomFieldType) : null;
  if (!type) fields.push('type');
  const helpText = text(input.helpText) || null;
  if ((helpText?.length ?? 0) > CUSTOM_HELP_MAX) fields.push('helpText');
  const restricted = flag(input.restricted);
  if (restricted && kind === 'job') fields.push('restricted');
  let numberMin: string | null = null; let numberMax: string | null = null; let numberDecimals: number | null = null;
  if (type === 'number') {
    const blank = (v: unknown) => v == null || (typeof v === 'string' && v.trim() === '');
    numberMin = blank(input.numberMin) ? null : decimalText(input.numberMin);
    if (!blank(input.numberMin) && numberMin === null) fields.push('numberMin');
    numberMax = blank(input.numberMax) ? null : decimalText(input.numberMax);
    if (!blank(input.numberMax) && numberMax === null) fields.push('numberMax');
    if (numberMin && numberMax && compareDecimal(numberMin, numberMax) > 0) fields.push('numberMax');
    const d = blank(input.numberDecimals) ? 0 : Number(input.numberDecimals);
    if (!Number.isInteger(d) || d < 0 || d > CUSTOM_DECIMALS_MAX) fields.push('numberDecimals');
    else numberDecimals = d;
    for (const [k, v] of [['numberMin', numberMin], ['numberMax', numberMax]] as const) {
      if (v && numberDecimals !== null && decimalsOf(v) > numberDecimals) fields.push(k);
    }
  }
  if (fields.length) return { ok: false, code: 'invalid_input', fields: [...new Set(fields)] };
  const category = kind === 'candidate' ? sensitiveCategory([...CUSTOM_FIELD_LOCALES.map((l) => labels[l]), helpText]) : null;
  if (category) return { ok: false, code: 'sensitive_field', fields: ['label_en'], category };
  return {
    ok: true,
    value: {
      kind: kind!, type: type!, labels, helpText, required: flag(input.required), restricted, enabled: input.enabled === undefined ? true : flag(input.enabled),
      numberMin, numberMax, numberDecimals,
    },
  };
}

export type CustomOptionInput = { enabled?: unknown } & Partial<Record<`label_${CustomFieldLocale}`, unknown>>;
/** An option as typed: labels (English required, ≤80 each). A CANDIDATE field's option labels are checked against the word list
 *  too (`kind` is the option's field's record kind). */
export function validateCustomOptionInput(input: CustomOptionInput, kind: CustomFieldKind): { ok: true; value: { labels: CustomLabels; enabled: boolean } } | Refusal {
  const labels = Object.fromEntries(CUSTOM_FIELD_LOCALES.map((l) => [l, text(input[`label_${l}`]) || null])) as CustomLabels;
  if (!labels.en) return { ok: false, code: 'missing_fields', fields: ['label_en'] };
  const long = CUSTOM_FIELD_LOCALES.filter((l) => (labels[l]?.length ?? 0) > CUSTOM_LABEL_MAX).map((l) => `label_${l}`);
  if (long.length) return { ok: false, code: 'invalid_input', fields: long };
  const category = kind === 'candidate' ? sensitiveCategory(CUSTOM_FIELD_LOCALES.map((l) => labels[l])) : null;
  if (category) return { ok: false, code: 'sensitive_field', fields: ['label_en'], category };
  return { ok: true, value: { labels, enabled: input.enabled === undefined ? true : flag(input.enabled) } };
}

/** The label in the viewer's locale, or English when that locale has none (or the locale is not one of the six). */
export function labelFor(labels: Partial<CustomLabels>, locale: string): string {
  const own = (CUSTOM_FIELD_LOCALES as readonly string[]).includes(locale) ? labels[locale as CustomFieldLocale] : null;
  return own?.trim() ? own : labels.en ?? '';
}

// ── Values ──────────────────────────────────────────────────────────────────────────────────────────────────

/** A field as the value rules need it (from the definition and its options). */
export type FieldRule = {
  id: string; type: CustomFieldType; required: boolean; enabled: boolean;
  numberMin: string | null; numberMax: string | null; numberDecimals: number | null;
  options: { id: string; enabled: boolean }[];
};
/** One stored value, typed: exactly one of these per record and field (a multiple-choice field: the chosen option ids). */
export type TypedValue =
  | { type: 'short_text' | 'long_text'; text: string }
  | { type: 'number'; number: string }
  | { type: 'date'; date: string }
  | { type: 'year_month'; date: string }
  | { type: 'single_choice' | 'multiple_choice'; optionIds: string[] }
  | { type: 'yes_no'; bool: boolean };
/** The raw form values: field id → the submitted string(s). */
export type RawCustomValues = Record<string, string | readonly string[] | undefined>;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
function realDate(s: string): boolean {
  const m = ISO_DATE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1900 || y > 2200 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

/** Whether a record can answer the field at all: a choice field needs a usable option — an enabled one, or one the record already
 *  chose. A required choice field without one is not enforced (it would block every save of every record). */
export function answerable(f: Pick<FieldRule, 'type' | 'options'>, previous?: TypedValue | null): boolean {
  if (f.type !== 'single_choice' && f.type !== 'multiple_choice') return true;
  const had = new Set(previous && 'optionIds' in previous ? previous.optionIds : []);
  return f.options.some((o) => o.enabled || had.has(o.id));
}

/**
 * Read and check the submitted values of the ENABLED fields (a disabled field's value is not touched): by type (text length,
 * a decimal within the range and decimals, a real date, a year and month, enabled options of the field and yes or no) and
 * required (on this save; a choice field with no usable option is not required). What the record ALREADY holds stays acceptable
 * unchanged — an option chosen before it was disabled, a number stored before the field's range or decimals were narrowed — and
 * is checked again only when it changes. `previous` is what the record holds now. Invisible characters (zero-width space, soft
 * hyphen, …) alone count as empty. Returns the typed value per field (null = empty, the value is cleared), or the refused ids.
 */
export function validateCustomValues(fields: readonly FieldRule[], raw: RawCustomValues, previous: ReadonlyMap<string, TypedValue> = new Map()):
  { ok: true; values: Map<string, TypedValue | null> } | { ok: false; code: 'custom_field_required' | 'custom_value_invalid'; fields: string[] } {
  const values = new Map<string, TypedValue | null>();
  const missing: string[] = []; const invalid: string[] = [];
  for (const f of fields) {
    if (!f.enabled) continue;
    const got = raw[f.id];
    const list = (Array.isArray(got) ? got : got === undefined ? [] : [got]).map((x) => String(x).trim()).filter((x) => stripIgnorable(x).trim() !== '');
    const one = list.length === 1 ? list[0] : list.length === 0 ? '' : null;
    const before = previous.get(f.id) ?? null;
    if (!list.length) {
      if (f.required && answerable(f, before)) missing.push(f.id);
      values.set(f.id, null);
      continue;
    }
    let v: TypedValue | null = null;
    switch (f.type) {
      case 'short_text': case 'long_text': {
        const max = f.type === 'short_text' ? CUSTOM_SHORT_TEXT_MAX : CUSTOM_LONG_TEXT_MAX;
        const t = one === null ? null : f.type === 'short_text' ? one.replace(/\s+/g, ' ') : one.replace(/\r\n?/g, '\n');
        if (t !== null && t.length <= max) v = { type: f.type, text: t };
        break;
      }
      case 'number': {
        const d = one === null ? null : decimalText(one);
        const unchanged = d !== null && before?.type === 'number' && compareDecimal(before.number, d) === 0;
        if (d !== null && (unchanged || (decimalsOf(d) <= (f.numberDecimals ?? 0) && (!f.numberMin || compareDecimal(d, f.numberMin) >= 0)
          && (!f.numberMax || compareDecimal(d, f.numberMax) <= 0)))) v = { type: 'number', number: unchanged ? (before as { number: string }).number : d };
        break;
      }
      case 'date': if (one !== null && realDate(one)) v = { type: 'date', date: one }; break;
      case 'year_month': if (one !== null && /^\d{4}-\d{2}$/.test(one) && realDate(`${one}-01`)) v = { type: 'year_month', date: `${one}-01` }; break;
      case 'yes_no': if (one === 'yes' || one === 'no') v = { type: 'yes_no', bool: one === 'yes' }; break;
      case 'single_choice': case 'multiple_choice': {
        const ids = [...new Set(list)];
        const had = new Set(before && 'optionIds' in before ? before.optionIds : []);
        const usable = (id: string) => f.options.some((o) => o.id === id && (o.enabled || had.has(id)));
        if ((f.type === 'multiple_choice' || ids.length === 1) && ids.length <= CUSTOM_OPTIONS_MAX && ids.every((id) => isUuid(id) && usable(id))) {
          v = { type: f.type, optionIds: ids };
        }
        break;
      }
    }
    if (v) values.set(f.id, v);
    else invalid.push(f.id);
  }
  if (invalid.length) return { ok: false, code: 'custom_value_invalid', fields: invalid };
  if (missing.length) return { ok: false, code: 'custom_field_required', fields: missing };
  return { ok: true, values };
}

/** A form's custom values (`cf.<field id>` entries), or undefined when the form did not carry its custom fields (then the values
 *  are left as they are). A field with no entry is empty. */
export function customValuesFromForm(form: Pick<FormData, 'has' | 'entries'>): RawCustomValues | undefined {
  if (!form.has(CUSTOM_FORM_MARKER)) return undefined;
  const out: Record<string, string[]> = {};
  for (const [k, v] of form.entries()) {
    if (k === CUSTOM_FORM_MARKER || !k.startsWith('cf.') || typeof v !== 'string') continue;
    const id = k.slice(3);
    if (isUuid(id)) (out[id] ??= []).push(v);
  }
  return out;
}

/** Whether two stored values are the same (an unchanged value is not rewritten). */
export function sameValue(a: TypedValue | null | undefined, b: TypedValue | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  if (a.type !== b.type) return false;
  if ('optionIds' in a && 'optionIds' in b) return a.optionIds.length === b.optionIds.length && [...a.optionIds].sort().join() === [...b.optionIds].sort().join();
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The value as a form shows it back (input value, or the chosen option ids). */
export function formValue(v: TypedValue | null | undefined): string | string[] {
  if (!v) return '';
  switch (v.type) {
    case 'short_text': case 'long_text': return v.text;
    case 'number': return v.number;
    case 'date': return v.date;
    case 'year_month': return v.date.slice(0, 7);
    case 'yes_no': return v.bool ? 'yes' : 'no';
    default: return v.optionIds;
  }
}

// ── The one-field filter ───────────────────────────────────────────────────────────────────────────────────

/** "Filter by a custom field": one field and one answer — an option id, or yes / no. Sent as `<field id>:<option id|yes|no>`. */
export type CustomFilter = { fieldId: string; optionId: string } | { fieldId: string; bool: boolean };
export function parseCustomFilter(value: unknown): CustomFilter | null {
  if (typeof value !== 'string') return null;
  const [fieldId, answer, ...rest] = value.split(':');
  if (rest.length || !isUuid(fieldId)) return null;
  if (answer === 'yes' || answer === 'no') return { fieldId, bool: answer === 'yes' };
  return isUuid(answer) ? { fieldId, optionId: answer } : null;
}
export const customFilterKey = (f: CustomFilter) => `${f.fieldId}:${'optionId' in f ? f.optionId : f.bool ? 'yes' : 'no'}`;

/** Move one item up or down in an ordered list of ids: the new order, or null when it cannot move. */
export function moveInOrder(ids: readonly string[], id: string, direction: unknown): string[] | null {
  const i = ids.indexOf(id);
  const j = direction === 'up' ? i - 1 : direction === 'down' ? i + 1 : -1;
  if (i < 0 || j < 0 || j >= ids.length) return null;
  const next = [...ids];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}
