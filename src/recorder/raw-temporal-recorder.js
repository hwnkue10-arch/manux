/**
 * RawTemporalRecorder (ManuX Temporal Gesture Recorder)
 * 
 * Captures raw, unadulterated time-series hand tracking data (landmarks, timestamps,
 * geometry states, OS mouse events) for offline TCN intent training.
 *
 * Core Principles:
 * 1. Zero overhead when inactive (single boolean check).
 * 2. Never invents synthetic coordinates for dropped/lost frames (preserves raw ground truth).
 * 3. Exact monotonically increasing timestamp & empirical dt calculation.
 * 4. Structured JSONL export without blocking UI frames.
 */

export class RawTemporalRecorder {
  constructor({ maxFrames = 15000, onChunk = null, chunkSize = 1000 } = {}) {
    this.maxFrames = Number.isFinite(maxFrames) && maxFrames > 0 ? maxFrames : 15000;
    this.onChunk = typeof onChunk === 'function' ? onChunk : null;
    this.chunkSize = chunkSize;

    this.recording = false;
    this.sessionId = null;
    this.startTime = null;
    this.lastTimestamp = null;
    this.frameCount = 0;
    this.trackedCount = 0;
    this.droppedCount = 0;
    this.buffer = [];
    this.metadata = null;
  }

  /**
   * Start a new recording session.
   */
  start({ mode = 'trigger', width = 640, height = 480, metadata = {} } = {}) {
    const now = Date.now();
    const randomSuffix = Math.random().toString(36).slice(2, 7);
    this.sessionId = `manux_${mode}_${now}_${randomSuffix}`;
    this.recording = true;
    this.startTime = performance.now();
    this.lastTimestamp = null;
    this.frameCount = 0;
    this.trackedCount = 0;
    this.droppedCount = 0;
    this.buffer = [];

    this.metadata = {
      sessionId: this.sessionId,
      startedAt: new Date(now).toISOString(),
      mode,
      resolution: { width, height },
      ...metadata,
    };

    return {
      sessionId: this.sessionId,
      metadata: this.metadata,
    };
  }

  /**
   * Record a single frame. Must be sub-millisecond when active, and virtually 0ms when inactive.
   */
  recordFrame({
    timestamp = performance.now(),
    landmarks = null,
    quality = true,
    mode = 'trigger',
    geometryState = null,
    events = null,
    actionIntent = null,
  } = {}) {
    if (!this.recording) return null;

    // Safety: prevent unbounded memory leak if user forgets to stop
    if (this.buffer.length >= this.maxFrames) {
      console.warn(`[RawTemporalRecorder] Reached maxFrames limit (${this.maxFrames}). Stopping recording.`);
      this.stop();
      return null;
    }

    // Exact empirical dt calculation
    const numTimestamp = Number.isFinite(timestamp) ? timestamp : performance.now();
    const dt = this.lastTimestamp !== null
      ? Math.max(0, Number(((numTimestamp - this.lastTimestamp) / 1000).toFixed(6)))
      : 0;
    this.lastTimestamp = numTimestamp;

    // Evaluate tracking validity without inventing synthetic coordinates
    const handTracked = Array.isArray(landmarks) && landmarks.length === 21;
    let rawLandmarks = null;

    if (handTracked) {
      this.trackedCount++;
      rawLandmarks = new Array(21);
      for (let i = 0; i < 21; i++) {
        const pt = landmarks[i];
        if (pt && Number.isFinite(pt.x) && Number.isFinite(pt.y)) {
          rawLandmarks[i] = {
            x: Number(pt.x.toFixed(6)),
            y: Number(pt.y.toFixed(6)),
            z: pt.z !== undefined && Number.isFinite(pt.z) ? Number(pt.z.toFixed(6)) : 0,
          };
        } else {
          rawLandmarks[i] = { x: 0, y: 0, z: 0 };
        }
      }
    } else {
      this.droppedCount++;
    }

    // Parse quality detail
    const qualityRecord = typeof quality === 'object' && quality !== null
      ? { ok: Boolean(quality.ok), spanPx: quality.spanPx ?? null, reason: quality.reason ?? null }
      : { ok: Boolean(quality), spanPx: null, reason: null };

    // Capture geometry controller state snapshot
    let geom = null;
    if (geometryState && typeof geometryState === 'object') {
      geom = {
        mode: geometryState.mode || 'unknown',
        phase: geometryState.phase || 'unknown',
        activePos: geometryState.activePos ? {
          x: Number(geometryState.activePos.x.toFixed(4)),
          y: Number(geometryState.activePos.y.toFixed(4)),
        } : null,
        gates: geometryState.gates ? { ...geometryState.gates } : null,
      };
    }

    // Capture actual emitted OS mouse events
    const mouseEvents = Array.isArray(events) && events.length > 0
      ? events.map(ev => ({ ...ev }))
      : [];

    const record = {
      type: 'frame',
      sessionId: this.sessionId,
      frameId: ++this.frameCount,
      timestamp: Number(numTimestamp.toFixed(2)),
      dt,
      mode,
      tracking: {
        tracked: handTracked,
        quality: qualityRecord,
      },
      rawLandmarks,
      geometryState: geom,
      actualMouseEvents: mouseEvents,
      actionIntent: actionIntent || null,
    };

    this.buffer.push(record);

    // Optional chunking callback for streaming pipelines
    if (this.onChunk && this.buffer.length % this.chunkSize === 0) {
      try {
        this.onChunk(this.buffer.slice(-this.chunkSize));
      } catch (e) {
        console.error('[RawTemporalRecorder] onChunk callback failed:', e);
      }
    }

    return record;
  }

  /**
   * Stop recording and finalize session metadata.
   */
  stop() {
    if (!this.recording) return null;

    this.recording = false;
    const endedAt = new Date().toISOString();
    const durationMs = this.startTime !== null ? performance.now() - this.startTime : 0;

    const summary = {
      sessionId: this.sessionId,
      startedAt: this.metadata?.startedAt,
      endedAt,
      durationMs: Number(durationMs.toFixed(1)),
      totalFrames: this.frameCount,
      trackedFrames: this.trackedCount,
      droppedFrames: this.droppedCount,
      trackingRatio: this.frameCount > 0 ? Number((this.trackedCount / this.frameCount).toFixed(4)) : 0,
      mode: this.metadata?.mode,
    };

    return {
      sessionId: this.sessionId,
      metadata: this.metadata,
      summary,
      totalFrames: this.frameCount,
      frames: this.buffer,
    };
  }

  /**
   * Serialize recorded session into standard JSON Lines (JSONL).
   * Line 1: Session Header
   * Line 2..N: Frame Records
   * Line N+1: Session Summary
   */
  toJSONL() {
    const lines = [];

    // Header record
    lines.push(JSON.stringify({
      type: 'header',
      version: '1.0.0',
      sessionId: this.sessionId,
      metadata: this.metadata,
    }));

    // Data frame records
    for (let i = 0; i < this.buffer.length; i++) {
      lines.push(JSON.stringify(this.buffer[i]));
    }

    // Summary record
    lines.push(JSON.stringify({
      type: 'summary',
      sessionId: this.sessionId,
      endedAt: new Date().toISOString(),
      totalFrames: this.frameCount,
      trackedFrames: this.trackedCount,
      droppedFrames: this.droppedCount,
      trackingRatio: this.frameCount > 0 ? Number((this.trackedCount / this.frameCount).toFixed(4)) : 0,
    }));

    return lines.join('\n') + '\n';
  }

  /**
   * Trigger browser file download of the JSONL session.
   */
  downloadJSONL() {
    if (this.buffer.length === 0) {
      console.warn('[RawTemporalRecorder] No frames to download.');
      return false;
    }

    const content = this.toJSONL();
    const blob = new Blob([content], { type: 'application/x-ndjson;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.download = `${this.sessionId || 'manux_recording'}.jsonl`;
    a.href = url;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return true;
  }
}
