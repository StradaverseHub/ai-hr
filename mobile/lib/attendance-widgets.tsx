import {requireOptionalNativeModule} from 'expo';
import {widgetPresentation} from './widget-copy';
import type {AttendanceWidgetSnapshot} from './widget-snapshot';
const native=requireOptionalNativeModule<{updateSnapshot:(payload:string)=>void}>('OneHRAttendanceWidget');
export function updateAttendanceWidgets(snapshot:AttendanceWidgetSnapshot|null):void{
 try{native?.updateSnapshot(JSON.stringify({...widgetPresentation(snapshot),expiresAt:snapshot?.expiresAt??0}));}catch{/* Widget failure never blocks authentication or attendance. */}
}
export function initializeAttendanceWidgets():void{updateAttendanceWidgets(null);}
