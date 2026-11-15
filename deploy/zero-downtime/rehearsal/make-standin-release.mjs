#!/usr/bin/env node
/**
 * ADR-0181 rehearsal only — writes a STAND-IN release tree with the exact on-disk shape that
 * release-web.sh and the real aihr-web@.service expect, so the switching mechanism (systemd, Nginx,
 * drain, rollback, static union, boot enablement) is exercised for real on a CI runner without a
 * database. The application proof of skew protection uses a real Next build in the same workflow.
 *
 *   node make-standin-release.mjs <dir> <BUILD_ID> [--repo <checkout>] [--start-delay-ms 4000]
 *
 * The stand-in server (node_modules/next/dist/bin/next, invoked as `next start -H h -p p`):
 *   /health                         200 "ok"
 *   /login, /                        HTML with <html data-dpl-id="BUILD_ID">
 *   /slow?ms=N                       answers after N ms (requests in flight across a switch)
 *   /_next/static/chunks/BUILD_ID.js this build's chunk only (the static union must serve old ones)
 * On SIGTERM it stops accepting, finishes in-flight requests and exits 0, as Next does.
 */
import fs from 'node:fs';
import path from 'node:path';

const [dir, id, ...rest] = process.argv.slice(2);
if (!dir || !/^[A-Za-z0-9_-]{8,64}$/.test(id ?? '')) throw new Error('usage: make-standin-release.mjs <dir> <BUILD_ID> [--repo <checkout>] [--start-delay-ms N]');
const opt = (name, d) => { const i = rest.indexOf(name); return i === -1 ? d : rest[i + 1]; };
const repo = opt('--repo', null);
const delay = Number(opt('--start-delay-ms', 4000));

const w = (rel, content, mode) => {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  if (mode) fs.chmodSync(p, mode);
};

w('.next/BUILD_ID', id);
w('.next/routes-manifest.json', JSON.stringify({ version: 3, deploymentId: id }));
w(`.next/static/chunks/${id}.js`, `/* chunk of ${id} */`);
w('deploy/check-customer-env.mjs', '// stand-in: the real check is exercised by the customer-install tests\n');
w('node_modules/next/dist/bin/next', `#!/usr/bin/env node
const http = require('node:http');
const args = process.argv.slice(2);
const host = args[args.indexOf('-H') + 1], port = Number(args[args.indexOf('-p') + 1]);
const ID = ${JSON.stringify(id)};
let inflight = 0;
const server = http.createServer((req, res) => {
  inflight++;
  res.on('close', () => inflight--);
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/health') return res.end('ok');
  if (u.pathname === '/slow') return setTimeout(() => res.end('slow ' + ID), Number(u.searchParams.get('ms') || 10000));
  if (u.pathname === '/_next/static/chunks/' + ID + '.js') { res.setHeader('content-type', 'text/javascript'); return res.end('/* ' + ID + ' */'); }
  if (u.pathname.startsWith('/_next/')) { res.statusCode = 404; return res.end('not in this build'); }
  res.setHeader('content-type', 'text/html');
  res.end('<!DOCTYPE html><html lang="en" data-dpl-id="' + ID + '"><body>stand-in ' + ID + '</body></html>');
});
server.keepAliveTimeout = 5000;
setTimeout(() => server.listen(port, host, () => console.log('stand-in', ID, 'listening', host + ':' + port)), ${delay});
process.on('SIGTERM', () => {
  console.log('SIGTERM: draining', inflight, 'in flight');
  server.close(() => { console.log('drained'); process.exit(0); });
  server.closeIdleConnections();
});
`, 0o755);

// The release-mode classifier and the migration journal come from the real checkout, so `mode` runs
// the same code it runs in production.
if (repo) {
  for (const rel of ['scripts/releases/migration-release-mode.mjs', 'deploy/zero-downtime/migrate-online.sh']) {
    w(rel, fs.readFileSync(path.join(repo, rel)), rel.endsWith('.sh') ? 0o755 : undefined);
  }
  fs.cpSync(path.join(repo, 'db/migrations'), path.join(dir, 'db/migrations'), { recursive: true });
}
console.log(`stand-in release ${id} at ${dir}`);
