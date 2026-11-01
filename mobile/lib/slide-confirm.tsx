import { useEffect,useRef,useState } from 'react';
import { Animated,Easing,PanResponder,Pressable,View,type LayoutChangeEvent } from 'react-native';
import { DesignText as Text } from './design';
import { useTenantDesign } from './design';
import { t } from './i18n';
import { alpha } from './visual';
/** Confirm on RELEASE at the end, never on a tap or a cancelled drag. VoiceOver/TalkBack gets an explicit two-step action. */
export function SlideConfirm({label,disabled,onConfirm}:{label:string;disabled?:boolean;onConfirm:()=>void}){
  const {design,palette,reduceMotion}=useTenantDesign();
  const [width,setWidth]=useState(0),[armed,setArmed]=useState(false);
  const travel=Math.max(0,width-56),x=useRef(new Animated.Value(0)).current;
  const live=useRef({disabled,travel,onConfirm,reduceMotion});live.current={disabled,travel,onConfirm,reduceMotion};
  const distance=useRef(0),busy=useRef(false);
  function reset(){distance.current=0;Animated.timing(x,{toValue:0,duration:live.current.reduceMotion?0:200,easing:Easing.out(Easing.quad),useNativeDriver:true}).start();}
  function confirm(){if(busy.current||live.current.disabled)return;busy.current=true;setArmed(false);reset();live.current.onConfirm();}
  useEffect(()=>{busy.current=false;reset();setArmed(false);},[disabled,label]);
  const responder=useRef(PanResponder.create({
    onStartShouldSetPanResponder:()=>!live.current.disabled,
    onMoveShouldSetPanResponder:(_e,g)=>!live.current.disabled&&Math.abs(g.dx)>Math.abs(g.dy)&&g.dx>5,
    onPanResponderMove:(_e,g)=>{if(live.current.disabled)return;distance.current=Math.max(0,Math.min(live.current.travel,g.dx));x.setValue(distance.current);},
    onPanResponderRelease:()=>{if(live.current.travel>0&&distance.current>=live.current.travel*.92)confirm();else reset();},
    onPanResponderTerminate:reset,onPanResponderTerminationRequest:()=>true,
  })).current;
  const accent=palette;
  return <View>
    <View onLayout={(e:LayoutChangeEvent)=>setWidth(e.nativeEvent.layout.width)} style={{minHeight:54,justifyContent:'center',borderWidth:1,borderColor:palette.border,borderRadius:design.clockLayout==='punch'?6:40,backgroundColor:palette.card,experimental_backgroundImage:`linear-gradient(135deg, ${alpha(palette.accent,.25)} 0%, transparent 45%, ${alpha(palette.accent,.35)} 100%)`,opacity:disabled ? .55 : 1}}>
      <Text accessible={false} style={{color:palette.text,textAlign:'center',paddingLeft:48,paddingRight:18,fontSize:14,fontWeight:'600'}}>{label}</Text>
      <Animated.View {...responder.panHandlers} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{position:'absolute',left:6,width:42,height:42,borderRadius:design.clockLayout==='punch'?3:21,backgroundColor:accent.button,alignItems:'center',justifyContent:'center',transform:[{translateX:x}]}}><Text style={{fontSize:21,color:accent.onButton}}>→</Text></Animated.View>
    </View>
    <Pressable accessibilityRole="button" accessibilityLabel={`${label}. ${armed?t('confirmAction'):t('useTapConfirmation')}`} accessibilityState={{disabled:!!disabled}} disabled={disabled} onPress={()=>armed?confirm():setArmed(true)} style={{minHeight:44,justifyContent:'center',alignItems:'center'}}>
      <Text style={{color:palette.accent,fontSize:13}}>{armed?t('confirmAction'):t('useTapConfirmation')}</Text>
    </Pressable>
  </View>;
}
