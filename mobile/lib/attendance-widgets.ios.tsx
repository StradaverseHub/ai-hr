import {t} from './i18n';
import {HStack,VStack,Text,Link,Image} from '@expo/ui/swift-ui';
import {font,foregroundStyle,widgetURL,containerBackground,padding,accessibilityLabel,lineLimit} from '@expo/ui/swift-ui/modifiers';
import {createWidget,type WidgetEnvironment} from 'expo-widgets';

type Labels={clockIn:string;clockOut:string;hint:string};
const InWidget=(props:Labels,env:WidgetEnvironment)=>{
 'widget';
 const color=env.colorScheme==='dark'?'#F3F5F9':'#172235';
 if(env.widgetFamily==='accessoryCircular')return <VStack modifiers={[widgetURL('aihr://clock?action=in'),accessibilityLabel(props.clockIn)]}><Image systemName="arrow.down.right.circle"/></VStack>;
 return <VStack alignment="leading" spacing={12} modifiers={[widgetURL('aihr://clock?action=in'),containerBackground(env.colorScheme==='dark'?'#142238':'#F5F8FC','widget')]}><Text modifiers={[font({size:16,weight:'semibold'}),foregroundStyle(color)]}>OneHR+</Text><Image systemName="arrow.down.right.circle.fill" color="#177869"/><Text modifiers={[font({size:18,weight:'semibold'}),foregroundStyle(color),lineLimit(2)]}>{props.clockIn}</Text></VStack>;
};
const OutWidget=(props:Labels,env:WidgetEnvironment)=>{
 'widget';
 const color=env.colorScheme==='dark'?'#F3F5F9':'#172235';
 if(env.widgetFamily==='accessoryCircular')return <VStack modifiers={[widgetURL('aihr://clock?action=out'),accessibilityLabel(props.clockOut)]}><Image systemName="arrow.up.right.circle"/></VStack>;
 return <VStack alignment="leading" spacing={12} modifiers={[widgetURL('aihr://clock?action=out'),containerBackground(env.colorScheme==='dark'?'#142238':'#F5F8FC','widget')]}><Text modifiers={[font({size:16,weight:'semibold'}),foregroundStyle(color)]}>OneHR+</Text><Image systemName="arrow.up.right.circle.fill" color="#177869"/><Text modifiers={[font({size:18,weight:'semibold'}),foregroundStyle(color),lineLimit(2)]}>{props.clockOut}</Text></VStack>;
};
const ActionsWidget=(props:Labels,env:WidgetEnvironment)=>{
 'widget';
 const color=env.colorScheme==='dark'?'#F3F5F9':'#172235';
 return <VStack alignment="leading" spacing={12} modifiers={[containerBackground(env.colorScheme==='dark'?'#142238':'#F5F8FC','widget')]}><Text modifiers={[font({size:18,weight:'semibold'}),foregroundStyle(color)]}>OneHR+</Text><Text modifiers={[font({size:12}),foregroundStyle(color)]}>{props.hint}</Text><HStack spacing={24}><Link destination="aihr://clock?action=in" modifiers={[padding({vertical:12})]}><Text modifiers={[font({size:18,weight:'semibold'}),foregroundStyle('#177869')]}>{props.clockIn}</Text></Link><Link destination="aihr://clock?action=out" modifiers={[padding({vertical:12})]}><Text modifiers={[font({size:18,weight:'semibold'}),foregroundStyle('#177869')]}>{props.clockOut}</Text></Link></HStack></VStack>;
};
const clockIn=createWidget('OneHRClockIn',InWidget),clockOut=createWidget('OneHRClockOut',OutWidget),actions=createWidget('OneHRAttendance',ActionsWidget);
export function initializeAttendanceWidgets():void{
 // Public, static properties only. A widget failure must not prevent signing in or recording attendance.
 try{const labels={clockIn:t('clockIn'),clockOut:t('clockOut'),hint:t('widgetOpenHint')};clockIn.updateSnapshot(labels);clockOut.updateSnapshot(labels);actions.updateSnapshot(labels);}catch{}
}
