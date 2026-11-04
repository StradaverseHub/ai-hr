/** DIAGNOSTIC ONLY (CI branch, never release evidence). Exercises a verbatim copy of pressWithFocus from
 * test/lifecycle-v9-html-gaps.browser.test.tsx under deterministic window deactivation (a popup window). */
import {expect,it} from 'vitest';
import {userEvent} from 'vitest/browser';
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function pressWithFocus(button:HTMLElement,key:string,step:string) {
 for(let attempt=1;attempt<=3;attempt++){
  await expect.poll(()=>{if(!button.matches(':focus')){button.blur();button.focus();}return document.activeElement===button&&button.matches(':focus');}).toBe(true);
  let focusTaken=false,activated=false;const taken=()=>{focusTaken=true;},clicked=()=>{activated=true;};
  button.addEventListener('blur',taken);button.addEventListener('click',clicked);
  try{await userEvent.keyboard(key);}finally{button.removeEventListener('blur',taken);button.removeEventListener('click',clicked);}
  if(activated||!focusTaken)return;
  console.info('V9_KEYBOARD_FOCUS_TAKEN '+JSON.stringify({step,key,attempt}));
 }
 throw new Error(`${step}: another browser window took keyboard focus during every press`);
}
it('keeps keyboard activation exact when another window takes focus', async()=>{
 document.body.innerHTML='';
 const make=(name:string)=>{const button=document.createElement('button');button.type='button';button.textContent=name;document.body.append(button);let clicks=0;button.addEventListener('click',()=>{clicks++;});return {button,clicks:()=>clicks};};
 const events:string[]=[];const t0=performance.now();const note=(name:string)=>events.push(`${Math.round(performance.now()-t0)}:${name}`);
 for(const type of ['focus','blur'])window.addEventListener(type,event=>{if(event.target===window)note('window-'+type);});
 const takenLines:string[]=[];const info=console.info;console.info=(...args:any[])=>{if(typeof args[0]==='string'&&args[0].startsWith('V9_KEYBOARD_FOCUS_TAKEN'))takenLines.push(args[0]);info(...args);};
 const results:any[]=[];
 try{
  // P1: the window is deactivated after focus() and before the press (the release-run state).
  const one=make('one');one.button.focus();const popup1=window.open('about:blank','_blank','popup,width=320,height=240');
  for(let i=0;i<40&&one.button.matches(':focus');i++)await wait(25);
  results.push({case:'P1 before press',activeIsButton:document.activeElement===one.button,matchesFocus:one.button.matches(':focus'),hasFocus:document.hasFocus()});
  await pressWithFocus(one.button,'{Enter}','P1');results.push({case:'P1 after press',clicks:one.clicks(),taken:takenLines.length});
  popup1?.close();for(let i=0;i<40&&!document.hasFocus();i++)await wait(25);
  // P2: the window is deactivated while the press is in flight (opened from the focus that the helper performs).
  const two=make('two');let opened:Window|null=null;two.button.addEventListener('focus',()=>{if(!opened)opened=window.open('about:blank','_blank','popup,width=320,height=240');});
  const before=takenLines.length;await pressWithFocus(two.button,'{Enter}','P2');results.push({case:'P2 after press',clicks:two.clicks(),taken:takenLines.length-before,popup:!!opened});
  (opened as Window|null)?.close();for(let i=0;i<40&&!document.hasFocus();i++)await wait(25);
  // P3: a press on a button that keeps focus but whose activation is prevented is never repeated.
  const three=make('three');three.button.addEventListener('keypress',event=>event.preventDefault());const beforeThree=takenLines.length;
  await pressWithFocus(three.button,'{Enter}','P3');results.push({case:'P3 after press',clicks:three.clicks(),taken:takenLines.length-beforeThree});
 }finally{console.info=info;}
 console.info('HELPER_DIAG '+JSON.stringify({results,events,takenLines}));
 expect(results.find(r=>r.case==='P1 after press')?.clicks).toBe(1);
 expect(results.find(r=>r.case==='P3 after press')?.clicks).toBe(0);
});
