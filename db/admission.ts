import {DATABASE_CAPACITY_DIGEST} from '../lib/database-capacity';

/** Application admission happens before a PostgreSQL connection is borrowed. */
export type DatabaseWorkload = 'interactive' | 'background' | 'authentication';
export {DATABASE_CAPACITY_DIGEST};
export class DatabaseAdmissionError extends Error {
  /** Next.js keeps a thrown error's own digest, so the error boundary can recognise this failure. */
  readonly digest = DATABASE_CAPACITY_DIGEST;
  constructor(readonly code: 'queue-full' | 'queue-timeout') {
    super('Database work could not start within the configured capacity budget.');
    this.name = 'DatabaseAdmissionError';
  }
}
/** Waiters of one workload lane and one tenant, which are admitted in FIFO order (nested work may go first). */
type WaitQueue = {waiting: number; admitted: number};
type Waiter = {
  workload: DatabaseWorkload;
  tenant: string;
  /** Nested in a transaction this tenant already holds; never waits on the tenant's own share. */
  uncapped: boolean;
  queue: WaitQueue;
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
  /**
   * The stall budget. A waiter is refused only once its own queue (its lane and tenant) has admitted no work for this
   * long, so a burst that is draining is served however long the drain takes: a 9 am Home burst of one large employer
   * must queue, not fail. It still refuses within this budget when the work ahead of it is stuck.
   */
  waitMs: number;
  /**
   * The longest any waiter is kept, progress or not (default four stall budgets). It is far above every proxy and
   * client timeout, so it only sheds queued work that nobody is still waiting for under sustained overload.
   */
  maxWaitMs?: number;
  /** Hard ceiling per tenant, whatever else is idle. Tenant write admission uses 1 to serialise writes. */
  perTenantCapacity?: number;
  /**
   * A tenant's fair share, and it is work-conserving. A tenant at or above it takes a new permit only while
   * no other tenant has work running or waiting, so a lone tenant can use every permit except the login
   * reserve. Once another tenant has work, the over-share tenant gets nothing new until it is back under
   * its share, and the other tenant goes first. Permits already held are never revoked, so an arriving
   * tenant waits for the next permit to free; that is safe only because long transactions are leaving the
   * request path. Authentication work is not a tenant here and never counts as one.
   */
  tenantFairShare?: number;
  /** Most waiters one tenant may queue, so a hot tenant cannot fill the whole queue. */
  maxWaitingPerTenant?: number;
  /** Permits tenant work may never hold: login can always start here. */
  authenticationReserve?: number;
  /** Most permits authentication may hold, so a login flood cannot displace every page. */
  authenticationCapacity?: number;
  /** Pending authentication work, counted apart from the tenant queue. */
  maxAuthenticationWaiting?: number;
}, now:()=>number=()=>performance.now()) {
  const {capacity, backgroundCapacity, maxWaiting, waitMs} = options;
  const maxBackgroundWaiting = options.maxBackgroundWaiting ?? maxWaiting;
  if (![capacity, backgroundCapacity, maxWaiting, waitMs].every(Number.isSafeInteger)
    || capacity < 1 || backgroundCapacity < 1 || backgroundCapacity > capacity || maxWaiting < 0 || waitMs < 1) {
    throw new Error('Invalid database admission budget.');
  }
  const maxWaitMs = options.maxWaitMs ?? waitMs * 4;
  if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < waitMs) throw new Error('Invalid database admission budget.');
  // The stall check runs in quarter steps, so a stalled waiter is refused between one and 1.25 stall budgets after
  // its queue last moved, and exactly at the budget when its queue never moved.
  const stallStepMs = Math.max(1, Math.ceil(waitMs / 4));
  const perTenantCapacity = options.perTenantCapacity ?? capacity;
  if (!Number.isSafeInteger(maxBackgroundWaiting) || maxBackgroundWaiting < 0 || maxBackgroundWaiting > maxWaiting)
    throw new Error('Invalid background waiting budget.');
  if (!Number.isSafeInteger(perTenantCapacity) || perTenantCapacity < 1 || perTenantCapacity > capacity)
    throw new Error('Invalid per-tenant admission budget.');
  const tenantFairShare = options.tenantFairShare ?? capacity;
  if (!Number.isSafeInteger(tenantFairShare) || tenantFairShare < 1 || tenantFairShare > capacity)
    throw new Error('Invalid tenant fair share.');
  const maxWaitingPerTenant = options.maxWaitingPerTenant ?? maxWaiting;
  if (!Number.isSafeInteger(maxWaitingPerTenant) || maxWaitingPerTenant < 0 || maxWaitingPerTenant > maxWaiting)
    throw new Error('Invalid per-tenant waiting budget.');
  const authenticationReserve = options.authenticationReserve ?? 0;
  const authenticationCapacity = options.authenticationCapacity ?? capacity;
  const maxAuthenticationWaiting = options.maxAuthenticationWaiting ?? maxWaiting;
  if (![authenticationReserve, authenticationCapacity, maxAuthenticationWaiting].every(Number.isSafeInteger)
    || authenticationReserve < 0 || authenticationReserve >= capacity
    || authenticationCapacity < 1 || authenticationCapacity > capacity || authenticationCapacity < authenticationReserve
    || maxAuthenticationWaiting < 0)
    throw new Error('Invalid authentication admission budget.');
  let active = 0, background = 0, authentication = 0, interactiveTurns = 0, backgroundWaiting = 0, authenticationWaiting = 0;
  let backgroundDebtMs = 0, accountedAt=now();
  const waiting: Waiter[] = [];
  const activeByTenant = new Map<string, number>();
  const waitingByTenant = new Map<string, number>();
  /** Each lane-and-tenant queue that has waiters, and how many of its waiters were admitted so far. */
  const queues = new Map<string, WaitQueue>();
  function accountOccupiedTime(){
    const at=now(),elapsed=Math.max(0,at-accountedAt);accountedAt=at;
    // Only contended time matters. Account both lanes together so completion
    // order cannot lose foreground credit or accumulate credit during idle time.
    backgroundDebtMs=waiting.some(w=>w.workload==='interactive')
      ?Math.max(0,backgroundDebtMs+elapsed*(background*3-(active-background))):0;
  }
  function dequeue(index: number) {
    accountOccupiedTime();
    const [waiter] = waiting.splice(index, 1);
    if (--waiter.queue.waiting === 0) queues.delete(waiter.workload + '\u0000' + waiter.tenant);
    if (waiter.workload === 'background') backgroundWaiting--;
    if (waiter.workload === 'authentication') authenticationWaiting--;
    else {
      const remaining = (waitingByTenant.get(waiter.tenant) ?? 1) - 1;
      if (remaining) waitingByTenant.set(waiter.tenant, remaining);
      else waitingByTenant.delete(waiter.tenant);
    }
    return waiter;
  }
  const otherTenantHasWork = (tenant: string) =>
    activeByTenant.size > (activeByTenant.has(tenant) ? 1 : 0) || waitingByTenant.size > (waitingByTenant.has(tenant) ? 1 : 0);
  const eligible = (workload: DatabaseWorkload, tenant?: string, uncapped = false) => {
    if (active >= capacity) return false;
    // Authentication has its own ceiling and never counts against a tenant's share.
    if (workload === 'authentication') return authentication < authenticationCapacity;
    if (active - authentication >= capacity - authenticationReserve) return false;
    if (workload === 'background' && (background >= backgroundCapacity
      || (backgroundDebtMs > 0 && waiting.some(w=>w.workload==='interactive')))) return false;
    if (tenant === undefined || uncapped) return true;
    const held = activeByTenant.get(tenant) ?? 0;
    return held < perTenantCapacity && (held < tenantFairShare || !otherTenantHasWork(tenant));
  };
  function grant(waiter: Waiter) {
    waiter.clean();
    accountOccupiedTime();
    // Progress for everyone still waiting behind this waiter in its queue.
    waiter.queue.admitted++;
    active++;
    if (waiter.workload === 'background') {
      background++; interactiveTurns = 0;
    }
    else if (waiter.workload === 'authentication') authentication++;
    else interactiveTurns = Math.min(3, interactiveTurns + 1);
    if (waiter.workload !== 'authentication') activeByTenant.set(waiter.tenant, (activeByTenant.get(waiter.tenant) ?? 0) + 1);
    let released = false;
    waiter.resolve(() => {
      if (released) return;
      accountOccupiedTime();
      released = true;
      active--;
      if (waiter.workload === 'background') {
        background--;
      }
      else if (waiter.workload === 'authentication') authentication--;
      if (waiter.workload !== 'authentication') {
        const remaining = (activeByTenant.get(waiter.tenant) ?? 1) - 1;
        if (remaining) activeByTenant.set(waiter.tenant, remaining);
        else activeByTenant.delete(waiter.tenant);
      }
      drain();
    });
  }
  function drain() {
    accountOccupiedTime();
    while (active < capacity && waiting.length) {
      // Login, session checks and recovery run first: every page depends on them and they are short.
      // Their own ceiling keeps a login flood from taking the permits tenant pages need.
      let index = authenticationWaiting && eligible('authentication')
        ? waiting.findIndex(w => w.workload === 'authentication') : -1;
      // Interactive work has preference, but a waiting background unit receives one of every
      // four admissions when its lane has space and its occupied-time share is paid.
      // With no interactive queue background can use spare capacity. Within a lane, prefer the least active tenant;
      // equal tenants retain FIFO order. No tenant label is exported in telemetry.
      const preferred: 'interactive' | 'background' = interactiveTurns >= 3 ? 'background' : 'interactive';
      const lanes: ('interactive' | 'background')[] = [preferred, preferred === 'interactive' ? 'background' : 'interactive'];
      for (const lane of index === -1 ? lanes : []) {
        if (!eligible(lane)) continue;
        let least = Infinity;
        for (let i = 0; i < waiting.length; i++) {
          const w = waiting[i];
          const count = activeByTenant.get(w.tenant) ?? 0;
          if (w.workload === lane && eligible(lane, w.tenant, w.uncapped) && count < least) { index = i; least = count; }
        }
        if (index !== -1) break;
      }
      if (index === -1) break;
      grant(dequeue(index));
    }
  }
  async function acquire(tenant: string, workload: DatabaseWorkload, signal?: AbortSignal, options?: {ignoreTenantCap?: boolean}): Promise<() => void> {
    signal?.throwIfAborted();
    accountOccupiedTime();
    tenant = tenant.toLowerCase();
    // A nested transaction already holds this tenant's permit; capping it again could deadlock.
    const uncapped = options?.ignoreTenantCap === true;
    // A full queue cannot reject a new eligible lane while all queued work is lane-blocked.
    const immediate = eligible(workload, tenant, uncapped) && !waiting.some(w => eligible(w.workload, w.tenant, w.uncapped));
    if (!immediate && (workload === 'authentication'
      ? authenticationWaiting >= maxAuthenticationWaiting
      : (waiting.length - authenticationWaiting >= maxWaiting
        || (workload === 'background' && backgroundWaiting >= maxBackgroundWaiting)
        || (!uncapped && (waitingByTenant.get(tenant) ?? 0) >= maxWaitingPerTenant))))
      throw new DatabaseAdmissionError('queue-full');
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const key = workload + '\u0000' + tenant;
      const queue = immediate ? {waiting: 0, admitted: 0} : queues.get(key) ?? {waiting: 0, admitted: 0};
      const waiter: Waiter = {tenant, workload, uncapped, queue, resolve, reject, clean: () => {
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
      queue.waiting++;
      queues.set(key, queue);
      if (workload === 'background') backgroundWaiting++;
      if (workload === 'authentication') authenticationWaiting++;
      else waitingByTenant.set(waiter.tenant, (waitingByTenant.get(waiter.tenant) ?? 0) + 1);
      // Refuse only a stalled waiter: one whose queue admitted nobody for a whole stall budget, or one kept for the
      // absolute ceiling. Each step compares the queue's admissions with the previous step, so this needs no clock.
      let seen = queue.admitted, idleSteps = 0, steps = 0;
      const maxSteps = Math.ceil(maxWaitMs / stallStepMs);
      const step = () => {
        steps++;
        if (queue.admitted !== seen) { seen = queue.admitted; idleSteps = 0; } else idleSteps++;
        if (idleSteps >= 4 || steps >= maxSteps) remove(new DatabaseAdmissionError('queue-timeout'));
        else timer = setTimeout(step, stallStepMs);
      };
      timer = setTimeout(step, stallStepMs);
      signal?.addEventListener('abort', abort, {once: true});
      if (signal?.aborted) abort();
      else drain();
    });
  }
  return {
    acquire,
    snapshot: () => {
      accountOccupiedTime();
      return {active, background, authentication, waiting: waiting.length, backgroundWaiting, authenticationWaiting, backgroundDebtMs, capacity, backgroundCapacity, maxWaiting, maxBackgroundWaiting, perTenantCapacity, tenantFairShare, maxWaitingPerTenant, authenticationReserve, authenticationCapacity, maxAuthenticationWaiting, waitMs, maxWaitMs};
    },
  };
}
