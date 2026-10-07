# Monolith objects — CSS-3D recipes

All objects are plain CSS transforms inside a `perspective` stage. No WebGL. Reference files: `reference/Main.dc.html` (monolith), `Payroll.dc.html` (plates), `OrgTower.dc.html` (stacked floors with pull-out and fly-to), `Campus.dc.html` (isometric plane, four-wall blocks, billboards), `Drive.dc.html` (drawers with standing files), `generator.py` (`render_object` + `.ob` CSS for the compact set), `dashboard-game.py` (the game loop, walking, door, lift).

## Stage
`.stage{perspective:1800–2000px; perspective-origin:35–50% 30–40%}` with `.spot` (radial light pool, drifts 16s), `.shadow` (long ellipse, blur 24–36px, `skewX(-26deg)`), and a faint edge vignette. Hub stages are 960px tall with the side panel floating over the right 400px on a bone fade.

## Cuboid (monolith, slab, cube)
Six faces in a `preserve-3d` box: front `translateZ(d/2)`, back `rotateY(180deg) translateZ(d/2)`, left `rotateY(-90deg) translateZ(w/2)`, right `rotateY(90deg) translateZ(w/2)`, top `rotateX(90deg) translateZ(h/2)`, bottom `rotateX(-90deg) translateZ(h/2)`. Front carries the sheen (`linear-gradient(115deg, transparent 30%, rgba(255,255,255,.2) 47%, transparent 60%)`, `background-size:260% 100%`, animated `background-position`). Etched hairlines are 1px `rgba(255,255,255,.22)`; the current mark is a 3px signal line with the glow.

## Stacked floors (tower)
Each floor is a 560×76 slab: front at z=0, top `rotateX(-90deg)` extending back, right `rotateY(90deg)` at `left:100%`, left `rotateY(-90deg)` at `left:-depth`, back `translateZ(-depth) rotateY(180deg)`, all with `backface-visibility:hidden` except the top. Floors stack with `bottom = base + i*92`. Selected floor `translateX(90px)`. Lit desks are a radial-gradient dot pattern whose width is headcount ÷ desks.

## Isometric plane (campus, floor interior)
Plane `rotateX(58deg) rotateZ(rz)`. A block at (x,y,w,d,h) has four outward walls with `backface-visibility:hidden` so any rotation works:
- front: `top:100%; transform-origin:50% 0; transform:rotateX(90deg) rotateY(180deg)`
- back: `bottom:100%; transform-origin:50% 100%; transform:rotateX(-90deg) rotateY(180deg)`
- left: `right:100%; transform-origin:100% 50%; transform:rotateY(-90deg) rotateZ(180deg)`
- right: `left:100%; transform-origin:0 50%; transform:rotateY(90deg) rotateZ(180deg)`
- top: `translateZ(h)`.
Anything that must face the camera (labels, trees, people) is a 0×0 anchor with `transform: translateZ(z) rotateZ(-rz) rotateX(-58deg)` and the content centred inside it.

## Drawers (cabinet)
Each drawer is a box (front, two sides, back, floor as `top:100%` rotated `-90deg`); files stand on the floor with `transform-origin:bottom; rotateX(90deg)`, 150px tall so they show above the rim. Open = `translateZ(240px)` plus a staggered rise of the files.

## Camera (`useOrbit`)
State `{ a, b, zoom }` (yaw, pitch or plane spin, scale). Pointer: record start on down, start the drag after 5px, `setPointerCapture` then, `a += dx*0.35`, `b -= dy*0.15`, clamp per object. Wheel: native non-passive listener, `zoom *= exp(-deltaY*0.0016)`, clamp. A click is never a drag because of the 5px threshold; pick handlers check a `moved` flag that resets on the next tick. Fly-to-selection: put `translate3d(tx,ty,0)` inside the rotation (`rotateX rotateY scale3d translate3d`) with `tx, ty` = minus the item's offset from the object's centre, and raise the zoom.

## Game loop (parked dashboard)
`requestAnimationFrame`; held keys from `keydown`/`keyup` on the focused root; position updated at 230–260px/s with simple rectangle and circle collisions; DOM written directly for the avatar and the camera each frame; React state only for logical changes (near, scene, floor). Billboard figures as above. See `dashboard-game.py` for the full implementation, including the door trigger, the lift and the floor data.
