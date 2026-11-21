import * as React from 'react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {IndependentHomeCard,useHomeCardRefresh} from '../components/employee-home/home-card';
import {HOME_CARD_READ_HARD_CAP_MS,HOME_CARD_REFRESH_DEDUPE_MS} from '../lib/employee-home-delivery';

const labels={loading:'Loading',failed:'This card could not load. Try again.',timeout:'This card took too long. Try again.',retry:'Retry',refresh:'Refresh'};
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();});
describe('independent Home card experience',()=>{
  const advance=(ms:number)=>act(async()=>{await vi.advanceTimersByTimeAsync(ms);});
  it('keeps a slow card in its loading state past 2.8 s, then renders it without any alert',async()=>{
    vi.useFakeTimers();
    let release:((value:string)=>void)|undefined,seen:AbortSignal|undefined;
    const read=vi.fn((signal:AbortSignal)=>{seen=signal;return new Promise<string>(resolve=>{release=resolve;});});
    render(<IndependentHomeCard card="team" title="Team" labels={labels} requestKey="team:own" read={read}>{value=><p>{value}</p>}</IndependentHomeCard>);
    const region=screen.getByRole('region',{name:'Team'});
    await advance(2800);await advance(9000);
    expect(region).toHaveAttribute('aria-busy','true');
    expect(within(region).getByRole('status')).toHaveTextContent(labels.loading);
    expect(screen.queryByRole('alert')).toBeNull();expect(seen?.aborted).toBe(false);
    await act(async()=>{release!('Team status recorded');await vi.advanceTimersByTimeAsync(0);});
    expect(within(region).getByText('Team status recorded')).toBeVisible();
    expect(region).toHaveAttribute('aria-busy','false');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(read).toHaveBeenCalledOnce();
  });
  it('shows the existing timeout alert only at the hard cap, aborts that read and never retries it',async()=>{
    vi.useFakeTimers();
    let seen:AbortSignal|undefined;
    const read=vi.fn((signal:AbortSignal)=>{seen=signal;return new Promise<string>(()=>{});});
    render(<IndependentHomeCard card="tasks" title="Waiting for You" labels={labels} requestKey="tasks:own" read={read}>{value=><p>{value}</p>}</IndependentHomeCard>);
    const region=screen.getByRole('region',{name:'Waiting for You'});
    await advance(HOME_CARD_READ_HARD_CAP_MS-1);
    expect(within(region).queryByRole('alert')).toBeNull();expect(seen?.aborted).toBe(false);
    await advance(1);
    expect(within(region).getByRole('alert')).toHaveTextContent(labels.timeout);
    expect(seen?.aborted).toBe(true);
    await advance(HOME_CARD_READ_HARD_CAP_MS*3);
    expect(read).toHaveBeenCalledOnce();
    expect(within(region).getByRole('button',{name:'Retry: Waiting for You'})).toBeEnabled();
  });
  function RefreshingCard({read}:{read:(signal:AbortSignal)=>Promise<string>}){
    const {refresh,activity}=useHomeCardRefresh(30000);
    return <IndependentHomeCard card="notices" title="Notices" labels={labels} requestKey={`notices:own:${refresh}`} read={read} activity={activity}>
      {value=><p>{value}</p>}</IndependentHomeCard>;
  }
  const activate=()=>{fireEvent(window,new Event('focus'));fireEvent(document,new Event('visibilitychange'));};
  it('never lets a focus or visibility refresh cancel a read in flight, including a slow first load',async()=>{
    const clock=vi.spyOn(performance,'now').mockReturnValue(1000);
    const signals:AbortSignal[]=[],releases:((value:string)=>void)[]=[];
    const read=vi.fn((signal:AbortSignal)=>{signals.push(signal);return new Promise<string>(resolve=>{releases.push(resolve);});});
    render(<RefreshingCard read={read}/>);
    await waitFor(()=>expect(read).toHaveBeenCalledOnce());
    for(let step=1;step<=3;step++){clock.mockReturnValue(1000+step*5000);activate();}
    await act(async()=>{await Promise.resolve();});
    expect(read).toHaveBeenCalledOnce();expect(signals[0].aborted).toBe(false);
    await act(async()=>{releases[0]('First load arrived');await Promise.resolve();});
    expect(await screen.findByText('First load arrived')).toBeVisible();
    expect(read).toHaveBeenCalledOnce();
    // Once idle, one activation (focus and visibility together) refreshes at once, exactly once.
    clock.mockReturnValue(30000);activate();
    await waitFor(()=>expect(read).toHaveBeenCalledTimes(2));
    clock.mockReturnValue(30000+HOME_CARD_REFRESH_DEDUPE_MS*3);activate();
    await act(async()=>{await Promise.resolve();});
    // That refresh is itself in flight, so the next activation does not cancel it.
    expect(read).toHaveBeenCalledTimes(2);expect(signals[1].aborted).toBe(false);
    await act(async()=>{releases[1]('Refreshed notices');await Promise.resolve();});
    expect(await screen.findByText('Refreshed notices')).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('refreshes an idle card on each activation without waiting for the read cap',async()=>{
    const clock=vi.spyOn(performance,'now').mockReturnValue(1000);
    let count=0;
    const read=vi.fn(async(_signal:AbortSignal)=>'Notices version '+(++count));
    render(<RefreshingCard read={read}/>);
    expect(await screen.findByText('Notices version 1')).toBeVisible();
    clock.mockReturnValue(1500);activate();
    expect(await screen.findByText('Notices version 2')).toBeVisible();
    // A second activation only just past the de-duplication window, far inside the old 2.8 s and 20 s gates.
    clock.mockReturnValue(1500+HOME_CARD_REFRESH_DEDUPE_MS+1);activate();
    expect(await screen.findByText('Notices version 3')).toBeVisible();
    expect(read).toHaveBeenCalledTimes(3);
  });
  it('still shows a real read error or refusal at once, with the failed message rather than the timeout',async()=>{
    const read=vi.fn(async(_signal:AbortSignal):Promise<string>=>{throw new Error('Fictional permission refusal');});
    render(<IndependentHomeCard card="notices" title="Notices" labels={labels} requestKey="notices:own" read={read}>{value=><p>{value}</p>}</IndependentHomeCard>);
    const region=screen.getByRole('region',{name:'Notices'});
    await waitFor(()=>expect(within(region).getByRole('alert')).toHaveTextContent(labels.failed));
    expect(within(region).getByRole('alert')).not.toHaveTextContent(labels.timeout);
    expect(screen.queryByText('Fictional permission refusal')).not.toBeInTheDocument();
    expect(read).toHaveBeenCalledOnce();
  });
  it('keeps a ready sibling usable and retries only the failed card',async()=>{
    const calendar=vi.fn(async(_signal:AbortSignal):Promise<string>=>'Calendar recovered')
      .mockRejectedValueOnce(new Error('Fictional private query detail'));
    const tasks=vi.fn(async()=>'One assigned task');
    render(<>
      <IndependentHomeCard card="calendar" title="Calendar" labels={labels} requestKey="calendar:own" read={calendar}>{value=><p>{value}</p>}</IndependentHomeCard>
      <IndependentHomeCard card="tasks" title="Waiting for You" labels={labels} requestKey="tasks:own" read={tasks}>{value=><button type="button">{value}</button>}</IndependentHomeCard>
    </>);
    const calendarRegion=screen.getByRole('region',{name:'Calendar'}),tasksRegion=screen.getByRole('region',{name:'Waiting for You'});
    await waitFor(()=>expect(within(calendarRegion).getByRole('alert')).toHaveTextContent(labels.failed));
    await waitFor(()=>expect(within(tasksRegion).getByRole('button',{name:'One assigned task'})).toBeEnabled());
    expect(screen.queryByText('Fictional private query detail')).not.toBeInTheDocument();
    const taskReads=tasks.mock.calls.length;
    fireEvent.click(within(calendarRegion).getByRole('button',{name:'Retry: Calendar'}));
    await waitFor(()=>expect(within(calendarRegion).getByText('Calendar recovered')).toBeVisible());
    expect(tasks).toHaveBeenCalledTimes(taskReads);
    expect(within(tasksRegion).getByRole('button',{name:'One assigned task'})).toBeEnabled();
  });
  it('does not show a previous employment result after the request context changes',async()=>{
    let releaseOld:((value:string)=>void)|undefined,oldSignal:AbortSignal|undefined;
    const oldRead=(signal:AbortSignal)=>{oldSignal=signal;return new Promise<string>(resolve=>{releaseOld=resolve;});};
    const currentRead=async()=>'Selected employment';
    const body=(value:string)=><p>{value}</p>;
    const {rerender}=render(<IndependentHomeCard card="timeOff" title="Time Off" labels={labels} requestKey="employment:old" read={oldRead}>{body}</IndependentHomeCard>);
    await waitFor(()=>expect(oldSignal).toBeDefined());
    rerender(<IndependentHomeCard card="timeOff" title="Time Off" labels={labels} requestKey="employment:selected" read={currentRead}>{body}</IndependentHomeCard>);
    await waitFor(()=>expect(screen.getByText('Selected employment')).toBeVisible());
    expect(oldSignal?.aborted).toBe(true);
    await React.act(async()=>{releaseOld!('Old employment');await Promise.resolve();});
    expect(screen.queryByText('Old employment')).not.toBeInTheDocument();
    expect(screen.getByText('Selected employment')).toBeVisible();
  });
  it('contains a renderer failure and allows an explicit retry without losing a sibling',async()=>{
    vi.spyOn(console,'error').mockImplementation(()=>{});
    let broken=true;
    const read=async()=>'Recorded notice';
    const summary=async()=>'Recorded update';
    render(<>
      <IndependentHomeCard card="notices" title="Notices" labels={labels} requestKey="notices:own" read={read}>
        {value=>{if(broken)throw new Error('Fictional renderer fault');return <p>{value}</p>;}}
      </IndependentHomeCard>
      <IndependentHomeCard card="summary" title="Today at a glance" labels={labels} requestKey="summary:own" read={summary}>{value=><p>{value}</p>}</IndependentHomeCard>
    </>);
    const notices=screen.getByRole('region',{name:'Notices'});
    await waitFor(()=>expect(within(notices).getByRole('alert')).toHaveTextContent(labels.failed));
    await waitFor(()=>expect(screen.getByText('Recorded update')).toBeVisible());
    broken=false;fireEvent.click(within(notices).getByRole('button',{name:'Retry: Notices'}));
    await waitFor(()=>expect(within(notices).getByText('Recorded notice')).toBeVisible());
    expect(screen.getByText('Recorded update')).toBeVisible();
  });
});
