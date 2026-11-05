/**
 * PoseSnapshotStudio (ManuX Spatial Pose Snapshot Dataset Collector)
 * 
 * Captures single-frame gold-standard posture samples comparing
 * Geometry Controller judgment (predictedAction) against human Ground Truth (groundTruthAction).
 *
 * Core Principles:
 * 1. Zero label noise: Captures frozen posture frames held intentionally by the developer.
 * 2. Rejects invalid tracking: Never records samples during tracking loss or poor quality.
 * 3. Captures corner cases: Specifically designed to collect failure angles (discrepancies).
 * 4. Mode isolation: Strict separation of Trigger Mode and Index Mode semantics.
 * 5. Full reproducibility: Preserves 21 raw 3D landmarks, geometry gate states, and timestamps.
 */

export const SUPPORTED_ACTIONS = [
  { id: 'move', key: '1', label: 'move (포인터 이동)', icon: '👆', desc: '손바닥을 안정적으로 유지하며 커서를 부드럽게 이동하는 자세', modes: ['trigger', 'index'] },
  { id: 'freeze', key: '2', label: 'freeze (포인터 고정)', icon: '🔒', desc: '검지를 접어 커서 위치를 고정하는 자세 (Trigger 모드 전용)', modes: ['trigger'] },
  { id: 'left_click', key: '3', label: 'left_click (좌클릭)', icon: '👍', desc: 'Trigger: 엄지 펴기 / Index: 엄지-검지 핀치', modes: ['trigger', 'index'] },
  { id: 'right_click', key: '4', label: 'right_click (우클릭)', icon: '🤙', desc: 'Trigger: 새끼손가락 펴기 / Index: 엄지-약지 터치', modes: ['trigger', 'index'] },
  { id: 'scroll', key: '5', label: 'scroll (휠 스크롤)', icon: '🖐️', desc: 'Trigger: 손바닥(🖐️) 또는 V자(✌️) 펴기 / Index: 스와이프 자세', modes: ['trigger', 'index'] },
  { id: 'idle', key: '6', label: 'idle (중립/휴식)', icon: '✊', desc: '마우스 제어 동작을 하지 않는 편안한 휴식 또는 주먹 자세', modes: ['trigger', 'index'] },
];

export class PoseSnapshotStudio {
  constructor({ maxSamples = 1000, streamThrottleMs = 50 } = {}) {
    this.maxSamples = Number.isFinite(maxSamples) && maxSamples > 0 ? maxSamples : 1000;
    this.samples = [];
    this.selectedGroundTruth = 'move';
    this.captureMode = 'snapshot'; // 'snapshot' | 'stream'
    this.isStreaming = false;
    this.streamDiscrepancyOnly = true; // when true in stream mode, automatically collects only mismatch/failure frames
    this.streamThrottleMs = Number.isFinite(streamThrottleMs) && streamThrottleMs >= 0 ? streamThrottleMs : 50;
    this.lastStreamSampleTime = 0;
  }

  /**
   * Set capture mode ('snapshot' for single frame capture, 'stream' for continuous frame stream).
   */
  setCaptureMode(mode) {
    if (mode !== 'snapshot' && mode !== 'stream') {
      throw new Error(`[PoseSnapshotStudio] Invalid capture mode: ${mode}. Must be 'snapshot' or 'stream'.`);
    }
    this.captureMode = mode;
    if (mode === 'snapshot' && this.isStreaming) {
      this.isStreaming = false;
    }
    return this.captureMode;
  }

  /**
   * Start continuous stream collection.
   */
  startStream() {
    this.captureMode = 'stream';
    this.isStreaming = true;
    this.lastStreamSampleTime = 0;
    return true;
  }

  /**
   * Stop continuous stream collection.
   */
  stopStream() {
    this.isStreaming = false;
    return false;
  }

  /**
   * Toggle continuous stream collection on/off.
   */
  toggleStream() {
    if (this.isStreaming) {
      return this.stopStream();
    }
    return this.startStream();
  }

  /**
   * Configure whether stream collection records only discrepancy (failure) frames or all frames.
   */
  setStreamDiscrepancyOnly(discrepancyOnly) {
    this.streamDiscrepancyOnly = Boolean(discrepancyOnly);
    return this.streamDiscrepancyOnly;
  }

  /**
   * Set currently selected ground truth action.
   */
  setSelectedGroundTruth(actionId, mode = 'trigger') {
    const actionDef = SUPPORTED_ACTIONS.find(a => a.id === actionId);
    if (!actionDef) {
      throw new Error(`[PoseSnapshotStudio] Unknown action: ${actionId}`);
    }
    if (!actionDef.modes.includes(mode)) {
      return { success: false, reason: `Action '${actionId}' is not supported in ${mode} mode` };
    }
    this.selectedGroundTruth = actionId;
    return { success: true, action: actionDef };
  }

  /**
   * Capture a single frame posture sample.
   * Blocks capture if hand tracking is invalid or quality is failing.
   */
  captureSnapshot({
    groundTruthAction = this.selectedGroundTruth,
    landmarks = null,
    quality = true,
    mode = 'trigger',
    geometryState = null,
    screenshot = null,
    timestamp = performance.now(),
    isoTime = new Date().toISOString(),
    metadata = {},
  } = {}) {
    // 1. Strict validation of tracking validity and quality
    const handTracked = Array.isArray(landmarks) && landmarks.length === 21;
    const isQualityOk = typeof quality === 'object' && quality !== null
      ? Boolean(quality.ok)
      : Boolean(quality);

    if (!handTracked || !isQualityOk) {
      return {
        success: false,
        reason: !handTracked ? 'no_hand_tracked' : 'poor_tracking_quality',
      };
    }

    // 2. Validate action support in current mode
    const actionDef = SUPPORTED_ACTIONS.find(a => a.id === groundTruthAction);
    if (!actionDef || !actionDef.modes.includes(mode)) {
      return {
        success: false,
        reason: `unsupported_action_for_mode`,
        mode,
        action: groundTruthAction,
      };
    }

    // 3. Deep copy 21 raw landmarks without modification
    const rawLandmarks = new Array(21);
    for (let i = 0; i < 21; i++) {
      const pt = landmarks[i];
      rawLandmarks[i] = {
        x: Number(pt.x.toFixed(6)),
        y: Number(pt.y.toFixed(6)),
        z: pt.z !== undefined && Number.isFinite(pt.z) ? Number(pt.z.toFixed(6)) : 0,
      };
    }

    // 4. Extract Controller prediction
    let predictedAction = 'idle';
    if (geometryState && typeof geometryState === 'object') {
      predictedAction = geometryState.mode || 'idle';
    }

    // Determine whether this sample is a match (normal verified sample) or discrepancy (geometry failure sample)
    const isMatch = (predictedAction === groundTruthAction);

    const now = Date.now();
    const rand = Math.random().toString(36).slice(2, 6);
    const sampleId = `snap_${mode}_${groundTruthAction}_${now}_${rand}`;

    const qualityInfo = typeof quality === 'object' && quality !== null
      ? { ok: Boolean(quality.ok), handPresent: Boolean(quality.handPresent), spanPx: quality.spanPx ?? null, reason: quality.reason ?? null }
      : { ok: true, handPresent: true, spanPx: null, reason: null };

    const sample = {
      sampleId,
      timestamp: Number(Number(timestamp).toFixed(2)),
      isoTime,
      mode,
      source: metadata.source || (this.isStreaming ? 'stream' : 'snapshot'),
      trackingValid: true,
      quality: qualityInfo,
      predictedAction,
      groundTruthAction,
      isMatch,
      isFailureSample: !isMatch,
      rawLandmarks,
      controllerState: geometryState ? {
        mode: geometryState.mode || 'unknown',
        phase: geometryState.phase || 'unknown',
        activePos: geometryState.activePos ? {
          x: Number(geometryState.activePos.x.toFixed(4)),
          y: Number(geometryState.activePos.y.toFixed(4)),
        } : null,
        gates: geometryState.gates ? { ...geometryState.gates } : null,
      } : null,
      screenshot: typeof screenshot === 'string' && screenshot.startsWith('data:image/') ? screenshot : null,
      metadata: { ...metadata },
    };

    if (this.samples.length >= this.maxSamples) {
      this.samples.shift(); // keep within maxSamples
    }

    this.samples.push(sample);

    return {
      success: true,
      sample,
      totalSamples: this.samples.length,
    };
  }

  /**
   * Process a live frame during continuous stream collection.
   * If streaming is active, evaluates tracking quality, throttling, and discrepancy filters
   * and records posture samples automatically.
   */
  processStreamFrame({
    groundTruthAction = this.selectedGroundTruth,
    landmarks = null,
    quality = true,
    mode = 'trigger',
    geometryState = null,
    screenshot = null,
    timestamp = performance.now(),
    isoTime = new Date().toISOString(),
    metadata = {},
  } = {}) {
    if (!this.isStreaming) {
      return { success: false, reason: 'stream_not_active' };
    }

    // 1. Throttle check
    if (this.lastStreamSampleTime > 0 && (timestamp - this.lastStreamSampleTime) < this.streamThrottleMs) {
      return { success: false, reason: 'throttled' };
    }

    // 2. Validate tracking validity and quality
    const handTracked = Array.isArray(landmarks) && landmarks.length === 21;
    const isQualityOk = typeof quality === 'object' && quality !== null
      ? Boolean(quality.ok)
      : Boolean(quality);

    if (!handTracked || !isQualityOk) {
      return { success: false, reason: !handTracked ? 'no_hand_tracked' : 'poor_tracking_quality' };
    }

    // 3. Extract Controller prediction
    let predictedAction = 'idle';
    if (geometryState && typeof geometryState === 'object') {
      predictedAction = geometryState.mode || 'idle';
    }
    const isMatch = (predictedAction === groundTruthAction);

    // 4. Discrepancy filter: If user enabled streamDiscrepancyOnly, capture ONLY mismatch/failure frames!
    if (this.streamDiscrepancyOnly && isMatch) {
      return { success: false, reason: 'match_skipped_discrepancy_only', predictedAction, groundTruthAction };
    }

    // 5. Capture sample
    const result = this.captureSnapshot({
      groundTruthAction,
      landmarks,
      quality,
      mode,
      geometryState,
      screenshot,
      timestamp,
      isoTime,
      metadata: {
        ...metadata,
        source: 'stream',
        discrepancyOnlyFilter: this.streamDiscrepancyOnly,
      },
    });

    if (result.success) {
      this.lastStreamSampleTime = timestamp;
    }

    return {
      ...result,
      streamCaptured: result.success,
      isDiscrepancy: !isMatch,
    };
  }

  /**
   * Delete / undo the last captured sample.
   */
  deleteLastSample() {
    if (this.samples.length === 0) return null;
    return this.samples.pop();
  }

  /**
   * Delete a sample by its unique sampleId.
   */
  deleteSampleById(sampleId) {
    const idx = this.samples.findIndex(s => s.sampleId === sampleId);
    if (idx === -1) return null;
    return this.samples.splice(idx, 1)[0];
  }

  /**
   * Clear all captured samples.
   */
  clearSamples() {
    const count = this.samples.length;
    this.samples = [];
    return count;
  }

  /**
   * Get all captured samples.
   */
  getSamples() {
    return [...this.samples];
  }

  /**
   * Calculate summary statistics of the dataset.
   */
  getStats() {
    const total = this.samples.length;
    let matches = 0;
    let discrepancies = 0;
    const byGroundTruth = {};
    const byPredicted = {};
    const modeCounts = { trigger: 0, index: 0 };

    for (const a of SUPPORTED_ACTIONS) {
      byGroundTruth[a.id] = 0;
      byPredicted[a.id] = 0;
    }

    for (const s of this.samples) {
      if (s.isMatch) matches++;
      else discrepancies++;

      byGroundTruth[s.groundTruthAction] = (byGroundTruth[s.groundTruthAction] || 0) + 1;
      byPredicted[s.predictedAction] = (byPredicted[s.predictedAction] || 0) + 1;
      if (s.mode) modeCounts[s.mode] = (modeCounts[s.mode] || 0) + 1;
    }

    const accuracy = total > 0 ? Number((matches / total).toFixed(4)) : 0;

    return {
      total,
      matches,
      discrepancies,
      accuracy,
      byGroundTruth,
      byPredicted,
      modeCounts,
    };
  }

  /**
   * Serialize dataset to JSON format with comprehensive header and summary.
   */
  toJSON({ indent = 2 } = {}) {
    const stats = this.getStats();
    const data = {
      type: 'manux_pose_snapshot_dataset',
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
      summary: stats,
      samples: this.samples,
    };
    return JSON.stringify(data, null, indent);
  }

  /**
   * Serialize dataset to standard JSON Lines (JSONL).
   */
  toJSONL() {
    const lines = [];
    lines.push(JSON.stringify({
      type: 'header',
      dataset: 'manux_pose_snapshot_dataset',
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
    }));

    for (const s of this.samples) {
      lines.push(JSON.stringify(s));
    }

    lines.push(JSON.stringify({
      type: 'summary',
      ...this.getStats(),
      exportedAt: new Date().toISOString(),
    }));

    return lines.join('\n') + '\n';
  }

  /**
   * Download dataset as JSON file in browser environment.
   */
  downloadJSON({ filename = null } = {}) {
    if (this.samples.length === 0) return false;
    if (typeof Blob === 'undefined' || typeof document === 'undefined' || !document.createElement) {
      return false;
    }

    try {
      const mode = this.samples[this.samples.length - 1]?.mode || 'trigger';
      const defaultFilename = `manux_pose_snapshots_${mode}_${Date.now()}.json`;
      const content = this.toJSON({ indent: 2 });
      const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.download = filename || defaultFilename;
      a.href = url;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      return true;
    } catch (err) {
      console.error('[PoseSnapshotStudio] downloadJSON error:', err);
      return false;
    }
  }
}

