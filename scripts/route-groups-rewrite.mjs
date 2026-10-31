#!/usr/bin/env node
/**
 * Moves page routes into the (auth) and (app) root-layout route groups and rewrites every reference to
 * their old paths. Separate root layouts make Next.js do a full page load between the login flow and the
 * authenticated shell, so an expired session never renders the login form inside the old shell.
 *
 * Idempotent: run it again on a branch that predates the move (after merging main) to relocate files the
 * branch added under the old folders and to rewrite references it introduced. Review the diff afterwards.
 *
 *   node scripts/route-groups-rewrite.mjs
 *
 * Deliberately untouched: applied migrations (immutable), installed capability-binding owner labels
 * (deploy/access, stored by migrations as identities), the mobile app's own app/ folder, and historical
 * review/mockup/research records.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { posix } from 'node:path';

const AUTH = ['login', 'invite', 'reset-password'];
const APP = ['admin', 'analytics', 'approvals', 'assistant', 'attendance', 'claims', 'control-tower', 'delegations',
  'feedback', 'knowledge-base', 'leave', 'letters', 'lifecycle', 'manage', 'me', 'mobile-preview', 'notices', 'operator',
  'org', 'payroll', 'people', 'performance', 'personnel', 'reports', 'rewards', 'roster', 'system-testing', 'tasks'];
const APP_FILES = ['page', 'loading'];

/** [old, new] repository-relative prefixes; a prefix matches itself or anything below it. */
const MOVES = [
  ...AUTH.map((d) => [`app/${d}`, `app/(auth)/${d}`]),
  ...APP.map((d) => [`app/${d}`, `app/(app)/${d}`]),
  ...APP_FILES.flatMap((f) => [[`app/${f}.tsx`, `app/(app)/${f}.tsx`], [`app/${f}`, `app/(app)/${f}`]]),
  // The shell's root layout; the login flow's layout is new and has no old path.
  ['app/layout.tsx', 'app/(app)/layout.tsx'], ['app/layout', 'app/(app)/layout'],
];

const SKIP = [/^mobile\//, /^db\/migrations\//, /^deploy\/access\//, /^node_modules\//, /^pnpm-lock\.yaml$/,
  /^docs\/(mockups|reviews|audits|research|deferred|plans|feedback-plans)\//, /^\.impeccable\//,
  /^scripts\/improve\/.*\.workflow\.js$/,
  /^scripts\/route-groups-rewrite\.mjs$/,
  // Synthetic release trees that model their own app/ layout.
  /^test\/r385-release-document-boundary\.test\.ts$/];
const TEXT = /\.(?:[cm]?[jt]sx?|css|json|mdx?|py|sh|ya?ml)$/;

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 });
const mapPath = (p) => {
  for (const [from, to] of MOVES) if (p === from || p.startsWith(`${from}/`)) return to + p.slice(from.length);
  return p;
};
const EXTS = ['', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.css', '.json', '/index.ts', '/index.tsx', '/index.js'];
const resolves = (p) => EXTS.some((e) => existsSync(p + e));
const unmapPath = (p) => {
  for (const [from, to] of MOVES) if (p === to || p.startsWith(`${to}/`)) return from + p.slice(to.length);
  return p;
};

// 1. Move. Whole folders first; then anything a branch added under an old folder after the move.
for (const [from, to] of MOVES) {
  if (!existsSync(from)) continue;
  const tracked = git('ls-files', '-z', '--', from).split('\0').filter(Boolean);
  if (!tracked.length) continue;
  if (!existsSync(to)) {
    execFileSync('mkdir', ['-p', posix.dirname(to)]);
    git('mv', from, to);
  } else {
    for (const file of tracked) {
      const dest = mapPath(file);
      execFileSync('mkdir', ['-p', posix.dirname(dest)]);
      git('mv', file, dest);
    }
  }
}

// 2. Rewrite references.
const NAMES = [...AUTH, ...APP].join('|');
// app/<moved>... when it starts a path: start of string, after a non-path character, or after @/ ./ ../ prefixes.
const PATH_REF = new RegExp(
  String.raw`(?<=(?:^|[^\w\-/.])(?:@/|(?:\.\.?/)+)?)app/(?:(${NAMES})(?=[/'"\x60)\s:#,\]*]|$)|(page|loading|layout)(?=\.tsx|['"\x60]))`,
  'gm',
);
const JOIN_REF = new RegExp(String.raw`(['"])app\1(\s*,\s*)(['"])(${NAMES})\3`, 'g');
const SPECIFIER = /((?:\bfrom|\bimport|\brequire|@import|\burl|vi\.mock|vi\.importActual|new URL)\s*\(?\s*)(['"])(\.\.?\/[^'"\n]+)\2/g;

const changed = [];
for (const file of git('ls-files', '-z').split('\0').filter(Boolean)) {
  if (!TEXT.test(file) || SKIP.some((r) => r.test(file)) || !existsSync(file)) continue;
  const before = readFileSync(file, 'utf8');
  let after = before;
  if (file.startsWith('app/')) {
    const oldDir = posix.dirname(unmapPath(file));
    const newDir = posix.dirname(file);
    after = after.replace(SPECIFIER, (all, lead, quote, spec) => {
      // Already correct from where the file now lives (a sibling that moved with it, or a rerun): keep.
      if (resolves(posix.join(newDir, spec))) return all;
      const target = mapPath(posix.normalize(posix.join(oldDir, spec)));
      let next = posix.relative(newDir, target);
      if (!next.startsWith('.')) next = `./${next}`;
      if (spec.endsWith('/') && !next.endsWith('/')) next += '/';
      return `${lead}${quote}${next}${quote}`;
    });
  }
  after = after.replace(PATH_REF, (all, dir, file_) => mapPath(`app/${dir ?? file_}`));
  // Segment-wise joins: join(root, 'app', 'payroll', ...) gains the group segment.
  after = after.replace(JOIN_REF, (all, q, sep, q2, name) => `${q}app${q}${sep}${q2}${mapPath(`app/${name}`).split('/')[1]}${q2}${sep}${q2}${name}${q2}`);
  // Tests that turn a shell URL into its page file: `app${href}/page.tsx` and rel.replace(/^app/, '').
  if (file.startsWith('test/')) {
    after = after.replace(/(?<=[`'"](?:\.\.\/)?)app\$\{/g, 'app/(app)${');
    after = after.replace(/(['"])app\1(\s*,\s*)(?=[A-Za-z_][\w.!]*\s*[,)])/g, (all, q, sep) => `${q}app${q}${sep}${q}(app)${q}${sep}`);
    after = after.split(".replace(/^app/, '')").join(".replace(/^app\\/\\(app\\)/, '')");
  }
  if (after !== before) { writeFileSync(file, after); changed.push(file); }
}
console.log(`Rewrote references in ${changed.length} files.`);
