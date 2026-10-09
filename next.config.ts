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
   * newer, hoisted `@swc/helpers` selected by the build tracer. Bundled, every payslip PDF route answers 500 with
   * "export 'applyDecoratedDescriptor' was not found … Did you mean _apply_decorated_descriptor?".
   * Observed on a dev server on 2026-09-24, on both PDF routes; the vitest suite is green either way
   * because Node resolves the CJS build (`dist/main.cjs`), which is correct.
   *
   * Listing it here makes Next `require()` it from node_modules at runtime, which is the CJS build, which
   * works — and keeps 1.5 MB of font parser out of the server bundle. Do not remove this line without
   * rendering a Chinese payslip through a running server and looking at the result (CLAUDE.md §8).
   * Next 16.3 also traces external dynamic imports. The one-line fontkit export-map patch selects its
   * same verified CJS build for imports, making tracing independent of the private helper hoist.
   */
  serverExternalPackages: ['fontkit'],

  /**
   * r394 — how long a FULLY prefetched route (components/intent-link.tsx: the sidebar prefetches the whole
   * page on hover/focus) may be reused from the client router cache. Next's default for full prefetches is
   * 5 minutes, which on an HR system could show a leave list or a balance that has already changed; 30 s
   * (Next's minimum) covers hover-to-click and quick back-and-forth, and every server action that changes
   * data already calls revalidatePath, which clears it. `dynamic` stays at its default of 0: a page reached
   * WITHOUT a prefetch is always rendered fresh.
   */
  experimental: { staleTimes: { static: 30 } },

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
          // 'self', NOT 'none'. The Knowledge Base renders an in-product PDF preview as
          // <iframe src="/knowledge-base/<id>/download?inline=1"> (app/knowledge-base/[id]/page.tsx),
          // which is same-origin — 'none' refuses to frame our own document and the preview goes blank.
          // 'self' still blocks every cross-origin frame, which is the clickjacking the header is for.
          { key: 'Content-Security-Policy', value: "frame-ancestors 'self'; object-src 'none'; base-uri 'self'" },
          // SAMEORIGIN for the same reason: X-Frame-Options has no 'self', and DENY would break that
          // preview in any browser that still honours this header over CSP frame-ancestors.
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          // geolocation=(self), NOT (). ADR-0070 clock-in captures coordinates via
          // navigator.geolocation.getCurrentPosition (components/attendance-clock-button.tsx); an empty
          // allowlist disables the API for the whole document, so self-service clock-in would silently
          // stop recording where the employee was — a feature loss dressed as a security header.
          // camera and microphone stay fully denied: nothing in the product uses either.
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self)' },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
