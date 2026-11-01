import {HStack,VStack,Text,Link,Image,Spacer} from '@expo/ui/swift-ui';
import {font,foregroundStyle,widgetURL,containerBackground,accessibilityLabel,lineLimit,frame,background,shapes,privacySensitive,minimumScaleFactor} from '@expo/ui/swift-ui/modifiers';
import {createWidget,type WidgetEnvironment} from 'expo-widgets';
import {widgetPresentation,type WidgetPresentation} from './widget-copy';
import type {AttendanceWidgetSnapshot} from './widget-snapshot';

const InWidget=(p:WidgetPresentation,e:WidgetEnvironment)=>{
 'widget';
 const dark=e.colorScheme==='dark',ink=dark?'#F1FFF8':'#102E25',muted=dark?'#B3D0C3':'#416557';
 if(e.widgetFamily==='accessoryCircular')return <VStack modifiers={[widgetURL('aihr://clock?action=in'),accessibilityLabel(p.clockIn)]}><Image systemName="arrow.down.right.circle"/></VStack>;
 return <VStack alignment="leading" spacing={3} modifiers={[widgetURL('aihr://clock?action=in'),frame({maxWidth:999,maxHeight:999,alignment:'leading'}),containerBackground({type:'linearGradient',colors:dark?['#24483C','#0B1D17']:['#D7EFE3','#F6FAF3'],startPoint:{x:0,y:0},endPoint:{x:1,y:1}},'widget')]}>
  <Text modifiers={[font({size:10}),foregroundStyle(muted),lineLimit(2),privacySensitive()]}>{p.status}</Text>
  <Text modifiers={[font({size:30,weight:'light'}),foregroundStyle(ink),privacySensitive()]}>{p.inTime}</Text>
  <HStack spacing={6} modifiers={[frame({maxWidth:999,minHeight:36}),background('#A6F2D5',shapes.capsule())]}><Image systemName="arrow.right.to.line" size={14} color="#102E25"/><Text modifiers={[font({size:13,weight:'semibold'}),foregroundStyle('#102E25'),lineLimit(1),minimumScaleFactor(.75)]}>{p.clockIn}</Text></HStack>
  <Text modifiers={[font({size:9}),foregroundStyle(muted),lineLimit(2),privacySensitive()]}>{p.updated}</Text>
 </VStack>;
};
const OutWidget=(p:WidgetPresentation,e:WidgetEnvironment)=>{
 'widget';
 const dark=e.colorScheme==='dark',ink=dark?'#F1FFF8':'#102E25',muted=dark?'#B3D0C3':'#416557';
 if(e.widgetFamily==='accessoryCircular')return <VStack modifiers={[widgetURL('aihr://clock?action=out'),accessibilityLabel(p.clockOut)]}><Image systemName="arrow.up.right.circle"/></VStack>;
 return <VStack alignment="leading" spacing={3} modifiers={[widgetURL('aihr://clock?action=out'),frame({maxWidth:999,maxHeight:999,alignment:'leading'}),containerBackground({type:'linearGradient',colors:dark?['#24483C','#0B1D17']:['#D7EFE3','#F6FAF3'],startPoint:{x:0,y:0},endPoint:{x:1,y:1}},'widget')]}>
  <Text modifiers={[font({size:10}),foregroundStyle(muted),lineLimit(2),privacySensitive()]}>{p.status}</Text>
  <Text modifiers={[font({size:30,weight:'light'}),foregroundStyle(ink),privacySensitive()]}>{p.outTime}</Text>
  <HStack spacing={6} modifiers={[frame({maxWidth:999,minHeight:36}),background('#A6F2D5',shapes.capsule())]}><Image systemName="arrow.up.right" size={14} color="#102E25"/><Text modifiers={[font({size:13,weight:'semibold'}),foregroundStyle('#102E25'),lineLimit(1),minimumScaleFactor(.75)]}>{p.clockOut}</Text></HStack>
  <Text modifiers={[font({size:9}),foregroundStyle(muted),lineLimit(2),privacySensitive()]}>{p.updated}</Text>
 </VStack>;
};
const ActionsWidget=(p:WidgetPresentation,e:WidgetEnvironment)=>{
 'widget';
 const dark=e.colorScheme==='dark',ink=dark?'#F1FFF8':'#102E25',muted=dark?'#B3D0C3':'#416557';
 return <VStack alignment="leading" spacing={4} modifiers={[frame({maxWidth:999,maxHeight:999,alignment:'leading'}),containerBackground({type:'linearGradient',colors:dark?['#24483C','#0B1D17']:['#D7EFE3','#F6FAF3'],startPoint:{x:0,y:0},endPoint:{x:1,y:1}},'widget')]}>
  <HStack spacing={8}><Text modifiers={[font({size:14,weight:'semibold'}),foregroundStyle(ink)]}>OneHR+</Text><Spacer/><Text modifiers={[font({size:11}),foregroundStyle(muted),lineLimit(1),minimumScaleFactor(.7),privacySensitive()]}>{p.status}</Text></HStack>
  <HStack spacing={20}>
   <VStack alignment="leading" spacing={0} modifiers={[frame({maxWidth:999,alignment:'leading'})]}><Text modifiers={[font({size:11}),foregroundStyle(muted)]}>{p.clockIn}</Text><Text modifiers={[font({size:28,weight:'light'}),foregroundStyle(ink),privacySensitive()]}>{p.inTime}</Text></VStack>
   <VStack alignment="leading" spacing={0} modifiers={[frame({maxWidth:999,alignment:'leading'})]}><Text modifiers={[font({size:11}),foregroundStyle(muted)]}>{p.clockOut}</Text><Text modifiers={[font({size:28,weight:'light'}),foregroundStyle(ink),privacySensitive()]}>{p.outTime}</Text></VStack>
  </HStack>
  <HStack spacing={10}>
   <Link destination="aihr://clock?action=in" modifiers={[frame({maxWidth:999,minHeight:44}),background(p.active?(dark?'#29483B':'#C6E1D2'):'#A6F2D5',shapes.capsule()),accessibilityLabel(p.clockIn)]}><HStack spacing={6}><Image systemName="arrow.right.to.line" size={15} color={p.active?ink:'#102E25'}/><Text modifiers={[font({size:14,weight:'semibold'}),foregroundStyle(p.active?ink:'#102E25'),lineLimit(1),minimumScaleFactor(.65)]}>{p.clockIn}</Text></HStack></Link>
   <Link destination="aihr://clock?action=out" modifiers={[frame({maxWidth:999,minHeight:44}),background(p.active?'#A6F2D5':(dark?'#29483B':'#C6E1D2'),shapes.capsule()),accessibilityLabel(p.clockOut)]}><HStack spacing={6}><Image systemName="arrow.up.right" size={15} color={p.active?'#102E25':ink}/><Text modifiers={[font({size:14,weight:'semibold'}),foregroundStyle(p.active?'#102E25':ink),lineLimit(1),minimumScaleFactor(.65)]}>{p.clockOut}</Text></HStack></Link>
  </HStack>
  <Text modifiers={[font({size:9}),foregroundStyle(muted),lineLimit(1),minimumScaleFactor(.7),privacySensitive()]}>{p.updated}</Text>
 </VStack>;
};
const clockIn=createWidget('OneHRClockIn',InWidget),clockOut=createWidget('OneHRClockOut',OutWidget),actions=createWidget('OneHRAttendance',ActionsWidget);
export function updateAttendanceWidgets(snapshot:AttendanceWidgetSnapshot|null):void{
 try{
  const props=widgetPresentation(snapshot),empty=widgetPresentation(null);
  for(const widget of [clockIn,clockOut,actions]){
   if(snapshot)widget.updateTimeline([{date:new Date(),props},{date:new Date(snapshot.expiresAt),props:empty}]);
   else widget.updateSnapshot(empty);
  }
 }catch{/* A widget failure cannot block authentication or attendance. */}
}
export function initializeAttendanceWidgets():void{updateAttendanceWidgets(null);}
