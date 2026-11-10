/** Runs once when a Next.js server starts. Node runtime only: the Edge runtime cannot open the database socket. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || process.env.NEXT_PHASE === 'phase-production-build') return;
  const {warnIfFleetExceedsServer} = await import('./db/connection-budget-check');
  await warnIfFleetExceedsServer();
}
