import { redirect } from 'next/navigation';

/**
 * Legacy redirect stub (f1b994e3). The leave audit export is retired with the page it belonged to: the
 * one export now lives at /admin/audit/export and takes an Area, so `?module=leave` reproduces this
 * route's output. The columns and the describePayload masking are unchanged there, byte for byte
 * (ADR-0047 — external consumers read these files).
 *
 * The ROUTE is kept so a saved download link still resolves. Every filter param is forwarded verbatim —
 * same names on the destination — with `module=leave` added, and `format` rides along untouched, so an
 * old CSV link still returns a CSV.
 *
 * No guard here: the destination route re-checks isAdmin() for itself, exactly as this one did.
 */
export async function GET(req: Request) {
  const src = new URL(req.url);
  const out = new URLSearchParams(src.searchParams);
  out.set('module', 'leave');
  redirect(`/admin/audit/export?${out.toString()}`);
}
