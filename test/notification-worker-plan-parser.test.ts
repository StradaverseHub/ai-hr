import {expect,it} from 'vitest';
import {notificationAutoExplainMessages} from './fixtures/notification-worker/auto-explain';
const frame=(pid:number,value:unknown)=>`2026-11-08 00:00:00 [${pid}] LOG:  duration: 12.345 ms plan:\n${JSON.stringify(value,null,2)}\nCONTEXT: PL/pgSQL function notification_worker_private.admit_login() line 4 at IF\n`;
it('parses only the exact native PID, retaining nested context and actual execution/JIT fields',()=>{
 const value={'Query Text':"SELECT '{quoted}'",Plan:{'Node Type':'Result','Actual Rows':1,'Actual Loops':1},JIT:{Timing:{Total:11.9}}};
 const parsed=notificationAutoExplainMessages(frame(11,value)+frame(12,value),12);expect(parsed).toHaveLength(1);expect(parsed[0]).toMatchObject({pid:12,durationMs:12.345,document:value});expect(parsed[0].context).toContain('notification_worker_private.admit_login()');
});
it('refuses truncated/missing execution plans and invalid PID identities instead of accepting an outer success claim',()=>{
 expect(()=>notificationAutoExplainMessages('2026 [12] LOG: duration: 1 ms plan:\n{"Query Text":"SELECT 1","Plan":{',12)).toThrow('Truncated');
 expect(()=>notificationAutoExplainMessages(frame(12,{'Query Text':'SELECT 1',claimedExecuted:true}),12)).toThrow('Native executable');
 expect(()=>notificationAutoExplainMessages(frame(12,{'Query Text':'SELECT 1',Plan:{'Node Type':'Result'}}),12)).toThrow('Actual native execution');
 expect(()=>notificationAutoExplainMessages('',0)).toThrow('Unbounded');expect(notificationAutoExplainMessages(frame(11,{'Query Text':'SELECT 1',Plan:{}}),12)).toEqual([]);
});
