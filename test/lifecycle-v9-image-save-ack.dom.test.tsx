import {useState} from 'react';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {ConfigurationSaveStatus} from '../app/lifecycle/v9/configuration-save-status';
import {TemplateSurface} from '../app/lifecycle/v9/template-surface';
import {useUnsavedChangesGuard} from '../components/ui/unsaved-changes';
import {EmailDefinition} from '../app/lifecycle/v9/email-definition';
import {useV9Configuration} from '../app/lifecycle/v9/use-v9-configuration';
import {v9Defaults} from '../lib/lifecycle-v9-defaults';
import type {Config,ConfigSaveReceipt,EmailAsset} from '../lib/lifecycle-v9-model';
import {aiReviewDomHtml,captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
const image:EmailAsset={id:'9ea43e78-c325-4f88-8313-1b6fc3a1a78e',kind:'image',name:'Fictional welcome.png',mimeType:'image/png',size:20,contentHash:'a'.repeat(64),at:'2026-11-18T00:00:00Z',by:'Fictional HR'};
type Result={ok:true;result:ConfigSaveReceipt}|{ok:false;error:string};
const defer=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{resolve,promise};};
const noRects=()=>Object.assign([],{item:()=>null}) as unknown as DOMRectList;
for(const proto of [Range.prototype,Element.prototype] as {getClientRects?:unknown;getBoundingClientRect?:unknown}[]){proto.getClientRects??=noRects;proto.getBoundingClientRect??=()=>({x:0,y:0,top:0,left:0,right:0,bottom:0,width:0,height:0,toJSON(){}});}
HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
function Harness({initial,save,sent}:{initial:Config;save:(revision:number,value:Config)=>Promise<Result>;sent:()=>void}){
 const c=useV9Configuration(initial,save,()=>{},10000),[uploading,setUploading]=useState(false),email=c.draft!.emails[0];
 return <><ConfigurationSaveStatus state={c.state} error={c.error} retry={c.retry} reload={()=>{}} names={email.images?.map(image=>image.name)} uploading={uploading}/><EmailDefinition email={email} saved={c.state==='saved'&&!uploading} uploadsReady={c.state==='saved'} revision={c.draft!.revision} templates={[]} disabled={false} onUploadingChange={setUploading} change={change=>c.edit(next=>change(next.emails[0]))}/><button onClick={()=>{void c.flush().then(ok=>{if(ok)sent();});}}>Send current test</button><output data-testid="draft">{JSON.stringify(c.draft)}</output></>;
}
const draft=()=>JSON.parse(screen.getByTestId('draft').textContent!) as Config;
it('keeps delayed upload + body + alt in one acknowledged definition, retains in-flight typing, and reopens the saved revision',async()=>{
 const upload=defer<{ok:boolean;json:()=>Promise<{asset:EmailAsset}>}>(),first=defer<Result>(),second=defer<Result>(),sent=vi.fn(),initial=v9Defaults();
 const save=vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);vi.stubGlobal('fetch',vi.fn(()=>upload.promise));
 const view=render(<Harness initial={initial} save={save} sent={sent}/>);
 fireEvent.change(screen.getByLabelText('Add image'),{target:{files:[new File(['fictional'],'Fictional welcome.png',{type:'image/png'})]}});
 fireEvent.change(screen.getByRole('textbox',{name:'Subject'}),{target:{value:'Edited while upload is delayed'}});
 await act(async()=>{upload.resolve({ok:true,json:async()=>({asset:image})});});
 await waitFor(()=>expect(draft().emails[0].images).toEqual([image]));
 expect(draft().emails[0].subject).toBe('Edited while upload is delayed');
 fireEvent.change(screen.getByRole('textbox',{name:`Alt text for ${image.name}`}),{target:{value:'Connect, learn and grow'}});
 const toolbar=screen.getByRole('toolbar',{name:'Formatting'});fireEvent.click(within(toolbar).getByRole('button',{name:'Image'}));
 fireEvent.click(within(screen.getByRole('dialog',{name:'Insert image'})).getByRole('button',{name:/Fictional welcome.png/}));
 await waitFor(()=>expect(JSON.stringify(draft().emails[0].bodyDoc)).toContain(image.id));
 fireEvent.click(screen.getByRole('tab',{name:'Preview'}));expect(screen.getByText(/Preview of unsaved changes/)).toBeVisible();
 fireEvent.click(screen.getByRole('button',{name:'Send current test'}));expect(save).toHaveBeenCalledOnce();expect(sent).not.toHaveBeenCalled();
 fireEvent.change(screen.getByRole('textbox',{name:'Subject'}),{target:{value:'Final subject'}});
 await act(async()=>{first.resolve({ok:true,result:{revision:initial.revision+1,groupsRevision:1}});});
 expect(save).toHaveBeenCalledTimes(2);expect(sent).not.toHaveBeenCalled();
 const saved=save.mock.calls[1][1] as Config;expect(saved.emails[0]).toMatchObject({subject:'Final subject',images:[{...image,alt:'Connect, learn and grow'}]});
 expect(saved.emails[0].bodyDoc).toEqual(draft().emails[0].bodyDoc);
 await act(async()=>{second.resolve({ok:true,result:{revision:initial.revision+2,groupsRevision:1}});});
 expect(sent).toHaveBeenCalledOnce();expect(screen.queryByText(/Preview of unsaved changes/)).toBeNull();
 const acknowledged=structuredClone(draft());view.unmount();render(<Harness initial={acknowledged} save={save} sent={sent}/>);
 expect(draft().emails[0]).toEqual(acknowledged.emails[0]);expect(screen.getByRole('textbox',{name:`Alt text for ${image.name}`})).toHaveValue('Connect, learn and grow');
 expect(draft().revision).toBe(initial.revision+2);
});
it('shows the named failure and retry inside the open modal and requires an explicit discard before reloading',()=>{
 const retry=vi.fn(),reload=vi.fn();render(<TemplateSurface kind="email" dirty close={()=>{}} heading={<h2>Fictional Welcome email</h2>}><ConfigurationSaveStatus state="error" error="The stored receipt is invalid." retry={retry} reload={reload} names={[image.name]}/></TemplateSurface>);
 const modal=screen.getByRole('dialog',{name:'Edit email template'});expect(within(modal).getByText(`Could not save changes to ${image.name}.`,{exact:false})).toBeVisible();
 fireEvent.click(within(modal).getByRole('button',{name:'Try saving again'}));expect(retry).toHaveBeenCalledOnce();
 fireEvent.click(within(modal).getByRole('button',{name:'Reload saved settings'}));expect(reload).not.toHaveBeenCalled();
 fireEvent.click(within(screen.getByRole('alertdialog',{name:'Reload saved settings?'})).getByRole('button',{name:'Keep editing'}));expect(reload).not.toHaveBeenCalled();
 fireEvent.click(within(modal).getByRole('button',{name:'Reload saved settings'}));fireEvent.click(screen.getByRole('button',{name:'Discard changes and reload'}));expect(reload).toHaveBeenCalledOnce();
});
it('guards both Close and Escape while unsaved and keeps the modal open when declined',()=>{
 const close=vi.fn();const view=render(<TemplateSurface kind="email" dirty close={close}>Retained edits</TemplateSurface>);
 fireEvent.click(screen.getByRole('button',{name:'Close'}));expect(close).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Keep editing'}));
 const event=new Event('cancel',{bubbles:true,cancelable:true});fireEvent(screen.getByRole('dialog'),event);expect(event.defaultPrevented).toBe(true);expect(close).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Close editor'}));expect(close).toHaveBeenCalledOnce();
 view.rerender(<TemplateSurface kind="email" dirty={false} close={close}>Saved</TemplateSurface>);fireEvent.click(screen.getByRole('button',{name:'Close'}));expect(close).toHaveBeenCalledTimes(2);
});
it.each(['en','ms','zh','ta','th','vi'])('renders the acknowledged/unsaved/named-error copy in %s',locale=>{
 const ui=JSON.parse(readFileSync('messages/'+locale+'.json','utf8')).probationEmailBuilder.ui as Record<string,string>;
 const copy=(key:string,values?:Record<string,string|number>)=>Object.entries(values??{}).reduce((s,[k,v])=>s.replace('{'+k+'}',String(v)),ui[key]);
 const view=render(<ConfigurationSaveStatus state="saved" error="" retry={()=>{}} reload={()=>{}} copy={copy}/>);expect(screen.getByRole('status')).toHaveTextContent(ui.ackSaved);
 view.rerender(<ConfigurationSaveStatus state="error" error="Controlled receipt refusal" names={[image.name]} retry={()=>{}} reload={()=>{}} copy={copy}/>);expect(screen.getByRole('status')).toHaveTextContent(ui.ackNotSaved);expect(screen.getByText(copy('ackImageFailed',{names:image.name}),{exact:false})).toBeVisible();
});
it.each(['light','dark'] as const)('captures the real modal save failure and retained controls on desktop and phone (%s)',async mode=>{
 render(<TemplateSurface kind="email" dirty close={()=>{}} heading={<h2>Fictional Welcome email</h2>}><ConfigurationSaveStatus state="error" error="The image receipt could not be verified." names={['Fictional welcome.png']} retry={()=>{}} reload={()=>{}}/><EmailDefinition email={{...v9Defaults().emails[0],images:[{...image,alt:'Connect, learn and grow'}]}} templates={[]} disabled={false} saved={false} uploadsReady={false} change={()=>{}}/></TemplateSurface>);
 fireEvent.click(screen.getByRole('tab',{name:'Preview'}));
 const style=readFileSync('app/lifecycle/v9/workspace.css','utf8')+readFileSync('app/onboarding-workspace.css','utf8');
 await captureAiReviewScreenshots('<style>'+style+'</style><div class="v9-workspace">'+aiReviewDomHtml(document.body)+'</div>','en','feedback-image-save-ack-'+mode,'Actual email modal, named save failure, retry and dirty preview; fictional content; controlled render, not staging acceptance','atelier',mode);
},120000);

it('warns before reload and in-app navigation only while a save is unacknowledged',()=>{
 function Guard({dirty}:{dirty:boolean}){useUnsavedChangesGuard(dirty,'Unsaved image changes');return <a href="/personnel">Personnel</a>;}
 const confirm=vi.fn(()=>false);vi.stubGlobal('confirm',confirm);const view=render(<Guard dirty/>);
 const reload=new Event('beforeunload',{cancelable:true});fireEvent(window,reload);expect(reload.defaultPrevented).toBe(true);
 const click=new MouseEvent('click',{bubbles:true,cancelable:true});fireEvent(screen.getByRole('link'),click);expect(confirm).toHaveBeenCalledWith('Unsaved image changes');expect(click.defaultPrevented).toBe(true);
 view.rerender(<Guard dirty={false}/>);const savedReload=new Event('beforeunload',{cancelable:true});fireEvent(window,savedReload);expect(savedReload.defaultPrevented).toBe(false);
});
