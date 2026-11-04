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

function cos2D(a, b, c) {
  const ux = a.x - b.x, uy = a.y - b.y;
  const vx = c.x - b.x, vy = c.y - b.y;
  const length = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  return length > 1e-8 ? (ux * vx + uy * vy) / length : 0;
}

function distToSegment(p, a, b) {
  const vx = b.x - a.x, vy = b.y - a.y;
  const lenSq = vx * vx + vy * vy;
  const t = lenSq > 1e-8 ? clamp(((p.x - a.x) * vx + (p.y - a.y) * vy) / lenSq, 0, 1) : 0;
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
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
  const isIndexLike = pointerMode === 'index' || pointerMode === 'trigger';
  const inBounds = isIndexLike
    ? landmarks.every(p => p && Number.isFinite(p.x) && Number.isFinite(p.y) &&
        p.x >= -0.25 && p.x <= 1.25 && p.y >= -0.25 && p.y <= 1.25 &&
        (p.z === undefined || (Number.isFinite(p.z) && Math.abs(p.z) <= 3)))
    : landmarks.every(p => p && Number.isFinite(p.x) && Number.isFinite(p.y) &&
        p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1 &&
        (p.z === undefined || (Number.isFinite(p.z) && Math.abs(p.z) <= 3)));
  if (!inBounds) return null;
  // MediaPipe's z uses approximately the same scale as x. All axes below use video-width units.
  const points = landmarks.map(p => ({
    x: isIndexLike ? clamp(p.x, 0, 1) : p.x,
    y: (isIndexLike ? clamp(p.y, 0, 1) : p.y) * height / width,
    z: p.z ?? 0
  }));
  const palm = Math.max(dist2D(points[0], points[9]), dist2D(points[5], points[17]));
  if (palm < 0.025 || palm > 0.8) return null;
  const palmScale = palm;

  const extended = base => straight(points[base], points[base + 1], points[base + 3]) &&
    dist2D(points[base + 3], points[base]) > dist2D(points[base + 1], points[base]) * 1.32 &&
    dist2D(points[base + 3], points[0]) > dist2D(points[base + 1], points[0]) * 1.05;
  const index = extended(5), middle = extended(9), ring = extended(13), pinky = extended(17);
  const ratio = tip => dist2D(points[4], points[tip]) / palm;
  const dIndex = ratio(8);
  const dMiddle = ratio(12);
  const dRing = ratio(16);
  const dPinky = ratio(20);
  const dTwoFinger = dist2D(points[8], points[12]) / palm;

  // Clenched fingers count: fingers curled tightly into palm
  const clenchedCount = [8, 12, 16, 20].filter(tip => dist2D(points[tip], points[0]) < palm * 1.05).length;

  const wasScrolling = previousPinch === 'scroll';
  const wasThumbDown = previousPinch === 'left' || previousPinch === 'both';
  const wasPinkyDown = previousPinch === 'right' || previousPinch === 'both';

  // === INTRINSIC PALM COORDINATE BASIS (3D 손바닥 고유 정규직교기저) ===
  // vHat: 손목(0) -> 중지 너클(9) 원위 축 (+v = 손가락 펴짐, -v = 손목/손바닥 방향 말림)
  // uHat: 소지 너클(17) -> 검지 너클(5) 가로 축 (해부학적으로 언제나 엄지 쪽 Radial 방향)
  //       그람-슈미트 직교화: u = u_raw - (u_raw · v)v 로 완벽한 90도 직교 가로축 생성
  const vx = points[9].x - points[0].x, vy = points[9].y - points[0].y;
  const vLen = Math.hypot(vx, vy) || 1e-5;
  const vHatX = vx / vLen, vHatY = vy / vLen;

  const ax = points[5].x - points[17].x, ay = points[5].y - points[17].y;
  const aDotV = ax * vHatX + ay * vHatY;
  const ux = ax - aDotV * vHatX, uy = ay - aDotV * vHatY;
  const uLen = Math.hypot(ux, uy) || 1e-5;
  const uHatX = ux / uLen, uHatY = uy / uLen;

  // Zero-GC 스칼라 인라인 내적 및 Z-Damping 거리 계산 함수
  const projV = (a, b) => ((a.x - b.x) * vHatX + (a.y - b.y) * vHatY) / palm;
  const projU = (a, b) => ((a.x - b.x) * uHatX + (a.y - b.y) * uHatY) / palm;
  const distZDamped = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, ((a.z ?? 0) - (b.z ?? 0)) * 0.45);

  // Multi-angle finger extension helper for Trigger mode:
  // 너클(MCP)을 로컬 원점으로 삼아, 끝점(Tip)이 첫 마디(PIP)보다 +v 방향으로 앞서 전진했는가를 검증
  const fingerOpen2D = (base, isHold = false) => {
    const dvMCP = projV(points[base + 3], points[base]);
    const dvPIP = projV(points[base + 3], points[base + 1]);
    const cosWristMCP = cos2D(points[0], points[base], points[base + 3]);
    const forwardFromWrist = dvMCP > (isHold ? 0.04 : 0.16) && dvPIP > (isHold ? -0.02 : 0.02) && cosWristMCP < (isHold ? 0.05 : -0.15);
    const minCos = isHold ? -0.15 : -0.38;
    const minReach = isHold ? 1.12 : 1.26;
    const uncurled = cos2D(points[base], points[base + 1], points[base + 3]) < minCos &&
      dist2D(points[base + 3], points[base]) > dist2D(points[base + 1], points[base]) * minReach;
    return forwardFromWrist && (uncurled || extended(base));
  };

  const indexOpen = pointerMode === 'trigger' ? fingerOpen2D(5, wasScrolling) : index;
  const middleOpen = pointerMode === 'trigger' ? fingerOpen2D(9, wasScrolling) : middle;
  const ringOpen = pointerMode === 'trigger' ? fingerOpen2D(13, false) : ring;

  // In index-like modes, index finger aiming away from knuckle
  const indexAiming = pointerMode === 'trigger'
    ? indexOpen
    : (indexOpen && (dist2D(points[8], points[5]) > dist2D(points[6], points[5]) * 1.32 || dist2D(points[8], points[0]) > palm * 1.05));

  // V-sign posture: In Trigger Mode, anytime Index + Middle are both extended forward, engage V-sign scroll!
  const vSignPosture = pointerMode === 'trigger'
    ? (indexOpen && middleOpen)
    : (indexAiming && middleOpen && !ringOpen);

  const middleRaised = middleOpen;

  // V-sign scroll: Index + Middle raised. 100% decoupled from thumb!
  const isVSignScroll = allowVScroll && vSignPosture;

  // 3. Thumb Extension (엄지가위 👆+👍 - Left Click):
  //    그람-슈미트 직교계(uHat, vHat)와 검지 첫 마디(LM 6) 3D 유클리드 거리로 주먹 접힘 100% 차단
  const thCos234 = cos2D(points[2], points[3], points[4]);
  const thCos124 = cos2D(points[1], points[2], points[4]);
  const dThumbMCP = distZDamped(points[4], points[2]) / palm;
  const dThumbBase5 = distZDamped(points[4], points[5]) / palm;
  const dThumbBase6 = distZDamped(points[4], points[6]) / palm;
  const dThumbBase9 = distZDamped(points[4], points[9]) / palm;
  const d3ThumbWrist = distZDamped(points[4], points[0]) / palm;
  const d3ThumbIndexMCP = dThumbBase5;
  const d3ThumbToKnuckles = Math.min(dThumbBase5, dThumbBase9);

  // Radial outward abduction along +uHat:
  // 엄지가 펴지면 ("엄지가위") 3->4 벡터가 +uHat(방사 외측) 방향으로 강하게 전개됨
  // 주먹 위로 엄지가 접히면 3->4 벡터가 -uHat(안쪽) 또는 LM 6에 바짝 붙음
  const len34 = Math.max(1e-5, dist2D(points[4], points[3]));
  const radialDir34 = ((points[4].x - points[3].x) * uHatX + (points[4].y - points[3].y) * uHatY) / len34;
  const radial24 = projU(points[4], points[2]);
  const thOut9 = dist2D(points[4], points[9]) / Math.max(1e-5, dist2D(points[3], points[9]));

  const thStraight = thCos234 < (wasThumbDown ? -0.40 : -0.55) && thCos124 < (wasThumbDown ? -0.40 : -0.55);
  const thAbducted = radialDir34 > (wasThumbDown ? 0.22 : 0.35) &&
                     radial24 > (wasThumbDown ? 0.15 : 0.19) &&
                     thOut9 > (wasThumbDown ? 1.08 : 1.15);
  const thReach = dThumbMCP > (wasThumbDown ? 0.30 : 0.34);
  const thClearance = dThumbBase5 > (wasThumbDown ? 0.25 : 0.29) &&
                      dThumbBase6 > (wasThumbDown ? 0.26 : 0.32) &&
                      dThumbBase9 > (wasThumbDown ? 0.36 : 0.42);

  const thumbExtended = !isVSignScroll && thStraight && thAbducted && thReach && thClearance;

  // 4. Pinky Extension (우클릭 - Right Click):
  //    소지 직선도, 약지 대비 독립 전개량(pkVsRing), 약지 끝(16)과의 이격 거리 검증
  const dPinkyMCP = distZDamped(points[20], points[17]) / palm;
  const dPinkyWrist = distZDamped(points[20], points[0]) / palm;
  const d3PinkyMCP = dPinkyMCP;
  const d3PinkyWrist = dPinkyWrist;
  const pkCos = cos2D(points[17], points[18], points[20]);
  const pkCosDIP = cos2D(points[18], points[19], points[20]);
  const pkVsRing = dist2D(points[20], points[17]) / Math.max(1e-5, dist2D(points[16], points[13]));
  const dPinkyRingTip = distZDamped(points[20], points[16]) / palm;
  const pinkyStraight = pkCos < -0.45 && pkCosDIP < -0.40;

  const pinkyExtended = !isVSignScroll && (
    wasPinkyDown
      ? (pkCos < -0.32 && pkCosDIP < -0.28 && dPinkyMCP > 0.38 && pkVsRing > 1.18 && dPinkyRingTip > 0.28)
      : (pkCos < -0.48 && pkCosDIP < -0.40 && dPinkyMCP > 0.45 && pkVsRing > 1.32 && dPinkyRingTip > 0.34)
  );

  const triggerAllFourFolded = !indexAiming && !middleRaised && !pinkyExtended;
  const isFist = pointerMode === 'trigger'
    ? (triggerAllFourFolded && !thumbExtended)
    : pointerMode === 'index'
    ? (!indexAiming || clenchedCount >= 4)
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
  let gates = null;

  if (pointerMode === 'trigger') {
    // === PARADIGM B: INDEPENDENT FINGER TRIGGER / EXTENSION MODE ===
    // 1. Pointer: Index Tip (LM 8). When index curls/folds, pointer FREEZES at last valid location.
    // 2. Left Click: Thumb (LM 4) extended outwards.
    // 3. Right Click: Pinky (LM 20) extended outwards.
    // 4. Simultaneous Click: Thumb + Pinky both extended.
    // 5. Scroll: Index + Middle extended (✌️ V-sign), with Thumb and Pinky folded.
    // 6. Rest: Complete 5-finger fist (all 4 fingers curled AND thumb not extended).

    // V-sign scroll: Middle tip raised with Index aiming (100% independent)
    const isScrollGesture = isVSignScroll;

    const canPressLeft = !isFist && !isScrollGesture && thumbExtended;
    const canPressRight = !isFist && !isScrollGesture && pinkyExtended;

    if (isFist) {
      mode = 'idle';
      pinch = null;
    } else if (isScrollGesture) {
      mode = 'scroll';
      pinch = null;
    } else if (canPressLeft && canPressRight) {
      mode = 'both';
      pinch = 'both';
    } else if (canPressLeft) {
      mode = 'left';
      pinch = 'left';
    } else if (canPressRight) {
      mode = 'right';
      pinch = 'right';
    } else if (!indexAiming) {
      mode = 'frozen';
      pinch = null;
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

    gates = {
      isFist,
      isScrollGesture,
      indexAiming,
      indexFolded: !indexAiming,
      canPressLeft,
      canPressRight,
      thumbExtended,
      pinkyExtended,
      pinkyStraight,
      dThumbWrist: d3ThumbWrist,
      dThumbBase: d3ThumbIndexMCP,
      dPinkyWrist: d3PinkyWrist,
      dPinkyMCP: d3PinkyMCP,
      d3ThumbToKnuckles,
    };
  } else if (pointerMode === 'index') {
    // === ERGONOMIC PARADIGM: Absolute 1:1 Mapping + Pure Gesture 2 Scroll + Independent Clicks ===
    // 1. Pointer: Cursor follows Index Tip (LM 8) in absolute coordinates (100% coincident with AR HUD).
    // 2. Strict Gesture 2 (V-Sign): Index + Middle extended upwards, Ring + Pinky curled into palm, clean V gap.
    //    WHILE IN SCROLL: Left and Right clicks are 100% BLOCKED and suppressed!
    // 3. Left Click: Thumb (LM 4) + Middle (LM 12) pinch. Independent!
    // 4. Right Click: Thumb (LM 4) + Ring (LM 16) pinch. Independent!
    // 5. Simultaneous Click: If both touch thumb, BOTH left and right are active!
    // 6. Rest / Idle: Strictly Fist (주먹: all curled).

    // === SCROLL GESTURE: clean V-sign (✌️) only. Open palm is the natural relaxed pose, so it must stay "move". ===
    const isVSignScroll = allowVScroll &&
      index && middle && !ring && !pinky &&
      dist2D(points[16], points[0]) < palm * 1.10 &&
      dist2D(points[20], points[0]) < palm * 1.10 &&
      dTwoFinger > 0.16 &&
      dMiddle > 0.40 && dRing > 0.40 && dIndex > 0.40;

    const isScrollGesture = isVSignScroll;

    // Intentional Pinch Stance: Clicks ONLY allowed when index is actively aiming and not scrolling
    const canClick = !isFist && !isScrollGesture && indexAiming;

    // Middle tip must be elevated/extended for an intentional pinch, not curled into palm
    const middlePinching = dist2D(points[12], points[0]) > palm * 0.88 && dist2D(points[4], points[0]) > palm * 0.60;
    const isLeft = canClick && middlePinching && dMiddle < 0.25;

    // Ring tip must be elevated/extended for an intentional pinch, not curled into palm
    const ringPinching = dist2D(points[16], points[0]) > palm * 0.85 && dist2D(points[4], points[0]) > palm * 0.60;
    const isRight = canClick && ringPinching && dRing < 0.25;

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
    gates = {isFist, isScrollGesture, canPressLeft: isLeft, canPressRight: isRight};
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

  let fingertips;
  if (pointerMode === 'trigger') {
    fingertips = {
      index: {x: points[8].x, y: points[8].y, visible: true, frozen: Boolean(gates?.indexFolded)},
      thumb: {x: points[4].x, y: points[4].y, visible: Boolean(gates?.thumbExtended), active: Boolean(gates?.canPressLeft)},
      middle: {x: points[12].x, y: points[12].y, visible: Boolean(gates?.isScrollGesture), active: Boolean(gates?.isScrollGesture)},
      ring: {x: points[16].x, y: points[16].y, visible: false, active: false},
      pinky: {x: points[20].x, y: points[20].y, visible: Boolean(gates?.pinkyExtended), active: Boolean(gates?.canPressRight)},
      wrist: {x: points[0].x, y: points[0].y, visible: true},
    };
  } else if (pointerMode === 'index') {
    const isFist = gates?.isFist;
    const middleActive = dist2D(points[12], points[0]) > palm * 0.88;
    const ringActive = dist2D(points[16], points[0]) > palm * 0.85;
    const pinkyActive = dist2D(points[20], points[0]) > palm * 0.85;
    const thumbActive = dist2D(points[4], points[0]) > palm * 0.60 && !isFist;

    fingertips = {
      index: {x: points[8].x, y: points[8].y, visible: indexAiming},
      thumb: {x: points[4].x, y: points[4].y, visible: thumbActive},
      middle: {x: points[12].x, y: points[12].y, visible: middleActive},
      ring: {x: points[16].x, y: points[16].y, visible: ringActive},
      pinky: {x: points[20].x, y: points[20].y, visible: pinkyActive},
      wrist: {x: points[0].x, y: points[0].y, visible: true},
    };
  } else {
    fingertips = {
      index: {x: points[8].x, y: points[8].y, visible: true},
      thumb: {x: points[4].x, y: points[4].y, visible: true},
      middle: {x: points[12].x, y: points[12].y, visible: true},
      ring: {x: points[16].x, y: points[16].y, visible: true},
      pinky: {x: points[20].x, y: points[20].y, visible: true},
      wrist: {x: points[0].x, y: points[0].y, visible: true},
    };
  }

  const unpinched = (pointerMode === 'index' || pointerMode === 'trigger')
    ? (pinch === null)
    : (dIndex >= 0.44 && dMiddle >= 0.44);

  return {mode, pinch, anchor, gates, vScroll: isSmartphoneScroll, dIndex, dMiddle, dRing, dPinky, dTwoFinger, palm, fingertips, activePos, unpinched};
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
    this.euroThumbX = new OneEuroFilter({minCutoff: 0.35, beta: 8.0});
    this.euroThumbY = new OneEuroFilter({minCutoff: 0.35, beta: 8.0});
    this.euroMiddleX = new OneEuroFilter({minCutoff: 0.35, beta: 8.0});
    this.euroMiddleY = new OneEuroFilter({minCutoff: 0.35, beta: 8.0});
    this.euroRingX = new OneEuroFilter({minCutoff: 0.35, beta: 8.0});
    this.euroRingY = new OneEuroFilter({minCutoff: 0.35, beta: 8.0});
    this.euroPinkyX = new OneEuroFilter({minCutoff: 0.35, beta: 8.0});
    this.euroPinkyY = new OneEuroFilter({minCutoff: 0.35, beta: 8.0});
    this.lastEmittedU = null;
    this.lastEmittedV = null;
    this.lockPos = null;
    this.frozenU = null;
    this.frozenV = null;
    this.lastAimU = null;
    this.lastAimV = null;
    this.lastStableU = null;
    this.lastStableV = null;
    this.aimHistory = [];
    this.scrollAnchorX = null;
    this.scrollAnchorY = null;
    this.scrollVelocity = 0;
    this.scrollDown = false;
    this.scrollReleaseCount = 0;
    this.fistFrames = 0;
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
    this.scrollFrames = 0;
    this.leftReleaseCount = 0;
    this.rightReleaseCount = 0;
    this.lastFingertips = null;
    this.lastActivePos = null;
    this.lastValidAt = null;
    this.euroU?.reset();
    this.euroV?.reset();
    this.euroThumbX?.reset();
    this.euroThumbY?.reset();
    this.euroMiddleX?.reset();
    this.euroMiddleY?.reset();
    this.euroRingX?.reset();
    this.euroRingY?.reset();
    this.euroPinkyX?.reset();
    this.euroPinkyY?.reset();
    this.lastEmittedU = null;
    this.lastEmittedV = null;
    this.lockPos = null;
    this.frozenU = null;
    this.frozenV = null;
    this.lastAimU = null;
    this.lastAimV = null;
    this.lastStableU = null;
    this.lastStableV = null;
    this.aimHistory = [];
    this.scrollAnchorX = null;
    this.scrollAnchorY = null;
    this.scrollVelocity = 0;
    this.fistFrames = 0;
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
    this.scrollFrames = 0;
    this.leftReleaseCount = 0;
    this.rightReleaseCount = 0;
    this.euroU?.reset();
    this.euroV?.reset();
    this.euroThumbX?.reset();
    this.euroThumbY?.reset();
    this.euroMiddleX?.reset();
    this.euroMiddleY?.reset();
    this.euroRingX?.reset();
    this.euroRingY?.reset();
    this.euroPinkyX?.reset();
    this.euroPinkyY?.reset();
    this.lastEmittedU = null;
    this.lastEmittedV = null;
    this.lockPos = null;
    this.scrollAnchorX = null;
    this.scrollAnchorY = null;
    this.scrollVelocity = 0;
    this.fistFrames = 0;
    if (disarm) {
      this.armed = false;
      this.frozenU = null;
      this.frozenV = null;
      this.lastAimU = null;
      this.lastAimV = null;
    }
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
    const isIndexLike = this.pointerMode === 'index' || this.pointerMode === 'trigger';
    const observed = quality === true ? observation(landmarks, width, height, this.pinch, this.vScroll, this.pointerMode) : null;
    if (!observed) {
      // Index/Trigger mode: a few dropped/poor frames must not break an ongoing drag.
      if (isIndexLike && (this.leftDown || this.rightDown) &&
          this.lastValidAt !== null && now - this.lastValidAt < 300) {
        return this.state('holding');
      }
      this.lastHand = null;
      this.lastFingertips = this.lastActivePos = null;
      return this.interrupt('invalid');
    }
    this.lastValidAt = now;
    if (isIndexLike && observed.fingertips) {
      const thm = observed.fingertips.thumb;
      const mid = observed.fingertips.middle;
      const rng = observed.fingertips.ring;
      const pnk = observed.fingertips.pinky;
      const idx = observed.fingertips.index;
      this.lastFingertips = {
        index: idx ? {x: idx.x, y: idx.y, visible: idx.visible, frozen: Boolean(idx.frozen)} : null,
        thumb: thm ? {x: this.euroThumbX.filter(thm.x, now), y: this.euroThumbY.filter(thm.y, now), visible: thm.visible, active: Boolean(thm.active)} : null,
        middle: mid ? {x: this.euroMiddleX.filter(mid.x, now), y: this.euroMiddleY.filter(mid.y, now), visible: mid.visible, active: Boolean(mid.active)} : null,
        ring: rng ? {x: this.euroRingX.filter(rng.x, now), y: this.euroRingY.filter(rng.y, now), visible: rng.visible, active: Boolean(rng.active)} : null,
        pinky: pnk ? {x: this.euroPinkyX.filter(pnk.x, now), y: this.euroPinkyY.filter(pnk.y, now), visible: pnk.visible, active: Boolean(pnk.active)} : null,
        wrist: observed.fingertips.wrist,
      };
    } else {
      this.lastFingertips = observed.fingertips;
    }
    this.lastActivePos = observed.activePos;
    // Index/Trigger mode uses absolute mapping, so MediaPipe handedness flicker must not reset a drag.
    const changedHand = !isIndexLike && handedness && this.lastHand && handedness !== this.lastHand;
    this.lastHand = handedness;
    if (gap || changedHand) return this.interrupt('tracking-reset');

    const dIndex = observed.dIndex ?? 1.0;
    const indexVelocity = (this.lastDIndex !== null && Number.isFinite(now) && !gap)
      ? (dIndex - this.lastDIndex)
      : 0;
    this.lastDIndex = dIndex;

    const events = [];

    if (this.pointerMode === 'trigger') {
      // === PARADIGM B: INDEPENDENT FINGER TRIGGER / EXTENSION MODE ===
      // 1. Pointer: Index Tip (LM 8). When index curls/folds, pointer FREEZES at last valid location.
      // 2. Left Click: Thumb (LM 4) extended outwards. Hold = Drag. Fold = Release.
      // 3. Right Click: Pinky (LM 20) extended outwards. Hold = Right Down. Fold = Release.
      // 4. Simultaneous Click: Thumb + Pinky both extended.
      // 5. Scroll: Index + Middle extended (✌️ V-sign), with Thumb and Pinky folded.
      // 6. Rest: Complete 5-finger fist (all 4 fingers curled AND thumb not extended).
      const g = observed.gates;

      // Scroll (✌️ V-sign trigger): Middle tip raised engages wheel continuously
      if (g.isScrollGesture) {
        if (this.leftDown) {
          this.leftDown = false;
          this.leftReleaseCount = 0;
          events.push({type: 'button', button: 'left', down: false});
        }
        if (this.rightDown) {
          this.rightDown = false;
          this.rightReleaseCount = 0;
          events.push({type: 'button', button: 'right', down: false});
        }
        this.scrollDown = true;
        this.scrollReleaseCount = 0;
        this.scrollFrames = 0;
      } else if (this.scrollDown) {
        if (g.isFist || ++this.scrollReleaseCount >= 3) {
          this.scrollDown = false;
          this.scrollReleaseCount = 0;
          this.scrollFrames = 0;
        }
      }
      const scrolling = this.scrollDown;

      // Left Click (Thumb trigger): instant press, 2-frame debounced release
      if (this.leftDown) {
        if (!g.thumbExtended) {
          if (++this.leftReleaseCount >= 2) {
            this.leftDown = false;
            this.leftReleaseCount = 0;
            events.push({type: 'button', button: 'left', down: false});
          }
        } else this.leftReleaseCount = 0;
      } else if (g.canPressLeft && !scrolling) {
        this.leftDown = true;
        this.leftReleaseCount = 0;
        this.dragDisplacement = 0;
        this.dragUnlocked = false;
        this.lockPos = null;
        events.push({type: 'button', button: 'left', down: true});
      }

      // Right Click (Pinky trigger): instant press, 2-frame debounced release
      if (this.rightDown) {
        if (!g.pinkyExtended) {
          if (++this.rightReleaseCount >= 2) {
            this.rightDown = false;
            this.rightReleaseCount = 0;
            events.push({type: 'button', button: 'right', down: false});
          }
        } else this.rightReleaseCount = 0;
      } else if (g.canPressRight && !scrolling) {
        this.rightDown = true;
        this.rightReleaseCount = 0;
        events.push({type: 'button', button: 'right', down: true});
      }

      if (scrolling) {
        this.mode = 'scroll';
        this.fistFrames = 0;
      } else if (this.leftDown && this.rightDown) {
        this.mode = 'both';
        this.fistFrames = 0;
      } else if (this.leftDown) {
        this.mode = 'left';
        this.fistFrames = 0;
      } else if (this.rightDown) {
        this.mode = 'right';
        this.fistFrames = 0;
      } else if (g.indexFolded) {
        if (g.isFist) {
          if (this.mode === 'idle' || ++this.fistFrames >= 4) {
            this.mode = 'idle';
          } else {
            this.mode = 'frozen';
          }
        } else {
          this.mode = 'frozen';
          this.fistFrames = 0;
        }
      } else {
        this.mode = 'move';
        this.fistFrames = 0;
      }
      this.pinch = scrolling ? 'scroll' : (this.mode === 'both' || this.mode === 'left' || this.mode === 'right' ? this.mode : null);

      // While held, keep corresponding fingertip visible and active on HUD
      if (this.lastFingertips) {
        if (this.leftDown && this.lastFingertips.thumb) {
          this.lastFingertips.thumb.visible = true;
          this.lastFingertips.thumb.active = true;
        }
        if (this.rightDown && this.lastFingertips.pinky) {
          this.lastFingertips.pinky.visible = true;
          this.lastFingertips.pinky.active = true;
        }
      }

      if (this.mode === 'idle') {
        const result = this.interrupt('ready', false);
        result.events.unshift(...events);
        return result;
      }

      // Pointer coordinate calculation & freeze
      let filtU, filtV;
      if (g.indexFolded) {
        // Index is folded: hold cursor strictly at the last known aim coordinate
        filtU = this.lastAimU ?? this.frozenU ?? this.lastEmittedU ?? 0.5;
        filtV = this.lastAimV ?? this.frozenV ?? this.lastEmittedV ?? 0.5;
        this.frozenU = filtU;
        this.frozenV = filtV;
      } else {
        const rawU = observed.activePos.x;
        const rawV = observed.activePos.y;
        filtU = this.euroU.filter(rawU, now);
        filtV = this.euroV.filter(rawV, now);

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

        // Stationary Tremor Gate (Deadband)
        if (this.lastEmittedU !== null && this.lastEmittedV !== null) {
          const deltaPx = Math.hypot((filtU - this.lastEmittedU) * 1920, (filtV - this.lastEmittedV) * 1080);
          if (deltaPx < 2.5 && !this.leftDown) {
            filtU = this.lastEmittedU;
            filtV = this.lastEmittedV;
          }
        }
        this.lastEmittedU = filtU;
        this.lastEmittedV = filtV;
        this.lastAimU = filtU;
        this.lastAimV = filtV;
        this.frozenU = filtU;
        this.frozenV = filtV;
      }

      observed.activePos.x = clamp(Number(filtU.toFixed(4)), 0, 1);
      observed.activePos.y = clamp(Number(filtV.toFixed(4)), 0, 1);

      if (this.mode === 'scroll') {
        // === RATE-BASED AUTO-SCROLL ANCHOR (휠클릭 자동 스크롤 모드) ===
        if (this.scrollAnchorY === null) {
          this.scrollAnchorY = observed.anchor.y;
          this.scrollAnchorX = observed.anchor.x;
          this.remaining.y = 0;
        }
        const anchorY = this.scrollAnchorY;
        const offsetY = observed.anchor.y - anchorY;
        const DEADZONE = 0.012; // ±12px deadzone around center anchor
        let velocity = 0;
        if (Math.abs(offsetY) > DEADZONE) {
          const delta = offsetY > 0 ? (offsetY - DEADZONE) : (offsetY + DEADZONE);
          velocity = delta * this.sensitivity * 0.45;
        }
        this.scrollVelocity = velocity;

        if (Math.abs(velocity) > 0.01) {
          this.remaining.y += velocity;
          const wheel = clamp(Math.trunc(this.remaining.y / 4) * 4, -120, 120);
          if (wheel) {
            events.push({type: 'scroll', dy: wheel});
            this.remaining.y = clamp(this.remaining.y - wheel, -3.999, 3.999);
          }
        }
      } else {
        this.scrollAnchorY = null;
        this.scrollAnchorX = null;
        this.scrollVelocity = 0;
        this.lastTouchY = null;
        events.push({type: 'moveTo', x: observed.activePos.x, y: observed.activePos.y});
      }

      return this.state('active', events, 1, {
        fingertips: this.lastFingertips,
        activePos: observed.activePos,
        dIndex: observed.dIndex,
        dMiddle: observed.dMiddle,
        dRing: observed.dRing,
        dPinky: observed.dPinky,
        dTwoFinger: observed.dTwoFinger,
        scrollAnchor: this.scrollAnchorY !== null ? {x: this.scrollAnchorX, y: this.scrollAnchorY} : null,
        scrollVelocity: this.scrollVelocity || 0,
      });
    } else if (this.pointerMode === 'index') {
      // === ERGONOMIC INDEX MODE: Absolute 1:1 Pointer + Debounced Sticky Buttons ===
      // Press: instant when the gate says the fingers touch (keeps native double-click fast).
      // Hold: once pressed, posture changes (index bending, fist detection, finger leaving HUD)
      //       NEVER release the button. Only a clear finger separation for RELEASE_FRAMES does.
      const g = observed.gates;
      const RELEASE_RATIO = 0.42;
      const RELEASE_FRAMES = 2;

      // Scroll requires a stable V-sign for 3 frames and can never start while a button is held.
      if (g.isScrollGesture && !this.leftDown && !this.rightDown) this.scrollFrames++;
      else this.scrollFrames = 0;
      const scrolling = this.scrollFrames >= 3;

      if (this.leftDown) {
        if (observed.dMiddle > RELEASE_RATIO) {
          if (++this.leftReleaseCount >= RELEASE_FRAMES) {
            this.leftDown = false;
            this.leftReleaseCount = 0;
            events.push({type: 'button', button: 'left', down: false});
          }
        } else this.leftReleaseCount = 0;
      } else if (g.canPressLeft && !scrolling) {
        this.leftDown = true;
        this.leftReleaseCount = 0;
        this.dragDisplacement = 0;
        this.dragUnlocked = false;
        this.lockPos = null;
        events.push({type: 'button', button: 'left', down: true});
      }

      if (this.rightDown) {
        if (observed.dRing > RELEASE_RATIO) {
          if (++this.rightReleaseCount >= RELEASE_FRAMES) {
            this.rightDown = false;
            this.rightReleaseCount = 0;
            events.push({type: 'button', button: 'right', down: false});
          }
        } else this.rightReleaseCount = 0;
      } else if (g.canPressRight && !scrolling) {
        this.rightDown = true;
        this.rightReleaseCount = 0;
        events.push({type: 'button', button: 'right', down: true});
      }

      if (scrolling) this.mode = 'scroll';
      else if (this.leftDown && this.rightDown) this.mode = 'both';
      else if (this.leftDown) this.mode = 'left';
      else if (this.rightDown) this.mode = 'right';
      else if (g.isFist) this.mode = 'idle';
      else this.mode = 'move';
      this.pinch = this.mode === 'both' || this.mode === 'left' || this.mode === 'right' ? this.mode : null;

      // While a button is held, keep the touching finger visible on the HUD even if it curls.
      if (this.lastFingertips) {
        if (this.leftDown && this.lastFingertips.middle) this.lastFingertips.middle.visible = true;
        if (this.rightDown && this.lastFingertips.ring) this.lastFingertips.ring.visible = true;
        if ((this.leftDown || this.rightDown) && this.lastFingertips.thumb) this.lastFingertips.thumb.visible = true;
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
        fingertips: this.lastFingertips,
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
