/** DIAGNOSTIC ONLY (CI branch, never release evidence). Deterministically deactivates this page's window between a
 * button's focus() and an Enter press by opening a popup window, and records what Firefox does with the key. */
import {it} from 'vitest';
import {userEvent} from 'vitest/browser';
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
it('records keyboard activation when the window is deactivated after focus', async()=>{
 document.body.innerHTML='';
 const button=document.createElement('button');button.type='button';button.textContent='Toggle section';button.setAttribute('aria-expanded','false');
 let clicks=0;button.addEventListener('click',()=>{clicks++;button.setAttribute('aria-expanded',String(button.getAttribute('aria-expanded')!=='true'));});
 document.body.append(button);
 const events:string[]=[];const t0=performance.now();const note=(name:string)=>events.push(`${Math.round(performance.now()-t0)}:${name}`);
 for(const type of ['focus','blur'])window.addEventListener(type,event=>{if(event.target===window)note('window-'+type);});
 for(const type of ['focus','blur','keydown','keypress','keyup','click'])button.addEventListener(type,event=>note('button-'+type+(event instanceof KeyboardEvent?':'+event.key:'')));
 const log:any[]=[];
 const state=(step:string,extra:any={})=>log.push({step,activeIsButton:document.activeElement===button,matchesFocus:button.matches(':focus'),hasFocus:document.hasFocus(),clicks,expanded:button.getAttribute('aria-expanded'),...extra});
 const press=async(step:string)=>{const before=clicks;await userEvent.keyboard('{Enter}');state(step,{activated:clicks-before});};
 button.focus();state('A focused, window active');await press('A Enter');
 button.focus();state('B focused');
 const popup=window.open('about:blank','_blank','popup,width=320,height=240');
 for(let i=0;i<40&&document.hasFocus();i++)await wait(25);
 state('B popup opened',{popup:!!popup});
 await press('B Enter after deactivation without refocus');
 button.focus();state('C refocused while deactivated');await press('C Enter after refocus');
 button.blur();button.focus();state('D blurred and refocused while deactivated');await press('D Enter');
 popup?.close();
 for(let i=0;i<40&&!document.hasFocus();i++)await wait(25);
 state('E popup closed');await press('E Enter after popup closed without refocus');
 button.focus();state('F refocused after popup closed');await press('F Enter');
 console.info('FOCUS_DIAG '+JSON.stringify({engine:navigator.userAgent,log,events}));
});
