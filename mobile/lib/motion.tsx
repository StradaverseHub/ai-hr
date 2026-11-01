/** Presentation only: commands stay on the unchanged, stationary Pressable hit targets. */
import { Children, type ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import Animated, { cubicBezier, Extrapolation, interpolate, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { useTenantDesign } from './design';

const easeOut = cubicBezier(0.23, 1, 0.32, 1);

export function PressSurface({ pressed, disabled = false, depth = 0, scale = .98, style, children }: {
  pressed: boolean; disabled?: boolean; depth?: number; scale?: number; style?: StyleProp<ViewStyle>; children: ReactNode;
}) {
  const { reduceMotion } = useTenantDesign();
  const active = pressed && !disabled && !reduceMotion;
  return <Animated.View style={[style, {
    transform: [{ translateY: active ? depth : 0 }, { scale: active ? scale : 1 }],
    transitionProperty: 'transform', transitionDuration: reduceMotion ? 0 : 120, transitionTimingFunction: easeOut,
  }]}>{children}</Animated.View>;
}

function CarouselItem({ children, offset, index, stride, reduceMotion }: {
  children: ReactNode; offset: SharedValue<number>; index: number; stride: number; reduceMotion: boolean;
}) {
  const animatedStyle = useAnimatedStyle(() => {
    const distance = Math.abs(offset.get() - index * stride);
    return { transform: [
      { scale: reduceMotion ? 1 : interpolate(distance, [0, stride], [1, .98], Extrapolation.CLAMP) },
      { translateY: reduceMotion ? 0 : interpolate(distance, [0, stride], [0, 2], Extrapolation.CLAMP) },
    ] };
  }, [index, stride, reduceMotion]);
  return <Animated.View style={animatedStyle}>{children}</Animated.View>;
}

/** Finger-led focus, computed on the UI runtime; never changes balances or delays actions. */
export function MotionCarousel({ children, itemWidth }: { children: ReactNode; itemWidth: number }) {
  const { reduceMotion } = useTenantDesign();
  const offset = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler(event => { offset.set(event.contentOffset.x); });
  const stride = itemWidth + 12;
  return <Animated.ScrollView horizontal showsHorizontalScrollIndicator={false} snapToInterval={stride}
    decelerationRate="fast" onScroll={reduceMotion ? undefined : onScroll} scrollEventThrottle={16}
    contentContainerStyle={{ gap: 12, paddingBottom: 8, paddingRight: 20 }}>
    {Children.map(children, (child, index) => <CarouselItem offset={offset} index={index} stride={stride} reduceMotion={reduceMotion}>{child}</CarouselItem>)}
  </Animated.ScrollView>;
}
