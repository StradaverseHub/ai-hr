import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

const nextConfig: NextConfig = {
  /**
   * 5b2a7f0f — `fontkit` IS REQUIRED AT RUNTIME, NOT BUNDLED, AND THAT IS NOT A PREFERENCE.
   *
   * `lib/payslip-pdf-fonts.ts` loads fontkit so pdf-lib can subset the Unicode faces the payslip needs.
   * fontkit ships two builds; Turbopack picks the ESM one, `dist/module.mjs`, which does
   * `import { applyDecoratedDescriptor } from '@swc/helpers'` — an export that no longer exists in the
   * `@swc/helpers` its own range resolves to. Bundled, every payslip PDF route answers 500 with
   * "export 'applyDecoratedDescriptor' was not found … Did you mean _apply_decorated_descriptor?".
   * Observed on a dev server on 2026-09-24, on both PDF routes; the vitest suite is green either way
   * because Node resolves the CJS build (`dist/main.cjs`), which is correct.
   *
   * Listing it here makes Next `require()` it from node_modules at runtime, which is the CJS build, which
   * works — and keeps 1.5 MB of font parser out of the server bundle. Do not remove this line without
   * rendering a Chinese payslip through a running server and looking at the result (CLAUDE.md §8).
   */
  serverExternalPackages: ['fontkit'],
};

export default withNextIntl(nextConfig);
