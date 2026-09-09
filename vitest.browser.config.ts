import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

/**
 * The REAL-BROWSER project (r93). Separate config, separate command: `pnpm test:browser`.
 *
 * WHY IT IS NOT IN THE DEFAULT GATE. A browser test is slower and more failure-prone than a unit test,
 * and `pnpm vitest run` is the 6013-test suite this project's whole release gate rests on. A flaky
 * browser test must not be able to turn that red. Promote this into the gate only once it has a track
 * record — and say so in HANDOFF.md when it happens.
 *
 * WHAT IT BUYS, and it is the one thing nothing else here can do: REAL CSS. jsdom applies no stylesheet
 * and computes no layout, so it cannot see the class of bug 4dbe04c6 was — `${inputCls} w-28` losing to
 * the `w-full` inside inputCls, because Tailwind's emission order decides the winner, not the order of
 * the class attribute. Reading the source concluded the width was set. Only getComputedStyle in a real
 * engine can settle it.
 *
 * Tailwind is compiled for real: importing app/globals.css puts the request through Vite's postcss
 * pipeline, which is the same @tailwindcss/postcss plugin the app builds with.
 *
 * `provider: playwright({...})` is a FUNCTION from @vitest/browser-playwright, not the string
 * 'playwright' that older Vitest used — the providers were split into their own packages in v4.
 * Browser binaries live in ~/Library/Caches/ms-playwright and are installed with
 * `pnpm exec playwright install chromium`.
 */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
    /**
     * ONE React, or hooks break in a way that reads like a component bug (r256).
     * Vite's dep optimizer runs per discovered graph, and two passes produce two React copies:
     * react-dom then installs the hook dispatcher on one copy's shared internals while a component
     * imported through the other reads `null`. The symptom is
     * `TypeError: Cannot read properties of null (reading 'useContext')` thrown from inside a library
     * (lucide-react, for us) — nothing points at the real cause, and the test looks like it broke the
     * component it renders.
     */
    dedupe: ['react', 'react-dom'],
  },
  /**
   * WHY THESE ARE LISTED BY HAND. The dep scanner is STATIC: a test that reaches a component through
   * `await import(...)` — which test/topbar-identity-width.browser.test.tsx must do, so `vi.mock` lands
   * before the module loads — hides that component's whole import graph from it. Those deps are then
   * discovered at runtime, forcing a SECOND optimize pass, which is what duplicates React and also
   * makes the first run after a cold cache fail outright with
   * "Vite unexpectedly reloaded a test" and zero tests collected.
   *
   * So: anything a browser test reaches only through a dynamic import belongs here. The list is
   * everything components/user-menu.tsx pulls in, plus the render harness itself.
   */
  optimizeDeps: {
    include: [
      'react',
      'react/jsx-dev-runtime',
      'react-dom',
      'react-dom/client',
      'react-dom/server',
      '@testing-library/react',
      'next-intl',
      'next/link',
      'lucide-react',
      '@radix-ui/react-slot',
      'class-variance-authority',
      'clsx',
      'tailwind-merge',
    ],
  },
  test: {
    name: 'browser',
    include: ['test/**/*.browser.test.tsx'],
    setupFiles: ['./test/browser-setup.ts'],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: 'chromium' }],
    },
  },
});
