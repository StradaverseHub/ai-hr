# ADR-0016 — UI internationalization (multi-language packs)

Status: **Accepted** · Date: 2026-06-14

## Context

The product is Malaysia-first and the workforce reading it is multilingual: Bahasa Melayu, Mandarin,
and Tamil are everyday languages on a Malaysian shop floor, and the same engine is meant to serve
neighbouring markets (Thailand, Vietnam) next. Until now every visible string was a hardcoded English
literal across ~47 component files. We want the UI translatable without:

- forcing a URL-locale scheme (`/en/...`, `/ms/...`) onto an internal app that already sits behind
  auth and a cookie-based dev identity;
- blocking the feature on professionally-translated copy for five languages (we don't have it yet);
- conflating **display language** with the **statutory localization packs** of ADR-0008. Those packs
  decide *which country's* payroll/leave/tax rules apply. Language is orthogonal: a Mandarin-reading
  HR admin in KL still runs the Malaysian EPF/SOCSO/PCB rules. The two axes must never couple.

The user's scope decision: ship the **foundation + all five languages machine-drafted with English
fallback**, plus **a translation export/import framework** so a human can later export the strings,
match/fill them, and import the corrected copy back — without a developer touching JSON by hand.

## Decision

### 1. next-intl, cookie-scoped, no URL routing

Adopt `next-intl` (v4). Locale is carried by a `NEXT_LOCALE` cookie, resolved server-side in
`i18n/request.ts` via `getRequestConfig`; there is no `[locale]` URL segment and no middleware
rewrite. This matches the existing app shape (cookie-based company scope and dev identity) and keeps
deep links stable. `app/layout.tsx` wraps the tree in `<NextIntlClientProvider>` (messages are
inherited from the request config) and sets `<html lang>` dynamically from `getLocale()`.

Supported locales (`i18n/config.ts`): `en` (source), `zh` (Simplified, zh-Hans), `ms`, `ta`, `th`,
`vi`. The switcher lists each language by its **endonym** (简体中文, Bahasa Melayu, தமிழ், ไทย,
Tiếng Việt).

### 2. English is the source and the fallback

`messages/en.json` is canonical: it defines which keys exist. Each other catalog is a (possibly
partial) overlay. `i18n/request.ts` deep-merges the locale catalog over English so any **missing or
blank** key renders the English string rather than a raw `nav.dashboard` key. This is what makes
"machine-drafted, fill in later" safe to ship: a half-translated catalog degrades to English, never to
broken keys. Catalogs are nested string maps (namespaced `common` / `nav` / `dashboard` / …), never
arrays.

### 3. Translation matrix: export → match → import

The round-trip a non-developer uses to supply real translations (`scripts/i18n-lib.ts` +
`i18n-export.ts` + `i18n-import.ts`, wired as `pnpm i18n:export` / `pnpm i18n:import`):

- **Export** flattens every catalog into one CSV — columns `key, en, zh, ms, ta, th, vi`, one row per
  leaf key, English source in view beside each language. Prints per-locale coverage.
- A translator fills the blank cells in the CSV (any spreadsheet).
- **Import** reads the CSV back, rebuilds each `messages/<locale>.json` in English's key order,
  writing **only non-blank cells** (blanks stay blank so English fallback keeps rendering). Keys
  absent from English are dropped; the `en` column is never written back.

The round-trip is **lossless and idempotent** — export-then-import with no edits produces a zero diff.
The CSV (`messages/*.csv`) is a regenerable working artifact and is git-ignored.

### 4. Script-font coverage without a web-font download

CJK, Thai, and Tamil need glyphs the Latin display font (Plus Jakarta Sans) doesn't carry. Rather than
self-hosting large CJK web fonts (which `next/font` handles poorly) or adding a render-blocking Google
Fonts `<link>`, the `--font-sans` token carries an **OS-native script fallback chain** (PingFang SC /
Hiragino / Microsoft YaHei / Noto CJK; Thonburi / Leelawadee / Noto Thai; Tamil Sangam MN / Nirmala /
Noto Tamil). Per-glyph fallback walks the chain until a font has the glyph, so Latin runs on Jakarta
and non-Latin text uses whatever script font the user's OS already ships — zero extra bytes. If a
target OS lacks a script font we can add a self-hosted Noto subset later without touching call sites.

## Consequences

- **Foundation only.** This slice extracts and wires the **navigation** strings (sidebar) as the proof
  surface, plus `common`/`dashboard` shells. The remaining ~500–800 page strings are migrated
  incrementally page-by-page using the same `useTranslations` pattern; each new key lands in
  `messages/en.json` and flows through the export/import matrix.
- **Machine drafts are provisional.** `zh`/`ms`/`vi` drafts are reasonable; `ta`/`th` are best-effort
  and flagged for native review. The export/import loop is the correction mechanism — no code change
  needed to fix copy.
- **Language ≠ pack.** Switching display language never changes statutory behaviour (ADR-0008). The two
  remain separate axes by construction: locale lives in a cookie read by `i18n/request.ts`; packs are
  selected by company country.
- A client component closing the switcher menu must not unmount the server-action `<form>` in its click
  handler — React flushes discrete events synchronously, which would cancel the native submit. The menu
  is hidden via `hidden`, not unmounted, so the locale submit always fires.

## Alternatives considered

- **URL-routed locales (`/[locale]/...`)** — next-intl's default. Rejected: forces middleware and
  rewrites every route for an internal, auth-gated, cookie-driven app, and breaks existing deep links
  for no benefit here.
- **Translate everything up front with professional copy** — not available, and would block the
  feature indefinitely. English-fallback + import loop ships value now and improves continuously.
- **Self-hosted CJK/Thai/Tamil web fonts** — large payloads, `next/font` CJK ergonomics are poor, and
  most users already have OS script fonts. Deferred until a real tofu report justifies it.
- **Bake translations into a DB table** — over-engineered for UI chrome; JSON catalogs are diffable,
  reviewable in PRs, and edited through the CSV loop without a migration.
