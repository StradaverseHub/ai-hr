import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';

const packagePath = new URL('../mobile/package.json', import.meta.url);
const nativeRequire = createRequire(packagePath);
const decode = nativeRequire('decode-uri-component') as (value: string) => string;
const query = nativeRequire('query-string') as { parse: (value: string) => Record<string, string> };

describe('native dependency fixes — actual installed callers', () => {
  it('ships exactly the provenance-pinned upstream decoder with only its export converted', () => {
    const provenance = JSON.parse(readFileSync('mobile/vendor/decode-uri-component/provenance.json', 'utf8')) as {
      sourceSha256: string; commonJsSha256: string;
    };
    const compiled = readFileSync('mobile/vendor/decode-uri-component/index.cjs', 'utf8');
    const original = compiled.replace('module.exports = function decodeUriComponent(encodedURI)',
      'export default function decodeUriComponent(encodedURI)');
    expect(original).not.toBe(compiled);
    expect(createHash('sha256').update(compiled).digest('hex')).toBe(provenance.commonJsSha256);
    expect(createHash('sha256').update(original).digest('hex')).toBe(provenance.sourceSha256);
    expect(nativeRequire('decode-uri-component')).toBe(decode);
    expect(nativeRequire.resolve('decode-uri-component')).toMatch(/vendor\/decode-uri-component\/index\.cjs$/);
    expect(readFileSync('mobile/vendor/decode-uri-component/LICENSE', 'utf8')).toContain('Sam Verschueren');
  });

  it('preserves PKCE callback parameters and Unicode in the existing CommonJS query parser', () => {
    const text = 'é 马来语 😂';
    expect(decode(encodeURIComponent(text))).toBe(text);
    expect(query.parse(`code=abc%2Bdef&state=state%20value&name=${encodeURIComponent(text)}`)).toMatchObject({
      code: 'abc+def', state: 'state value', name: text,
    });
    expect(decode('%C2%C2')).toBe('\uFFFD\uFFFD');
    expect(query.parse('state=%E0%A4%A').state).toBe('%E0%A4%A');
  });

  it('malformed URL input completes in the real parser without the exponential decoder path', async () => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const load = require('node:module').createRequire(workerData);
      const parsed = load('query-string').parse('state=' + '%C2'.repeat(10000));
      parentPort.postMessage(parsed.state.length);
    `, { eval: true, workerData: packagePath.pathname });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await new Promise<number>((resolve, reject) => {
        worker.once('message', resolve); worker.once('error', reject);
        watchdog = setTimeout(() => reject(new Error('The malformed URL decoder did not finish within 5 seconds.')), 5000);
      });
      expect(result).toBe(10000);
    } finally { clearTimeout(watchdog); await worker.terminate(); }
  });

  it('the patched UUID module still produces the Xcode project ids Expo needs', () => {
    const xcode = nativeRequire('xcode') as { project: (path: string) => { hash: unknown; generateUuid: () => string } };
    const project = xcode.project('fixture.pbxproj');
    project.hash = { project: { objects: {} } };
    const ids = new Set(Array.from({ length: 50 }, () => project.generateUuid()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[A-F0-9]{24}$/);
    const fromXcode = createRequire(nativeRequire.resolve('xcode'));
    expect((fromXcode('uuid/package.json') as { version: string }).version).toBe('11.1.1');
  });
});
