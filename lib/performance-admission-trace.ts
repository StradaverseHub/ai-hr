import { DATABASE_CAPACITY_DIGEST } from './database-capacity';

type ShellStage = 'session' | 'idle-policy' | 'principals' | 'company-scope' | 'viewer' |
  'navigation-access' | 'letters' | 'onboarding-navigation' | 'onboarding-tasks' |
  'lifecycle-navigation' | 'lifecycle-inbox' | 'assistant' | 'identity-email';

type RequestStage = 'render' | 'action' | 'route' | 'proxy';

export function traceAdmissionFailure(source: 'shell', stage: ShellStage, error: unknown): void;
export function traceAdmissionFailure(source: 'next', stage: RequestStage, error: unknown): void;
export function traceAdmissionFailure(source: 'shell' | 'next', stage: ShellStage | RequestStage, error: unknown): void {
  if (process.env.AIHR_PERF_ADMISSION_TRACE !== 'true') return;

  let current = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth++) {
    const { code, digest, cause } = current as { code?: unknown; digest?: unknown; cause?: unknown };
    const kind = code === 'queue-full' || code === 'queue-timeout'
      ? code
      : digest === DATABASE_CAPACITY_DIGEST ? 'capacity-digest' : null;
    if (kind) {
      console.info('PERF_ADMISSION_FAILURE', source, stage, kind);
      return;
    }
    current = cause;
  }
}

export function observeShellAdmission<T>(stage: ShellStage, work: Promise<T>): Promise<T> {
  if (process.env.AIHR_PERF_ADMISSION_TRACE !== 'true') return work;
  return work.catch((error: unknown) => {
    traceAdmissionFailure('shell', stage, error);
    throw error;
  });
}
