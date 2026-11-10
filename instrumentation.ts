/** Runs once when a Next.js server starts. The database check is Node-only: the Edge runtime has no socket. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.NEXT_PHASE !== 'phase-production-build') {
    const {warnIfFleetExceedsServer} = await import('./db/connection-budget-check');
    await warnIfFleetExceedsServer();
  }
}
