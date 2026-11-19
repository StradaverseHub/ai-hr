import type {ResignationTaskView} from '@/lib/resignation-journey';
export function resignationTaskInFilter(task:ResignationTaskView,filter:string,viewerId?:string){return filter==='all'||filter==='assigned'&&(!task.team||!!task.onIt&&task.onIt.id===viewerId)||filter==='tagged'&&task.tagged||filter==='team'&&task.team||filter==='overdue'&&task.overdue;}
