/**
 * Lifecycle message coverage (ADR-0095). The i18n coverage guard checks static keys; this one pins the
 * COMPUTED ones: the history timeline renders `history.<action>` for every action the services write, and
 * the badges render `status.*`, `assetStatus.*` and `assetType.*` from the module's own vocabularies.
 * A new action or status without a label would otherwise render as a raw key on a screen no static check sees.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ASSET_REQUEST_STATUSES, ASSET_STATUSES, ASSET_TYPES } from '../core/lifecycle-defaults';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
const messages = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(read(`messages/${l}.json`)).lifecycle])) as Record<string, Record<string, unknown>>;
const get = (obj: unknown, dotted: string): unknown => dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);

/** Every history `action` the services write: literals plus the three templated families, expanded. */
function writtenActions(): string[] {
  const dir = fileURLToPath(new URL('../core', import.meta.url));
  const found = new Set<string>();
  for (const f of readdirSync(dir).filter((x) => /^lifecycle-.+\.ts$/.test(x))) {
    const src = read(`core/${f}`);
    for (const m of src.matchAll(/action:\s*'([a-z_]+\.[a-z_]+)'/g)) found.add(m[1]!);
    for (const m of src.matchAll(/action:\s*first \? '([a-z_.]+)' : '([a-z_.]+)'/g)) { found.add(m[1]!); found.add(m[2]!); }
    for (const m of src.matchAll(/action:\s*ev === 'owner' \? '([a-z_.]+)' : '([a-z_.]+)'/g)) { found.add(m[1]!); found.add(m[2]!); }
    for (const m of src.matchAll(/action:\s*next === 'completed' \? '([a-z_.]+)' : '([a-z_.]+)'/g)) { found.add(m[1]!); found.add(m[2]!); }
    for (const m of src.matchAll(/action:\s*`([a-z_]+)\.\$\{(act|next)\}`/g)) {
      for (const v of m[2] === 'act' ? ['approved', 'rejected'] : ['procured', 'tagged', 'assigned', 'completed']) found.add(`${m[1]}.${v}`);
    }
  }
  // config.* actions go to the audit ledger only (recordConfig), never the timeline.
  return [...found].filter((a) => !a.startsWith('config.')).sort();
}

describe('lifecycle messages', () => {
  it('scans enough source to mean something (a scan that finds nothing proves nothing)', () => {
    expect(writtenActions().length).toBeGreaterThanOrEqual(30);
  });

  it('every history action the services write has a label in every locale', () => {
    const missing: string[] = [];
    for (const a of writtenActions()) for (const l of LOCALES) if (typeof get(messages[l], `history.${a}`) !== 'string') missing.push(`${l}: history.${a}`);
    expect(missing).toEqual([]);
  });

  it('every status vocabulary the badges render is labelled in every locale', () => {
    const missing: string[] = [];
    const need = [
      ...ASSET_STATUSES.map((s) => `assetStatus.${s}`), ...ASSET_TYPES.map((s) => `assetType.${s}`),
      ...ASSET_REQUEST_STATUSES.filter((s) => s !== 'pending_approval' || true).map((s) => `status.${s}`),
      ...['in_progress', 'completed', 'cancelled', 'open'].map((s) => `status.${s}`),
      ...['pending', 'pending_l2', 'approved', 'rejected'].map((s) => `approval.${s}`),
      ...['pending', 'accepted', 'rejected'].map((s) => `outcome.${s}`),
    ];
    for (const k of need) for (const l of LOCALES) if (typeof get(messages[l], k) !== 'string') missing.push(`${l}: ${k}`);
    expect(missing).toEqual([]);
  });

  it('placeholders agree across locales for every message', () => {
    const flat = (o: unknown, p = '', out: Record<string, string> = {}): Record<string, string> => {
      for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
        if (typeof v === 'string') out[p + k] = v; else flat(v, `${p}${k}.`, out);
      }
      return out;
    };
    const ph = (s: string) => (s.match(/\{[a-zA-Z]+\}/g) ?? []).sort().join(',');
    const en = flat(messages.en);
    const bad: string[] = [];
    for (const l of LOCALES.filter((x) => x !== 'en')) {
      const f = flat(messages[l]);
      for (const [k, v] of Object.entries(en)) if (ph(v) !== ph(f[k] ?? '')) bad.push(`${l}: ${k}`);
    }
    expect(Object.keys(en).length).toBeGreaterThan(300);
    expect(bad).toEqual([]);
  });
});
