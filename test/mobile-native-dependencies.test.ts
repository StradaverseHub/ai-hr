import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { describe, expect, it } from 'vitest';

const packagePath = new URL('../mobile/package.json', import.meta.url);
const nativeRequire = createRequire(packagePath);
const webRequire = createRequire(new URL('../package.json', import.meta.url));
const decode = nativeRequire('decode-uri-component') as (value: string) => string;
// SDK58 removed query-string. Exercise the installed Expo callback parser rather than
// restoring an obsolete dependency just to keep its old regression fixture loadable.
const parserModule = { exports: {} as { getQueryParams: (value: string) => { errorCode: string | null; params: Record<string, string> } } };
const parserSource = readFileSync(join(dirname(nativeRequire.resolve('expo-auth-session')), 'QueryParams.js'), 'utf8');
runInNewContext(transpileModule(parserSource, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText,
  { module: parserModule, exports: parserModule.exports, URL, URLSearchParams, Object });
const query = { parse: (value: string) => parserModule.exports.getQueryParams(`onehr://auth/callback?${value}`).params };

describe('native dependency fixes — actual installed callers', () => {
  it('shares the web React type identity when native contracts enter the web test program', () => {
    // Pure native contracts are imported by web tests. Two JSX type identities made tsc exhaust 6 GB.
    expect(nativeRequire('@types/react/package.json').version).toBe(webRequire('@types/react/package.json').version);
  });

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

  it('preserves PKCE callback parameters, fragments and Unicode in the installed Expo URL parser', () => {
    const text = 'é 马来语 😂';
    expect(decode(encodeURIComponent(text))).toBe(text);
    expect(query.parse(`code=abc%2Bdef&state=state%20value&name=${encodeURIComponent(text)}`)).toMatchObject({
      code: 'abc+def', state: 'state value', name: text,
    });
    expect(decode('%C2%C2')).toBe('\uFFFD\uFFFD');
    expect(query.parse('state=%E0%A4%A').state).toBe('\uFFFD%A');
    expect(parserModule.exports.getQueryParams('onehr://auth/callback?state=original&errorCode=example#code=abc%2Bdef')).toEqual({
      errorCode: 'example', params: { state: 'original', code: 'abc+def' },
    });
  });

  it('malformed URL input completes in the real parser without the exponential decoder path', async () => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const load = require('node:module').createRequire(workerData);
      (async () => {
        const file = require('node:path').join(require('node:path').dirname(load.resolve('expo-auth-session')), 'QueryParams.js');
        const { getQueryParams } = await import(require('node:url').pathToFileURL(file).href);
        const parsed = getQueryParams('onehr://auth/callback?state=' + '%C2'.repeat(10000));
        parentPort.postMessage(parsed.params.state.length);
      })().catch(error => { throw error; });
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

  it('malformed links with many distinct encoded runs cannot stall the real query parser', async () => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const load = require('node:module').createRequire(workerData);
      let payload = '';
      for (let i = 0; i < 32000; i++) {
        payload += '%' + Math.floor(i / 256).toString(16).padStart(2, '0') + '%' + (i % 256).toString(16).padStart(2, '0') + 'x';
      }
      (async () => {
        const file = require('node:path').join(require('node:path').dirname(load.resolve('expo-auth-session')), 'QueryParams.js');
        const { getQueryParams } = await import(require('node:url').pathToFileURL(file).href);
        const parsed = getQueryParams('onehr://auth/callback?state=' + payload + '%zz');
        parentPort.postMessage({ length: parsed.params.state.length, intact: parsed.params.state.endsWith('%zz') });
      })().catch(error => { throw error; });
    `, { eval: true, workerData: packagePath.pathname });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await new Promise<{ length: number; intact: boolean }>((resolve, reject) => {
        worker.once('message', resolve); worker.once('error', reject);
        watchdog = setTimeout(() => reject(new Error('Distinct malformed URL runs blocked the parser for 5 seconds.')), 5000);
      });
      expect(result.intact).toBe(true);
      expect(result.length).toBeGreaterThan(32000);
    } finally { clearTimeout(watchdog); await worker.terminate(); }
  }, 10000);

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
