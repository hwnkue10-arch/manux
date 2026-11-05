import test from 'node:test';
import assert from 'node:assert/strict';
import { RawTemporalRecorder } from '../src/recorder/raw-temporal-recorder.js';

function createDummyLandmarks(baseX = 0.5, baseY = 0.5) {
  const points = [];
  for (let i = 0; i < 21; i++) {
    points.push({
      x: baseX + i * 0.01,
      y: baseY + i * 0.01,
      z: -0.05 + i * 0.005,
    });
  }
  return points;
}

test('RawTemporalRecorder: starts inactive with zero frame accumulation', () => {
  const recorder = new RawTemporalRecorder();
  assert.equal(recorder.recording, false);
  assert.equal(recorder.sessionId, null);
  assert.equal(recorder.buffer.length, 0);

  const res = recorder.recordFrame({
    timestamp: 1000,
    landmarks: createDummyLandmarks(),
    mode: 'trigger',
  });

  assert.equal(res, null);
  assert.equal(recorder.buffer.length, 0);
});

test('RawTemporalRecorder: start() initializes session metadata', () => {
  const recorder = new RawTemporalRecorder();
  const session = recorder.start({
    mode: 'trigger',
    width: 1280,
    height: 720,
    metadata: { testRunner: 'node:test' },
  });

  assert.equal(recorder.recording, true);
  assert.ok(recorder.sessionId.startsWith('manux_trigger_'));
  assert.equal(session.metadata.mode, 'trigger');
  assert.equal(session.metadata.resolution.width, 1280);
  assert.equal(session.metadata.resolution.height, 720);
  assert.equal(session.metadata.testRunner, 'node:test');
  assert.equal(recorder.buffer.length, 0);
});

test('RawTemporalRecorder: records 21 raw landmarks precisely and calculates dt', () => {
  const recorder = new RawTemporalRecorder();
  recorder.start({ mode: 'trigger' });

  const lm1 = createDummyLandmarks(0.3, 0.4);
  const frame1 = recorder.recordFrame({
    timestamp: 1000.0,
    landmarks: lm1,
    quality: { ok: true, spanPx: 120 },
    mode: 'trigger',
    geometryState: { mode: 'move', phase: 'active', activePos: { x: 0.3, y: 0.4 } },
    events: [{ type: 'moveTo', x: 0.3, y: 0.4 }],
  });

  assert.equal(frame1.frameId, 1);
  assert.equal(frame1.timestamp, 1000.0);
  assert.equal(frame1.dt, 0);
  assert.equal(frame1.tracking.tracked, true);
  assert.equal(frame1.tracking.quality.ok, true);
  assert.equal(frame1.tracking.quality.spanPx, 120);
  assert.equal(frame1.rawLandmarks.length, 21);
  assert.equal(frame1.rawLandmarks[0].x, 0.3);
  assert.equal(frame1.rawLandmarks[0].y, 0.4);
  assert.equal(frame1.actualMouseEvents.length, 1);
  assert.equal(frame1.actualMouseEvents[0].type, 'moveTo');

  const lm2 = createDummyLandmarks(0.31, 0.41);
  const frame2 = recorder.recordFrame({
    timestamp: 1033.333,
    landmarks: lm2,
    quality: true,
    mode: 'trigger',
    geometryState: { mode: 'left', gates: { thumbExtended: true } },
    events: [{ type: 'button', button: 'left', down: true }],
  });

  assert.equal(frame2.frameId, 2);
  assert.equal(frame2.timestamp, 1033.33);
  assert.ok(Math.abs(frame2.dt - 0.033333) < 0.0001);
  assert.equal(frame2.geometryState.mode, 'left');
  assert.equal(frame2.geometryState.gates.thumbExtended, true);
  assert.equal(frame2.actualMouseEvents[0].button, 'left');
  assert.equal(frame2.actualMouseEvents[0].down, true);
});

test('RawTemporalRecorder: tracking failure records rawLandmarks as null without synthetic values', () => {
  const recorder = new RawTemporalRecorder();
  recorder.start({ mode: 'trigger' });

  // Frame 1: Tracked
  recorder.recordFrame({
    timestamp: 2000,
    landmarks: createDummyLandmarks(),
    quality: true,
    mode: 'trigger',
  });

  // Frame 2: Dropped / Out of frame
  const frame2 = recorder.recordFrame({
    timestamp: 2033,
    landmarks: null,
    quality: { ok: false, reason: 'hand-too-small' },
    mode: 'trigger',
    geometryState: { mode: 'idle', phase: 'invalid' },
    events: [{ type: 'release' }],
  });

  assert.equal(frame2.frameId, 2);
  assert.equal(frame2.tracking.tracked, false);
  assert.equal(frame2.tracking.quality.ok, false);
  assert.equal(frame2.tracking.quality.reason, 'hand-too-small');
  assert.equal(frame2.rawLandmarks, null);
  assert.equal(frame2.actualMouseEvents[0].type, 'release');

  const session = recorder.stop();
  assert.equal(session.summary.totalFrames, 2);
  assert.equal(session.summary.trackedFrames, 1);
  assert.equal(session.summary.droppedFrames, 1);
  assert.equal(session.summary.trackingRatio, 0.5);
});

test('RawTemporalRecorder: separates Trigger mode and Index mode metadata and frames', () => {
  const recTrigger = new RawTemporalRecorder();
  recTrigger.start({ mode: 'trigger' });
  const fT = recTrigger.recordFrame({
    timestamp: 100,
    landmarks: createDummyLandmarks(),
    mode: 'trigger',
  });
  assert.equal(fT.mode, 'trigger');
  assert.ok(recTrigger.sessionId.includes('trigger'));

  const recIndex = new RawTemporalRecorder();
  recIndex.start({ mode: 'index' });
  const fI = recIndex.recordFrame({
    timestamp: 100,
    landmarks: createDummyLandmarks(),
    mode: 'index',
  });
  assert.equal(fI.mode, 'index');
  assert.ok(recIndex.sessionId.includes('index'));
});

test('RawTemporalRecorder: toJSONL() produces valid JSON Lines format', () => {
  const recorder = new RawTemporalRecorder();
  recorder.start({ mode: 'trigger', width: 640, height: 480 });

  recorder.recordFrame({
    timestamp: 1000,
    landmarks: createDummyLandmarks(),
    mode: 'trigger',
    geometryState: { mode: 'move' },
    events: [{ type: 'moveTo', x: 0.5, y: 0.5 }],
  });

  recorder.recordFrame({
    timestamp: 1033,
    landmarks: null,
    mode: 'trigger',
  });

  const jsonl = recorder.toJSONL();
  const lines = jsonl.trim().split('\n');

  assert.equal(lines.length, 4); // Header + 2 Frames + Summary

  const header = JSON.parse(lines[0]);
  assert.equal(header.type, 'header');
  assert.equal(header.sessionId, recorder.sessionId);
  assert.equal(header.metadata.mode, 'trigger');

  const frame1 = JSON.parse(lines[1]);
  assert.equal(frame1.type, 'frame');
  assert.equal(frame1.frameId, 1);
  assert.equal(frame1.rawLandmarks.length, 21);

  const frame2 = JSON.parse(lines[2]);
  assert.equal(frame2.type, 'frame');
  assert.equal(frame2.frameId, 2);
  assert.equal(frame2.rawLandmarks, null);

  const summary = JSON.parse(lines[3]);
  assert.equal(summary.type, 'summary');
  assert.equal(summary.totalFrames, 2);
  assert.equal(summary.trackedFrames, 1);
  assert.equal(summary.droppedFrames, 1);
});

test('RawTemporalRecorder: maxFrames limit halts recording safely', () => {
  const recorder = new RawTemporalRecorder({ maxFrames: 3 });
  recorder.start({ mode: 'trigger' });

  assert.ok(recorder.recordFrame({ timestamp: 10, landmarks: createDummyLandmarks() }));
  assert.ok(recorder.recordFrame({ timestamp: 20, landmarks: createDummyLandmarks() }));
  assert.ok(recorder.recordFrame({ timestamp: 30, landmarks: createDummyLandmarks() }));

  // 4th frame exceeds maxFrames
  const overflowFrame = recorder.recordFrame({ timestamp: 40, landmarks: createDummyLandmarks() });
  assert.equal(overflowFrame, null);
  assert.equal(recorder.recording, false);
  assert.equal(recorder.buffer.length, 3);
});
