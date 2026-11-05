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
    this.currentAnnotation = null;
    this.annotations = [];
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
    this.currentAnnotation = null;
    this.annotations = [];

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
    mode = null,
    geometryState = null,
    controllerEvents = null,
    dispatch = null,
    actionIntent = null,
  } = {}) {
    if (!this.recording) return null;

    const effectiveMode = mode || this.metadata?.mode || 'trigger';

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

    const effectiveActionIntent = (actionIntent !== null && actionIntent !== undefined)
      ? actionIntent
      : (this.currentAnnotation ? this.currentAnnotation.actionIntent : null);

    const record = {
      type: 'frame',
      sessionId: this.sessionId,
      frameId: ++this.frameCount,
      timestamp: Number(numTimestamp.toFixed(2)),
      dt,
      mode: effectiveMode,
      tracking: {
        tracked: handTracked,
        quality: qualityRecord,
      },
      rawLandmarks,
      geometryState: geom,
      controllerEvents: reqEvents,
      dispatch: dispatch ? { ...dispatch } : null,
      actionIntent: effectiveActionIntent,
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
   * Start a human-in-the-loop manual action annotation interval.
   * Monotonically timestamps the start and pushes an annotation_start event to the stream.
   * Subsequent recorded frames will carry this actionIntent until ended or cancelled.
   */
  startAnnotation({ actionIntent, trialId = null, metadata = {} } = {}) {
    if (!this.recording) return null;
    if (!actionIntent || typeof actionIntent !== 'string') {
      throw new Error('[RawTemporalRecorder] Valid actionIntent string is required');
    }

    // Auto-close previous annotation if still active
    if (this.currentAnnotation) {
      this.endAnnotation({ autoClosed: true });
    }

    const startTimestamp = performance.now();
    const mode = this.metadata?.mode || 'trigger';
    const trial = Number.isFinite(trialId) ? trialId : null;
    const rand = Math.random().toString(36).slice(2, 6);
    const annotationId = `ann_${mode}_${actionIntent}_t${trial ?? Date.now()}_${rand}`;

    this.currentAnnotation = {
      annotationId,
      sessionId: this.sessionId,
      mode,
      actionIntent,
      trialId: trial,
      startTimestamp: Number(startTimestamp.toFixed(2)),
      startFrameId: this.frameCount + 1,
      labelSource: 'manual',
      metadata: { ...metadata },
    };

    const startEvent = {
      type: 'annotation_start',
      annotationId,
      sessionId: this.sessionId,
      mode,
      actionIntent,
      trialId: trial,
      startTimestamp: Number(startTimestamp.toFixed(2)),
      startFrameId: this.currentAnnotation.startFrameId,
      labelSource: 'manual',
      metadata: { ...metadata },
    };

    this.buffer.push(startEvent);
    return startEvent;
  }

  /**
   * End the current action annotation interval.
   * Monotonically timestamps the end and pushes an annotation_end event to the stream.
   */
  endAnnotation({ metadata = {}, ...rest } = {}) {
    if (!this.recording || !this.currentAnnotation) return null;

    const endTimestamp = performance.now();
    const ann = this.currentAnnotation;
    const durationMs = Number(Math.max(0, endTimestamp - ann.startTimestamp).toFixed(2));
    const endFrameId = this.frameCount;
    const frameCount = Math.max(0, endFrameId - ann.startFrameId + 1);

    const mergedMetadata = { ...ann.metadata, ...metadata, ...rest };

    const endEvent = {
      type: 'annotation_end',
      annotationId: ann.annotationId,
      sessionId: this.sessionId,
      mode: ann.mode,
      actionIntent: ann.actionIntent,
      trialId: ann.trialId,
      startTimestamp: ann.startTimestamp,
      endTimestamp: Number(endTimestamp.toFixed(2)),
      durationMs,
      startFrameId: ann.startFrameId,
      endFrameId,
      frameCount,
      labelSource: 'manual',
      metadata: mergedMetadata,
    };

    this.buffer.push(endEvent);
    this.annotations.push(endEvent);
    this.currentAnnotation = null;
    return endEvent;
  }

  /**
   * Cancel / abort the current action annotation interval (e.g. human mistake during trial).
   * Reverts actionIntent to null on any frames recorded during this trial,
   * emits an annotation_cancel event, and clears currentAnnotation.
   */
  cancelAnnotation({ reason = 'manual_cancel' } = {}) {
    if (!this.recording || !this.currentAnnotation) return null;

    const ann = this.currentAnnotation;
    const cancelledAt = performance.now();

    // Revert actionIntent on any frames recorded during this aborted trial
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      const item = this.buffer[i];
      if (item.type === 'frame' && item.frameId >= ann.startFrameId) {
        item.actionIntent = null;
      } else if (item.type === 'annotation_start' && item.annotationId === ann.annotationId) {
        break;
      }
    }

    const cancelEvent = {
      type: 'annotation_cancel',
      annotationId: ann.annotationId,
      sessionId: this.sessionId,
      mode: ann.mode,
      actionIntent: ann.actionIntent,
      trialId: ann.trialId,
      startTimestamp: ann.startTimestamp,
      cancelledAt: Number(cancelledAt.toFixed(2)),
      reason,
      labelSource: 'manual',
    };

    this.buffer.push(cancelEvent);
    this.currentAnnotation = null;
    return cancelEvent;
  }

  /**
   * Get the active in-progress annotation object or null.
   */
  getCurrentAnnotation() {
    return this.currentAnnotation;
  }

  /**
   * Get list of all completed annotation intervals recorded in this session.
   */
  getAnnotations() {
    return [...this.annotations];
  }

  /**
   * Stop recording and finalize session metadata. Buffer is never cleared.
   */
  stop() {
    if (!this.recording) return this.summary ? { sessionId: this.sessionId, metadata: this.metadata, summary: this.summary, totalFrames: this.frameCount, frames: this.buffer, annotations: this.annotations } : null;

    // Auto-close active annotation if one was running when stop was pressed
    if (this.currentAnnotation) {
      this.endAnnotation({ autoClosed: true });
    }

    this.recording = false;
    const endedAt = new Date().toISOString();
    const durationMs = this.startTime !== null ? performance.now() - this.startTime : 0;

    // Calculate annotation statistics breakdown
    const annotationsSummary = {};
    for (const ann of this.annotations) {
      annotationsSummary[ann.actionIntent] = (annotationsSummary[ann.actionIntent] || 0) + 1;
    }

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
      totalAnnotations: this.annotations.length,
      annotationsSummary,
    };

    return {
      sessionId: this.sessionId,
      mode: this.metadata?.mode,
      metadata: this.metadata,
      summary: this.summary,
      totalFrames: this.frameCount,
      frames: this.buffer,
      annotations: this.annotations,
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
      version: '1.1.0',
      sessionId: this.sessionId,
      metadata: this.metadata,
    }));

    // Data frame and annotation records in chronological order
    for (let i = 0; i < this.buffer.length; i++) {
      lines.push(JSON.stringify(this.buffer[i]));
    }

    // Dynamic annotations breakdown if summary was not already finalized
    let annSummary = this.summary?.annotationsSummary;
    if (!annSummary) {
      annSummary = {};
      for (const ann of this.annotations) {
        annSummary[ann.actionIntent] = (annSummary[ann.actionIntent] || 0) + 1;
      }
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
      mode: this.metadata?.mode,
      totalAnnotations: this.summary?.totalAnnotations ?? this.annotations.length,
      annotationsSummary: annSummary,
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
