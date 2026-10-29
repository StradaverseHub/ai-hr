/**
 * The stored shape of a customer's mobile workplace setup (ADR-0161): one `tenant_setting` row, key
 * `mobile.workplace_setup`, scope `platform`. Pure; shared by the web reader (core/mobile-workplace-setup.ts)
 * and the owner-role writer (scripts/mobile-setup-issuance.ts) so both read the same contract.
 */
import { parseEnvelope, type SignedEnvelope } from './mobile-workplace-setup-verify';

export const MOBILE_SETUP_SETTING_KEY = 'mobile.workplace_setup';
export type MobileSetupMethod = 'issued' | 'imported';

/** Signed public data and its provenance only. No credential, key, path or tenant identifier. */
export type StoredWorkplaceSetup = {
  version: 1;
  setup: SignedEnvelope | null;
  method: MobileSetupMethod | null;
  /** When `setup` was stored (ISO). */
  recordedAt: string | null;
  /** The latest failed attempt, kept beside the previous setup rather than replacing it. */
  failure: { reason: string; at: string } | null;
};

export const EMPTY_STORED_SETUP: StoredWorkplaceSetup = Object.freeze({ version: 1, setup: null, method: null, recordedAt: null, failure: null });

const isoOrNull = (value: unknown) => typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value)) ? value : null;

/**
 * Read the stored JSON defensively. An unknown shape reads as "no setup" rather than throwing: the
 * value is re-verified before use anyway, and a reader must never fail open on a shape it does not know.
 */
export function parseStoredSetup(value: unknown): StoredWorkplaceSetup {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...EMPTY_STORED_SETUP };
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return { ...EMPTY_STORED_SETUP };
  let setup: SignedEnvelope | null = null;
  try { setup = v.setup == null ? null : parseEnvelope(v.setup); } catch { setup = null; }
  const method: MobileSetupMethod | null = setup !== null && (v.method === 'issued' || v.method === 'imported') ? v.method as MobileSetupMethod : null;
  const failure = v.failure && typeof v.failure === 'object' && !Array.isArray(v.failure) &&
    typeof (v.failure as Record<string, unknown>).reason === 'string' && /^[a-z_]{1,40}$/.test((v.failure as Record<string, string>).reason) &&
    isoOrNull((v.failure as Record<string, unknown>).at)
    ? { reason: (v.failure as Record<string, string>).reason, at: (v.failure as Record<string, string>).at } : null;
  return { version: 1, setup, method, recordedAt: setup ? isoOrNull(v.recordedAt) : null, failure };
}
