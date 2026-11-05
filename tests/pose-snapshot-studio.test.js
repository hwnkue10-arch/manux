import test from 'node:test';
import assert from 'node:assert/strict';
import { PoseSnapshotStudio, SUPPORTED_ACTIONS, normalizeActionId } from '../src/recorder/pose-snapshot-studio.js';

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

test('PoseSnapshotStudio: captures valid posture sample when predicted matches groundTruth', () => {
  const studio = new PoseSnapshotStudio();
  const lm = createDummyLandmarks(0.4, 0.3);

  const res = studio.captureSnapshot({
    groundTruthAction: 'left_click',
    landmarks: lm,
    quality: { ok: true, handPresent: true, spanPx: 130 },
    mode: 'trigger',
    geometryState: { mode: 'left_click', phase: 'active', activePos: { x: 0.4, y: 0.3 } },
  });

  assert.equal(res.success, true);
  assert.equal(res.totalSamples, 1);

  const s = res.sample;
  assert.ok(s.sampleId.startsWith('snap_trigger_left_click_'));
  assert.equal(s.mode, 'trigger');
  assert.equal(s.trackingValid, true);
  assert.equal(s.predictedAction, 'left_click');
  assert.equal(s.groundTruthAction, 'left_click');
  assert.equal(s.isMatch, true);
  assert.equal(s.isFailureSample, false);
  assert.equal(s.rawLandmarks.length, 21);
  assert.equal(s.rawLandmarks[0].x, 0.4);
});

test('PoseSnapshotStudio: captures failure sample (discrepancy) when predicted does not match groundTruth', () => {
  const studio = new PoseSnapshotStudio();
  const lm = createDummyLandmarks(0.5, 0.5);

  // Human user is actually doing "right_click", but Geometry Controller erroneously predicted "idle" (Corner case failure)
  const res = studio.captureSnapshot({
    groundTruthAction: 'right_click',
    landmarks: lm,
    quality: { ok: true, handPresent: true },
    mode: 'trigger',
    geometryState: { mode: 'idle', phase: 'holding' },
  });

  assert.equal(res.success, true);
  const s = res.sample;
  assert.equal(s.groundTruthAction, 'right_click');
  assert.equal(s.predictedAction, 'idle');
  assert.equal(s.isMatch, false);
  assert.equal(s.isFailureSample, true);
});

test('PoseSnapshotStudio: rejects capture when tracking is invalid or quality is bad', () => {
  const studio = new PoseSnapshotStudio();

  // 1. Missing landmarks
  const res1 = studio.captureSnapshot({
    groundTruthAction: 'move',
    landmarks: null,
    quality: true,
  });
  assert.equal(res1.success, false);
  assert.equal(res1.reason, 'no_hand_tracked');

  // 2. Incomplete landmarks (fewer than 21)
  const res2 = studio.captureSnapshot({
    groundTruthAction: 'move',
    landmarks: [{ x: 0.5, y: 0.5 }],
    quality: true,
  });
  assert.equal(res2.success, false);
  assert.equal(res2.reason, 'no_hand_tracked');

  // 3. Poor quality flag
  const res3 = studio.captureSnapshot({
    groundTruthAction: 'move',
    landmarks: createDummyLandmarks(),
    quality: { ok: false, reason: 'hand-too-far' },
  });
  assert.equal(res3.success, false);
  assert.equal(res3.reason, 'poor_tracking_quality');

  assert.equal(studio.getSamples().length, 0);
});

test('PoseSnapshotStudio: action validation rejects unknown actions and accepts both_click', () => {
  const studio = new PoseSnapshotStudio();
  const lm = createDummyLandmarks();

  // Unknown action rejected
  const res = studio.captureSnapshot({
    groundTruthAction: 'unknown_action_xyz',
    landmarks: lm,
    quality: true,
    mode: 'trigger',
  });

  assert.equal(res.success, false);
  assert.equal(res.reason, 'unsupported_action_for_mode');
  assert.equal(studio.getSamples().length, 0);

  // both_click accepted
  const resBoth = studio.captureSnapshot({
    groundTruthAction: 'both_click',
    landmarks: lm,
    quality: true,
    mode: 'trigger',
  });
  assert.equal(resBoth.success, true);
  assert.equal(studio.getSamples().length, 1);
});

test('PoseSnapshotStudio: controller mode left/right/both normalizes cleanly to left_click/right_click/both_click', () => {
  const studio = new PoseSnapshotStudio();
  const lm = createDummyLandmarks();

  // Controller returns raw 'left', groundTruth is 'left_click' -> must be a MATCH!
  const resLeft = studio.captureSnapshot({
    groundTruthAction: 'left_click',
    geometryState: { mode: 'left' },
    landmarks: lm,
    mode: 'trigger',
  });
  assert.equal(resLeft.success, true);
  assert.equal(resLeft.sample.predictedAction, 'left_click');
  assert.equal(resLeft.sample.isMatch, true);
  assert.equal(resLeft.sample.isFailureSample, false);

  // Controller returns raw 'right', groundTruth is 'right_click' -> must be a MATCH!
  const resRight = studio.captureSnapshot({
    groundTruthAction: 'right_click',
    geometryState: { mode: 'right' },
    landmarks: lm,
    mode: 'trigger',
  });
  assert.equal(resRight.success, true);
  assert.equal(resRight.sample.predictedAction, 'right_click');
  assert.equal(resRight.sample.isMatch, true);

  // Controller returns raw 'both', groundTruth is 'both_click' -> must be a MATCH!
  const resBoth = studio.captureSnapshot({
    groundTruthAction: 'both_click',
    geometryState: { mode: 'both' },
    landmarks: lm,
    mode: 'trigger',
  });
  assert.equal(resBoth.success, true);
  assert.equal(resBoth.sample.predictedAction, 'both_click');
  assert.equal(resBoth.sample.isMatch, true);
});

test('PoseSnapshotStudio: deleteLastSample() and deleteSampleById() support undo operations', () => {
  const studio = new PoseSnapshotStudio();
  const lm = createDummyLandmarks();

  studio.captureSnapshot({ groundTruthAction: 'move', landmarks: lm, mode: 'trigger' });
  const s2 = studio.captureSnapshot({ groundTruthAction: 'left_click', landmarks: lm, mode: 'trigger' }).sample;
  studio.captureSnapshot({ groundTruthAction: 'scroll', landmarks: lm, mode: 'trigger' });

  assert.equal(studio.getSamples().length, 3);

  // Delete last (undo scroll)
  const undone = studio.deleteLastSample();
  assert.equal(undone.groundTruthAction, 'scroll');
  assert.equal(studio.getSamples().length, 2);

  // Delete by id (delete left_click)
  const deleted = studio.deleteSampleById(s2.sampleId);
  assert.equal(deleted.sampleId, s2.sampleId);
  assert.equal(studio.getSamples().length, 1);
  assert.equal(studio.getSamples()[0].groundTruthAction, 'move');
});

test('PoseSnapshotStudio: getStats() calculates accuracy, matches, and discrepancies accurately', () => {
  const studio = new PoseSnapshotStudio();
  const lm = createDummyLandmarks();

  // 1 match (move == move)
  studio.captureSnapshot({ groundTruthAction: 'move', geometryState: { mode: 'move' }, landmarks: lm });
  // 1 match (left_click == left_click)
  studio.captureSnapshot({ groundTruthAction: 'left_click', geometryState: { mode: 'left_click' }, landmarks: lm });
  // 1 discrepancy (right_click != idle)
  studio.captureSnapshot({ groundTruthAction: 'right_click', geometryState: { mode: 'idle' }, landmarks: lm });

  const stats = studio.getStats();
  assert.equal(stats.total, 3);
  assert.equal(stats.matches, 2);
  assert.equal(stats.discrepancies, 1);
  assert.equal(stats.accuracy, 0.6667);
  assert.equal(stats.byGroundTruth.move, 1);
  assert.equal(stats.byGroundTruth.left_click, 1);
  assert.equal(stats.byGroundTruth.right_click, 1);
  assert.equal(stats.byPredicted.idle, 1);
});

test('PoseSnapshotStudio: toJSON() and toJSONL() produce valid schemas', () => {
  const studio = new PoseSnapshotStudio();
  const lm = createDummyLandmarks();

  studio.captureSnapshot({
    groundTruthAction: 'move',
    geometryState: { mode: 'move' },
    landmarks: lm,
    mode: 'trigger',
  });

  // JSON
  const jsonStr = studio.toJSON();
  const parsed = JSON.parse(jsonStr);
  assert.equal(parsed.type, 'manux_pose_snapshot_dataset');
  assert.equal(parsed.summary.total, 1);
  assert.equal(parsed.samples.length, 1);
  assert.equal(parsed.samples[0].groundTruthAction, 'move');

  // JSONL
  const jsonlStr = studio.toJSONL();
  const lines = jsonlStr.trim().split('\n');
  assert.equal(lines.length, 3); // header + sample + summary
  assert.equal(JSON.parse(lines[0]).type, 'header');
  assert.equal(JSON.parse(lines[1]).groundTruthAction, 'move');
  assert.equal(JSON.parse(lines[2]).type, 'summary');
});

test('PoseSnapshotStudio: captureMode switching between snapshot and stream', () => {
  const studio = new PoseSnapshotStudio();
  assert.equal(studio.captureMode, 'snapshot');
  assert.equal(studio.isStreaming, false);

  studio.setCaptureMode('stream');
  assert.equal(studio.captureMode, 'stream');

  studio.startStream();
  assert.equal(studio.isStreaming, true);

  // Switching back to snapshot automatically stops active stream
  studio.setCaptureMode('snapshot');
  assert.equal(studio.captureMode, 'snapshot');
  assert.equal(studio.isStreaming, false);

  // Invalid mode throws
  assert.throws(() => studio.setCaptureMode('invalid'), /Invalid capture mode/);
});

test('PoseSnapshotStudio: processStreamFrame handles continuous stream, throttling, and discrepancy filtering', () => {
  const studio = new PoseSnapshotStudio({ streamThrottleMs: 50 });
  const lm = createDummyLandmarks();

  // 1. Inactive stream returns stream_not_active
  const rInactive = studio.processStreamFrame({ landmarks: lm, timestamp: 100 });
  assert.equal(rInactive.success, false);
  assert.equal(rInactive.reason, 'stream_not_active');

  // Start stream with discrepancy-only filtering
  studio.startStream();
  studio.setStreamDiscrepancyOnly(true);
  studio.setSelectedGroundTruth('right_click');

  // 2. Normal matching frame (predicted: right_click == groundTruth: right_click) -> skipped
  const rMatch = studio.processStreamFrame({
    landmarks: lm,
    geometryState: { mode: 'right_click' },
    timestamp: 200,
  });
  assert.equal(rMatch.success, false);
  assert.equal(rMatch.reason, 'match_skipped_discrepancy_only');
  assert.equal(studio.getSamples().length, 0);

  // 3. Discrepancy frame (user holding right_click, but system predicted move at awkward angle) -> captured!
  const rDisc = studio.processStreamFrame({
    landmarks: lm,
    geometryState: { mode: 'move' },
    timestamp: 260,
  });
  assert.equal(rDisc.success, true);
  assert.equal(rDisc.streamCaptured, true);
  assert.equal(rDisc.isDiscrepancy, true);
  assert.equal(studio.getSamples().length, 1);
  assert.equal(studio.getSamples()[0].source, 'stream');
  assert.equal(studio.getSamples()[0].isFailureSample, true);

  // 4. Throttling: frame arriving too quickly (< 50ms) is skipped
  const rThrottle = studio.processStreamFrame({
    landmarks: lm,
    geometryState: { mode: 'move' },
    timestamp: 280, // only 20ms after 260
  });
  assert.equal(rThrottle.success, false);
  assert.equal(rThrottle.reason, 'throttled');
  assert.equal(studio.getSamples().length, 1);

  // 5. With streamDiscrepancyOnly = false, matching frames are also recorded
  studio.setStreamDiscrepancyOnly(false);
  const rAll = studio.processStreamFrame({
    landmarks: lm,
    geometryState: { mode: 'right_click' },
    timestamp: 330,
  });
  assert.equal(rAll.success, true);
  assert.equal(rAll.streamCaptured, true);
  assert.equal(rAll.isDiscrepancy, false);
  assert.equal(studio.getSamples().length, 2);

  // 6. Stop stream
  studio.stopStream();
  assert.equal(studio.isStreaming, false);
});


