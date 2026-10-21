import * as React from 'react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {IndependentHomeCard} from '../components/employee-home/home-card';

const labels={loading:'Loading',failed:'This card could not load. Try again.',timeout:'This card took too long. Try again.',retry:'Retry',refresh:'Refresh'};
afterEach(()=>{cleanup();vi.restoreAllMocks();});
describe('independent Home card experience',()=>{
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
