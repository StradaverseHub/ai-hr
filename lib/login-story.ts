/** Public, fictional presentation only. This module cannot read a session or HR records. */
export const LOGIN_STORY = { intro: 2600, swirl: 1800, opening: 350 + 1500, layer: 1900, end: 19900 } as const;
export type StoryLayer = 'interfaces' | 'guard' | 'harness' | 'context' | 'capabilities' | 'record' | 'outcome';
const layers: readonly StoryLayer[] = ['interfaces', 'guard', 'harness', 'context', 'capabilities', 'record', 'outcome'];

export function loginStoryAt(elapsed: number) {
  const time = Math.max(0, elapsed);
  const swirl = Math.min(1, Math.max(0, (time - LOGIN_STORY.intro) / LOGIN_STORY.swirl));
  const layerIndex = Math.min(layers.length - 1, Math.max(0, Math.floor((time - LOGIN_STORY.intro - LOGIN_STORY.swirl - 1800) / LOGIN_STORY.layer)));
  return { swirl, clock: time >= LOGIN_STORY.intro, finished: time >= LOGIN_STORY.end, active: layers[layerIndex] };
}

export type TexturePoint = { x: number; y: number; u: number; v: number };
/** Warp an actual UI image into a vortex whose sink is the live Interfaces face. */
export function loginSwirlPoint(u: number, v: number, progress: number, sink: readonly [number, number]): TexturePoint {
  const t = Math.min(1, Math.max(0, progress)), p = t * t * (3 - 2 * t);
  const dx = (u - .5) * 804, dy = (v - .5) * 512;
  const radius = Math.min(1, Math.hypot((u - .5) * 1.4, (v - .5) * 1.4));
  const angle = Math.PI * 3 * p * p * (1 - .45 * radius);
  const scale = (1 - p) ** (1.15 + .6 * (1 - radius));
  return {
    x: 425 + (sink[0] - 425) * p + (dx * Math.cos(angle) - dy * Math.sin(angle)) * scale,
    y: 263 + (sink[1] - 263) * p + (dx * Math.sin(angle) + dy * Math.cos(angle)) * scale * (1 - .62 * p),
    u, v,
  };
}

export function drawLoginTriangle(ctx: CanvasRenderingContext2D, image: HTMLImageElement, a: TexturePoint, b: TexturePoint, c: TexturePoint) {
  const au = a.u * image.naturalWidth, av = a.v * image.naturalHeight;
  const bu = b.u * image.naturalWidth, bv = b.v * image.naturalHeight;
  const cu = c.u * image.naturalWidth, cv = c.v * image.naturalHeight;
  const determinant = au * (bv - cv) + bu * (cv - av) + cu * (av - bv);
  if (Math.abs(determinant) < .001) return;
  ctx.save();
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.closePath(); ctx.clip();
  ctx.transform(
    (a.x * (bv - cv) + b.x * (cv - av) + c.x * (av - bv)) / determinant,
    (a.y * (bv - cv) + b.y * (cv - av) + c.y * (av - bv)) / determinant,
    (a.x * (cu - bu) + b.x * (au - cu) + c.x * (bu - au)) / determinant,
    (a.y * (cu - bu) + b.y * (au - cu) + c.y * (bu - au)) / determinant,
    (a.x * (bu * cv - cu * bv) + b.x * (cu * av - au * cv) + c.x * (au * bv - bu * av)) / determinant,
    (a.y * (bu * cv - cu * bv) + b.y * (cu * av - au * cv) + c.y * (au * bv - bu * av)) / determinant,
  );
  ctx.drawImage(image, 0, 0); ctx.restore();
}
