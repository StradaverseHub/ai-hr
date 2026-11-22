import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { expect, it } from 'vitest';
import { createBackgroundReadAdmission } from '../db/background-read-admission';
import { currentHttpReadLifetime, withHttpReadLifetime } from '../lib/http-read-lifetime';

class ResponseEvents extends EventEmitter {
  writableFinished = false;
  destroyed = false;

  asResponse() {
    return this as unknown as ServerResponse;
  }
}

it('cancels queued passive reads for the closed response and preserves a concurrent response', async () => {
  const admission = createBackgroundReadAdmission({ capacity: 1, maxWaiting: 2, waitMs: 10_000 });
  let release!: () => void;
  const blocker = new Promise<void>(resolve => { release = resolve; });
  const held = admission.run('tenant', () => blocker);
  const closedResponse = new ResponseEvents();
  const connectedResponse = new ResponseEvents();
  let closedReadStarted = false;
  let connectedSignal: AbortSignal | undefined;
  const abandoned = withHttpReadLifetime(closedResponse.asResponse(), async () => {
    await Promise.resolve();
    return admission.run('tenant', async () => { closedReadStarted = true; }, currentHttpReadLifetime());
  });
  const connected = withHttpReadLifetime(connectedResponse.asResponse(), async () => {
    await Promise.resolve();
    connectedSignal = currentHttpReadLifetime();
    return admission.run('tenant', async () => 'usable', connectedSignal);
  });
  const rejected = expect(abandoned).rejects.toMatchObject({ name: 'AbortError' });

  try {
    await Promise.resolve();
    expect(currentHttpReadLifetime()).toBeUndefined();
    expect(admission.snapshot().waiting).toBe(2);
    closedResponse.emit('close');
    await rejected;
    expect(closedReadStarted).toBe(false);
    expect(admission.snapshot().waiting).toBe(1);
    expect(connectedSignal?.aborted).toBe(false);
  } finally {
    closedResponse.emit('close');
    release();
  }
  await held;
  await expect(connected).resolves.toBe('usable');
  connectedResponse.writableFinished = true;
  connectedResponse.emit('close');
  expect(connectedSignal?.aborted).toBe(false);
});
