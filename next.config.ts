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

  /**
   * Security (assessment 2026-09, findings M5/H3). Global response headers. Applied to every route so a
   * new page cannot forget them. The CSP is deliberately the SAFE subset — `frame-ancestors` (anti
   * clickjacking of HR/payroll screens), `object-src 'none'` and `base-uri 'self'` — and NOT a
   * `script-src` policy, which would need nonce wiring through the App Router and risks breaking the app;
   * that is a tracked follow-up. `X-Content-Type-Options: nosniff` here backstops the per-route nosniff on
   * attachment serving (lib/attachment-response.ts). HSTS is inert over plain HTTP and takes effect once
   * TLS fronts the app.
   */
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'" },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
