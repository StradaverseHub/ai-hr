export const meta = {
  name: 'i18n-guidetours',
  description: 'Translate the onboarding.tour.* walkthrough steps + kb.startWalkthrough into zh/ms/ta/th/vi',
  phases: [{ title: 'Translate', detail: 'one agent per locale merges the new tour-step translations' }],
}

const RULES = `
Translate the NEW in-product walkthrough strings for the ai-hr app (a Malaysia-first HRMS) into one
target language. Working dir is the repo root.

SOURCE: messages/en.json. Translate ONLY:
  (a) the "onboarding.tour" object (nested as onboarding.tour.<module>.<step>.{title,body}), and
  (b) the single key "kb.startWalkthrough".
Leave every other key untouched.

TASK:
1. Read messages/en.json to get en.onboarding.tour and en.kb.startWalkthrough.
2. Read messages/<LOCALE>.json (it already has the full catalog; onboarding.tour does NOT exist yet).
3. Set messages/<LOCALE>.json's onboarding.tour to the translated object (same nested keys), and set its
   kb.startWalkthrough — WITHOUT changing any other key. Write the file (valid JSON, trailing newline).

PRESERVE EXACTLY: Markdown emphasis like **Request leave** (keep the ** and translate the words inside),
inline code in backticks like \`hr_admin\` / \`super_admin\` (keep verbatim), and brand/acronyms:
AI HR, EPF, SOCSO, EIS, PCB, MTD, LHDN, EA, Form E, CP22, CP22A, CP39, MYR, RM, CSV. The product terms
"Knowledge Base" and module names translate naturally (consistent with the existing nav/kb translations).

TONE: short, friendly, action-oriented walkthrough copy. Return the count of tour leaf keys written.
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
  required: ['locale', 'keys', 'wrote'],
  additionalProperties: false,
  properties: {
    locale: { type: 'string' },
    keys: { type: 'number' },
    wrote: { type: 'boolean' },
    notes: { type: 'array', items: { type: 'string' } },
  },
}

const results = await parallel(
  LOCALES.map((l) => () =>
    agent(
      `${RULES}\n\nTARGET LANGUAGE: ${l.name}\nLOCALE: ${l.code}\nFILE: messages/${l.code}.json\n\nDo it now.`,
      { label: `gt:${l.code}`, phase: 'Translate', schema: SCHEMA },
    ),
  ),
)
const ok = results.filter(Boolean)
for (const r of ok) log(`${r.locale}: ${r.keys} keys`)
return { done: ok.map((r) => r.locale) }
