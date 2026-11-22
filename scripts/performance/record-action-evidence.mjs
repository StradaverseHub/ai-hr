import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export function recordActionEvidence(registrations, origin) {
  const entries = [...registrations.keys()].sort().map(id => [id, [...registrations.get(id)].sort()]);
  assert(entries.length > 0, 'The record build must register Server Actions');
  const ordinals = new Map(entries.map(([id], index) => [id, index + 1]));

  return {
    identity: {
      registryDigest: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
      registered: entries.length,
    },
    async observe(page, pathname, template, row, action) {
      const requests = new Map();
      const requested = request => {
        if (request.method() !== 'POST') return;
        const url = new URL(request.url());
        if (url.origin !== origin || url.pathname !== pathname) return;
        const actionId = request.headers()['next-action'];
        const matchesWorker = registrations.get(actionId)?.has(template) === true;
        requests.set(request, {
          started: performance.now(),
          protocol: actionId ? 'next-action' : 'form',
          page: template,
          ...(matchesWorker && { actionOrdinal: ordinals.get(actionId) }),
        });
      };
      const responded = response => {
        const request = requests.get(response.request());
        if (!request) return;
        request.status = response.status();
        request.headersMs = Math.round(performance.now() - request.started);
      };
      page.on('request', requested);
      page.on('response', responded);
      try {
        return await action();
      } finally {
        page.off('request', requested);
        page.off('response', responded);
        row.transports = [...requests.values()].map(({ started, ...receipt }) => receipt);
      }
    },
  };
}
