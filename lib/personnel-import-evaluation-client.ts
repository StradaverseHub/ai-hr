/** Browser-only metadata preparation. Raw source/fingerprints are never an action payload or stored. */
import { EmployeeImportEvaluationPublicResultSchema, type EmployeeImportEvaluationReceipt, type EmployeeImportEvaluationBinding } from './personnel-import-evaluation';
export async function personnelImportLocalDigest(text: string): Promise<string> { const captured = text; return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(captured))), byte => byte.toString(16).padStart(2, '0')).join(''); }
export function captureEmployeeImportEvaluationReceipt(value: unknown, companyId: string, binding?: EmployeeImportEvaluationBinding): EmployeeImportEvaluationReceipt {
    const result = EmployeeImportEvaluationPublicResultSchema.parse(value);
    if (result.kind !== 'evaluation' || result.receipt.companyId !== companyId || binding && (result.receipt.attemptId !== binding.attemptId || result.receipt.attemptVersion < binding.attemptVersion))
        throw Error('Import measurement unavailable.');
    return result.receipt;
}
/** Focus is an observed browser condition, never an assertion that a person was working. No idle,
 * hidden-tab or background time is attributed; it does not measure work done outside this page. */
export function personnelImportFocusClock() { let accumulated = 0, started: number | null = null; return { update(focused: boolean, now: number) { if (!Number.isFinite(now) || now < 0)
        return; if (started !== null) {
        accumulated += Math.max(0, now - started);
        started = null;
    } if (focused)
        started = now; }, read(now: number) { return Math.min(2592000000, Math.round(accumulated + (started === null ? 0 : Math.max(0, now - started)))); }, reset() { accumulated = 0; started = null; } }; }
export function employeeImportSourceFingerprint(csv: string, family: string, registers: Readonly<Record<string, string | undefined>>, allocations: string) { return JSON.stringify([csv, family, Object.entries(registers).sort(([a], [b]) => a.localeCompare(b)), allocations]); }

/** Hash the original selected File bytes in browser memory; no filename or bytes leave this helper. */
export async function personnelImportLocalBytesDigest(bytes:ArrayBuffer):Promise<string>{const captured=bytes.slice(0);return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',captured)),byte=>byte.toString(16).padStart(2,'0')).join('');}
