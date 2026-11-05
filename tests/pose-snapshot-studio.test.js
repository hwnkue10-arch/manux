import test from 'node:test';
import assert from 'node:assert/strict';
import { PoseSnapshotStudio, SUPPORTED_ACTIONS } from '../src/recorder/pose-snapshot-studio.js';

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

test('PoseSnapshotStudio: mode segregation rejects unsupported actions (freeze in Index mode)', () => {
  const studio = new PoseSnapshotStudio();
  const lm = createDummyLandmarks();

  // Index mode does not have "freeze"
  const res = studio.captureSnapshot({
    groundTruthAction: 'freeze',
    landmarks: lm,
    quality: true,
    mode: 'index',
  });

  assert.equal(res.success, false);
  assert.equal(res.reason, 'unsupported_action_for_mode');
  assert.equal(studio.getSamples().length, 0);

  // Trigger mode accepts "freeze"
  const resTrigger = studio.captureSnapshot({
    groundTruthAction: 'freeze',
    landmarks: lm,
    quality: true,
    mode: 'trigger',
  });
  assert.equal(resTrigger.success, true);
  assert.equal(studio.getSamples().length, 1);
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
