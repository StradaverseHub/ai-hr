export const meta = {
  name: 'i18n-translate',
  description: 'Translate the full English message catalog into zh/ms/ta/th/vi, then verify parity + ICU integrity',
  phases: [
    { title: 'Translate', detail: 'one agent per language writes its complete messages/<locale>.json' },
    { title: 'Verify', detail: 'a second agent checks key parity + ICU placeholders + leftover English' },
  ],
}

const RULES = `
PROJECT: ai-hr, a Malaysia-first commercial HRMS. messages/en.json is the canonical English UI catalog
(nested namespaces, ~789 leaf strings). You are producing the catalog for ONE target language.

OUTPUT FILE: messages/<LOCALE>.json — mirror en.json's structure EXACTLY (same keys, same nesting, same order).
Replace every leaf STRING VALUE with its translation. Do not add, remove, rename, or re-nest keys.

PRESERVE EXACTLY (do NOT translate):
- ICU placeholders and structure: {count}, {total}, {name}, {date}, {amount}, and plural/select blocks like
  {d, plural, one {# day} other {# days}}. Keep the variable NAMES, the braces, the '#', and the
  plural/select keywords ('plural', 'one', 'other', 'select') verbatim. Translate ONLY the human words inside
  the {one {...}} / {other {...}} sub-messages. For languages with no grammatical plural (zh, ms, th, vi),
  keep BOTH 'one' and 'other' present and put the natural form in each (they may be identical).
- Non-letter glue inside strings: · – — / : % and the currency token 'RM', 'MYR'.
- Proper nouns / brand / statutory acronyms — keep verbatim: AI HR, Malaysia, EPF, KWSP, SOCSO, PERKESO,
  EIS, SIP, PCB, MTD, LHDN, MyInvois, CP39, CP22, CP22A, TP1, TP3, EA, Form E, CP8D, IC, MYR, RM, CSV.
  (You MAY localize the surrounding words.)

TONE: concise UI/product language a payroll/HR user in that market expects. Use the conventional local term for
HR/payroll concepts (e.g. ms: Gaji, Cuti, Caruman, Kehadiran; zh: 薪资, 休假, 考勤, 缴纳). Keep it short enough to
fit buttons/labels.

VALIDITY: the file MUST be valid JSON (UTF-8). Every value a string. No trailing commas. End with a newline.
`

const LOCALES = [
  { code: 'zh', name: 'Simplified Chinese (zh-Hans, 简体中文)', note: 'Use Simplified characters and Mainland China conventions. No grammatical plural — keep ICU plural blocks but use the same wording in one/other.' },
  { code: 'ms', name: 'Bahasa Melayu (Malaysian Malay)', note: 'Standard Malaysian Malay as used in MY HR/payroll. No grammatical plural — keep ICU blocks, same wording in one/other.' },
  { code: 'ta', name: 'Tamil (தமிழ்)', note: 'Malaysian Tamil register. Best-effort; this catalog is flagged for native review. Keep ICU structure; Tamil has one/other plural.' },
  { code: 'th', name: 'Thai (ไทย)', note: 'Best-effort; flagged for native review. No grammatical plural — keep ICU blocks, same wording in one/other. No spaces between Thai words.' },
  { code: 'vi', name: 'Vietnamese (Tiếng Việt)', note: 'Standard Vietnamese with proper diacritics. No grammatical plural — keep ICU blocks, same wording in one/other.' },
]

const TRANSLATE_SCHEMA = {
  type: 'object',
  required: ['locale', 'leafCount', 'wrote'],
  additionalProperties: false,
  properties: {
    locale: { type: 'string' },
    leafCount: { type: 'number' },
    wrote: { type: 'boolean' },
    notes: { type: 'array', items: { type: 'string' } },
  },
}

const VERIFY_SCHEMA = {
  type: 'object',
  required: ['locale', 'enLeafCount', 'localeLeafCount', 'parity', 'issuesFixed'],
  additionalProperties: false,
  properties: {
    locale: { type: 'string' },
    enLeafCount: { type: 'number' },
    localeLeafCount: { type: 'number' },
    parity: { type: 'boolean' },
    placeholdersOk: { type: 'boolean' },
    issuesFixed: { type: 'number' },
    untranslatedSuspects: { type: 'array', items: { type: 'string' } },
    notes: { type: 'array', items: { type: 'string' } },
  },
}

const results = await pipeline(
  LOCALES,
  (l) =>
    agent(
      `${RULES}\n\nTARGET LANGUAGE: ${l.name}\nLOCALE CODE: ${l.code}\nLANGUAGE NOTE: ${l.note}\n\nSTEPS:\n1. Read messages/en.json (the full English catalog).\n2. Produce the complete translated catalog for ${l.code}, mirroring en.json structure exactly.\n3. Write messages/${l.code}.json with the full translated catalog (overwrite the existing partial file).\nReturn how many leaf strings you wrote.`,
      { label: `translate:${l.code}`, phase: 'Translate', schema: TRANSLATE_SCHEMA },
    ),
  (_t, l) =>
    agent(
      `${RULES}\n\nVERIFY the translation for ${l.name} (${l.code}).\n\nSTEPS:\n1. Read messages/en.json and messages/${l.code}.json.\n2. Check KEY PARITY: ${l.code} must have exactly the same set of leaf keys as en.json (no missing, no extra). If any key is missing, add it (translated). If any extra/renamed, fix it.\n3. Check ICU INTEGRITY for every value: same placeholder variable names as the English source, intact {…} braces, intact plural/select structure and '#'. Fix any value whose placeholders drifted from English.\n4. Check for LEFTOVER ENGLISH: values still in English that should be translated (ignore allowed proper nouns / acronyms / RM / MYR / AI HR). Translate any you find.\n5. Ensure the file is valid JSON ending in a newline. Write the corrected messages/${l.code}.json.\nReturn the parity + placeholder status and how many issues you fixed.`,
      { label: `verify:${l.code}`, phase: 'Verify', schema: VERIFY_SCHEMA },
    ),
)

const ok = results.filter(Boolean)
for (const r of ok) {
  log(`${r.locale}: ${r.localeLeafCount}/${r.enLeafCount} keys, parity=${r.parity}, placeholdersOk=${r.placeholdersOk}, fixed=${r.issuesFixed}`)
}

return {
  locales: ok.map((r) => ({
    locale: r.locale,
    parity: r.parity,
    placeholdersOk: r.placeholdersOk,
    enLeafCount: r.enLeafCount,
    localeLeafCount: r.localeLeafCount,
    issuesFixed: r.issuesFixed,
    untranslatedSuspects: (r.untranslatedSuspects ?? []).slice(0, 10),
  })),
}
