import { AsyncLocalStorage } from 'node:async_hooks';
import type { ServerResponse } from 'node:http';

// The Next request handler and its compiled layouts share one process-local scope.
const runtime = globalThis as typeof globalThis & {
  __aihrHttpReadLifetime?: AsyncLocalStorage<AbortSignal>;
};
const lifetimes = (runtime.__aihrHttpReadLifetime ??= new AsyncLocalStorage());

export function currentHttpReadLifetime(): AbortSignal | undefined {
  return lifetimes.getStore();
}

export function withHttpReadLifetime<T>(response: ServerResponse, handle: () => T): T {
  const controller = new AbortController();
  const onClose = () => {
    if (!response.writableFinished) {
      controller.abort(new DOMException('The HTTP response closed before it finished.', 'AbortError'));
    }
  };
  if (response.destroyed) onClose();
  else response.once('close', onClose);
  return lifetimes.run(controller.signal, handle);
}
