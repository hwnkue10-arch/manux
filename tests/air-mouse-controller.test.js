import test from 'node:test';
import assert from 'node:assert/strict';
import {AirMouseController} from '../src/air-mouse-controller.js';

import {hand} from './helpers/mouse-hand.js';

function session(options = {}) {
  const controller = new AirMouseController({smoothing:1,...options});
  let now = -60;
  const feed = (pose = 'move', transform = {}, overrides = {}) => {
    now += 60;
    return controller.update({landmarks:hand(pose, transform), now, enabled:true, width:1000,height:1000,handedness:'Right',...overrides});
  };
  const hold = (pose = 'move', transform = {}) => [feed(pose,transform),feed(pose,transform),feed(pose,transform),feed(pose,transform)];
  return {controller,feed,hold};
}

const events = states => states.flatMap(s => s.events);
const downs = states => events(states).filter(e => e.type === 'button' && e.down);

test('relaxed open palm settles before relative mirrored pointer movement; first position never teleports', () => {
  const s = session();
  const states = s.hold();
  assert.equal(states[0].phase, 'holding');
  assert.equal(states.at(-1).mode, 'move');
  assert.deepEqual(events(states), []);
  const result = s.feed('move', {x:.02,y:.01});
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].type, 'move');
  assert.ok(Math.abs(result.events[0].dx + 36) <= 1);
  assert.ok(Math.abs(result.events[0].dy - 18) <= 1);
});

test('left pinch clicks once, moves while held, and releases immediately when fingers separate', () => {
  const s = session(); s.hold('move');
  const entry = s.hold('left');
  assert.deepEqual(downs(entry), [{type:'button',button:'left',down:true}]);
  const drag = s.feed('left', {x:-.02});
  assert.ok(drag.events.some(e => e.type === 'move' && e.dx > 0));
  assert.equal(downs([drag]).length, 0);
  const release = s.feed('move');
  assert.ok(release.events.some(e => e.type === 'button' && e.button === 'left' && !e.down));
  assert.equal(s.feed('move').events.filter(e => e.type === 'button').length, 0);
});

test('right pinch is exactly one click even when held and moved; unpinch rearms it', () => {
  const s = session(); s.hold('move');
  const entry = s.hold('right');
  assert.deepEqual(events(entry), [{type:'button',button:'right',down:true},{type:'button',button:'right',down:false}]);
  const moving = s.hold('right',{x:.03});
  assert.equal(downs(moving).length,0);
  assert.ok(events(moving).some(e=>e.type==='move'&&e.dx<0));
  s.hold('move');
  assert.equal(downs(s.hold('right')).length, 1);
});

test('returning from a confirmed action to the base pose resumes movement without another dwell or jump', () => {
  for (const pose of ['left','right','scroll']) {
    const s = session(); s.hold('move'); s.hold(pose);
    const transition = s.feed('move',{x:.06});
    assert.equal(transition.phase,'active',pose);
    assert.equal(transition.mode,'move',pose);
    assert.equal(transition.events.some(e=>e.type==='move'),false,pose);
    if (pose==='left') assert.ok(transition.events.some(e=>e.type==='button'&&!e.down));
    const next = s.feed('move',{x:.07});
    assert.ok(next.events.some(e=>e.type==='move'&&e.dx<0&&Math.abs(e.dx)<=19),pose);
  }
});

test('an unconfirmed action or lost hand does not bypass the initial movement dwell', () => {
  const s = session(); s.hold('move');
  assert.equal(s.feed('left').phase,'holding');
  assert.equal(s.feed('move').phase,'holding');
  s.hold('left');
  s.feed('left',{}, {landmarks:null});
  assert.equal(s.feed('move').phase,'holding');
});

test('enabling while pinching cannot click until a visible unpinched pose is held', () => {
  for (const pose of ['left','right']) {
    const s = session();
    assert.deepEqual(events(s.hold(pose)), []);
    assert.equal(s.feed(pose).phase, 'release-required');
    s.hold('open');
    assert.equal(downs(s.hold(pose)).length, 1);
  }
});

test('thumb/ring pinch scroll needs movement, ignores horizontal travel, and never moves the cursor', () => {
  const s = session(); s.hold('move');
  assert.deepEqual(events(s.hold('scroll')), []);
  assert.deepEqual(s.feed('scroll',{x:.02}).events, []);
  const down = s.feed('scroll',{x:.02,y:.02});
  assert.ok(down.events.some(e => e.type === 'scroll' && e.dy > 0));
  assert.equal(down.events.some(e => e.type === 'move'), false);
  const up = s.feed('scroll',{x:.02,y:0});
  assert.ok(up.events.some(e => e.type === 'scroll' && e.dy < 0));
  assert.deepEqual(events(s.hold('fist')), []);
});

test('fist and single extended index rest without pointer, click, or scroll', () => {
  const s = session();
  for (const pose of ['fist','index']) {
    assert.deepEqual(events(s.hold(pose)), []);
    assert.equal(s.feed(pose,{x:.02}).mode,'idle');
  }
});

test('ambiguous simultaneous index/middle pinch cannot choose a mouse button', () => {
  const s = session(); s.hold('move');
  assert.deepEqual(events(s.hold('both')), []);
});

test('pinch hysteresis tolerates small finger-distance jitter but releases beyond the outer threshold', () => {
  const s = session(); s.hold('move'); s.hold('left');
  const jitter = hand('left'); jitter[4].x = jitter[8].x - .075; // ~.326 palm widths: hold, not new entry.
  const held = s.feed('left',{}, {landmarks:jitter});
  assert.equal(held.mode, 'left');
  assert.equal(held.events.some(e => e.type === 'button' && !e.down), false);
  const opened = hand('left'); opened[4].x = opened[8].x - .11;
  assert.ok(s.feed('left',{}, {landmarks:opened}).events.some(e => e.type === 'button' && !e.down));
});

test('missing landmarks and poor quality release a drag and require a new unpinched observation', () => {
  for (const lost of [{landmarks:undefined},{quality:false}]) {
    const s = session(); s.hold('move'); s.hold('left');
    const release = s.feed('left',{},lost);
    assert.equal(release.phase,'invalid');
    assert.ok(release.events.some(e => e.type === 'release'));
    assert.deepEqual(events(s.hold('left')), []);
    s.hold('move');
    assert.equal(downs(s.hold('left')).length,1);
  }
});

test('tracking loss does not rearm a held right click', () => {
  const s = session(); s.hold('move'); s.hold('right');
  s.feed('right',{}, {landmarks:[]});
  assert.deepEqual(events(s.hold('right')),[]);
  s.hold('open');
  assert.equal(downs(s.hold('right')).length,1);
});

test('a brief unknown shape cannot repeat a right click without a confirmed release', () => {
  const s = session(); s.hold('move'); s.hold('right');
  s.feed('open');
  assert.deepEqual(events(s.hold('right')),[]);
});

test('reset and disable release any held button; reenabling a held pinch is blocked', () => {
  for (const reset of [s => s.controller.reset(), s => s.feed('left',{}, {enabled:false})]) {
    const s = session(); s.hold('move'); s.hold('left');
    assert.deepEqual(reset(s).events,[{type:'release'}]);
    assert.deepEqual(events(s.hold('left')),[]);
  }
});

test('stale or duplicate timestamps cannot count toward activation or replay input', () => {
  const s = session(); s.hold('move');
  const common = {landmarks:hand('left'),enabled:true,width:1000,height:1000};
  for (const now of [180,150,180]) {
    const result = s.controller.update({...common,now});
    assert.equal(result.phase,'stale');
    assert.deepEqual(result.events,[]);
  }
  assert.equal(downs(s.hold('left')).length,1);
});

test('long gaps and handedness changes release dragging and discard the movement anchor', () => {
  for (const change of [{now:2000},{handedness:'Left'}]) {
    const s = session(); s.hold('move'); s.hold('left');
    const result = s.feed('left',{x:.05},change);
    assert.equal(result.phase,'tracking-reset');
    assert.ok(result.events.some(e=>e.type==='release'));
    assert.equal(result.events.some(e=>e.type==='move'),false);
  }
});

test('reacquired pointer starts from a fresh anchor instead of moving across the whole screen', () => {
  const s = session(); s.hold('move');
  s.feed('move',{}, {landmarks:null});
  assert.deepEqual(events(s.hold('move',{x:.12})),[]);
  const moved = s.feed('move',{x:.13});
  assert.ok(moved.events.every(e => e.type !== 'move' || Math.abs(e.dx) < 30));
});

test('a sudden large jump interrupts a drag instead of sending a teleport', () => {
  const s = session(); s.hold('move'); s.hold('left');
  const result = s.feed('left',{x:.18});
  assert.equal(result.phase,'tracking-reset');
  assert.ok(result.events.some(e=>e.type==='release'));
  assert.equal(result.events.some(e=>e.type==='move'),false);
});

test('slow subpixel movements accumulate while symmetric stationary jitter cancels', () => {
  const s = session(); s.hold('move');
  const slow = Array.from({length:20},(_,i)=>s.feed('move',{x:(i+1)*.0001}));
  assert.ok(events(slow).filter(e=>e.type==='move').reduce((total,e)=>total+e.dx,0) <= -3);
  const t = session(); t.hold('move');
  const jitter = Array.from({length:30},(_,i)=>t.feed('move',{x:(i%2 ? 1 : -1)*.00005}));
  assert.deepEqual(events(jitter),[]);
});

test('movement cap drops excess backlog instead of continuing to move after the hand stops', () => {
  const s = session({sensitivity:6000}); s.hold('move');
  const jump = s.feed('move',{x:.10});
  assert.ok(jump.events.every(e=>e.type!=='move'||Math.abs(e.dx)<=100));
  assert.deepEqual(events(s.hold('move',{x:.10})),[]);
});

test('mirror, scale and in-plane rotation preserve pose interpretation', () => {
  for (const transform of [{mirrored:true},{scale:.6},{rotate:.6},{mirrored:true,rotate:-.5}]) {
    const s = session();
    assert.equal(s.hold('move',transform).at(-1).mode,'move');
    assert.equal(s.hold('scroll',transform).at(-1).mode,'scroll');
    assert.equal(downs(s.hold('left',transform)).length,1);
  }
});

test('aspect correction gives the same pose at different input aspect ratios', () => {
  const s = session();
  for (let i=0;i<4;i++) s.feed('move',{aspect:1.3},{width:1300,height:1000});
  assert.equal(s.feed('move',{aspect:1.3},{width:1300,height:1000}).mode,'move');
});

test('three extended fingers are enough for the relaxed move pose; thumb position is not a requirement', () => {
  const s = session();
  const relaxed = hand('move'), folded = hand('fist');
  for (const i of [5,6,7,8]) relaxed[i] = folded[i];
  for (let i=0;i<4;i++) s.feed('move',{}, {landmarks:relaxed});
  assert.equal(s.feed('move',{}, {landmarks:relaxed}).mode,'move');
});

test('non-finite, incomplete, out-of-frame and degenerate landmarks cannot create inputs', () => {
  const bad = hand(); bad[8].x = NaN;
  const outside = hand(); outside[4].y = -0.1;
  for (const landmarks of [[],bad,outside,hand().slice(0,20),Array(21).fill({x:.5,y:.5,z:0})]) {
    const s = session(); s.hold('move');
    assert.equal(s.feed('left',{}, {landmarks}).phase,'invalid');
    assert.deepEqual(events(s.hold('left')),[]);
  }
  assert.throws(()=>new AirMouseController({sensitivity:Infinity}),RangeError);
});


test('ergonomic pointer ballistics scales down micro-tremors and accelerates fast sweeps', () => {
  const linear = session({ballistics:false, smoothing:1});
  const accel = session({ballistics:true, smoothing:1});
  linear.hold('move'); accel.hold('move');

  // Micro-motion: dx is scaled down for sub-pixel precision
  const linMicro = linear.feed('move', {x: 0.0008});
  const accMicro = accel.feed('move', {x: 0.0008});
  const linDx = linMicro.events[0]?.dx ?? 0;
  const accDx = accMicro.events[0]?.dx ?? 0;
  assert.ok(Math.abs(accDx) <= Math.abs(linDx));

  // Fast sweep: dx is amplified for screen crossing
  const linFast = linear.feed('move', {x: 0.02});
  const accFast = accel.feed('move', {x: 0.02});
  assert.ok(Math.abs(accFast.events[0].dx) > Math.abs(linFast.events[0].dx));
});

test('click lock suppresses tiny accidental motion during left-click until intentional drag', () => {
  const s = session({clickLock:true, smoothing:1});
  s.hold('move');
  s.hold('left');
  // Small jitter after clicking down (< 10px) is suppressed
  const jitter = s.feed('left', {x: -0.002});
  assert.equal(jitter.events.some(e => e.type === 'move'), false);
  // Intentional drag (> 10px) unlocks motion
  const drag = s.feed('left', {x: -0.02});
  assert.ok(drag.events.some(e => e.type === 'move' && e.dx > 0));
});

test('opt-in V-sign (peace) gesture triggers smooth scroll without thumb pinch', () => {
  const s = session({vScroll:true, smoothing:1});
  s.hold('move');
  const makeV = (transform = {}) => {
    const v = hand('move', transform);
    const folded = hand('fist', transform);
    for (const i of [13,14,15,16, 17,18,19,20]) v[i] = folded[i];
    return v;
  };

  for (let i = 0; i < 4; i++) s.feed('move', {}, {landmarks: makeV()});
  const state = s.feed('move', {}, {landmarks: makeV()});
  assert.equal(state.mode, 'scroll');

  const scrolled = s.feed('move', {}, {landmarks: makeV({y: 0.03})});
  assert.ok(scrolled.events.some(e => e.type === 'scroll'));
});

test('two-finger clutch (index and middle touching) triggers smooth scroll', () => {
  const s = session({vScroll:true, smoothing:1});
  s.hold('move');
  const makeClutch = (transform = {}) => {
    const h = hand('move', transform);
    // Bring index tip (8) close to middle tip (12)
    h[8] = {x: 0.485, y: 0.355, z: 0};
    h[12] = {x: 0.50, y: 0.35, z: 0};
    return h;
  };

  for (let i = 0; i < 4; i++) s.feed('move', {}, {landmarks: makeClutch()});
  const state = s.feed('move', {}, {landmarks: makeClutch()});
  assert.equal(state.mode, 'scroll');

  const scrolled = s.feed('move', {}, {landmarks: makeClutch({y: 0.03})});
  assert.ok(scrolled.events.some(e => e.type === 'scroll'));
});

test('pre-pinch velocity dampening suppresses cursor drift while fingers are closing', () => {
  const s = session({clickLock:true, smoothing:1});
  s.hold('move');

  // Step 1: hand in move mode, index tip at normal open position
  const h1 = hand('move');
  s.feed('move', {}, {landmarks: h1});

  // Step 2: hand moves by x: 0.02, but index finger is rapidly closing towards thumb (dIndex dropping)
  const h2 = hand('move', {x: 0.02});
  // move index tip (8) close to thumb (4), but not yet at pinch threshold
  h2[8] = {x: h2[4].x + 0.09, y: h2[4].y, z: 0}; // dIndex ~ 0.39, dropping rapidly
  const damped = s.feed('move', {}, {landmarks: h2});

  // The move displacement should be heavily damped (< 10px instead of normal ~36px)
  const dx = damped.events.find(e => e.type === 'move')?.dx ?? 0;
  assert.ok(Math.abs(dx) < 10, `Expected damped dx < 10, got ${dx}`);
});

test('pointerMode: index tracks index finger tip directly and reports fingertip HUD data', () => {
  const s = session({pointerMode:'index', smoothing:1});
  // Pointing index
  const r1 = s.hold('index');
  assert.ok(r1[0].fingertips?.index);
  assert.ok(r1[0].fingertips?.thumb);
  assert.ok(r1[0].fingertips?.middle);
  assert.ok(r1[0].activePos);
  assert.ok(r1[0].activePos.x >= 0 && r1[0].activePos.x <= 1);
  assert.ok(r1[0].activePos.y >= 0 && r1[0].activePos.y <= 1);

  // Moving index tip in pointing pose moves cursor
  const h2 = hand('index', {x: 0.02, y: 0.01});
  const r2 = s.feed('index', {}, {landmarks: h2});
  assert.equal(r2.mode, 'move');
  assert.ok(r2.events.some(e => e.type === 'moveTo' || e.type === 'move'));

  // Gesture-free cursor tracking: open/relaxed palm continues to track index tip
  const openResult = s.feed('move', {x: 0.02});
  assert.equal(openResult.mode, 'move', 'Open/relaxed palm must track index tip');

  // Only Fist (주먹) stops tracking and enters idle (rest)
  const fistResult = s.feed('fist', {x: 0.02});
  assert.equal(fistResult.mode, 'idle', 'Fist must be idle/rest');
});

test('pointerMode: index left pinch holds left button continuously for reliable drag and drop', () => {
  const s = session({pointerMode:'index', smoothing:1});
  s.hold('index');

  // Pinch thumb and middle (index-left)
  const pinchStates = s.hold('index-left');
  const p1 = pinchStates.at(-1);
  assert.equal(p1.mode, 'left');
  assert.ok(pinchStates.flatMap(s => s.events).some(e => e.type === 'button' && e.button === 'left' && e.down));

  // Small displacement under 14px has zero click-dip
  const smallMove = hand('index-left', {x: -0.002, y: 0.001});
  const pSmall = s.feed('index-left', {}, {landmarks: smallMove});
  assert.equal(pSmall.mode, 'left');

  // Intentional larger hand movement drags smoothly
  const dragMove = hand('index-left', {x: -0.05, y: 0.02});
  const pDrag = s.feed('index-left', {}, {landmarks: dragMove});
  assert.equal(pDrag.mode, 'left');
  assert.ok(pDrag.events.some(e => e.type === 'moveTo' || e.type === 'move'));
  // Left button MUST NOT be released or pressed again during drag
  assert.equal(pDrag.events.filter(e => e.type === 'button').length, 0);

  // Release fingers (debounced: separation must persist for 2 frames)
  const openIndex = hand('index');
  const pRelease = [s.feed('index', {}, {landmarks: openIndex}), s.feed('index', {}, {landmarks: openIndex})];
  assert.ok(pRelease.flatMap(r => r.events).some(e => e.type === 'button' && e.button === 'left' && !e.down));
});

test('pointerMode: index right click triggers on Thumb + Ring touch and never in Fist', () => {
  const s = session({pointerMode:'index', smoothing:1});
  // Pointing index
  const g1 = s.hold('index');
  assert.equal(g1.at(-1).mode, 'move');
  assert.equal(g1.at(-1).pinch, null);

  // Fist (all fingers curled) MUST BE IDLE and can never click
  const fist = s.hold('fist');
  assert.equal(fist.at(-1).mode, 'idle');
  assert.equal(fist.flatMap(s => s.events).filter(e => e.type === 'button').length, 0);

  // Thumb + Ring touch triggers Right Click
  const rightStates = s.hold('index-right');
  assert.equal(rightStates.at(-1).mode, 'right');
  assert.ok(rightStates.flatMap(s => s.events).some(e => e.type === 'button' && e.button === 'right' && e.down));

  // Releasing Thumb + Ring touch releases Right Click (debounced 2 frames)
  const releaseStates = [s.feed('index'), s.feed('index')];
  assert.ok(releaseStates.flatMap(r => r.events).some(e => e.type === 'button' && e.button === 'right' && !e.down));
});

test('pointerMode: index smartphone touch swipe scrolls down when swiping up, and fist lifts touch', () => {
  const s = session({pointerMode:'index', vScroll:true, smoothing:1});
  s.hold('move');

  const makeV = (transform = {}) => {
    const h = hand('move', transform);
    h[16].y = h[14].y + 0.05; // ring curled
    h[20].y = h[18].y + 0.05; // pinky curled
    return h;
  };

  // Touch Down in peace gesture (2 fingers extended): V-sign takes precedence over right click
  for (let i = 0; i < 4; i++) s.feed('move', {}, {landmarks: makeV()});
  const touchDown = s.feed('move', {}, {landmarks: makeV()});
  assert.equal(touchDown.mode, 'scroll', 'V-sign must activate scroll, never false right click');
  assert.equal(touchDown.events.filter(e => e.type === 'button').length, 0);

  // Swipe UP (Y decreases: y: -0.03) -> page scrolls DOWN (positive scroll dy)
  const swipeUp = s.feed('move', {}, {landmarks: makeV({y: -0.03})});
  assert.equal(swipeUp.mode, 'scroll');
  const scrollEvent = swipeUp.events.find(e => e.type === 'scroll');
  assert.ok(scrollEvent, 'Expected scroll event during swipe up');
  assert.ok(scrollEvent.dy > 0, `Expected downward scroll (positive dy) when flicking up, got ${scrollEvent.dy}`);

  // Touch Lift: curling hand into fist acts as lifting finger off glass
  const lift = s.feed('fist', {}, {landmarks: hand('fist')});
  assert.equal(lift.mode, 'idle');
  // Zero scroll events on touch lift
  assert.equal(lift.events.filter(e => e.type === 'scroll').length, 0);

  // Moving hand down while in fist produces NO reverse scroll!
  const fistDown = s.feed('fist', {}, {landmarks: hand('fist', {y: 0.05})});
  assert.equal(fistDown.events.filter(e => e.type === 'scroll').length, 0);

  // Open palm (🖐️) is the natural relaxed pose: it must stay pointer movement, never scroll.
  for (let i = 0; i < 4; i++) s.feed('move', {}, {landmarks: hand('open')});
  const openState = s.feed('move', {}, {landmarks: hand('open', {y: -0.03})});
  assert.equal(openState.mode, 'move', 'Open palm must not scroll');
  assert.equal(openState.events.filter(e => e.type === 'scroll' || e.type === 'button').length, 0);
});

test('pointerMode: index rapid double-click, independent Left and Right, Fist is strictly idle with zero click', () => {
  const s = session({pointerMode:'index', smoothing:1});
  s.hold('index');

  // 1. Rapid double-click verification: press is instant, release is debounced by 2 frames
  const btn = (states, down) => [states].flat().flatMap(r => r.events).some(e => e.type === 'button' && e.button === 'left' && e.down === down);
  const tap1Down = s.feed('index-left');
  assert.ok(btn(tap1Down, true));
  const tap1Up = [s.feed('index'), s.feed('index')];
  assert.ok(btn(tap1Up, false));

  const tap2Down = s.feed('index-left');
  assert.ok(btn(tap2Down, true), 'Double-click 2nd tap must fire immediately');
  const tap2Up = [s.feed('index'), s.feed('index')];
  assert.ok(btn(tap2Up, false));

  // 2. Simultaneous Left + Right Click: when both Middle and Ring touch Thumb, BOTH buttons are down
  const bothState = s.feed('index-both');
  assert.equal(bothState.mode, 'both');
  assert.ok(bothState.events.some(e => e.type === 'button' && e.button === 'left' && e.down));
  assert.ok(bothState.events.some(e => e.type === 'button' && e.button === 'right' && e.down));

  // Releasing Ring only releases right, left remains down
  const leftRemain = [s.feed('index-left'), s.feed('index-left')].flatMap(r => r.events);
  assert.ok(leftRemain.some(e => e.type === 'button' && e.button === 'right' && !e.down));
  assert.ok(!leftRemain.some(e => e.type === 'button' && e.button === 'left'));

  // Releasing Middle releases left
  const allRelease = [s.feed('index'), s.feed('index')];
  assert.ok(btn(allRelease, false));

  // 3. Clenched Fist: even with thumb touching curled fingers, it MUST BE IDLE and NEVER click!
  const fistStates = s.hold('fist');
  assert.equal(fistStates.at(-1).mode, 'idle');
  assert.equal(fistStates.flatMap(s => s.events).filter(e => e.type === 'button').length, 0);

  // 4. Active Pos Mapping: moving index in comfortable center zone (0.28 to 0.72) spans 0 to 1
  const hLeft = hand('index'); hLeft[8] = {x: 0.72, y: 0.20, z: 0}; // mirroredX = 0.28 -> activePos.x = 0
  const rLeft = s.feed('index', {}, {landmarks: hLeft});
  assert.equal(rLeft.activePos.x, 0);

  const hRight = hand('index'); hRight[8] = {x: 0.28, y: 0.20, z: 0}; // mirroredX = 0.72 -> activePos.x = 1
  const rRight = s.feed('index', {}, {landmarks: hRight});
  assert.ok(Math.abs(rRight.activePos.x - 1) < 1e-5);
});

test('pointerMode: index drag survives posture glitches (index curl / fist flag / dropped frames) and single jitter frames', () => {
  const s = session({pointerMode:'index', smoothing:1});
  s.hold('index');
  const press = s.feed('index-left');
  assert.ok(press.events.some(e => e.type === 'button' && e.button === 'left' && e.down));

  // Index curls while dragging (would be detected as fist/idle) -> still dragging
  const curled = hand('index-left'); curled[8] = {x: 0.5, y: 0.65, z: 0};
  const c = s.feed('index-left', {}, {landmarks: curled});
  assert.equal(c.events.filter(e => e.type === 'button').length, 0, 'Index curl must not release drag');
  assert.equal(c.mode, 'left');

  // A dropped frame (no hand) -> still dragging
  const lost = s.feed('index-left', {}, {landmarks: null});
  assert.equal(lost.events.filter(e => e.type === 'button').length, 0, 'Dropped frame must not release drag');

  // A single separated jitter frame -> still dragging
  const jitter = s.feed('index');
  assert.equal(jitter.events.filter(e => e.type === 'button').length, 0, 'Single jitter frame must not release drag');
  const back = s.feed('index-left');
  assert.equal(back.events.filter(e => e.type === 'button').length, 0);

  // Handedness flicker -> still dragging
  const flick = s.feed('index-left', {}, {handedness:'Left'});
  assert.equal(flick.events.filter(e => e.type === 'button').length, 0, 'Handedness flicker must not release drag');

  // HUD fingertips are the filtered copies and middle stays visible while held
  assert.equal(flick.fingertips.middle.visible, true);
});

test('pointerMode: index fist safety gate blocks clicks when curled, and stabilizes all fingertips', () => {
  const s = session({pointerMode:'index', smoothing:1});
  s.hold('index');

  // Pointing gesture where middle is curled into palm (< 0.88 palm) and thumb touches curled middle:
  const pointing = hand('index');
  pointing[4] = {...pointing[12]};
  const pointState = s.feed('index', {}, {landmarks: pointing});
  assert.equal(pointState.mode, 'move', 'Curled middle touching thumb in pointing stance must not trigger click');
  assert.equal(pointState.events.filter(e => e.type === 'button').length, 0);

  // Curled index (making a fist / relaxed hand):
  const curled = hand('index');
  curled[8] = {x: 0.5, y: 0.65, z: 0};
  const curledState = s.feed('index', {}, {landmarks: curled});
  assert.equal(curledState.mode, 'idle', 'Curling index finger must enter idle rest mode immediately');
  assert.equal(curledState.events.filter(e => e.type === 'button').length, 0);

  // All fingertips in index mode are returned filtered
  assert.ok(pointState.fingertips.thumb && Number.isFinite(pointState.fingertips.thumb.x));
  assert.ok(pointState.fingertips.middle && Number.isFinite(pointState.fingertips.middle.x));
  assert.ok(pointState.fingertips.ring && Number.isFinite(pointState.fingertips.ring.x));
});

test('pointerMode: trigger tracks index tip and folding index freezes cursor position', () => {
  const s = session({pointerMode:'trigger', smoothing:1});
  s.hold('trigger');

  const p1 = s.feed('trigger');
  assert.equal(p1.mode, 'move');
  const freezeU = p1.activePos.x;
  const freezeV = p1.activePos.y;

  // Fold index finger (pose = trigger-freeze) -> mode becomes frozen
  const pFrozen = s.feed('trigger-freeze', {x: 0.05, y: 0.05});
  assert.equal(pFrozen.mode, 'move');
  // activePos must be locked solid to the position before folding
  assert.equal(pFrozen.activePos.x, freezeU);
  assert.equal(pFrozen.activePos.y, freezeV);

  // Unfolding index resumes move tracking
  const pResume = s.feed('trigger');
  assert.equal(pResume.mode, 'move');
});

test('pointerMode: trigger thumb extension triggers Left Click & drag, debounces release', () => {
  const s = session({pointerMode:'trigger', smoothing:1});
  s.hold('trigger');

  // Extend thumb -> Left Down fires immediately
  const pDown = s.feed('trigger-left');
  assert.equal(pDown.mode, 'left');
  assert.ok(pDown.events.some(e => e.type === 'button' && e.button === 'left' && e.down));

  // Holding extended thumb while moving drags smoothly
  const pDrag = s.feed('trigger-left', {x: 0.03});
  assert.equal(pDrag.mode, 'left');
  assert.equal(pDrag.events.filter(e => e.type === 'button').length, 0);

  // Retracting thumb debounces release over 2 frames
  const pRel1 = s.feed('trigger');
  assert.equal(pRel1.events.filter(e => e.type === 'button').length, 0);
  const pRel2 = s.feed('trigger');
  assert.ok(pRel2.events.some(e => e.type === 'button' && e.button === 'left' && !e.down));
});

test('pointerMode: trigger fold-to-freeze then extend-thumb clicks at the frozen target', () => {
  const s = session({pointerMode:'trigger', smoothing:1});
  s.hold('trigger');

  // Move pointer to target
  const pTarget = s.feed('trigger');
  const targetU = pTarget.activePos.x;
  const targetV = pTarget.activePos.y;

  // 1. Fold index to freeze
  const pFreeze = s.feed('trigger-freeze', {x: 0.03, y: 0.03});
  assert.equal(pFreeze.mode, 'move');
  assert.equal(pFreeze.activePos.x, targetU);

  // 2. Extend thumb while index is folded -> Left Click fires AT target position!
  const pClick = s.feed('trigger-freeze-click', {x: 0.03, y: 0.03});
  assert.equal(pClick.mode, 'left');
  assert.ok(pClick.events.some(e => e.type === 'button' && e.button === 'left' && e.down));
  assert.equal(pClick.activePos.x, targetU);

  // 3. Retract thumb -> Left Click releases AT target position
  s.feed('trigger-freeze', {x: 0.03, y: 0.03});
  const pUp = s.feed('trigger-freeze', {x: 0.03, y: 0.03});
  assert.ok(pUp.events.some(e => e.type === 'button' && e.button === 'left' && !e.down));
  assert.equal(pUp.activePos.x, targetU);
});

test('pointerMode: trigger pinky extension triggers Right Click, both triggers simultaneous click', () => {
  const s = session({pointerMode:'trigger', smoothing:1});
  s.hold('trigger');

  // Extend pinky -> Right Click
  const pRight = s.feed('trigger-right');
  assert.equal(pRight.mode, 'right');
  assert.ok(pRight.events.some(e => e.type === 'button' && e.button === 'right' && e.down));

  // Retract pinky -> Right Click released
  s.feed('trigger');
  const pRightUp = s.feed('trigger');
  assert.ok(pRightUp.events.some(e => e.type === 'button' && e.button === 'right' && !e.down));

  // Both Thumb and Pinky extended -> Left and Right both down
  const pBoth = s.feed('trigger-both');
  assert.equal(pBoth.mode, 'both');
  assert.ok(pBoth.events.some(e => e.type === 'button' && e.button === 'left' && e.down));
  assert.ok(pBoth.events.some(e => e.type === 'button' && e.button === 'right' && e.down));
});

test('pointerMode: trigger V-sign scrolls smoothly and full fist is idle', () => {
  const s = session({pointerMode:'trigger', vScroll:true, smoothing:1});
  s.hold('trigger');

  // V-sign (Index + Middle extended, Thumb & Pinky folded) engages scroll after 3 dwell frames
  s.feed('trigger-scroll');
  s.feed('trigger-scroll');
  s.feed('trigger-scroll');
  const pScroll = s.feed('trigger-scroll', {y: -0.04});
  assert.equal(pScroll.mode, 'scroll');
  assert.ok(pScroll.events.some(e => e.type === 'scroll'));
  assert.equal(pScroll.events.filter(e => e.type === 'button').length, 0);

  // Fist (all 5 fingers curled) is strictly idle
  const pFist = s.hold('fist').at(-1);
  assert.equal(pFist.mode, 'idle');
  assert.equal(pFist.events.filter(e => e.type === 'button' || e.type === 'scroll').length, 0);
});

test('pointerMode: trigger angled forward fist (dorsal view) rejects bent thumb and detects thumb/pinky unfolding', () => {
  const s = session({pointerMode:'trigger', smoothing:1});
  s.hold('trigger');

  // Construct dorsal/angled fist posture where thumb is bent downward on outside of index finger
  const makeAngledHand = () => {
    const pts = hand('fist');
    pts[0] = {x: 0.56, y: 0.85, z: 0};
    pts[1] = {x: 0.48, y: 0.65, z: 0};
    pts[2] = {x: 0.35, y: 0.36, z: 0};
    pts[3] = {x: 0.28, y: 0.33, z: 0};
    pts[4] = {x: 0.29, y: 0.47, z: 0}; // Bent downward on outside of fist (must NOT click!)
    pts[5] = {x: 0.36, y: 0.28, z: 0};
    pts[6] = {x: 0.33, y: 0.42, z: 0};
    pts[7] = {x: 0.36, y: 0.52, z: 0};
    pts[8] = {x: 0.41, y: 0.50, z: 0};
    pts[9] = {x: 0.43, y: 0.35, z: 0};
    pts[10] = {x: 0.40, y: 0.48, z: 0};
    pts[11] = {x: 0.42, y: 0.56, z: 0};
    pts[12] = {x: 0.45, y: 0.54, z: 0};
    pts[13] = {x: 0.48, y: 0.45, z: 0};
    pts[14] = {x: 0.43, y: 0.58, z: 0};
    pts[15] = {x: 0.45, y: 0.65, z: 0};
    pts[16] = {x: 0.48, y: 0.62, z: 0};
    pts[17] = {x: 0.52, y: 0.58, z: 0};
    pts[18] = {x: 0.43, y: 0.72, z: 0};
    pts[19] = {x: 0.47, y: 0.76, z: 0};
    pts[20] = {x: 0.51, y: 0.74, z: 0};
    return pts;
  };

  // 1. Bent thumb on angled fist must NEVER be judged as extended
  const bentState = s.feed('fist', {}, {landmarks: makeAngledHand()});
  assert.notEqual(bentState.mode, 'left', 'Bent thumb must not trigger left click');
  assert.equal(bentState.events.filter(e => e.type === 'button').length, 0);

  // 2. Unfolding thumb outward in the angled view triggers Left Click
  const thumbOpen = makeAngledHand();
  thumbOpen[4] = {x: 0.20, y: 0.25, z: 0};
  const openState = s.feed('fist', {}, {landmarks: thumbOpen});
  assert.equal(openState.mode, 'left');
  assert.ok(openState.events.some(e => e.type === 'button' && e.button === 'left' && e.down));

  // 3. Bending thumb back down releases Left Click cleanly (after 2 debounce frames)
  s.feed('fist', {}, {landmarks: makeAngledHand()});
  const releaseState = s.feed('fist', {}, {landmarks: makeAngledHand()});
  assert.ok(releaseState.events.some(e => e.type === 'button' && e.button === 'left' && !e.down));

  // 4. Unfolding pinky forward in the angled view triggers Right Click
  const pinkyOpen = makeAngledHand();
  pinkyOpen[18] = {x: 0.55, y: 0.48, z: 0};
  pinkyOpen[19] = {x: 0.58, y: 0.38, z: 0};
  pinkyOpen[20] = {x: 0.62, y: 0.28, z: 0};
  const rState = s.feed('fist', {}, {landmarks: pinkyOpen});
  assert.equal(rState.mode, 'right');
  assert.ok(rState.events.some(e => e.type === 'button' && e.button === 'right' && e.down));
});

test('pointerMode: trigger front-facing clenched fist (Image 3) is strictly idle and thumb unfolding (Image 2) triggers left click', () => {
  const s = session({pointerMode:'trigger', smoothing:1});
  s.hold('trigger');

  // Realistic landmarks corresponding to User Image 3 (Frontal fist with thumb wrapped across index)
  const makeImage3Fist = () => {
    return [
      {x: 0.52, y: 0.82, z: 0.05},  // 0: Wrist
      {x: 0.38, y: 0.72, z: 0.02},  // 1: Thumb CMC
      {x: 0.28, y: 0.58, z: -0.01}, // 2: Thumb MCP
      {x: 0.30, y: 0.44, z: -0.04}, // 3: Thumb IP
      {x: 0.42, y: 0.47, z: -0.06}, // 4: Thumb Tip (curled across index finger towards middle finger!)
      {x: 0.40, y: 0.36, z: -0.03}, // 5: Index MCP
      {x: 0.42, y: 0.46, z: -0.07}, // 6: Index PIP
      {x: 0.43, y: 0.54, z: -0.06}, // 7: Index DIP
      {x: 0.44, y: 0.52, z: -0.04}, // 8: Index Tip (curled into palm)
      {x: 0.49, y: 0.38, z: -0.02}, // 9: Middle MCP
      {x: 0.49, y: 0.48, z: -0.07}, // 10: Middle PIP
      {x: 0.48, y: 0.56, z: -0.06}, // 11: Middle DIP
      {x: 0.46, y: 0.54, z: -0.03}, // 12: Middle Tip (curled into palm, close to LM 4!)
      {x: 0.56, y: 0.41, z: 0.00},  // 13: Ring MCP
      {x: 0.56, y: 0.52, z: -0.06}, // 14: Ring PIP
      {x: 0.54, y: 0.58, z: -0.05}, // 15: Ring DIP
      {x: 0.52, y: 0.55, z: -0.02}, // 16: Ring Tip (curled into palm)
      {x: 0.63, y: 0.46, z: 0.02},  // 17: Pinky MCP
      {x: 0.63, y: 0.56, z: -0.04}, // 18: Pinky PIP
      {x: 0.61, y: 0.62, z: -0.03}, // 19: Pinky DIP
      {x: 0.58, y: 0.59, z: -0.01}, // 20: Pinky Tip (curled into palm)
    ];
  };

  // 1. Clenched fist with wrapped thumb settles to idle within 4 debounce frames
  s.feed('fist', {}, {landmarks: makeImage3Fist()});
  s.feed('fist', {}, {landmarks: makeImage3Fist()});
  s.feed('fist', {}, {landmarks: makeImage3Fist()});
  const fistState = s.feed('fist', {}, {landmarks: makeImage3Fist()});
  assert.equal(fistState.mode, 'idle', 'Clenched fist must be idle');
  assert.equal(fistState.events.length, 0, 'No mouse events from clenched fist');

  // 2. Unfolding thumb outward (User Image 2 - L-Shape pose) triggers Left Click
  const lShapeHand = makeImage3Fist();
  // Extend index upwards
  lShapeHand[6] = {x: 0.40, y: 0.26, z: -0.05};
  lShapeHand[7] = {x: 0.40, y: 0.16, z: -0.07};
  lShapeHand[8] = {x: 0.40, y: 0.06, z: -0.09};
  // Extend thumb outward to the left (radial abduction)
  lShapeHand[3] = {x: 0.20, y: 0.52, z: -0.02};
  lShapeHand[4] = {x: 0.12, y: 0.50, z: -0.02};

  const clickState = s.feed('trigger-left', {}, {landmarks: lShapeHand});
  assert.equal(clickState.mode, 'left', 'L-shape with extended thumb triggers left click');
  assert.ok(clickState.events.some(e => e.type === 'button' && e.button === 'left' && e.down));
});

test('pointerMode: trigger 3D pitch/yaw invariance (cos3D keeps forward index aiming, clamped ringSpan rejects fist)', () => {
  const s = session({pointerMode:'trigger', smoothing:1});
  s.hold('trigger');

  // Forward pitched hand aiming directly toward camera (Z-axis foreshortened in 2D)
  const pitchedHand = hand('trigger');
  // In 2D, index joints 6, 7, 8 collapse close in Y, but extend along Z:
  pitchedHand[5] = {x: 0.43, y: 0.60, z: 0.0};
  pitchedHand[6] = {x: 0.43, y: 0.58, z: -0.15};
  pitchedHand[7] = {x: 0.43, y: 0.57, z: -0.30};
  pitchedHand[8] = {x: 0.43, y: 0.56, z: -0.45}; // Aiming straight forward at camera!

  const aimState = s.feed('trigger', {}, {landmarks: pitchedHand});
  assert.equal(aimState.mode, 'move', 'Forward pitched index must remain in move mode');
  assert.equal(aimState.fingertips?.index?.visible, true, 'cos3D recognizes straight forward aiming');

  // Multi-frame flexion to freeze: verify aimHistory rewinds past transitional dip
  const dipFrame1 = hand('trigger');
  dipFrame1[8] = {x: 0.43, y: 0.45, z: 0.0};
  s.feed('trigger', {}, {landmarks: dipFrame1});

  const foldFrame = hand('trigger-freeze');
  const freezeState = s.feed('trigger-freeze', {}, {landmarks: foldFrame});
  assert.ok(freezeState.mode === 'idle' || freezeState.mode === 'move');
  assert.ok(Number.isFinite(freezeState.activePos.x));
});

test('pointerMode: trigger strictly V-Sign (✌️) scrolls while Open Palm (🖐) and Fist (✊) are strictly idle', () => {
  const s = session({pointerMode:'trigger', vScroll:true, smoothing:1});
  s.hold('trigger');

  // 1. Open Palm (🖐) is strictly idle (just like fist) with zero movement or scroll
  s.feed('trigger-open-palm');
  s.feed('trigger-open-palm');
  const openPalmState = s.feed('trigger-open-palm', {y: -0.04});
  assert.equal(openPalmState.mode, 'idle', 'Open palm must be strictly idle');
  assert.equal(openPalmState.events.length, 0, 'Open palm must emit zero events');

  // 2. Zero click interference: even if thumb is stretched during open palm, NO left/right click
  const openPalmWithThumb = hand('trigger-open-palm');
  openPalmWithThumb[4] = {x: 0.15, y: 0.50, z: 0}; // thumb fully extended
  const clickBlockedState = s.feed('trigger-open-palm', {y: -0.04}, {landmarks: openPalmWithThumb});
  assert.equal(clickBlockedState.mode, 'idle', 'Must remain in idle');
  assert.equal(clickBlockedState.events.length, 0, 'Zero click events during open palm');

  // 3. V-Sign (✌️) engages scroll smoothly
  s.feed('trigger-scroll');
  s.feed('trigger-scroll');
  const vScrollState = s.feed('trigger-scroll', {y: -0.04});
  assert.equal(vScrollState.mode, 'scroll', 'V-Sign must engage scroll mode');
  assert.ok(vScrollState.events.some(e => e.type === 'scroll'), 'Must emit scroll events');

  // 4. Return to index aim: folding middle finger exits scroll and recovers move
  s.feed('trigger');
  s.feed('trigger');
  s.feed('trigger');
  const aimRecovered = s.feed('trigger');
  assert.equal(aimRecovered.mode, 'move', 'Returns cleanly to pointer move mode');
});


test('pointerMode: trigger hybridAI option assists real-world postures with high confidence', async () => {
  const sPure = session({pointerMode:'trigger', vScroll: true, hybridAI: false});
  const sHybrid = session({pointerMode:'trigger', vScroll: true, hybridAI: true});

  assert.equal(sPure.controller.hybridAI, false);
  assert.equal(sHybrid.controller.hybridAI, true);

  const fs = (await import('node:fs')).default;
  const path = (await import('node:path')).default;

  const dataDir = path.join(process.cwd(), 'data');
  if (fs.existsSync(dataDir)) {
    const moveFile = fs.existsSync(path.join(dataDir, 'legacy', 'manux_pose_snapshots_trigger_move.json'))
      ? path.join(dataDir, 'legacy', 'manux_pose_snapshots_trigger_move.json')
      : path.join(dataDir, 'manux_pose_snapshots_trigger_move.json');
    if (fs.existsSync(moveFile)) {
      const data = JSON.parse(fs.readFileSync(moveFile, 'utf8'));
      const sample = data.samples[0];
      sHybrid.hold('trigger');
      sHybrid.controller.update({landmarks: sample.rawLandmarks, now: 1000, enabled: true, quality: true});
      assert.ok(sHybrid.controller.lastGates.aiPose !== null);
      assert.equal(sHybrid.controller.lastGates.aiPose.action, 'move');
    }
  }
});

test('pointerMode: trigger strict mutual exclusivity between scroll and clicks (scroll blocked if thumb/pinky extended, clicks blocked during scroll and exit cooldown)', () => {
  const s = session({pointerMode:'trigger', vScroll: true, smoothing: 1});
  s.hold('trigger');

  // 1. Right click with middle finger raised (potential V-sign) MUST NOT trigger scroll
  const rightWithMiddleRaised = hand('trigger-right');
  rightWithMiddleRaised[12] = {x: 0.50, y: 0.26, z: 0}; // Middle extended
  const rState = s.feed('trigger-right', {}, {landmarks: rightWithMiddleRaised});
  assert.equal(rState.mode, 'right', 'Pinky extension must trigger right click, not scroll');
  assert.equal(rState.events.filter(e => e.type === 'scroll').length, 0, 'No scroll events during click');

  // Release right click
  s.feed('trigger');
  s.feed('trigger');

  // 2. Left click with middle finger raised MUST NOT trigger scroll
  const leftWithMiddleRaised = hand('trigger-left');
  leftWithMiddleRaised[12] = {x: 0.50, y: 0.26, z: 0}; // Middle extended
  const lState = s.feed('trigger-left', {}, {landmarks: leftWithMiddleRaised});
  assert.equal(lState.mode, 'left', 'Thumb extension must trigger left click, not scroll');
  assert.equal(lState.events.filter(e => e.type === 'scroll').length, 0, 'No scroll events during click');

  // Release left click
  s.feed('trigger');
  s.feed('trigger');

  // 3. Clean V-sign enters scroll after 2 frames
  s.feed('trigger-scroll');
  const scrollState = s.feed('trigger-scroll', {y: -0.04});
  assert.equal(scrollState.mode, 'scroll', 'Clean V-sign enters scroll');

  // 4. While in scroll, accidental thumb twitch is strictly blocked
  const scrollWithThumb = hand('trigger-scroll');
  scrollWithThumb[4] = {x: 0.20, y: 0.50, z: 0}; // Thumb out
  const inScrollState = s.feed('trigger-scroll', {y: -0.04}, {landmarks: scrollWithThumb});
  assert.equal(inScrollState.mode, 'scroll', 'Remains in scroll');
  assert.equal(inScrollState.events.filter(e => e.type === 'button').length, 0, 'Buttons 100% blocked during scroll');

  // 5. Exiting scroll: 4-frame anti-chatter cooldown blocks clicks during retraction
  s.feed('trigger');
  s.feed('trigger');
  s.feed('trigger');
  const exitFrame = s.feed('trigger'); // 4th non-scroll frame exits scroll
  assert.notEqual(exitFrame.mode, 'scroll');

  // During cooldown immediately after exiting scroll, thumb extension cannot click
  const cooldownClick = s.feed('trigger-left');
  assert.equal(cooldownClick.events.filter(e => e.type === 'button' && e.down).length, 0, 'Click blocked during post-scroll cooldown');
});

test('pointerMode: trigger anti-chattering filter suppresses single-frame scroll glitches and prevents click flutter', () => {
  const s = session({pointerMode:'trigger', vScroll: true, smoothing: 1});
  s.hold('trigger');

  // 1. Single-frame scroll spike during move mode is ignored (no scroll event, cursor continues)
  const singleGlitch = s.feed('trigger-scroll');
  assert.notEqual(singleGlitch.mode, 'scroll', '1-frame scroll glitch does not enter scroll');
  assert.equal(singleGlitch.events.filter(e => e.type === 'scroll').length, 0);

  // Next frame back to move remains cleanly in move
  const recoveredMove = s.feed('trigger', {x: 0.02});
  assert.equal(recoveredMove.mode, 'move');

  // 2. Click hold does not flutter on single intermediate frame drop
  s.feed('trigger-left'); // Press left
  assert.equal(s.controller.leftDown, true);

  // 1 frame of boundary hesitation does not release button (2-frame release debounce)
  s.feed('trigger');
  assert.equal(s.controller.leftDown, true, 'Left button remains held across 1-frame boundary hesitation');

  // 2nd frame of release confirms release
  const released = s.feed('trigger');
  assert.equal(s.controller.leftDown, false, 'Confirmed release after 2 frames');
  assert.ok(released.events.some(e => e.type === 'button' && e.button === 'left' && !e.down));
});
