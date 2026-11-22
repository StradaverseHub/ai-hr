// Only used by the hosted fictional 500-user comparison.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import next from 'next';
import { withHttpReadLifetime } from '../../lib/http-read-lifetime.ts';

const env = process.env;
assert(env.GITHUB_ACTIONS === 'true' && env.CI === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted');
assert(env.GITHUB_REPOSITORY === 'StradaverseHub/ai-hr' && env.GITHUB_EVENT_NAME === 'workflow_dispatch');
assert(env.PERF_HTTP_SUITE === 'browser-route-baseline' && env.AUTH_PROVIDER === 'internal');
assert(env.NODE_ENV === 'production');
const enabled = env.PERF_SHELL_HTTP_LIFETIME === 'true';
assert(enabled || env.PERF_SHELL_HTTP_LIFETIME === 'false');
const hostname = '127.0.0.1';
const port = Number(process.argv[2]);
assert(Number.isSafeInteger(port) && port > 1024 && port <= 65535);

const app = next({ dev: false, hostname, port });
await app.prepare();
const handle = app.getRequestHandler();

createServer((request, response) => {
  const render = () => handle(request, response);
  void (enabled ? withHttpReadLifetime(response, render) : render()).catch(error => {
    console.error('Hosted Next request failed', error instanceof Error ? error.name : 'unknown');
    if (response.headersSent) response.destroy();
    else {
      response.statusCode = 500;
      response.end();
    }
  });
}).listen(port, hostname);
