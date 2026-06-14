export const meta = {
  name: 'i18n-kb',
  description: 'Translate the new Knowledge Base (kb) namespace + nav.knowledgeBase into zh/ms/ta/th/vi',
  phases: [{ title: 'Translate', detail: 'one agent per locale merges the kb translations into its catalog' }],
}

const RULES = `
You are translating the NEW Knowledge Base UI strings for the ai-hr app (a Malaysia-first HRMS) into one
target language. Working dir is the repo root.

SOURCE: messages/en.json — translate ONLY (a) the entire "kb" namespace object and (b) the single key
"nav.knowledgeBase". Leave every other key untouched.

TASK:
1. Read messages/en.json to get the English "kb" object and "nav.knowledgeBase".
2. Read messages/<LOCALE>.json (it already has the full catalog; "nav" exists, "kb" does NOT yet).
3. Add a translated "kb" object (same keys/nesting as en.json's kb) and set nav.knowledgeBase, into the
   locale catalog — WITHOUT changing any other existing key. Preserve the file's overall structure.
4. Write messages/<LOCALE>.json back (valid JSON, every value a string, trailing newline).

PRESERVE EXACTLY: ICU placeholders + structure — {q}, {mb}, {date}, {size}, {type}, and the plural block
{count, plural, one {# document} other {# documents}} (keep variable names, braces, '#', plural/one/other;
translate only the words; for languages with no plural keep both arms with natural wording). Keep brand /
acronyms verbatim: AI HR, EPF, SOCSO, EIS, PCB, MYR, RM, CSV, Markdown. "Knowledge Base" is the product
term — translate it naturally for the market.

Return the count of kb leaf keys you wrote.
`

const LOCALES = [
  { code: 'zh', name: 'Simplified Chinese (简体中文)' },
  { code: 'ms', name: 'Bahasa Melayu' },
  { code: 'ta', name: 'Tamil (தமிழ்) — best-effort, flagged for native review' },
  { code: 'th', name: 'Thai (ไทย) — unspaced; best-effort, flagged for native review' },
  { code: 'vi', name: 'Vietnamese (Tiếng Việt)' },
]

const SCHEMA = {
  type: 'object',
  required: ['locale', 'kbKeys', 'wrote'],
  additionalProperties: false,
  properties: {
    locale: { type: 'string' },
    kbKeys: { type: 'number' },
    wrote: { type: 'boolean' },
    notes: { type: 'array', items: { type: 'string' } },
  },
}

const results = await parallel(
  LOCALES.map((l) => () =>
    agent(
      `${RULES}\n\nTARGET LANGUAGE: ${l.name}\nLOCALE: ${l.code}\nFILE TO UPDATE: messages/${l.code}.json\n\nDo it now: read en.json + messages/${l.code}.json, add the translated kb object and nav.knowledgeBase, write messages/${l.code}.json.`,
      { label: `kb:${l.code}`, phase: 'Translate', schema: SCHEMA },
    ),
  ),
)
const ok = results.filter(Boolean)
for (const r of ok) log(`${r.locale}: ${r.kbKeys} kb keys`)
return { done: ok.map((r) => r.locale) }
