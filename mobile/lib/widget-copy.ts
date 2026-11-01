import {t} from './i18n';
import type {AttendanceWidgetSnapshot} from './widget-snapshot';
export type WidgetPresentation={clockIn:string;clockOut:string;hint:string;status:string;inTime:string;outTime:string;updated:string;active:boolean};
export function widgetPresentation(snapshot:AttendanceWidgetSnapshot|null):WidgetPresentation{
 return {clockIn:t('clockIn'),clockOut:t('clockOut'),hint:t('widgetOpenHint'),status:snapshot?t(snapshot.status==='in'?'widgetClockedIn':'widgetClockedOut'):t('widgetRefresh'),inTime:snapshot?.inTime??'—',outTime:snapshot?.outTime??'—',updated:snapshot?t('widgetUpdated',{date:snapshot.day,time:snapshot.updated}):t('widgetOpenHint'),active:snapshot?.status==='in'};
}
