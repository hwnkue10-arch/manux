/**
 * RawTemporalRecorder (ManuX Temporal Gesture Recorder)
 * 
 * Captures raw, unadulterated time-series hand tracking data (landmarks, timestamps,
 * geometry states, controller-requested mouse events) for offline TCN intent training.
 *
 * Core Principles:
 * 1. Zero overhead when inactive (single boolean check).
 * 2. Never invents synthetic coordinates for dropped/lost frames (preserves raw ground truth).
 * 3. Exact monotonically increasing timestamp & empirical dt calculation.
 * 4. Clear distinction: controllerEvents (gesture engine commands) vs verified OS events.
 * 5. Strict data preservation upon reaching maxFrames limit.
 */

export class RawTemporalRecorder {
  constructor({ maxFrames = 15000, onChunk = null, chunkSize = 1000, autoDownload = true } = {}) {
    this.maxFrames = Number.isFinite(maxFrames) && maxFrames > 0 ? maxFrames : 15000;
    this.onChunk = typeof onChunk === 'function' ? onChunk : null;
    this.chunkSize = chunkSize;
    this.autoDownload = Boolean(autoDownload);

    this.recording = false;
    this.sessionId = null;
    this.startTime = null;
    this.lastTimestamp = null;
    this.frameCount = 0;
    this.trackedCount = 0;
    this.droppedCount = 0;
    this.buffer = [];
    this.metadata = null;
    this.summary = null;
  }

  /**
   * Start a new recording session. Resets all temporal and buffer counters.
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
    this.summary = null;

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
   * Record a single frame. Sub-millisecond execution when active; 0ms when inactive.
   */
  recordFrame({
    timestamp = performance.now(),
    landmarks = null,
    quality = true,
    mode = 'trigger',
    geometryState = null,
    controllerEvents = null,
    dispatch = null,
    actionIntent = null,
  } = {}) {
    if (!this.recording) return null;

    // Exact empirical dt calculation from prior recorded frame
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
      ? {
          ok: Boolean(quality.ok),
          handPresent: quality.handPresent !== undefined ? Boolean(quality.handPresent) : handTracked,
          spanPx: quality.spanPx ?? null,
          reason: quality.reason ?? (handTracked ? null : 'no-hand'),
        }
      : {
          ok: Boolean(quality),
          handPresent: handTracked,
          spanPx: null,
          reason: handTracked ? null : 'no-hand',
        };

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

    // Capture controller-requested mouse commands (NOT verified OS driver events)
    const reqEvents = Array.isArray(controllerEvents) && controllerEvents.length > 0
      ? controllerEvents.map(ev => ({ ...ev }))
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
      controllerEvents: reqEvents,
      dispatch: dispatch ? { ...dispatch } : null,
      actionIntent: actionIntent || null,
    };

    // Push the frame FIRST to preserve the N-th boundary frame!
    this.buffer.push(record);

    // Optional chunking callback for streaming pipelines
    if (this.onChunk && this.buffer.length % this.chunkSize === 0) {
      try {
        this.onChunk(this.buffer.slice(-this.chunkSize));
      } catch (e) {
        console.error('[RawTemporalRecorder] onChunk callback failed:', e);
      }
    }

    // Check maxFrames safety limit: finalize, preserve data, and auto-download if configured
    if (this.buffer.length >= this.maxFrames) {
      this.stop();
      if (this.autoDownload) {
        try {
          this.downloadJSONL();
        } catch (e) {
          console.warn('[RawTemporalRecorder] Auto-download failed or skipped in non-browser environment; data preserved in buffer:', e);
        }
      }
    }

    return record;
  }

  /**
   * Stop recording and finalize session metadata. Buffer is never cleared.
   */
  stop() {
    if (!this.recording) return this.summary ? { sessionId: this.sessionId, metadata: this.metadata, summary: this.summary, totalFrames: this.frameCount, frames: this.buffer } : null;

    this.recording = false;
    const endedAt = new Date().toISOString();
    const durationMs = this.startTime !== null ? performance.now() - this.startTime : 0;

    this.summary = {
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
      summary: this.summary,
      totalFrames: this.frameCount,
      frames: this.buffer,
    };
  }

  /**
   * Serialize recorded session into standard JSON Lines (JSONL).
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
      endedAt: this.summary?.endedAt || new Date().toISOString(),
      totalFrames: this.frameCount,
      trackedFrames: this.trackedCount,
      droppedFrames: this.droppedCount,
      trackingRatio: this.frameCount > 0 ? Number((this.trackedCount / this.frameCount).toFixed(4)) : 0,
    }));

    return lines.join('\n') + '\n';
  }

  /**
   * Trigger browser file download of the JSONL session without discarding memory buffer.
   */
  downloadJSONL() {
    if (this.buffer.length === 0) {
      console.warn('[RawTemporalRecorder] No frames to download.');
      return false;
    }

    // Check DOM / Blob availability
    if (typeof Blob === 'undefined' || typeof document === 'undefined' || !document.createElement) {
      return false;
    }

    try {
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
    } catch (err) {
      console.error('[RawTemporalRecorder] downloadJSONL error:', err);
      return false;
    }
  }
}
