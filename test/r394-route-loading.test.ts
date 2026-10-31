/**
 * r394 — every page folder carries its own loading boundary (components/route-loading.tsx).
 *
 * Next 16 does not prefetch a dynamic route without `loading.tsx`, and a boundary covers only its own
 * segment, so a page folder without one brings back the frozen-click navigation measured on 2026-10-07.
 * A new page is caught here, not in production. The exceptions are full-screen pages outside the app
 * shell (no sidebar to keep, their own design): sign-in, invitation, password reset, the mobile preview —
 * and the app/(app)/admin/locations redirect stubs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
// app/(app)/admin/locations is a tree of guarded REDIRECT stubs (the screen moved to Organization); its own guard
// (test/work-location-organization-relocation.test.ts) pins it to nothing but the stubs, and a page that only
// redirects has nothing to show a skeleton for.
// The login flow, and the catch-all that only answers unmatched URLs with the shell's 404.
const EXEMPT = [/^app\/\(auth\)(\/|$)/, /^app\/\(app\)\/\[\.\.\.missing\](\/|$)/, /^app\/\(app\)\/mobile-preview(\/|$)/, /^app\/\(app\)\/admin\/locations(\/|$)/];

function pageDirs(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...pageDirs(rel));
    else if (e.name === 'page.tsx') out.push(dir);
  }
  return out;
}

type LoadingContract={namespace:string;key:string;parent?:{folder:string;specifier:string}};
const LOCALIZED:Readonly<Record<string,LoadingContract>>={
  'app/(app)/attendance/my-roster':{namespace:'attendance.myCalendar',key:'loading'},
  'app/(app)/me/ea':{namespace:'myEa',key:'loading'},
  'app/(app)/me/payslip':{namespace:'myPayslip',key:'loading'},
  'app/(app)/me/tp3':{namespace:'myTp3',key:'loading'},
  'app/(app)/payroll/formula-builder':{namespace:'payFormula',key:'loading'},
  'app/(app)/payroll/formula-builder/new':{namespace:'payFormula',key:'loading',parent:{folder:'app/(app)/payroll/formula-builder',specifier:'../loading'}},
  'app/(app)/payroll/formula-builder/[id]':{namespace:'payFormula',key:'loading',parent:{folder:'app/(app)/payroll/formula-builder',specifier:'../loading'}},
  'app/(app)/payroll/formula-builder/evaluations/[id]':{namespace:'payFormula',key:'traceLoading'},
};
const readLoading=(folder:string)=>fs.readFileSync(path.join(ROOT,folder,'loading.tsx'),'utf8');
function assertLocalizedLoading(folder:string,read:(folder:string)=>string,visited=new Set<string>()):void {
  const contract=LOCALIZED[folder];expect(contract,folder).toBeDefined();
  expect(visited.has(folder),'loading owner must not cycle').toBe(false);visited.add(folder);
  const source=read(folder);
  if(contract.parent){
    // Only these two exact child statements may delegate, and only to the finite known owner.
    expect(source.trim(),folder).toBe(`export {default} from '${contract.parent.specifier}';`);
    expect(path.resolve(ROOT,folder,contract.parent.specifier+'.tsx')).toBe(path.resolve(ROOT,contract.parent.folder,'loading.tsx'));
    expect(LOCALIZED[contract.parent.folder]).toMatchObject({namespace:contract.namespace,key:contract.key});
    return assertLocalizedLoading(contract.parent.folder,read,visited);
  }
  expect(source,folder).toContain(`getTranslations('${contract.namespace}')`);
  expect(source,folder).toContain('role="status"');
  expect(source,folder).toContain(`t('${contract.key}')`);
  expect(source,folder).not.toMatch(/animate-(?:pulse|spin)/);
}

describe('r394 · every page folder has a loading boundary', () => {
  const dirs = pageDirs('app');

  it('finds the app\'s pages (the sweep is not empty)', () => {
    expect(dirs.length).toBeGreaterThan(200);
    expect(dirs).toContain('app/(app)/leave');
    expect(dirs).toContain('app/(app)/leave/history');
  });

  it('each non-exempt page folder re-exports the shared RouteLoading shell', () => {
    const missing: string[] = [];
    const wrong: string[] = [];
    for (const d of dirs) {
      if (EXEMPT.some((r) => r.test(d))) continue;
      const f = path.join(ROOT, d, 'loading.tsx');
      if (!fs.existsSync(f)) { missing.push(d); continue; }
      const source = fs.readFileSync(f, 'utf8');
      if (LOCALIZED[d]) assertLocalizedLoading(d,readLoading);
      else if (!source.includes("from '@/components/route-loading'")) wrong.push(d);
    }
    expect(missing, 'add `export { default } from \'@/components/route-loading\';` as loading.tsx').toEqual([]);
    expect(wrong).toEqual([]);
  });

  it('accepts only the two exact Formula parent delegates and checks their real owner',()=>{
    for(const folder of ['app/(app)/payroll/formula-builder/new','app/(app)/payroll/formula-builder/[id]']){
      const visited:string[]=[];
      assertLocalizedLoading(folder,wanted=>{visited.push(wanted);return readLoading(wanted);});
      expect(visited).toEqual([folder,'app/(app)/payroll/formula-builder']);
      for(const wrong of ["export {default} from './missing';","export {default} from '../../loading';","export {default} from '/foreign/loading';",readLoading(folder)+"\nthrow new Error('extra child code');"]){
        expect(()=>assertLocalizedLoading(folder,wanted=>wanted===folder?wrong:readLoading(wanted))).toThrow();
      }
      expect(()=>assertLocalizedLoading(folder,wanted=>{
        if(wanted==='app/(app)/payroll/formula-builder')throw new Error('missing owner');return readLoading(wanted);
      })).toThrow('missing owner');
    }
  });

  it('refuses a missing namespace, status, correct key or reduced-motion boundary through a delegate',()=>{
    const owner='app/(app)/payroll/formula-builder',source=readLoading(owner);
    const wrong=[source.replace("getTranslations('payFormula')","getTranslations('foreign')"),
      source.replace('role="status"','role="none"'),source.replace("t('loading')","t('other')"),source+'\n// animate-pulse'];
    for(const changed of wrong){expect(changed).not.toBe(source);
      expect(()=>assertLocalizedLoading(owner+'/[id]',wanted=>wanted===owner?changed:readLoading(wanted))).toThrow();
    }
    const trace=owner+'/evaluations/[id]',traceSource=readLoading(trace);
    expect(traceSource).toContain("t('traceLoading')");
    expect(()=>assertLocalizedLoading(trace,wanted=>wanted===trace?traceSource.replace("t('traceLoading')","t('loading')"):readLoading(wanted))).toThrow();
    expect(()=>assertLocalizedLoading('app/unregistered',readLoading)).toThrow();
  });

  it('the exempt full-screen pages stay without the app-shell skeleton', () => {
    for (const d of dirs.filter((x) => EXEMPT.some((r) => r.test(x)))) {
      expect(fs.existsSync(path.join(ROOT, d, 'loading.tsx')), d).toBe(false);
    }
  });

  it('the shell is announced to assistive technology and honours reduced motion', () => {
    const src = fs.readFileSync(path.join(ROOT, 'components/route-loading.tsx'), 'utf8');
    expect(src).toContain('role="status"');
    expect(src).toContain("t('loading')");
    expect(src.match(/animate-pulse/g)?.length).toBe(src.match(/motion-reduce:animate-none/g)?.length);
  });
});
