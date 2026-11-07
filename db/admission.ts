/** Application admission happens before a PostgreSQL connection is borrowed. */
export type DatabaseWorkload = 'interactive' | 'background';
export class DatabaseAdmissionError extends Error {
  constructor(readonly code: 'queue-full' | 'queue-timeout') {
    super('Database work could not start within the configured capacity budget.');
    this.name = 'DatabaseAdmissionError';
  }
}
type Waiter = {
  workload: DatabaseWorkload;
  tenant: string;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  clean: () => void;
};

/** One gate per physical pool. Limits are process-local; deployment owns their aggregate. */
export function createDatabaseAdmission(options: {
  capacity: number;
  backgroundCapacity: number;
  maxWaiting: number;
  maxBackgroundWaiting?: number;
  waitMs: number;
  perTenantCapacity?: number;
}) {
  const {capacity, backgroundCapacity, maxWaiting, waitMs} = options;
  const maxBackgroundWaiting = options.maxBackgroundWaiting ?? maxWaiting;
  if (![capacity, backgroundCapacity, maxWaiting, waitMs].every(Number.isSafeInteger)
    || capacity < 1 || backgroundCapacity < 1 || backgroundCapacity > capacity || maxWaiting < 0 || waitMs < 1) {
    throw new Error('Invalid database admission budget.');
  }
  const perTenantCapacity = options.perTenantCapacity ?? capacity;
  if (!Number.isSafeInteger(maxBackgroundWaiting) || maxBackgroundWaiting < 0 || maxBackgroundWaiting > maxWaiting)
    throw new Error('Invalid background waiting budget.');
  if (!Number.isSafeInteger(perTenantCapacity) || perTenantCapacity < 1 || perTenantCapacity > capacity)
    throw new Error('Invalid per-tenant admission budget.');
  let active = 0, background = 0, interactiveTurns = 0, backgroundWaiting = 0;
  const waiting: Waiter[] = [];
  const activeByTenant = new Map<string, number>();
  function dequeue(index: number) {
    const [waiter] = waiting.splice(index, 1);
    if (waiter.workload === 'background') backgroundWaiting--;
    return waiter;
  }
  const eligible = (workload: DatabaseWorkload, tenant?: string) => active < capacity
    && (workload !== 'background' || background < backgroundCapacity)
    && (tenant === undefined || (activeByTenant.get(tenant) ?? 0) < perTenantCapacity);
  function grant(waiter: Waiter) {
    waiter.clean();
    active++;
    if (waiter.workload === 'background') { background++; interactiveTurns = 0; }
    else interactiveTurns = Math.min(3, interactiveTurns + 1);
    activeByTenant.set(waiter.tenant, (activeByTenant.get(waiter.tenant) ?? 0) + 1);
    let released = false;
    waiter.resolve(() => {
      if (released) return;
      released = true;
      active--;
      if (waiter.workload === 'background') background--;
      const remaining = (activeByTenant.get(waiter.tenant) ?? 1) - 1;
      if (remaining) activeByTenant.set(waiter.tenant, remaining);
      else activeByTenant.delete(waiter.tenant);
      drain();
    });
  }
  function drain() {
    while (active < capacity && waiting.length) {
      // Interactive work has preference, but a waiting background unit receives one of every
      // four admissions when its lane has space. Within a lane, prefer the least active tenant;
      // equal tenants retain FIFO order. No tenant label is exported in telemetry.
      const preferred: DatabaseWorkload = interactiveTurns >= 3 ? 'background' : 'interactive';
      const lanes: DatabaseWorkload[] = [preferred, preferred === 'interactive' ? 'background' : 'interactive'];
      let index = -1;
      for (const lane of lanes) {
        if (!eligible(lane)) continue;
        let least = Infinity;
        for (let i = 0; i < waiting.length; i++) {
          const w = waiting[i];
          const count = activeByTenant.get(w.tenant) ?? 0;
          if (w.workload === lane && eligible(lane, w.tenant) && count < least) { index = i; least = count; }
        }
        if (index !== -1) break;
      }
      if (index === -1) break;
      grant(dequeue(index));
    }
  }
  async function acquire(tenant: string, workload: DatabaseWorkload, signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    tenant = tenant.toLowerCase();
    // A full queue cannot reject a new eligible lane while all queued work is lane-blocked.
    const immediate = eligible(workload, tenant) && !waiting.some(w => eligible(w.workload, w.tenant));
    if (!immediate && (waiting.length >= maxWaiting || (workload === 'background' && backgroundWaiting >= maxBackgroundWaiting)))
      throw new DatabaseAdmissionError('queue-full');
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter: Waiter = {tenant: tenant.toLowerCase(), workload, resolve, reject, clean: () => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }};
      function remove(error: unknown) {
        const index = waiting.indexOf(waiter);
        if (index === -1) return;
        dequeue(index);
        waiter.clean();
        reject(error);
        drain();
      }
      function abort() { remove(signal!.reason); }
      if (immediate) { grant(waiter); return; }
      waiting.push(waiter);
      if (workload === 'background') backgroundWaiting++;
      timer = setTimeout(() => remove(new DatabaseAdmissionError('queue-timeout')), waitMs);
      signal?.addEventListener('abort', abort, {once: true});
      if (signal?.aborted) abort();
      else drain();
    });
  }
  return {
    acquire,
    snapshot: () => ({active, background, waiting: waiting.length, backgroundWaiting, capacity, backgroundCapacity, maxWaiting, maxBackgroundWaiting}),
  };
}
