import {AirMouseController} from './air-mouse-controller.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Practice actions are confined to the pad; only the desktop preload can control Windows. */
export class MouseWorkspace {
  constructor({root = document, bridge = globalThis.manuxDesktop} = {}) {
    this.root = root;
    this.bridge = bridge;
    this.$ = selector => root.querySelector(selector);

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
      });
    };

    this.controller = createController();
    this.active = false;
    this.ready = false;
    this.enabled = false;
    this.available = false;
    this.overlayActive = false;
    this.generation = 0;
    this.pending = false;
    this.lastFrame = null;
    this.position = {x:130, y:110};
    this.pressed = false;
    this.drag = null;
    this.clickStart = null;

    this.overlayCanvas = this.$('#overlay-hud-canvas');
    this.overlayCtx = this.overlayCanvas?.getContext('2d');

    this.$('#mouse-enabled')?.addEventListener('change', () => { void this.toggle(); });
    this.$('#mouse-stop')?.addEventListener('click', () => this.stop('마우스 제어를 껐습니다.'));
    this.$('#mouse-target')?.addEventListener('change', () => { this.stop(); this.renderTarget(); });
    this.$('#mouse-pointer-mode')?.addEventListener('change', () => {
      this.stop('추적 방식을 변경했습니다.');
      this.controller = createController();
      this.updateGuideCards();
      this.updateOverlayModeButton();
    });

    this.$('#overlay-mode-toggle')?.addEventListener('click', () => {
      const modeSelect = this.$('#mouse-pointer-mode');
      if (modeSelect) {
        modeSelect.value = modeSelect.value === 'trigger' ? 'index' : 'trigger';
        this.stop(modeSelect.value === 'trigger' ? '트리거 모드로 전환했습니다.' : '핀치 모드로 전환했습니다.');
        this.controller = createController();
        this.updateGuideCards();
        this.updateOverlayModeButton();
      }
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

    this.$('#mouse-click-target')?.addEventListener('click', () => {
      const el = this.$('#mouse-click-count'); if (el) el.textContent = String(Number(el.textContent) + 1);
    });
    this.$('#mouse-scroll-area')?.addEventListener('scroll', () => this.renderScroll());

    // Window controls & Overlay triggers
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

    window.addEventListener('keydown', event => {
      if (event.key === 'F11') {
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
      this.renderTarget(); this.refresh();
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

    this.updateGuideCards();
    this.updateOverlayModeButton();
    this.renderTarget();
    this.renderCursor();
    this.refresh();
  }

  getModeLabel(mode) {
    const pointerMode = this.controller?.pointerMode ?? 'trigger';
    if (pointerMode === 'trigger') {
      switch (mode) {
        case 'idle': return '쉬는 중 (주먹/휴식)';
        case 'move': return '👆 1: 포인터 이동 (검지)';
        case 'frozen': return '🔒 커서 고정 (엄지 펴서 클릭)';
        case 'left': return '🔫 좌클릭 · 드래그 (엄지 펴기)';
        case 'right': return '🤙 우클릭 (소지 펴기)';
        case 'both': return '🤙 좌우 동시 클릭 (엄지+소지)';
        case 'scroll': return '✌️ 휠 스크롤 (V자 위아래)';
        default: return '대기 중';
      }
    } else if (pointerMode === 'index') {
      switch (mode) {
        case 'idle': return '쉬는 중 (주먹/휴식)';
        case 'move': return '👆 포인터 이동 (검지)';
        case 'left': return '🤏 좌클릭 · 드래그 (엄지+중지)';
        case 'right': return '👆 우클릭 (엄지+약지)';
        case 'both': return '🤏 좌우 동시 클릭 (엄지+중지+약지)';
        case 'scroll': return '✌️ 휠 스크롤 (V자 위아래)';
        default: return '대기 중';
      }
    } else {
      switch (mode) {
        case 'idle': return '쉬는 중 (주먹/휴식)';
        case 'move': return '✋ 손바닥 포인터 이동';
        case 'left': return '🤏 엄지+검지 좌클릭';
        case 'right': return '👆 엄지+중지 우클릭';
        case 'scroll': return '🖐️ 휠 스크롤';
        default: return '대기 중';
      }
    }
  }

  updateOverlayModeButton() {
    const btn = this.$('#overlay-mode-toggle');
    if (btn) {
      const mode = this.controller?.pointerMode ?? 'trigger';
      btn.textContent = mode === 'trigger' ? '🔄 모드: 트리거' : (mode === 'index' ? '🔄 모드: 핀치' : '🔄 모드: 손바닥');
    }
  }

  updateGuideCards() {
    const mode = this.controller?.pointerMode ?? 'trigger';
    const articles = this.root.querySelectorAll('.mouse-guide article');
    if (articles.length >= 4) {
      const a1 = articles[0]?.querySelector('div');
      const a2 = articles[1]?.querySelector('div');
      const a3 = articles[2]?.querySelector('div');
      const a4 = articles[3]?.querySelector('div');
      if (mode === 'trigger') {
        if (a1) a1.innerHTML = '<h3>👆 1: 포인터 이동 (검지)</h3><p>검지 끝(LM 8) 직접 추적<br>검지를 접으면 그 자리에 커서 고정(Freeze)</p>';
        if (a2) a2.innerHTML = '<h3>🔫 엄지 펴기: 좌클릭 & 드래그</h3><p>엄지만 펴면 즉시 좌클릭 & 유지 시 드래그<br>검지를 접고 엄지를 펴면 흔들림 0% 정밀 클릭</p>';
        if (a3) a3.innerHTML = '<h3>🤙 소지 펴기: 우클릭</h3><p>새끼손가락(소지)만 펴면 우클릭<br>엄지와 소지를 같이 펴면 좌우 동시 클릭</p>';
        if (a4) a4.innerHTML = '<h3>✌️ V 제스처: 휠 스크롤</h3><p>검지+중지 펴고 위아래 이동 시 스크롤<br>주먹 쥐면(✊) 완전한 쉬는 자세</p>';
      } else if (mode === 'index') {
        if (a1) a1.innerHTML = '<h3>👆 검지 포인터 이동</h3><p>검지 끝(LM 8) 직접 추적<br>주먹 외 모든 자세 추적 · 떨림 방지</p>';
        if (a2) a2.innerHTML = '<h3>🤏 엄지+중지: 좌클릭 & 드래그</h3><p>엄지+중지 맞닿으면 좌클릭 & 더블클릭<br>검지 흔들림 0% · 연속 드래그</p>';
        if (a3) a3.innerHTML = '<h3>👆 엄지+약지: 우클릭</h3><p>엄지+약지 맞닿으면 우클릭<br>좌우 독립 판정 및 동시 클릭 가능</p>';
        if (a4) a4.innerHTML = '<h3>✌️ 제스처 2: 폰 터치 스크롤</h3><p>V자 펴고 위로 그으면 아래 스크롤<br>주먹 쥐어 손 떼기 (역스크롤 0%)</p>';
      } else {
        if (a1) a1.innerHTML = '<h3>✋ 손바닥 포인터 이동</h3><p>손바닥 중심 코어 추적<br>손바닥을 편 채 이동</p>';
        if (a2) a2.innerHTML = '<h3>🤏 엄지+검지: 좌클릭</h3><p>엄지+검지 맞닿으면 좌클릭<br>유지 시 드래그</p>';
        if (a3) a3.innerHTML = '<h3>👆 엄지+중지: 우클릭</h3><p>엄지+중지 맞닿으면 우클릭</p>';
        if (a4) a4.innerHTML = '<h3>🖐️ 폰 터치 스크롤</h3><p>손바닥 펴고 위아래 이동</p>';
      }
    }
  }

  get desktop() { return this.$('#mouse-target')?.value === 'desktop'; }
  get backgroundAllowed() { return (this.active || this.overlayActive) && this.enabled && this.desktop && this.available; }

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
      // Auto-enable mouse control in overlay mode if ready
      if (this.ready && !this.enabled) {
        const toggleEl = this.$('#mouse-enabled');
        if (toggleEl) {
          toggleEl.checked = true;
          await this.toggle();
        }
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
    const titleEl = this.$('#mouse-title');
    if (titleEl) titleEl.textContent = this.desktop ? 'Windows 마우스 제어' : '마우스 연습';
    const noteEl = this.$('#mouse-target-note');
    if (noteEl) {
      noteEl.textContent = this.desktop
        ? '실제 Windows 커서를 제어합니다. Ctrl + Alt + M으로 어디서든 중지할 수 있습니다.'
        : '연습 모드에서는 아래 영역의 커서만 움직입니다.';
    }
    const pad = this.$('#mouse-pad');
    if (pad) pad.hidden = this.desktop;
  }

  setReady(ready) {
    this.ready = ready;
    if (!ready) this.stop('카메라를 시작한 뒤 마우스 제어를 켜세요.');
    else if (!this.enabled) this.status('준비됐습니다. 제어를 켠 뒤 검지를 펴세요.');
    this.refresh();
  }

  setActive(active) {
    this.stop(); this.active = active; this.refresh();
    if (active) this.status(this.ready ? '제어를 켠 뒤 검지를 펴세요.' : '카메라를 시작한 뒤 마우스 제어를 켜세요.');
  }

  async toggle() {
    if (!this.$('#mouse-enabled')?.checked) { this.stop('마우스 제어를 껐습니다.'); return; }
    if (!this.ready || !this.active) { this.stop(); return; }
    const generation = ++this.generation;
    this.pending = true; this.refresh();
    try {
      if (this.desktop) {
        if (!this.available || !this.bridge) throw new Error('데스크톱 앱에서 실행하세요.');
        const status = await this.bridge.setEnabled(true);
        if (generation !== this.generation) { this.bridge.stop(); return; }
        if (!status.enabled) throw new Error(status.error || 'Windows 마우스 제어를 켜지 못했습니다.');
      }
      if (generation !== this.generation || !this.ready || !this.active) return;
      this.controller.reset(); this.enabled = true; this.lastFrame = performance.now();
      this.status('👆 검지로 포인터를 이동하세요. 엄지+중지(좌클릭·드래그) · 엄지+약지(우클릭) · ✌️ 폰 스크롤입니다.');
    } catch (error) { this.stop(error.message); }
    finally { this.pending = false; this.refresh(); }
  }

  stop(text) {
    this.generation++; this.enabled = false; this.lastFrame = null;
    this.controller.reset(); this.releasePractice(); this.bridge?.stop();
    const menu = this.$('#mouse-context-menu'); if (menu) menu.hidden = true;
    const modeEl = this.$('#mouse-mode'); if (modeEl) modeEl.textContent = '대기 중';
    const badgeEl = this.$('#overlay-mode-badge'); if (badgeEl) badgeEl.textContent = '대기 중';
    this.root.querySelectorAll('[data-mouse-mode]').forEach(el => el.classList.remove('active'));
    this.refresh(); if (text) this.status(text);
    if (this.overlayCtx && this.overlayCanvas) {
      this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    }
  }

  update({landmarks, now, quality, handedness, width, height, latency = 0}) {
    if (!this.active && !this.overlayActive) return null;
    if (this.enabled && latency > 450) this.stop('추적 결과가 늦어 제어를 껐습니다. 해상도를 낮추고 다시 켜보세요.');
    const state = this.controller.update({landmarks, now, quality, handedness, width, height, enabled:this.enabled});
    if (this.enabled) {
      this.lastFrame = performance.now();
      if (this.desktop) this.bridge?.send(state.events);
      else this.applyPractice(state.events);
      const hints = {
        'release-required':'손가락을 떼면 클릭을 다시 사용할 수 있습니다.',
        invalid:'손 전체가 카메라에 보이도록 해주세요.',
        holding:'손 모양을 확인하고 있습니다.',
        'tracking-reset':'손 위치를 다시 잡았습니다. 천천히 움직여주세요.',
      };
      this.status(hints[state.phase] || (state.mode === 'idle' ? '쉬는 중입니다 (주먹/휴식).' : (state.mode === 'scroll' ? '✌️ 휠 스크롤 중 · 손을 위아래로 그으세요.' : (state.mode === 'frozen' ? '🔒 커서 고정됨 · 엄지를 펴서 클릭하세요.' : `${this.getModeLabel(state.mode)} 중`))));
    }

    const labelText = this.enabled ? this.getModeLabel(state.mode) : '대기 중';
    const modeEl = this.$('#mouse-mode'); if (modeEl) modeEl.textContent = labelText;
    const badgeEl = this.$('#overlay-mode-badge'); if (badgeEl) badgeEl.textContent = labelText;

    const panel = this.$('#mouse-panel');
    if (panel) {
      panel.dataset.mode = state.mode;
      panel.dataset.phase = state.phase;
    }
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

    // Safety Gate: All fingers and reticles disappear completely in fist / rest (idle mode)
    if (state.mode === 'idle') {
      return;
    }

    // Deadzone-free compact active zone mapping to screen pixels
    const mapPoint = pt => {
      const mirroredX = 1.0 - pt.x;
      const u = clamp((mirroredX - 0.28) / 0.44, 0, 1);
      const v = clamp((pt.y - 0.20) / 0.48, 0, 1);
      return {x: u * w, y: v * h};
    };

    const idx = (state.activePos && state.fingertips?.index && state.fingertips.index.visible !== false)
      ? { x: state.activePos.x * w, y: state.activePos.y * h }
      : (state.fingertips?.index && state.fingertips.index.visible !== false ? mapPoint(state.fingertips.index) : null);
    const thm = (state.fingertips?.thumb && state.fingertips.thumb.visible !== false) ? mapPoint(state.fingertips.thumb) : null;
    const mid = (state.fingertips?.middle && state.fingertips.middle.visible !== false) ? mapPoint(state.fingertips.middle) : null;
    const rng = (state.fingertips?.ring && state.fingertips.ring.visible !== false) ? mapPoint(state.fingertips.ring) : null;
    const pnk = (state.fingertips?.pinky && state.fingertips.pinky.visible !== false) ? mapPoint(state.fingertips.pinky) : null;

    const isTrigger = (this.controller?.pointerMode ?? 'trigger') === 'trigger';

    if (isTrigger) {
      // === PARADIGM B: INDEPENDENT TRIGGER HUD ===
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
          ctx.fillText('🔫 좌클릭 [LM4]', thm.x + 22, thm.y);
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

      // 4. Middle-Click Auto-Scroll Anchor Compass & Velocity Beam (✌️ V-sign)
      if (state.mode === 'scroll') {
        ctx.save();
        const anchor = state.scrollAnchor ? mapPoint(state.scrollAnchor) : (idx ?? {x: w / 2, y: h / 2});
        const currentHand = (idx && mid) ? {x: (idx.x + mid.x) * 0.5, y: (idx.y + mid.y) * 0.5} : (idx ?? anchor);
        const vel = state.scrollVelocity ?? 0;

        // Draw Compass Circle (Middle-Click Origin)
        ctx.fillStyle = 'rgba(192, 132, 252, 0.22)';
        ctx.strokeStyle = '#c084fc';
        ctx.lineWidth = 2.5;
        ctx.shadowColor = '#c084fc';
        ctx.shadowBlur = 18;
        ctx.beginPath();
        ctx.arc(anchor.x, anchor.y, 24, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // Inner center point
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(anchor.x, anchor.y, 4, 0, Math.PI * 2);
        ctx.fill();

        // Compass Up / Down Triangles
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

        // Connecting tether from anchor to current hand
        ctx.strokeStyle = 'rgba(192, 132, 252, 0.75)';
        ctx.lineWidth = 3;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(anchor.x, anchor.y);
        ctx.lineTo(currentHand.x, currentHand.y);
        ctx.stroke();

        // Dynamic status text
        ctx.font = 'bold 13px "Segoe UI", sans-serif';
        if (vel > 0.1) {
          ctx.fillStyle = '#c084fc';
          ctx.fillText(`▼ 아래로 자동 스크롤 (${Math.min(100, Math.round(Math.abs(vel) * 22))}%)`, anchor.x + 34, anchor.y + 6);
        } else if (vel < -0.1) {
          ctx.fillStyle = '#c084fc';
          ctx.fillText(`▲ 위로 자동 스크롤 (${Math.min(100, Math.round(Math.abs(vel) * 22))}%)`, anchor.x + 34, anchor.y + 6);
        } else {
          ctx.fillStyle = '#e9d5ff';
          ctx.fillText('🎯 스크롤 기준점 (손을 위/아래로 이동)', anchor.x + 34, anchor.y + 6);
        }
        ctx.restore();
      }
    } else {
      // Connecting laser line between Thumb (4) and Middle (12) during left click / drag
      if ((state.mode === 'left' || state.mode === 'both') && thm && mid) {
        ctx.save();
        ctx.strokeStyle = '#10b981';
        ctx.lineWidth = 4;
        ctx.shadowColor = '#10b981';
        ctx.shadowBlur = 14;
        ctx.beginPath();
        ctx.moveTo(thm.x, thm.y);
        ctx.lineTo(mid.x, mid.y);
        ctx.stroke();

        ctx.fillStyle = '#10b981';
        ctx.font = 'bold 12px "Segoe UI", sans-serif';
        ctx.fillText('🤏 좌클릭 · 드래그', (thm.x + mid.x) / 2 + 15, (thm.y + mid.y) / 2);
        ctx.restore();
      }

      // Connecting laser line between Thumb (4) and Ring (16) during right click
      if ((state.mode === 'right' || state.mode === 'both') && thm && rng) {
        ctx.save();
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 4;
        ctx.shadowColor = '#3b82f6';
        ctx.shadowBlur = 14;
        ctx.beginPath();
        ctx.moveTo(thm.x, thm.y);
        ctx.lineTo(rng.x, rng.y);
        ctx.stroke();

        ctx.fillStyle = '#3b82f6';
        ctx.font = 'bold 12px "Segoe UI", sans-serif';
        ctx.fillText('👆 우클릭', (thm.x + rng.x) / 2 + 15, (thm.y + rng.y) / 2);
        ctx.restore();
      }

      // Stream guides during Smartphone Touch Scroll (Open Palm or V-Sign)
      if (state.mode === 'scroll') {
        ctx.save();
        ctx.strokeStyle = '#c084fc';
        ctx.lineWidth = 3;
        ctx.setLineDash([4, 4]);
        ctx.shadowColor = '#c084fc';
        ctx.shadowBlur = 14;
        ctx.beginPath();
        if (idx && mid && rng) {
          ctx.moveTo(idx.x, idx.y);
          ctx.lineTo(mid.x, mid.y);
          ctx.lineTo(rng.x, rng.y);
          ctx.stroke();

          ctx.fillStyle = '#c084fc';
          ctx.font = 'bold 12px "Segoe UI", sans-serif';
          ctx.fillText('🖐️ 손바닥 폰 터치 스크롤', mid.x + 15, mid.y);
        } else if (idx && mid) {
          ctx.moveTo(idx.x, idx.y);
          ctx.lineTo(mid.x, mid.y);
          ctx.stroke();

          ctx.fillStyle = '#c084fc';
          ctx.font = 'bold 12px "Segoe UI", sans-serif';
          ctx.fillText('✌️ 폰 터치 스크롤', (idx.x + mid.x) / 2 + 15, (idx.y + mid.y) / 2 - 10);
        }
        ctx.restore();
      }

      // Thumb Point (Amber Glow - only shown when middle/ring is active or clicking)
      if (thm && (mid || rng || state.mode === 'left' || state.mode === 'right')) {
        ctx.save();
        ctx.fillStyle = '#f59e0b';
        ctx.shadowColor = '#f59e0b';
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.arc(thm.x, thm.y, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#fef3c7';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(thm.x, thm.y, 12, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // Middle Point (Emerald Glow - Left Click)
      if (mid) {
        ctx.save();
        ctx.fillStyle = '#10b981';
        ctx.shadowColor = '#10b981';
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.arc(mid.x, mid.y, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#d1fae5';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(mid.x, mid.y, 12, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // Ring Point (Sapphire Blue Glow - Right Click)
      if (rng) {
        ctx.save();
        ctx.fillStyle = '#3b82f6';
        ctx.shadowColor = '#3b82f6';
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.arc(rng.x, rng.y, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#dbeafe';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(rng.x, rng.y, 12, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // Index Point (Cyan Glowing Reticle - Active Pointer Cursor)
      if (idx) {
        ctx.save();
        const isPointerActive = state.mode === 'move' || state.mode === 'left';
        ctx.fillStyle = isPointerActive ? '#00f0ff' : '#64748b';
        ctx.shadowColor = isPointerActive ? '#00f0ff' : '#00000000';
        ctx.shadowBlur = isPointerActive ? 18 : 0;
        ctx.beginPath();
        ctx.arc(idx.x, idx.y, 7, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = isPointerActive ? '#22d3ee' : '#94a3b8';
        ctx.lineWidth = 2;
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

        if (isPointerActive) {
          ctx.fillStyle = '#00f0ff';
          ctx.font = '600 11px "Segoe UI", sans-serif';
          ctx.fillText('INDEX [LM8]', idx.x + 22, idx.y - 12);
        }
        ctx.restore();
      }
    }
  }

  hit(selector) {
    const pad = this.$('#mouse-pad')?.getBoundingClientRect(), rect = this.$(selector)?.getBoundingClientRect();
    if (!pad || !rect) return false;
    const x = pad.left + this.position.x, y = pad.top + this.position.y;
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  applyPractice(events) {
    const pad = this.$('#mouse-pad');
    if (!pad) return;
    for (const event of events) {
      if (event.type === 'release') { this.releasePractice(); continue; }
      if (event.type === 'moveTo') {
        this.position.x = clamp(event.x * pad.clientWidth, 0, pad.clientWidth - 2);
        this.position.y = clamp(event.y * pad.clientHeight, 0, pad.clientHeight - 2);
        if (this.drag) {
          const target = this.$('#mouse-drag-target');
          if (target) {
            target.style.left = `${clamp(this.position.x - this.drag.x, 0, pad.clientWidth - target.offsetWidth)}px`;
            target.style.top = `${clamp(this.position.y - this.drag.y, 0, pad.clientHeight - target.offsetHeight)}px`;
          }
        }
        this.renderCursor();
      } else if (event.type === 'move') {
        this.position.x = clamp(this.position.x + event.dx, 0, pad.clientWidth - 2);
        this.position.y = clamp(this.position.y + event.dy, 0, pad.clientHeight - 2);
        if (this.drag) {
          const target = this.$('#mouse-drag-target');
          if (target) {
            target.style.left = `${clamp(this.position.x - this.drag.x, 0, pad.clientWidth - target.offsetWidth)}px`;
            target.style.top = `${clamp(this.position.y - this.drag.y, 0, pad.clientHeight - target.offsetHeight)}px`;
          }
        }
        this.renderCursor();
      } else if (event.type === 'scroll') {
        const area = this.$('#mouse-scroll-area');
        if (area) { area.scrollTop += event.dy; this.renderScroll(); }
      } else if (event.type === 'button' && event.button === 'right' && event.down) {
        const menu = this.$('#mouse-context-menu');
        if (menu) {
          menu.hidden = false;
          menu.style.left = `${clamp(this.position.x, 8, Math.max(8, pad.clientWidth - 250))}px`;
          menu.style.top = `${clamp(this.position.y, 8, pad.clientHeight - 90)}px`;
        }
      } else if (event.type === 'button' && event.button === 'left') {
        if (event.down) {
          const menu = this.$('#mouse-context-menu'); if (menu) menu.hidden = true;
          this.pressed = true;
          this.clickStart = this.hit('#mouse-click-target') ? {...this.position} : null;
          if (this.hit('#mouse-drag-target')) {
            const target = this.$('#mouse-drag-target');
            if (target) {
              this.drag = {x:this.position.x - target.offsetLeft, y:this.position.y - target.offsetTop};
              target.classList.add('dragging');
            }
          }
        } else {
          if (this.pressed && this.clickStart && this.hit('#mouse-click-target') && Math.hypot(this.position.x - this.clickStart.x, this.position.y - this.clickStart.y) < 12) {
            this.$('#mouse-click-target')?.click();
          }
          this.releasePractice();
        }
        this.renderCursor();
      }
    }
  }

  releasePractice() {
    this.pressed = false; this.drag = null; this.clickStart = null;
    this.$('#mouse-drag-target')?.classList.remove('dragging');
    this.renderCursor();
  }

  renderCursor() {
    const el = this.$('#mouse-cursor');
    if (el) {
      el.style.transform = `translate(${this.position.x}px, ${this.position.y}px)`;
      el.classList.toggle('pressed', this.pressed);
    }
  }

  renderScroll() {
    const el = this.$('#mouse-scroll-value');
    const area = this.$('#mouse-scroll-area');
    if (el && area) el.textContent = `${Math.round(area.scrollTop)}px`;
  }
}
