const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const dist2D = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const MAX_GAP_MS = 250;
const RELEASE_MS = 120;
const MIN_OBSERVATIONS = 3;

function straight(a, b, c) {
  const u = {x:a.x - b.x, y:a.y - b.y, z:a.z - b.z};
  const v = {x:c.x - b.x, y:c.y - b.y, z:c.z - b.z};
  const length = Math.hypot(u.x, u.y, u.z) * Math.hypot(v.x, v.y, v.z);
  return length > 1e-8 && (u.x * v.x + u.y * v.y + u.z * v.z) / length < -0.70;
}

class LowPassFilter {
  constructor(alpha = 1) {
    this.alpha = alpha;
    this.s = null;
  }
  filter(v, alpha = this.alpha) {
    this.s = this.s === null ? v : alpha * v + (1 - alpha) * this.s;
    return this.s;
  }
  reset() { this.s = null; }
}

class OneEuroFilter {
  constructor({minCutoff = 0.25, beta = 9.0, dCutoff = 1.0} = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.xFilter = new LowPassFilter();
    this.dxFilter = new LowPassFilter();
    this.lastTime = null;
    this.lastValue = null;
  }

  alpha(cutoff, dt) {
    const tau = 1.0 / (2 * Math.PI * cutoff);
    return 1.0 / (1.0 + tau / dt);
  }

  filter(v, now) {
    if (!Number.isFinite(now)) return v;
    if (this.lastTime === null || this.lastValue === null) {
      this.lastTime = now;
      this.lastValue = v;
      this.xFilter.reset();
      this.dxFilter.reset();
      return this.xFilter.filter(v);
    }
    const dt = Math.max(1e-4, (now - this.lastTime) / 1000.0);
    this.lastTime = now;

    const dValue = (v - this.lastValue) / dt;
    this.lastValue = v;
    const aD = this.alpha(this.dCutoff, dt);
    const edValue = this.dxFilter.filter(dValue, aD);

    const cutoff = this.minCutoff + this.beta * Math.abs(edValue);
    const a = this.alpha(cutoff, dt);
    return this.xFilter.filter(v, a);
  }

  reset() {
    this.lastTime = null;
    this.lastValue = null;
    this.xFilter.reset();
    this.dxFilter.reset();
  }
}

function observation(landmarks, width, height, previousPinch, allowVScroll = false, pointerMode = 'index') {
  if (!Array.isArray(landmarks) || landmarks.length !== 21 || !Number.isFinite(width) ||
      !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const inBounds = pointerMode === 'index'
    ? landmarks.every(p => p && Number.isFinite(p.x) && Number.isFinite(p.y) &&
        p.x >= -0.25 && p.x <= 1.25 && p.y >= -0.25 && p.y <= 1.25 &&
        (p.z === undefined || (Number.isFinite(p.z) && Math.abs(p.z) <= 3)))
    : landmarks.every(p => p && Number.isFinite(p.x) && Number.isFinite(p.y) &&
        p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1 &&
        (p.z === undefined || (Number.isFinite(p.z) && Math.abs(p.z) <= 3)));
  if (!inBounds) return null;
  // MediaPipe's z uses approximately the same scale as x. All axes below use video-width units.
  const points = landmarks.map(p => ({
    x: pointerMode === 'index' ? clamp(p.x, 0, 1) : p.x,
    y: (pointerMode === 'index' ? clamp(p.y, 0, 1) : p.y) * height / width,
    z: p.z ?? 0
  }));
  const palm = Math.max(dist2D(points[0], points[9]), dist2D(points[5], points[17]));
  if (palm < 0.025 || palm > 0.8) return null;

  const extended = base => straight(points[base], points[base + 1], points[base + 3]) &&
    dist2D(points[base + 3], points[0]) > dist2D(points[base + 1], points[0]) * 1.12;
  const index = extended(5), middle = extended(9), ring = extended(13), pinky = extended(17);
  const ratio = tip => dist2D(points[4], points[tip]) / palm;
  const dIndex = ratio(8);
  const dMiddle = ratio(12);
  const dRing = ratio(16);
  const dPinky = ratio(20);
  const dTwoFinger = dist2D(points[8], points[12]) / palm;

  // Clenched fingers count: fingers curled tightly into palm
  const clenchedCount = [8, 12, 16, 20].filter(tip => dist2D(points[tip], points[0]) < palm * 1.05).length;
  // In index mode, if index is extended pointing up, it is NEVER a fist! Only curled index + clenched fingers count as fist.
  const isFist = pointerMode === 'index'
    ? (!index && (clenchedCount >= 3 || (!middle && clenchedCount >= 2)))
    : (clenchedCount >= 2);

  // Reachable pinch tips must extend away from the wrist, and thumb must extend from wrist
  const reachable = (tip, base) => !isFist &&
    dist2D(points[tip], points[0]) > palm * 0.95 &&
    dist2D(points[tip], points[base]) > palm * 0.32 &&
    dist2D(points[4], points[0]) > palm * 0.60;

  // Exclusive left and right pinch detection (legacy palm mode)
  const isLeftPinch = reachable(8, 5) && dIndex < (previousPinch === 'left' ? 0.47 : 0.35) && dMiddle > dIndex * 1.15;
  const isRightPinch = reachable(12, 9) && dMiddle < (previousPinch === 'right' ? 0.47 : 0.38) && dIndex > dMiddle * 1.18;
  const isBothPinch = reachable(8, 5) && reachable(12, 9) && dIndex < 0.38 && dMiddle < 0.40;
  const isRingScrollPinch = reachable(16, 13) && dRing < (previousPinch === 'scroll' ? 0.47 : 0.35);

  // Smartphone Touch Scroll (✌️ Gesture 2: Index & Middle extended upwards, Ring & Pinky folded)
  // Or Two-Finger Clutch (LM 8 & LM 12 touching, thumb unpinched)
  const isPeaceGesture = index && middle && !ring && !pinky && dIndex > 0.38 && dMiddle > 0.40;
  const twoFingerClutch = !isBothPinch && !isLeftPinch && !isRightPinch && dIndex > 0.42 && dMiddle > 0.42 && dTwoFinger < 0.22;
  const isSmartphoneScroll = allowVScroll && (isPeaceGesture || twoFingerClutch);

  let mode = 'idle';
  let pinch = null;
  let anchor = null;

  if (pointerMode === 'index') {
    // === ERGONOMIC PARADIGM: Absolute 1:1 Mapping + Pure Gesture 2 Scroll + Independent Clicks ===
    // 1. Pointer: Cursor follows Index Tip (LM 8) in absolute coordinates (100% coincident with AR HUD).
    // 2. Strict Gesture 2 (V-Sign): Index + Middle extended upwards, Ring + Pinky curled into palm, clean V gap.
    //    WHILE IN SCROLL: Left and Right clicks are 100% BLOCKED and suppressed!
    // 3. Left Click: Thumb (LM 4) + Middle (LM 12) pinch. Independent!
    // 4. Right Click: Thumb (LM 4) + Ring (LM 16) pinch. Independent!
    // 5. Simultaneous Click: If both touch thumb, BOTH left and right are active!
    // 6. Rest / Idle: Strictly Fist (주먹: all curled).

    // Pure Gesture 2: strictly V-sign (Index & Middle extended, Ring & Pinky curled into palm, fingers separated)
    const isScrollGesture = allowVScroll &&
      index && middle && !ring && !pinky &&
      dist2D(points[16], points[0]) < palm * 1.10 &&
      dist2D(points[20], points[0]) < palm * 1.10 &&
      dTwoFinger > 0.16 &&
      dMiddle > 0.40 && dRing > 0.40 && dIndex > 0.40;

    // Independent Left Click: Thumb + Middle touch (ONLY when NOT scrolling and NOT in fist)
    const isLeft = !isFist && !isScrollGesture && (dMiddle < (previousPinch === 'left' || previousPinch === 'both' ? 0.35 : 0.28));

    // Independent Right Click: Thumb + Ring touch (ONLY when NOT scrolling and NOT in fist)
    const isRight = !isFist && !isScrollGesture && (dRing < (previousPinch === 'right' || previousPinch === 'both' ? 0.35 : 0.28));

    if (isFist) {
      mode = 'idle';
      pinch = null;
    } else if (isScrollGesture) {
      mode = 'scroll';
      pinch = null;
    } else if (isLeft && isRight) {
      mode = 'both';
      pinch = 'both';
    } else if (isLeft) {
      mode = 'left';
      pinch = 'left';
    } else if (isRight) {
      mode = 'right';
      pinch = 'right';
    } else {
      mode = 'move';
      pinch = null;
    }

    if (mode === 'scroll') {
      anchor = {
        x: (points[8].x + points[12].x) * 0.5,
        y: (points[8].y + points[12].y) * 0.5,
      };
    } else {
      anchor = {
        x: points[8].x,
        y: points[8].y,
      };
    }
  } else {
    // === LEGACY PALM MODE: Open Palm Move + Rigid Palm Anchor ===
    const fingers = [
      {mode:'left', tip:8, base:5, pinch:isLeftPinch, ratio:dIndex, reachable:reachable(8, 5)},
      {mode:'right', tip:12, base:9, pinch:isRightPinch, ratio:dMiddle, reachable:reachable(12, 9)},
      {mode:'scroll', tip:16, base:13, pinch:isRingScrollPinch, ratio:dRing, reachable:reachable(16, 13)},
    ];
    const pinches = fingers.filter(f => f.pinch);
    const ambiguous = pinches.length > 1 || (pinches.length === 1 && fingers.some(f =>
      f.mode !== pinches[0].mode && f.reachable && f.ratio < 0.42));
    pinch = ambiguous ? null : pinches[0]?.mode ?? null;

    const vScroll = allowVScroll && !ambiguous && !pinch && (isPeaceGesture || twoFingerClutch);
    mode = ambiguous ? 'idle' : pinch || (vScroll ? 'scroll' : (isFist ? 'idle' : 'move'));

    // Rigid Palm Anchor: Wrist (0) 20%, Index MCP (5) 50%, Middle MCP (9) 30%
    anchor = {
      x: 0.2 * points[0].x + 0.5 * points[5].x + 0.3 * points[9].x,
      y: 0.2 * points[0].y + 0.5 * points[5].y + 0.3 * points[9].y,
    };
  }

  // Deadzone-free compact active zone mapping coordinates (0 ~ 1 normalized across comfortable desk view)
  const mirroredX = 1.0 - (points[8].x);
  const activePos = {
    x: clamp((mirroredX - 0.28) / 0.44, 0, 1),
    y: clamp((points[8].y - 0.20) / 0.48, 0, 1),
  };

  const fingertips = {
    index: {x: points[8].x, y: points[8].y},
    thumb: {x: points[4].x, y: points[4].y},
    middle: {x: points[12].x, y: points[12].y},
    ring: {x: points[16].x, y: points[16].y},
    pinky: {x: points[20].x, y: points[20].y},
    wrist: {x: points[0].x, y: points[0].y},
  };

  const unpinched = pointerMode === 'index'
    ? (pinch === null)
    : (dIndex >= 0.44 && dMiddle >= 0.44);

  return {mode, pinch, anchor, vScroll: isSmartphoneScroll, dIndex, dMiddle, dRing, dPinky, dTwoFinger, palm, fingertips, activePos, unpinched};
}

/** Pure landmark-to-input controller. It never sends OS events or stores camera data. */
export class AirMouseController {
  constructor({pointerMode = 'palm', sensitivity = 1800, smoothing = 0.45, holdMs = 160, ballistics = false, clickLock = false, vScroll = false, rotationDeg = 0, gainY = 1.0} = {}) {
    if (!Number.isFinite(sensitivity) || sensitivity < 100 || sensitivity > 6000 ||
        !Number.isFinite(smoothing) || smoothing <= 0 || smoothing > 1 ||
        !Number.isFinite(holdMs) || holdMs < 0 || holdMs > 2000) {
      throw new RangeError('Invalid air mouse sensitivity, smoothing, or hold time.');
    }
    this.pointerMode = pointerMode;
    this.sensitivity = sensitivity;
    this.smoothing = smoothing;
    this.holdMs = holdMs;
    this.ballistics = Boolean(ballistics);
    this.clickLock = Boolean(clickLock);
    this.vScroll = Boolean(vScroll);
    this.rotationDeg = Number.isFinite(rotationDeg) ? rotationDeg : 0;
    this.gainY = Number.isFinite(gainY) ? gainY : 1.0;
    this.euroU = new OneEuroFilter({minCutoff: 0.25, beta: 9.0});
    this.euroV = new OneEuroFilter({minCutoff: 0.25, beta: 9.0});
    this.lastEmittedU = null;
    this.lastEmittedV = null;
    this.lockPos = null;
    this.reset();
  }

  state(phase, events = [], progress = 0, extras = {}) {
    return {
      mode:this.mode,
      phase,
      progress:clamp(progress, 0, 1),
      events,
      pinch:this.pinch ?? null,
      fingertips:this.lastFingertips ?? null,
      activePos:this.lastActivePos ?? null,
      ...extras
    };
  }

  reset() {
    this.enabled = false;
    this.lastTime = null;
    this.lastHand = null;
    this.mode = 'idle';
    this.candidate = null;
    this.candidateSince = null;
    this.observations = 0;
    this.pinch = null;
    this.anchor = null;
    this.filtered = null;
    this.remaining = {x:0,y:0};
    this.leftDown = false;
    this.rightDown = false;
    this.armed = false;
    this.releaseSince = null;
    this.dragDisplacement = 0;
    this.dragUnlocked = false;
    this.lastDIndex = null;
    this.scrollOriginY = null;
    this.lastTouchY = null;
    this.leftReleaseFrames = 0;
    this.lastFingertips = null;
    this.lastActivePos = null;
    this.euroU?.reset();
    this.euroV?.reset();
    this.lastEmittedU = null;
    this.lastEmittedV = null;
    this.lockPos = null;
    return this.state('disabled', [{type:'release'}]);
  }

  interrupt(phase, disarm = true) {
    const events = [];
    if (this.leftDown) events.push({type:'button', button:'left', down:false});
    if (this.rightDown) events.push({type:'button', button:'right', down:false});
    if (this.leftDown || this.rightDown) events.push({type:'release'});
    this.leftDown = false;
    this.rightDown = false;
    this.mode = 'idle';
    this.candidate = null;
    this.candidateSince = null;
    this.observations = 0;
    this.anchor = this.filtered = null;
    this.remaining = {x:0,y:0};
    this.pinch = null;
    this.releaseSince = null;
    this.dragDisplacement = 0;
    this.dragUnlocked = false;
    this.lastDIndex = null;
    this.scrollOriginY = null;
    this.lastTouchY = null;
    this.leftReleaseFrames = 0;
    this.euroU?.reset();
    this.euroV?.reset();
    this.lastEmittedU = null;
    this.lastEmittedV = null;
    this.lockPos = null;
    if (disarm) this.armed = false;
    return this.state(phase, events);
  }

  update({landmarks, now, enabled, quality = true, handedness = null, width = 1280, height = 720} = {}) {
    if (!enabled) {
      if (this.enabled) return this.reset();
      return this.state('disabled');
    }
    this.enabled = true;
    if (!Number.isFinite(now)) {
      this.lastFingertips = this.lastActivePos = null;
      return this.interrupt('invalid');
    }
    if (this.lastTime !== null && now <= this.lastTime) return this.state('stale');
    const gap = this.lastTime !== null && now - this.lastTime > MAX_GAP_MS;
    this.lastTime = now;
    const observed = quality === true ? observation(landmarks, width, height, this.pinch, this.vScroll, this.pointerMode) : null;
    if (!observed) {
      this.lastHand = null;
      this.lastFingertips = this.lastActivePos = null;
      return this.interrupt('invalid');
    }
    this.lastFingertips = observed.fingertips;
    this.lastActivePos = observed.activePos;
    const changedHand = handedness && this.lastHand && handedness !== this.lastHand;
    this.lastHand = handedness;
    if (gap || changedHand) return this.interrupt('tracking-reset');

    const dIndex = observed.dIndex ?? 1.0;
    const indexVelocity = (this.lastDIndex !== null && Number.isFinite(now) && !gap)
      ? (dIndex - this.lastDIndex)
      : 0;
    this.lastDIndex = dIndex;

    const events = [];

    if (this.pointerMode === 'index') {
      // === ERGONOMIC INDEX MODE: Absolute 1:1 Pointer + Independent Instant Clicks ===
      this.mode = observed.mode;
      this.pinch = observed.pinch;

      if (this.mode === 'scroll') {
        // Strict Scroll Rule: Left & Right clicks are 100% blocked during scroll!
        if (this.leftDown) {
          events.push({type: 'button', button: 'left', down: false});
          this.leftDown = false;
        }
        if (this.rightDown) {
          events.push({type: 'button', button: 'right', down: false});
          this.rightDown = false;
        }
      } else if (this.mode !== 'idle') {
        // Independent Left Button (Thumb + Middle)
        const wantLeft = (this.mode === 'left' || this.mode === 'both');
        if (wantLeft !== this.leftDown) {
          this.leftDown = wantLeft;
          events.push({type: 'button', button: 'left', down: wantLeft});
          if (wantLeft) {
            this.dragDisplacement = 0;
            this.dragUnlocked = false;
            this.lockPos = null;
          }
        }

        // Independent Right Button (Thumb + Ring)
        const wantRight = (this.mode === 'right' || this.mode === 'both');
        if (wantRight !== this.rightDown) {
          this.rightDown = wantRight;
          events.push({type: 'button', button: 'right', down: wantRight});
        }
      }

      if (this.mode === 'idle') {
        const result = this.interrupt('ready', false);
        result.events.unshift(...events);
        return result;
      }

      // === ABSOLUTE 1:1 POSITIONING & 1€ FILTER JITTER REMOVAL ===
      const rawU = observed.activePos.x;
      const rawV = observed.activePos.y;

      let filtU = this.euroU.filter(rawU, now);
      let filtV = this.euroV.filter(rawV, now);

      // Click Freeze Lock: lock micro-displacement immediately following click until intentional drag
      if (this.leftDown) {
        if (!this.dragUnlocked) {
          if (this.lockPos === null) {
            this.lockPos = {u: filtU, v: filtV};
          }
          const dragDist = Math.hypot((filtU - this.lockPos.u) * 1920, (filtV - this.lockPos.v) * 1080);
          if (dragDist < 16) {
            filtU = this.lockPos.u;
            filtV = this.lockPos.v;
          } else {
            this.dragUnlocked = true;
          }
        }
      } else {
        this.lockPos = null;
      }

      // Stationary Tremor Gate (Deadband): when hand is virtually motionless at rest, freeze cursor completely
      if (this.lastEmittedU !== null && this.lastEmittedV !== null) {
        const deltaPx = Math.hypot((filtU - this.lastEmittedU) * 1920, (filtV - this.lastEmittedV) * 1080);
        if (deltaPx < 2.5 && !this.leftDown) {
          filtU = this.lastEmittedU;
          filtV = this.lastEmittedV;
        }
      }
      this.lastEmittedU = filtU;
      this.lastEmittedV = filtV;

      observed.activePos.x = clamp(Number(filtU.toFixed(4)), 0, 1);
      observed.activePos.y = clamp(Number(filtV.toFixed(4)), 0, 1);

      if (this.mode === 'scroll') {
        // === Smartphone Touch Swipe Scroll ===
        if (this.lastTouchY === null) {
          this.lastTouchY = observed.anchor.y;
        }
        const motionY = observed.anchor.y - this.lastTouchY;
        this.lastTouchY = observed.anchor.y;
        if (Math.abs(motionY) > 0.0008) {
          const scrollInput = -motionY * this.sensitivity * 1.6;
          this.remaining.y += scrollInput;
          const wheel = clamp(Math.trunc(this.remaining.y / 6) * 6, -120, 120);
          if (wheel) {
            events.push({type: 'scroll', dy: wheel});
            this.remaining.y = clamp(this.remaining.y - wheel, -5.999, 5.999);
          }
        }
      } else {
        this.lastTouchY = null;
        // Absolute cursor movement event (1:1 coincident with HUD reticle)
        events.push({type: 'moveTo', x: observed.activePos.x, y: observed.activePos.y});
      }

      return this.state('active', events, 1, {
        fingertips: observed.fingertips,
        activePos: observed.activePos,
        dIndex: observed.dIndex,
        dMiddle: observed.dMiddle,
        dRing: observed.dRing,
        dPinky: observed.dPinky,
        dTwoFinger: observed.dTwoFinger
      });
    } else {
      // === LEGACY PALM MODE ===
      this.pinch = observed.pinch;
      if (observed.unpinched || (this.mode === 'move' && !observed.pinch)) {
        this.releaseSince ??= now;
        if (now - this.releaseSince >= RELEASE_MS) this.armed = true;
      } else this.releaseSince = null;

      if (this.leftDown) {
        if (observed.mode !== 'left') {
          if (dIndex >= 0.47 || ++this.leftReleaseFrames >= 4) {
            events.push({type:'button', button:'left', down:false});
            this.leftDown = false;
            this.armed = false;
            this.releaseSince = observed.unpinched ? now : null;
            this.dragDisplacement = 0;
            this.dragUnlocked = false;
            this.leftReleaseFrames = 0;
          }
        } else {
          this.leftReleaseFrames = 0;
        }
      }
      if (observed.mode === 'idle') {
        const releaseSince = this.releaseSince;
        const result = this.interrupt('ready', false);
        this.releaseSince = releaseSince;
        result.events.unshift(...events);
        return result;
      }

      if (observed.pinch && !this.armed && this.mode !== observed.mode) {
        const result = this.interrupt('release-required', false);
        result.events.unshift(...events);
        return result;
      }
      if (this.candidate !== observed.mode) {
        const recoveringMove = observed.mode === 'move' && ['left','right','scroll'].includes(this.mode);
        this.mode = recoveringMove ? 'move' : 'idle';
        this.candidate = observed.mode;
        this.candidateSince = now;
        this.observations = recoveringMove ? MIN_OBSERVATIONS : 1;
        this.anchor = this.filtered = observed.anchor;
        this.remaining = {x:0,y:0};
        this.dragDisplacement = 0;
        this.dragUnlocked = false;
        return this.state(recoveringMove ? 'active' : 'holding', events, recoveringMove ? 1 : 0);
      }
      this.observations++;
      if (this.mode !== observed.mode) {
        const progress = this.holdMs === 0 ? 1 : (now - this.candidateSince) / this.holdMs;
        this.anchor = this.filtered = observed.anchor;
        if (progress < 1 || this.observations < MIN_OBSERVATIONS) return this.state('holding', events, progress);
        this.mode = observed.mode;
        if (this.mode === 'left') {
          events.push({type:'button', button:'left', down:true});
          this.leftDown = true;
          this.armed = false;
          this.dragDisplacement = 0;
          this.dragUnlocked = false;
        } else if (this.mode === 'right') {
          events.push({type:'button', button:'right', down:true}, {type:'button', button:'right', down:false});
          this.armed = false;
        }
        return this.state('active', events, 1);
      }
    }

    if (!this.anchor || !this.filtered) {
      this.anchor = this.filtered = observed.anchor;
      return this.state('active', events, 1);
    }

    const delta = {x:observed.anchor.x - this.anchor.x, y:observed.anchor.y - this.anchor.y};
    this.anchor = observed.anchor;
    if (Math.hypot(delta.x, delta.y) > 0.14) {
      const result = this.interrupt('tracking-reset');
      result.events.unshift(...events);
      return result;
    }

    const next = {
      x:this.filtered.x + (observed.anchor.x - this.filtered.x) * this.smoothing,
      y:this.filtered.y + (observed.anchor.y - this.filtered.y) * this.smoothing,
    };
    let rawDx = -(next.x - this.filtered.x) * this.sensitivity;
    let rawDy = (next.y - this.filtered.y) * this.sensitivity;
    this.filtered = next;

    // Cross-View coordinate rotation compensation (e.g. -22° for diagonal top-left webcam)
    let dx = rawDx;
    let dy = rawDy;
    if (this.rotationDeg !== 0) {
      const rad = (this.rotationDeg * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      dx = rawDx * cos - rawDy * sin;
      dy = rawDx * sin + rawDy * cos;
    }

    // Anisotropic Y gain (compensates for foreshortening on desk plane)
    if (this.gainY !== 1.0) {
      dy *= this.gainY;
    }

    // Ergonomic pointer ballistics
    if (this.ballistics && this.mode !== 'scroll') {
      const v = Math.hypot(dx, dy);
      let gain = 1.0;
      if (v < 2.5) {
        gain = 0.55 + (v / 2.5) * 0.45;
      } else if (v > 7.0) {
        gain = 1.0 + Math.min(2.5, Math.pow((v - 7.0) / 8.0, 1.25));
      }
      dx *= gain;
      dy *= gain;
    }

    if (this.clickLock && this.mode === 'move' && !this.leftDown) {
      if (dIndex < 0.48 && indexVelocity < -0.008) {
        dx *= 0.05;
        dy *= 0.05;
      } else if (dIndex < 0.40 || (observed.dMiddle && observed.dMiddle < 0.42)) {
        dx *= 0.25;
        dy *= 0.25;
      }
    }

    if (this.mode === 'scroll') {
      if (this.scrollOriginY === null) {
        this.scrollOriginY = observed.anchor.y;
      }
      const offsetY = observed.anchor.y - this.scrollOriginY;
      let scrollInput = dy * 2;
      if (Math.abs(offsetY) > 0.008) {
        const rate = Math.sign(offsetY) * Math.min(18, Math.pow((Math.abs(offsetY) - 0.008) * 140, 1.25) * 4);
        scrollInput += rate;
      }
      this.remaining.y += scrollInput;
      const wheel = clamp(Math.trunc(this.remaining.y / 6) * 6, -120, 120);
      if (wheel) {
        events.push({type:'scroll',dy:wheel});
        this.remaining.y = clamp(this.remaining.y - wheel, -5.999, 5.999);
      }
    } else {
      this.scrollOriginY = null;
      this.lastTouchY = null;
      if (this.clickLock && this.mode === 'left' && this.leftDown && !this.dragUnlocked) {
        this.dragDisplacement += Math.hypot(dx, dy);
        if (this.dragDisplacement < 10) {
          dx = 0;
          dy = 0;
        } else {
          this.dragUnlocked = true;
        }
      }

      this.remaining.x += dx;
      this.remaining.y += dy;
      const px = clamp(Math.trunc(this.remaining.x), -100, 100);
      const py = clamp(Math.trunc(this.remaining.y), -100, 100);
      if (px || py) {
        events.push({type:'move',dx:px,dy:py});
        this.remaining.x = clamp(this.remaining.x - px, -0.999, 0.999);
        this.remaining.y = clamp(this.remaining.y - py, -0.999, 0.999);
      }
    }
    return this.state('active', events, 1, {
      fingertips: observed.fingertips,
      activePos: observed.activePos,
      dIndex: observed.dIndex,
      dMiddle: observed.dMiddle,
      dRing: observed.dRing,
      dPinky: observed.dPinky,
      dTwoFinger: observed.dTwoFinger
    });
  }
}
