export const meta = {
  name: 'i18n-onboarding',
  description: 'Translate the onboarding namespace into zh/ms/ta/th/vi',
  phases: [{ title: 'Translate', detail: 'one agent per locale merges the onboarding translations into its catalog' }],
}

const RULES = `
Translate the NEW onboarding (product-tour) UI strings for the ai-hr app (a Malaysia-first HRMS) into one
target language. Working dir is the repo root.

SOURCE: messages/en.json — translate ONLY the entire "onboarding" namespace object. Leave every other key.

TASK:
1. Read messages/en.json to get the English "onboarding" object.
2. Read messages/<LOCALE>.json (it already has the full catalog; "onboarding" does NOT exist yet).
3. Add a translated "onboarding" object (same keys as en.json's onboarding) into the locale catalog,
   WITHOUT changing any other key. Write messages/<LOCALE>.json (valid JSON, trailing newline).

PRESERVE EXACTLY: ICU placeholders — {current} and {total} in stepOf (keep names + braces). Keep emoji
(👋 🎉) as-is. Keep the language endonyms in onboarding.languageBody verbatim: 简体中文, Bahasa Melayu,
தமிழ், ไทย, Tiếng Việt. Keep the brand "AI HR" and the product term "Knowledge Base" (translate the latter
naturally for the market, consistent with how you translated it in the kb namespace).

TONE: warm, short, friendly first-run copy. Return the count of onboarding leaf keys written.
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
      `${RULES}\n\nTARGET LANGUAGE: ${l.name}\nLOCALE: ${l.code}\nFILE: messages/${l.code}.json\n\nDo it now: read en.json + messages/${l.code}.json, add the translated onboarding object, write messages/${l.code}.json.`,
      { label: `onboarding:${l.code}`, phase: 'Translate', schema: SCHEMA },
    ),
  ),
)
const ok = results.filter(Boolean)
for (const r of ok) log(`${r.locale}: ${r.keys} keys`)
return { done: ok.map((r) => r.locale) }
