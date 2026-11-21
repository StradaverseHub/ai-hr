import {afterEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {TestingScreenshotUpload} from '@/components/system-testing/screenshot-upload';
import {ActionFeedbackProvider} from '@/components/action-feedback';
const refresh=vi.hoisted(()=>vi.fn());
vi.mock('next/navigation',()=>({useRouter:()=>({refresh})}));
vi.mock('next-intl',()=>({useTranslations:()=>((key:string)=>(({upload:'Upload',screenshot:'Screenshot',uploading:'Uploading…',success:'Confirmed complete',uncertain:'Check status before retrying',uploadFailed:'Upload refused',uploadInvalid:'Invalid file'} as Record<string,string>)[key]??key))}));
vi.mock('react-dom',async original=>({...await original<typeof import('react-dom')>(),useFormStatus:()=>({pending:false,data:null,method:null,action:null})}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.clearAllMocks();});
function setup(){render(<ActionFeedbackProvider><TestingScreenshotUpload executionId="execution" runId="run"/></ActionFeedbackProvider>);const input=screen.getByLabelText('Screenshot') as HTMLInputElement;fireEvent.change(input,{target:{files:[new File(['test'],'evidence.png',{type:'image/png'})]}});return input;}
describe('confirmed attachment processing',()=>{
 it('holds pending to the server response, refuses duplicate submits and confirms success only after persistence',async()=>{
  let resolve!:(response:Response)=>void;const fetcher=vi.fn(()=>new Promise<Response>(done=>{resolve=done;}));vi.stubGlobal('fetch',fetcher);const input=setup(),form=input.closest('form')!;
  fireEvent.submit(form);fireEvent.submit(form);expect(fetcher).toHaveBeenCalledTimes(1);expect(screen.getByRole('button',{name:'Uploading…'})).toBeDisabled();expect(screen.queryByText('Confirmed complete')).toBeNull();
  await act(async()=>resolve(new Response(JSON.stringify({id:'11111111-1111-4111-8111-111111111111'}),{status:201,headers:{'content-type':'application/json'}})));await waitFor(()=>expect(screen.getByText('Confirmed complete')).toBeInTheDocument());expect(refresh).toHaveBeenCalledTimes(1);expect(screen.getByRole('button',{name:'Upload'})).toBeEnabled();
 });
 it('preserves the chosen file after a rejected or disconnected upload and never shows success',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('Disconnected')));const input=setup();fireEvent.submit(input.closest('form')!);await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('Check status before retrying'));expect(input.files?.[0]?.name).toBe('evidence.png');expect(refresh).not.toHaveBeenCalled();expect(screen.getByRole('button',{name:'Upload'})).toBeEnabled();expect(screen.queryByText('Confirmed complete')).toBeNull();
 });
 it('refuses an HTML authentication response as proof of attachment persistence',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('<html>Sign in</html>',{status:200,headers:{'content-type':'text/html'}})));const input=setup();fireEvent.submit(input.closest('form')!);await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('Check status before retrying'));expect(refresh).not.toHaveBeenCalled();expect(input.files?.[0]?.name).toBe('evidence.png');
 });

});
