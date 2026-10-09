# Fontkit import entry point

FACT: Next.js 16.3.8 external tracing selected `fontkit@1.9.0`'s ESM entry point and a privately
hoisted `@swc/helpers@0.5.23` in the main worktree, refusing its legacy named helper export. The same
locked packages built in a worktree with helpers 0.3.17 hoisted. Fontkit's own declared dependency
resolved to 0.3.17 in both installs; changing only the lockfile did not eliminate the tracing difference.

The patch changes only `exports.import` to the existing `dist/main.cjs`, already selected by
`exports.require`. It preserves fontkit 1.9.0, the lazy import, its font/subset algorithms and all
runtime dependencies. `serverExternalPackages: ['fontkit']` remains required. Frozen pnpm installs
apply the patch through `pnpm-workspace.yaml` and its locked hash.

Do not replace this with `@pdf-lib/fontkit` or fontkit 2.x without revalidating multilingual glyph
rendering; `lib/payslip-pdf-fonts.ts` records the verified subsetter compatibility constraint.
Before removing the patch, test a production build with helpers 0.5.x privately hoisted and inspect
rendered Chinese, Tamil, Thai and Vietnamese output.
