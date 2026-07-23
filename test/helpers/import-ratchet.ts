/**
 * Import-ratchet helper (ADR-0080 D7/D9) — the reusable mechanics behind every pack drift guard.
 *
 * A drift guard protects a pack boundary (a directory, e.g. `localization/my`): source files
 * outside the boundary must not import into it, except (a) a small set of ALWAYS-allowed importers
 * (the pack's own wiring: registry, contract file, build script) and (b) a checked-in ALLOWLIST of
 * pre-existing leaks, audited when the guard was seeded. Ratchet semantics:
 *
 *   - a file importing the boundary that is in neither set  → VIOLATION (the leak may not grow);
 *   - an allowlist entry whose file no longer imports the boundary → STALE (remove the entry — the
 *     list may only shrink).
 *
 * Each retrofit rung instantiates one guard in a one-line test:
 *   const r = runImportRatchet({ boundary: 'localization/my', allowlist, allowedImporters: … });
 *
 * Detection is source-static: import/export-from/require/dynamic-import specifiers are extracted
 * by regex (which also catches type-only imports and type-position `typeof import(…)` — type
 * coupling is still coupling) and resolved against the boundary. Only project-internal specifier
 * forms resolve: '@/…' (tsconfig alias), relative paths, and bare repo-root paths
 * (e.g. 'localization/my/…'). Framework-free on purpose (no vitest import), like
 * test/helpers/sidebar-source.ts: callers assert on the returned arrays with their own messages.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

export type ImportRatchetConfig = {
  /** Absolute repo root. */
  root: string;
  /** Top-level dirs/files to scan, repo-relative (test/ is deliberately never scanned). */
  scan: string[];
  /** The guarded boundary directory, repo-relative POSIX (e.g. 'localization/my'). */
  boundary: string;
  /**
   * Always-allowed importers (the pack itself + its wiring), given a repo-relative POSIX path.
   * These never appear in the allowlist.
   */
  allowedImporters: (relPath: string) => boolean;
  /** The checked-in ratchet allowlist: repo-relative POSIX paths audited at seeding time. */
  allowlist: string[];
};

export type ImportRatchetResult = {
  /** Every scanned file importing into the boundary, minus always-allowed (repo-relative, sorted). */
  importers: string[];
  /** Importers not covered by the allowlist — the ratchet failure (the leak grew). */
  violations: string[];
  /** Allowlist entries whose file no longer imports the boundary (or no longer exists) — remove them. */
  stale: string[];
};

const SOURCE_EXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs)$/;

/** Matches the specifier of: import/export … from '…', import '…', import('…'), require('…'). */
const SPEC_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;

function walk(path: string, out: string[]): string[] {
  let st;
  try {
    st = statSync(path);
  } catch {
    return out; // scan roots may not exist yet (e.g. packs/ before rung 1)
  }
  if (st.isDirectory()) {
    for (const name of readdirSync(path)) {
      if (name === 'node_modules' || name === '.next' || name === '.git') continue;
      walk(`${path}${sep}${name}`, out);
    }
  } else if (SOURCE_EXT.test(path)) {
    out.push(path);
  }
  return out;
}

export function runImportRatchet(cfg: ImportRatchetConfig): ImportRatchetResult {
  const root = resolve(cfg.root);
  const boundaryAbs = resolve(root, cfg.boundary);

  const importsBoundary = (spec: string, fileDir: string): boolean => {
    let abs: string;
    if (spec.startsWith('@/')) abs = resolve(root, spec.slice(2));
    else if (spec.startsWith('.')) abs = resolve(fileDir, spec);
    else if (spec.startsWith(cfg.boundary)) abs = resolve(root, spec); // bare repo-root form
    else return false; // package import — not ours
    return abs === boundaryAbs || abs.startsWith(boundaryAbs + sep);
  };

  const files = cfg.scan.flatMap((entry) => walk(resolve(root, entry), []));
  const importers: string[] = [];
  for (const file of files) {
    const rel = file.slice(root.length + 1).split(sep).join('/');
    if (cfg.allowedImporters(rel)) continue;
    const src = readFileSync(file, 'utf8');
    SPEC_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SPEC_RE.exec(src))) {
      if (importsBoundary(m[1], dirname(file))) {
        importers.push(rel);
        break;
      }
    }
  }
  importers.sort();

  const allowed = new Set(cfg.allowlist);
  const importerSet = new Set(importers);
  return {
    importers,
    violations: importers.filter((f) => !allowed.has(f)),
    stale: cfg.allowlist.filter((f) => !importerSet.has(f)),
  };
}
