/**
 * RSC server/client boundary guard (added after b7d84266 — a live P0).
 *
 * A Server Component (app/**\/page.tsx WITHOUT a 'use client' directive) may RENDER a component
 * exported from a 'use client' module (that's the normal island pattern), but it may NOT CALL a plain
 * function/value exported from one — Next.js throws at render time:
 *   "Attempted to call X() from the server but X is on the client."
 * That is a runtime error: tsc, next build, and the whole vitest suite all pass while the page is down.
 * This static guard catches the class before deploy: for every server page, it flags any import of a
 * lowercase-named export (a function/value, not a Component) from a 'use client' module that is then
 * *called* (`name(`) in the page. Fix by moving the pure helper into a non-'use client' sibling module.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === '.git') continue;
    const p = `${dir}/${name}`;
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name === 'page.tsx') out.push(p);
  }
  return out;
}

/** Resolve an import specifier (from a page) to a file path, or null. */
function resolveModule(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = root + spec.slice(2);
  else if (spec.startsWith('.')) {
    const dir = fromFile.slice(0, fromFile.lastIndexOf('/'));
    base = new URL(spec + '_', 'file://' + dir + '/').pathname.replace(/_$/, '');
  } else return null; // package import — not ours
  for (const cand of [base + '.tsx', base + '.ts', base + '/index.tsx', base + '/index.ts']) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

function isClientModule(path: string): boolean {
  const src = readFileSync(path, 'utf8').trimStart();
  return src.startsWith("'use client'") || src.startsWith('"use client"');
}

describe('RSC boundary: server pages must not call functions imported from client modules', () => {
  const pages = walk(root + 'app');
  const violations: string[] = [];

  for (const page of pages) {
    const src = readFileSync(page, 'utf8');
    if (src.trimStart().startsWith("'use client'") || src.trimStart().startsWith('"use client"')) continue; // client page — fine

    const importRe = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(src))) {
      const mod = resolveModule(m[2], page);
      if (!mod || !isClientModule(mod)) continue;
      const names = m[1]
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith('type ')) // type-only imports are erased, never called
        .map((s) => s.split(' as ').pop()!.trim());
      for (const name of names) {
        if (!/^[a-z]/.test(name)) continue; // Uppercase = Component, rendered as JSX — allowed
        // flag only if actually CALLED in the page (name followed by "(")
        if (new RegExp(`\\b${name}\\s*\\(`).test(src)) {
          violations.push(`${page.slice(root.length)} calls ${name}() imported from a 'use client' module (${m[2]})`);
        }
      }
    }
  }

  it('has no server-page that calls a function from a use-client module', () => {
    expect(violations, `RSC boundary violations (move the pure helper into a non-'use client' module):\n${violations.join('\n')}`).toEqual([]);
  });
});
