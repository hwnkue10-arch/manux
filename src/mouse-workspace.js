import {RawTemporalRecorder} from './recorder/raw-temporal-recorder.js';
import {AirMouseController} from './air-mouse-controller.js';

const LANDMARK_NAMES = [
  'WRIST',
  'THUMB_CMC', 'THUMB_MCP', 'THUMB_IP', 'THUMB_TIP',
  'INDEX_FINGER_MCP', 'INDEX_FINGER_PIP', 'INDEX_FINGER_DIP', 'INDEX_FINGER_TIP',
  'MIDDLE_FINGER_MCP', 'MIDDLE_FINGER_PIP', 'MIDDLE_FINGER_DIP', 'MIDDLE_FINGER_TIP',
  'RING_FINGER_MCP', 'RING_FINGER_PIP', 'RING_FINGER_DIP', 'RING_FINGER_TIP',
  'PINKY_MCP', 'PINKY_PIP', 'PINKY_DIP', 'PINKY_TIP'
];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export class MouseWorkspace {
  constructor({root = document, bridge = globalThis.manuxDesktop} = {}) {
    this.root = root;
    this.bridge = bridge;
    this.$ = selector => root.querySelector(selector);

    const loadActiveZone = () => {
      try {
        const raw = localStorage.getItem('manux_active_zone');
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Number.isFinite(parsed.x) && Number.isFinite(parsed.y) && Number.isFinite(parsed.width) && Number.isFinite(parsed.height)) {
            return {
              x: clamp(parsed.x, 0, 0.75),
              y: clamp(parsed.y, 0, 0.75),
              width: clamp(parsed.width, 0.20, 0.95),
              height: clamp(parsed.height, 0.20, 0.95),
            };
          }
        }
      } catch {}
      return { x: 0.20, y: 0.15, width: 0.60, height: 0.55 };
    };

    this.activeZone = loadActiveZone();
    this.paused = false;

    // Pure unchanged AirMouseController instantiation
    const createController = () => {
      const sensitivity = Number(this.$('#mouse-sensitivity')?.value ?? 1800);
      const pointerMode = this.$('#mouse-pointer-mode')?.value ?? 'trigger';
      const ballistics = this.$('#mouse-ballistics') ? this.$('#mouse-ballistics').checked : true;
      const clickLock = this.$('#mouse-click-lock') ? this.$('#mouse-click-lock').checked : true;
      const crossView = this.$('#mouse-cross-view') ? this.$('#mouse-cross-view').checked : true;
      return new AirMouseController({
        pointerMode,
        sensitivity,
        smoothing: 0.70,
        ballistics,
        clickLock,
        vScroll: true,
        rotationDeg: crossView ? -22 : 0,
        gainY: crossView ? 2.2 : 1.0,
        activeZone: {
          x: this.activeZone.x,
          y: this.activeZone.y,
          w: this.activeZone.width,
          h: this.activeZone.height,
        },
      });
    };

    this.controller = createController();
    this.recorder = new RawTemporalRecorder();
    this.active = true;
    this.ready = false;
    this.enabled = false;
    this.available = false;
    this.overlayActive = false;
    this.generation = 0;
    this.pending = false;
    this.lastFrame = null;
    this.position = {x: 130, y: 110};

    this.overlayCanvas = this.$('#overlay-hud-canvas');
    this.overlayCtx = this.overlayCanvas?.getContext('2d');

    // UI event listeners
    this.$('#mouse-enabled')?.addEventListener('change', () => { void this.toggle(); });
    this.$('#mouse-stop')?.addEventListener('click', () => this.stop('마우스 제어를 껐습니다.'));
    this.$('#mouse-target')?.addEventListener('change', () => { this.stop(); this.renderTarget(); });

    // Direct launch into overlay mode
    this.$('#btn-start-air-mouse')?.addEventListener('click', async () => {
      if (!this.ready) {
        if (typeof window.startManuxCamera === 'function') {
          await window.startManuxCamera();
        }
      }
      if (!this.enabled) {
        const toggleEl = this.$('#mouse-enabled');
        if (toggleEl) toggleEl.checked = true;
        await this.toggle();
      }
      await this.toggleOverlay(true);
    });

    // Pause toggle in HUD
    this.$('#overlay-pause-btn')?.addEventListener('click', () => {
      this.togglePause();
    });

    // Pointer mode change if present
    this.$('#mouse-pointer-mode')?.addEventListener('change', () => {
      this.stop('추적 방식을 변경했습니다.');
      this.controller = createController();
      this.updateGuideCards();
    });

    const updateSettings = (msg) => {
      this.stop(msg);
      this.controller = createController();
      if (this.$('#mouse-sensitivity-output') && this.$('#mouse-sensitivity')) {
        this.$('#mouse-sensitivity-output').textContent = String(this.$('#mouse-sensitivity').value);
      }
    };
    this.$('#mouse-sensitivity')?.addEventListener('input', () => updateSettings('감도를 바꿨습니다. 제어를 다시 켜세요.'));
    this.$('#mouse-ballistics')?.addEventListener('change', () => updateSettings('포인터 가속도 설정을 바꿨습니다. 제어를 다시 켜세요.'));
    this.$('#mouse-click-lock')?.addEventListener('change', () => updateSettings('클릭 흔들림 방지 설정을 바꿨습니다. 제어를 다시 켜세요.'));
    this.$('#mouse-cross-view')?.addEventListener('change', () => updateSettings('Cross-View 대각선 보정 설정을 바꿨습니다. 제어를 다시 켜세요.'));

    // Active Zone Presets & Sliders
    this.$('#btn-zone-default')?.addEventListener('click', () => {
      this.setActiveZone({ x: 0.20, y: 0.15, width: 0.60, height: 0.55 });
    });
    this.$('#btn-zone-wide')?.addEventListener('click', () => {
      this.setActiveZone({ x: 0.15, y: 0.12, width: 0.70, height: 0.55 });
    });
    this.$('#btn-zone-compact')?.addEventListener('click', () => {
      this.setActiveZone({ x: 0.25, y: 0.18, width: 0.50, height: 0.45 });
    });

    const onZoneSliderInput = () => {
      const x = Number(this.$('#zone-x')?.value ?? 0.20);
      const y = Number(this.$('#zone-y')?.value ?? 0.15);
      const width = Number(this.$('#zone-width')?.value ?? 0.60);
      const height = Number(this.$('#zone-height')?.value ?? 0.55);
      this.setActiveZone({ x, y, width, height });
    };
    this.$('#zone-x')?.addEventListener('input', onZoneSliderInput);
    this.$('#zone-y')?.addEventListener('input', onZoneSliderInput);
    this.$('#zone-width')?.addEventListener('input', onZoneSliderInput);
    this.$('#zone-height')?.addEventListener('input', onZoneSliderInput);

    // Direct Interactive Drag & Resize on the Camera Preview Active Zone Box
    this.initInteractiveZone();

    // Overlay triggers
    this.$('#btn-enter-overlay')?.addEventListener('click', () => void this.toggleOverlay(true));
    this.$('#btn-quick-overlay')?.addEventListener('click', () => void this.toggleOverlay(!this.overlayActive));
    this.$('#overlay-exit-btn')?.addEventListener('click', () => void this.toggleOverlay(false));
    this.$('#overlay-stop-btn')?.addEventListener('click', () => {
      this.stop('마우스 제어를 껐습니다.');
      void this.toggleOverlay(false);
    });
    this.$('#overlay-pip-btn')?.addEventListener('click', () => {
      document.body.classList.toggle('show-pip');
    });

    const hudPill = this.$('#overlay-hud-pill');
    hudPill?.addEventListener('mouseenter', () => {
      if (this.overlayActive && this.bridge) this.bridge.setIgnoreMouse(false);
    });
    hudPill?.addEventListener('mouseleave', () => {
      if (this.overlayActive && this.bridge) this.bridge.setIgnoreMouse(true);
    });

    this.$('#btn-win-min')?.addEventListener('click', () => this.bridge?.minimize());
    this.$('#btn-win-max')?.addEventListener('click', () => this.bridge?.maximize());
    this.$('#btn-win-close')?.addEventListener('click', () => this.bridge?.close());

    this.$('#overlay-record-btn')?.addEventListener('click', () => {
      this.toggleRecording();
    });

    this.$('#overlay-dump-btn')?.addEventListener('click', () => {
      this.triggerDebugDump();
    });

    window.addEventListener('keydown', event => {
      if (event.key === 'F4') {
        event.preventDefault();
        this.triggerDebugDump();
      } else if (event.key === 'F8') {
        event.preventDefault();
        this.toggleRecording();
      } else if (event.key === 'F11') {
        event.preventDefault();
        void this.toggleOverlay(!this.overlayActive);
      } else if (event.key === 'Escape' && this.overlayActive) {
        event.preventDefault();
        void this.toggleOverlay(false);
      }
    });

    this.unsubscribe = bridge?.onStatus(status => {
      this.available = Boolean(status.available);
      if (this.enabled && !status.enabled && this.desktop) this.stop(status.error || 'Windows 마우스 제어가 중지되었습니다.');
      this.renderTarget();
      this.refresh();
      if (status.error && !this.enabled) this.status(status.error, true);
    });

    if (bridge) {
      bridge.getStatus().then(status => {
        this.available = Boolean(status.available);
        this.renderTarget();
        if (status.error) this.status(status.error, true);
      }).catch(error => this.status(`데스크톱 연결 실패: ${error.message}`, true));
    }

    this.watchdog = setInterval(() => {
      if (this.enabled && this.lastFrame !== null && performance.now() - this.lastFrame > 700) {
        this.stop('손 추적 응답이 멈춰 제어를 껐습니다. 카메라를 확인하고 다시 켜세요.');
      }
    }, 100);

    this.syncActiveZoneUI();
    this.updateGuideCards();
    this.renderTarget();
    this.refresh();
  }

  initInteractiveZone() {
    const zoneBox = this.$('#camera-active-zone');
    const cameraWrap = this.$('.camera-wrap');
    if (!zoneBox || !cameraWrap) return;

    let dragMode = null; // 'move' | 'tl' | 'tr' | 'bl' | 'br'
    let startX = 0, startY = 0;
    let initZone = null;

    zoneBox.addEventListener('pointerdown', e => {
      e.preventDefault();
      e.stopPropagation();
      const handle = e.target.dataset?.handle;
      dragMode = handle ? handle : 'move';
      startX = e.clientX;
      startY = e.clientY;
      initZone = {...this.activeZone};
      zoneBox.classList.add('dragging');
      zoneBox.setPointerCapture(e.pointerId);
    });

    zoneBox.addEventListener('pointermove', e => {
      if (!dragMode || !initZone) return;
      const rect = cameraWrap.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      const dx = (e.clientX - startX) / rect.width;
      const dy = (e.clientY - startY) / rect.height;

      let nextX = initZone.x;
      let nextY = initZone.y;
      let nextW = initZone.width;
      let nextH = initZone.height;

      if (dragMode === 'move') {
        nextX = clamp(initZone.x + dx, 0, 1 - initZone.width);
        nextY = clamp(initZone.y + dy, 0, 1 - initZone.height);
      } else if (dragMode === 'br') {
        nextW = clamp(initZone.width + dx, 0.20, 1 - initZone.x);
        nextH = clamp(initZone.height + dy, 0.20, 1 - initZone.y);
      } else if (dragMode === 'bl') {
        const right = initZone.x + initZone.width;
        nextX = clamp(initZone.x + dx, 0, right - 0.20);
        nextW = right - nextX;
        nextH = clamp(initZone.height + dy, 0.20, 1 - initZone.y);
      } else if (dragMode === 'tr') {
        const bottom = initZone.y + initZone.height;
        nextW = clamp(initZone.width + dx, 0.20, 1 - initZone.x);
        nextY = clamp(initZone.y + dy, 0, bottom - 0.20);
        nextH = bottom - nextY;
      } else if (dragMode === 'tl') {
        const right = initZone.x + initZone.width;
        const bottom = initZone.y + initZone.height;
        nextX = clamp(initZone.x + dx, 0, right - 0.20);
        nextW = right - nextX;
        nextY = clamp(initZone.y + dy, 0, bottom - 0.20);
        nextH = bottom - nextY;
      }

      this.setActiveZone({ x: nextX, y: nextY, width: nextW, height: nextH });
    });

    const endDrag = e => {
      if (dragMode) {
        dragMode = null;
        initZone = null;
        zoneBox.classList.remove('dragging');
        try {
          zoneBox.releasePointerCapture(e.pointerId);
        } catch {}
      }
    };

    zoneBox.addEventListener('pointerup', endDrag);
    zoneBox.addEventListener('pointercancel', endDrag);
  }

  setActiveZone(zone) {
    this.activeZone = {
      x: clamp(Number(zone.x) || 0, 0, 0.75),
      y: clamp(Number(zone.y) || 0, 0, 0.75),
      width: clamp(Number(zone.width) || 0.60, 0.20, 0.95),
      height: clamp(Number(zone.height) || 0.55, 0.20, 0.95),
    };
    this.controller?.setActiveZone({
      x: this.activeZone.x,
      y: this.activeZone.y,
      w: this.activeZone.width,
      h: this.activeZone.height,
    });
    try {
      localStorage.setItem('manux_active_zone', JSON.stringify(this.activeZone));
    } catch {}
    this.syncActiveZoneUI();
  }

  syncActiveZoneUI() {
    const box = this.$('#camera-active-zone');
    if (box) {
      box.style.left = `${(this.activeZone.x * 100).toFixed(1)}%`;
      box.style.top = `${(this.activeZone.y * 100).toFixed(1)}%`;
      box.style.width = `${(this.activeZone.width * 100).toFixed(1)}%`;
      box.style.height = `${(this.activeZone.height * 100).toFixed(1)}%`;
    }

    const setSlider = (id, val) => {
      const slider = this.$(id);
      if (slider) slider.value = String(val);
      const out = this.$(`${id}-output`);
      if (out) out.textContent = Math.round(val * 100) + '%';
    };
    setSlider('#zone-x', this.activeZone.x);
    setSlider('#zone-y', this.activeZone.y);
    setSlider('#zone-width', this.activeZone.width);
    setSlider('#zone-height', this.activeZone.height);
  }

  togglePause(paused = !this.paused) {
    this.paused = Boolean(paused);
    if (this.paused) {
      if (this.desktop && this.bridge) {
        this.bridge.send([{ type: 'release' }]);
      }
      this.controller.reset();
    }
    const pauseBtn = this.$('#overlay-pause-btn');
    if (pauseBtn) {
      pauseBtn.textContent = this.paused ? '▶️ 재개' : '⏸️ 일시 정지';
      pauseBtn.classList.toggle('active-pause', this.paused);
    }
    const badgeEl = this.$('#overlay-mode-badge');
    if (badgeEl && this.paused) {
      badgeEl.textContent = '⏸️ 일시 정지됨';
    }
    this.status(this.paused ? '⏸️ 마우스 제어가 일시 정지되었습니다. (재개 버튼 클릭)' : '마우스 제어를 재개했습니다.');
  }

  getModeLabel(mode) {
    if (this.paused) return '⏸️ 일시 정지';
    const pointerMode = this.controller?.pointerMode ?? 'trigger';
    if (pointerMode === 'trigger') {
      switch (mode) {
        case 'idle': return '쉬는 중 (주먹/휴식)';
        case 'move': return '👆 1: 포인터 이동 (검지)';
        case 'frozen': return '🔒 커서 고정 (엄지 펴서 클릭)';
        case 'left': return '👍 좌클릭 · 드래그 (엄지)';
        case 'right': return '🤙 우클릭 (새끼손가락)';
        case 'both': return '🤙 좌우 동시 클릭';
        case 'scroll': return '🖐️ 휠 스크롤 (손바닥/V자)';
        default: return '대기 중';
      }
    } else {
      switch (mode) {
        case 'idle': return '쉬는 중 (주먹/휴식)';
        case 'move': return '👆 포인터 이동';
        case 'left': return '🤏 좌클릭 · 드래그';
        case 'right': return '👆 우클릭';
        case 'scroll': return '🖐️ 휠 스크롤';
        default: return '대기 중';
      }
    }
  }

  updateGuideCards() {
    const articles = this.root.querySelectorAll('.mouse-guide article');
    if (articles.length >= 4) {
      const a1 = articles[0]?.querySelector('div');
      const a2 = articles[1]?.querySelector('div');
      const a3 = articles[2]?.querySelector('div');
      const a4 = articles[3]?.querySelector('div');
      if (a1) a1.innerHTML = '<h3>👆 1: 포인터 이동 (검지)</h3><p>검지 끝(LM 8) 직접 추적<br>검지를 접으면 그 자리에 커서 고정 (Freeze)</p>';
      if (a2) a2.innerHTML = '<h3>👍 엄지 펴기: 좌클릭 & 드래그</h3><p>엄지만 펴면 즉시 좌클릭 & 유지 시 드래그<br>검지 접고 엄지 펴면 흔들림 0% 정밀 클릭</p>';
      if (a3) a3.innerHTML = '<h3>🤙 소지 펴기: 우클릭</h3><p>새끼손가락(소지)만 펴면 우클릭<br>엄지와 소지를 같이 펴면 동시 클릭</p>';
      if (a4) a4.innerHTML = '<h3>🖐️ 손바닥 펴기: 휠 스크롤</h3><p>손바닥 활짝(🖐) 또는 V자(✌️) 펴고 위아래 이동 시 스크롤<br>주먹(✊) 쥐면 완전한 쉬는 자세</p>';
    }
  }

  get desktop() { return this.$('#mouse-target')?.value === 'desktop' || true; }
  get backgroundAllowed() { return (this.active || this.overlayActive) && this.enabled && this.available; }

  async toggleOverlay(active) {
    if (this.overlayActive === active) return;
    this.overlayActive = Boolean(active);
    document.body.classList.toggle('overlay-mode', this.overlayActive);

    const titlebarOverlayBtn = this.$('#btn-quick-overlay');
    if (titlebarOverlayBtn) {
      titlebarOverlayBtn.textContent = this.overlayActive ? '🖥️ 창 모드로 복귀 (Esc)' : '✨ 화면 투명 HUD 오버레이 (F11)';
    }

    if (this.bridge?.setOverlay) {
      try {
        await this.bridge.setOverlay(this.overlayActive);
      } catch (err) {
        console.error('Failed to set overlay:', err);
      }
    }

    if (this.overlayActive) {
      if (this.ready && !this.enabled) {
        const toggleEl = this.$('#mouse-enabled');
        if (toggleEl) toggleEl.checked = true;
        await this.toggle();
      }
      this.resizeOverlayCanvas();
    } else {
      if (this.overlayCtx && this.overlayCanvas) {
        this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
      }
    }
  }

  resizeOverlayCanvas() {
    if (!this.overlayCanvas) return;
    const w = window.innerWidth, h = window.innerHeight;
    if (this.overlayCanvas.width !== w || this.overlayCanvas.height !== h) {
      this.overlayCanvas.width = w;
      this.overlayCanvas.height = h;
    }
  }

  status(text, error = false) {
    const el = this.$('#mouse-status');
    if (el) { el.textContent = text; el.classList.toggle('error', error); }
    const titlebarStatus = this.$('#titlebar-status');
    if (titlebarStatus) {
      titlebarStatus.textContent = this.enabled ? '제어 중' : '대기';
      titlebarStatus.className = `status-pill ${this.enabled ? 'on' : error ? 'error' : ''}`;
    }
  }

  refresh() {
    const enabledEl = this.$('#mouse-enabled');
    if (enabledEl) {
      enabledEl.disabled = !this.active || !this.ready || this.pending || (this.desktop && !this.available);
      enabledEl.checked = this.enabled;
    }
    const targetEl = this.$('#mouse-target');
    if (targetEl) targetEl.disabled = this.pending;
  }

  renderTarget() {
    const option = this.$('#mouse-target option[value="desktop"]');
    if (option) {
      option.disabled = !this.available;
      option.textContent = this.available ? 'Windows 마우스' : 'Windows 마우스 · 데스크톱 앱 필요';
    }
  }

  setReady(ready) {
    this.ready = ready;
    if (!ready) this.stop('카메라를 시작한 뒤 마우스 제어를 켜세요.');
    else if (!this.enabled) this.status('준비됐습니다. [에어 마우스 시작] 버튼을 누르세요.');
    this.refresh();
  }

  setActive(active) {
    this.stop();
    this.active = active;
    this.refresh();
  }

  async toggle() {
    if (!this.$('#mouse-enabled')?.checked) { this.stop('마우스 제어를 껐습니다.'); return; }
    if (!this.ready || !this.active) { this.stop(); return; }
    const generation = ++this.generation;
    this.pending = true;
    this.refresh();
    try {
      if (this.desktop) {
        if (!this.available || !this.bridge) throw new Error('데스크톱 앱에서 실행하세요.');
        const status = await this.bridge.setEnabled(true);
        if (generation !== this.generation) { this.bridge.stop(); return; }
        if (!status.enabled) throw new Error(status.error || 'Windows 마우스 제어를 켜지 못했습니다.');
      }
      if (generation !== this.generation || !this.ready || !this.active) return;
      this.controller.reset();
      this.enabled = true;
      this.paused = false;
      this.lastFrame = performance.now();
      this.status('👆 검지로 포인터를 이동하세요. 엄지(좌클릭·드래그) · 소지(우클릭) · 🖐휠 스크롤입니다.');
    } catch (error) {
      this.stop(error.message);
    } finally {
      this.pending = false;
      this.refresh();
    }
  }

  stop(text) {
    this.generation++;
    this.enabled = false;
    this.lastFrame = null;
    this.controller.reset();
    this.bridge?.stop();
    const modeEl = this.$('#mouse-mode');
    if (modeEl) modeEl.textContent = '대기 중';
    const badgeEl = this.$('#overlay-mode-badge');
    if (badgeEl) badgeEl.textContent = '대기 중';
    this.root.querySelectorAll('[data-mouse-mode]').forEach(el => el.classList.remove('active'));
    this.refresh();
    if (text) this.status(text);
    if (this.overlayCtx && this.overlayCanvas) {
      this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    }
  }

  update({landmarks, now, quality, handedness, width, height, latency = 0}) {
    if (!this.active && !this.overlayActive) return null;
    if (this.enabled && latency > 450) this.stop('추적 지연이 높아 제어를 껐습니다. 해상도를 낮추고 다시 켜보세요.');

    // Cache frame diagnostics for F4 debug snapshot
    this.lastLandmarks = landmarks;
    this.lastDimensions = {width, height};
    this.lastLatency = latency;

    // Pure AirMouseController execution with activeZone natively applied
    const state = this.controller.update({landmarks, now, quality, handedness, width, height, enabled: this.enabled});
    this.lastMouseState = state;
    if (state?.gates) {
      this.lastGates = state.gates;
    }

    // Raw Temporal Recording (Zero overhead when not active)
    if (this.recorder?.recording) {
      this.recorder.recordFrame({
        timestamp: now,
        landmarks,
        quality,
        mode: this.controller?.pointerMode ?? 'trigger',
        geometryState: state,
        events: state?.events,
      });
    }

    if (this.enabled) {
      this.lastFrame = performance.now();
      if (!this.paused) {
        if (this.desktop) this.bridge?.send(state.events);
      }
      const hints = {
        'release-required': '손가락을 떼면 클릭을 다시 사용할 수 있습니다.',
        invalid: '손 전체가 카메라에 보이도록 해주세요.',
        holding: '손 모양을 확인하고 있습니다.',
        'tracking-reset': '손 위치를 다시 잡았습니다. 천천히 움직여주세요.',
      };
      if (this.paused) {
        this.status('⏸️ 마우스 제어가 일시 정지되었습니다. (재개 버튼 클릭)');
      } else {
        this.status(hints[state.phase] || (state.mode === 'idle' ? '쉬는 중입니다 (주먹/휴식).' : (state.mode === 'scroll' ? '🖐️ 휠 스크롤 중 · 손을 위아래로 그으세요.' : (state.mode === 'frozen' ? '🔒 커서 고정됨 · 엄지를 펴서 클릭하세요.' : `${this.getModeLabel(state.mode)} 중`))));
      }
    }

    const labelText = this.enabled ? this.getModeLabel(state.mode) : '대기 중';
    const modeEl = this.$('#mouse-mode');
    if (modeEl) modeEl.textContent = labelText;
    const badgeEl = this.$('#overlay-mode-badge');
    if (badgeEl) badgeEl.textContent = labelText;

    this.root.querySelectorAll('[data-mouse-mode]').forEach(el => el.classList.toggle('active', this.enabled && el.dataset.mouseMode === state.mode));

    // Render AR HUD points on overlay canvas
    if (this.overlayActive) {
      this.renderOverlayHUD(state);
    }

    return state;
  }

  renderOverlayHUD(state) {
    if (!this.overlayCtx || !this.overlayCanvas) return;
    this.resizeOverlayCanvas();
    const ctx = this.overlayCtx;
    const w = this.overlayCanvas.width;
    const h = this.overlayCanvas.height;
    ctx.clearRect(0, 0, w, h);

    if (!state?.fingertips) return;

    // Safety Gate: All reticles disappear completely in fist / rest
    if (state.mode === 'idle') return;

    // Active zone mapping to screen pixels
    const zone = this.activeZone || { x: 0.20, y: 0.15, width: 0.60, height: 0.55 };
    const mapPoint = pt => {
      const mirroredX = 1.0 - pt.x;
      const u = clamp((mirroredX - zone.x) / zone.width, 0, 1);
      const v = clamp((pt.y - zone.y) / zone.height, 0, 1);
      return {x: u * w, y: v * h};
    };

    const idx = (state.activePos && state.fingertips?.index && state.fingertips.index.visible !== false)
      ? { x: state.activePos.x * w, y: state.activePos.y * h }
      : (state.fingertips?.index && state.fingertips.index.visible !== false ? mapPoint(state.fingertips.index) : null);
    const thm = (state.fingertips?.thumb && state.fingertips.thumb.visible !== false) ? mapPoint(state.fingertips.thumb) : null;
    const mid = (state.fingertips?.middle && state.fingertips.middle.visible !== false) ? mapPoint(state.fingertips.middle) : null;
    const pnk = (state.fingertips?.pinky && state.fingertips.pinky.visible !== false) ? mapPoint(state.fingertips.pinky) : null;

    // 1. Index Reticle (LM 8): Active pointer or locked target
    if (idx) {
      ctx.save();
      const isFrozen = state.mode === 'frozen' || Boolean(state.fingertips?.index?.frozen);
      const isClicking = state.mode === 'left' || state.mode === 'both';
      ctx.fillStyle = isFrozen ? '#38bdf8' : (isClicking ? '#22c55e' : '#00f0ff');
      ctx.shadowColor = ctx.fillStyle;
      ctx.shadowBlur = 18;

      ctx.beginPath();
      ctx.arc(idx.x, idx.y, 6, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(idx.x, idx.y, 18, 0, Math.PI * 2);
      ctx.stroke();

      // Crosshair ticks
      const r1 = 12, r2 = 24;
      ctx.beginPath();
      ctx.moveTo(idx.x - r2, idx.y); ctx.lineTo(idx.x - r1, idx.y);
      ctx.moveTo(idx.x + r1, idx.y); ctx.lineTo(idx.x + r2, idx.y);
      ctx.moveTo(idx.x, idx.y - r2); ctx.lineTo(idx.x, idx.y - r1);
      ctx.moveTo(idx.x, idx.y + r1); ctx.lineTo(idx.x, idx.y + r2);
      ctx.stroke();

      ctx.font = 'bold 12px "Segoe UI", sans-serif';
      if (isFrozen) {
        ctx.fillText('🔒 고정됨 [LM8 LOCKED]', idx.x + 24, idx.y - 12);
      } else if (isClicking) {
        ctx.fillText('🎯 타겟 클릭 중', idx.x + 24, idx.y - 12);
      } else {
        ctx.fillText('INDEX [LM8]', idx.x + 24, idx.y - 12);
      }
      ctx.restore();
    }

    // 2. Thumb Trigger Beacon (LM 4 - Left Click / Drag)
    if (thm && state.fingertips?.thumb?.visible !== false) {
      ctx.save();
      const isLeft = state.mode === 'left' || state.mode === 'both' || Boolean(state.fingertips?.thumb?.active);
      ctx.fillStyle = '#f59e0b';
      ctx.shadowColor = '#f59e0b';
      ctx.shadowBlur = isLeft ? 22 : 12;
      ctx.beginPath();
      ctx.arc(thm.x, thm.y, isLeft ? 9 : 6, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = '#fef3c7';
      ctx.lineWidth = isLeft ? 3 : 2;
      ctx.beginPath();
      ctx.arc(thm.x, thm.y, isLeft ? 20 : 13, 0, Math.PI * 2);
      ctx.stroke();

      if (isLeft) {
        ctx.font = 'bold 13px "Segoe UI", sans-serif';
        ctx.fillText('👍 좌클릭 [LM4]', thm.x + 22, thm.y);
      }
      ctx.restore();
    }

    // 3. Pinky Trigger Beacon (LM 20 - Right Click)
    if (pnk && state.fingertips?.pinky?.visible !== false) {
      ctx.save();
      const isRight = state.mode === 'right' || state.mode === 'both' || Boolean(state.fingertips?.pinky?.active);
      ctx.fillStyle = '#6366f1';
      ctx.shadowColor = '#6366f1';
      ctx.shadowBlur = isRight ? 22 : 12;
      ctx.beginPath();
      ctx.arc(pnk.x, pnk.y, isRight ? 9 : 6, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = '#e0e7ff';
      ctx.lineWidth = isRight ? 3 : 2;
      ctx.beginPath();
      ctx.arc(pnk.x, pnk.y, isRight ? 20 : 13, 0, Math.PI * 2);
      ctx.stroke();

      if (isRight) {
        ctx.font = 'bold 13px "Segoe UI", sans-serif';
        ctx.fillText('🤙 우클릭 [LM20]', pnk.x + 22, pnk.y);
      }
      ctx.restore();
    }

    // 4. Scroll Anchor Compass & Velocity Beam (🖐️ / ✌️)
    if (state.mode === 'scroll') {
      ctx.save();
      const anchor = state.scrollAnchor ? mapPoint(state.scrollAnchor) : (idx ?? {x: w / 2, y: h / 2});
      const currentHand = (idx && mid) ? {x: (idx.x + mid.x) * 0.5, y: (idx.y + mid.y) * 0.5} : (idx ?? anchor);
      const vel = state.scrollVelocity ?? 0;

      ctx.fillStyle = 'rgba(192, 132, 252, 0.22)';
      ctx.strokeStyle = '#c084fc';
      ctx.lineWidth = 2.5;
      ctx.shadowColor = '#c084fc';
      ctx.shadowBlur = 18;
      ctx.beginPath();
      ctx.arc(anchor.x, anchor.y, 24, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(anchor.x, anchor.y, 4, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = vel < -0.1 ? '#a855f7' : 'rgba(255, 255, 255, 0.7)';
      ctx.beginPath();
      ctx.moveTo(anchor.x, anchor.y - 19);
      ctx.lineTo(anchor.x - 7, anchor.y - 10);
      ctx.lineTo(anchor.x + 7, anchor.y - 10);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = vel > 0.1 ? '#a855f7' : 'rgba(255, 255, 255, 0.7)';
      ctx.beginPath();
      ctx.moveTo(anchor.x, anchor.y + 19);
      ctx.lineTo(anchor.x - 7, anchor.y + 10);
      ctx.lineTo(anchor.x + 7, anchor.y + 10);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = 'rgba(192, 132, 252, 0.75)';
      ctx.lineWidth = 3;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(anchor.x, anchor.y);
      ctx.lineTo(currentHand.x, currentHand.y);
      ctx.stroke();

      ctx.font = 'bold 13px "Segoe UI", sans-serif';
      if (vel > 0.1) {
        ctx.fillStyle = '#c084fc';
        ctx.fillText(`▼ 아래로 스크롤 (${Math.min(100, Math.round(Math.abs(vel) * 22))}%)`, anchor.x + 34, anchor.y + 6);
      } else if (vel < -0.1) {
        ctx.fillStyle = '#c084fc';
        ctx.fillText(`▲ 위로 스크롤 (${Math.min(100, Math.round(Math.abs(vel) * 22))}%)`, anchor.x + 34, anchor.y + 6);
      } else {
        ctx.fillStyle = '#e9d5ff';
        ctx.fillText('🖐️ 스크롤 기준점 (위/아래 이동)', anchor.x + 34, anchor.y + 6);
      }
      ctx.restore();
    }
  }
  triggerDebugDump() {
    try {
      const now = new Date();
      const pad = n => String(n).padStart(2, '0');
      const timeStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const prefix = `manux_dump_${timeStr}`;

      const video = this.$('#camera') || document.querySelector('video');
      const lmCanvas = this.$('#landmarks') || document.querySelector('canvas#landmarks');

      // 1. Capture snapshot image (Webcam Video + Skeleton Canvas)
      let snapDataUrl = null;
      if (video && video.videoWidth > 0 && video.videoHeight > 0) {
        const snapCanvas = document.createElement('canvas');
        snapCanvas.width = video.videoWidth;
        snapCanvas.height = video.videoHeight;
        const sctx = snapCanvas.getContext('2d');
        try {
          sctx.drawImage(video, 0, 0, snapCanvas.width, snapCanvas.height);
          if (lmCanvas && lmCanvas.width > 0) {
            sctx.drawImage(lmCanvas, 0, 0, snapCanvas.width, snapCanvas.height);
          }
          snapDataUrl = snapCanvas.toDataURL('image/png');
        } catch (e) {
          console.warn('Canvas snapshot capture failed:', e);
        }
      }

      if (snapDataUrl) {
        const aImg = document.createElement('a');
        aImg.download = `${prefix}.png`;
        aImg.href = snapDataUrl;
        document.body.appendChild(aImg);
        aImg.click();
        document.body.removeChild(aImg);
      }

      // 2. Build structured JSON telemetry
      const dumpData = {
        timestamp: now.toISOString(),
        resolution: this.lastDimensions || {
          width: video?.videoWidth || 640,
          height: video?.videoHeight || 480
        },
        activeZone: this.activeZone,
        mouseState: {
          mode: this.lastMouseState?.mode || (this.enabled ? 'idle' : 'disabled'),
          cursorScreen: this.lastMouseState?.activePos || null,
          cursorDesktopPixels: this.lastMouseState?.activePos ? {
            x: Math.round(this.lastMouseState.activePos.x * (window.screen?.width || 1920)),
            y: Math.round(this.lastMouseState.activePos.y * (window.screen?.height || 1080))
          } : null,
          buttons: {
            left: Boolean(this.controller?.leftDown),
            right: Boolean(this.controller?.rightDown),
            scroll: this.lastMouseState?.mode === 'scroll',
          }
        },
        landmarks: (this.lastLandmarks || []).map((pt, idx) => ({
          id: idx,
          name: LANDMARK_NAMES[idx] || `POINT_${idx}`,
          x: Number(pt.x.toFixed(4)),
          y: Number(pt.y.toFixed(4)),
          z: Number((pt.z ?? 0).toFixed(4)),
        })),
        internalGates: this.lastGates || this.controller?.lastGates || {},
        screenshotFile: snapDataUrl ? `${prefix}.png` : null,
      };

      const jsonStr = JSON.stringify(dumpData, null, 2);
      const jsonBlob = new Blob([jsonStr], { type: 'application/json' });
      const jsonUrl = URL.createObjectURL(jsonBlob);
      const aJson = document.createElement('a');
      aJson.download = `${prefix}.json`;
      aJson.href = jsonUrl;
      document.body.appendChild(aJson);
      aJson.click();
      document.body.removeChild(aJson);
      URL.revokeObjectURL(jsonUrl);

      this.showToast('📸 F4 덤프 완료 (JSON + 스크린샷 저장됨)');
    } catch (err) {
      console.error('F4 dump failed:', err);
      this.status(`덤프 실패: ${err.message}`, true);
    }
  }

  showToast(messageText) {
    let toast = this.$('#manux-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'manux-toast';
      toast.className = 'manux-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = messageText;
    toast.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      toast.classList.remove('show');
    }, 2500);
  }
  startRecording() {
    const mode = this.controller?.pointerMode ?? 'trigger';
    const width = this.lastDimensions?.width || 640;
    const height = this.lastDimensions?.height || 480;
    const session = this.recorder.start({ mode, width, height });
    this.updateRecorderUI(true);
    this.showToast(`⏺️ 녹화 시작 (세션: ${session.sessionId.slice(-10)})`);
  }

  stopRecording() {
    if (!this.recorder?.recording) return;
    const result = this.recorder.stop();
    this.updateRecorderUI(false);
    this.showToast(`⏹️ 녹화 종료 (${result.totalFrames} 프레임 저장됨)`);
    this.recorder.downloadJSONL();
  }

  toggleRecording() {
    if (this.recorder?.recording) {
      this.stopRecording();
    } else {
      this.startRecording();
    }
  }

  updateRecorderUI(isRecording) {
    const btn = this.$('#overlay-record-btn');
    if (btn) {
      btn.textContent = isRecording ? '⏹️ 녹화 중지 (F8)' : '⏺️ 녹화 시작 (F8)';
      btn.classList.toggle('recording-active', isRecording);
    }
  }
}
