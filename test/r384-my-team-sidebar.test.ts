import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
it('hides the My Team rail under 900px while retaining the normal sidebar breakpoint elsewhere',()=>{
 const source=readFileSync(resolve(process.cwd(),'components/sidebar.tsx'),'utf8').replace(/\/\*[\s\S]*?\*\//g,' ').replace(/(^|[^:])\/\/[^\n]*/g,'$1 ');
 expect(source).toContain('const pathname = usePathname();');
 const wrapper=source.match(/<div className=\{cn\('relative hidden h-full shrink-0'[\s\S]*?\)\}>/)?.[0];
 expect(wrapper,'the actual outer responsive wrapper must be present').toBeTruthy();
 expect(wrapper).toContain("pathname === '/manage/my-team' ? 'min-[900px]:block' : 'sm:block'");
 expect(wrapper).toContain("openNode && 'z-50'");
});
