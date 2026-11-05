import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { predictPose, extractPoseFeatures, MODEL_METADATA } from '../src/spatial-pose-model.js';

function createDummyLandmarks() {
  return Array.from({ length: 21 }, (_, i) => ({
    x: 0.5 + (i * 0.01),
    y: 0.5 + (i * 0.01),
    z: 0.0,
  }));
}

test('SpatialPoseModel: metadata exports valid architecture and classes', () => {
  assert.equal(MODEL_METADATA.version, '1.0.0');
  assert.equal(Array.isArray(MODEL_METADATA.classes), true);
  assert.equal(MODEL_METADATA.classes.length, 6);
  assert.ok(MODEL_METADATA.testAccuracy > 90);
});

test('SpatialPoseModel: handles degenerate, empty, and invalid landmarks gracefully', () => {
  assert.equal(predictPose(null), null);
  assert.equal(predictPose([]), null);
  assert.equal(predictPose(new Array(10)), null);
  assert.equal(extractPoseFeatures(null), null);
});

test('SpatialPoseModel: produces normalized probabilities summing to 1.0', () => {
  const dummy = createDummyLandmarks();
  const res = predictPose(dummy);
  assert.ok(res !== null);
  assert.ok(typeof res.action === 'string');
  assert.ok(MODEL_METADATA.classes.includes(res.action));
  assert.ok(res.confidence >= 0 && res.confidence <= 1.0);

  let sum = 0;
  for (const cls of MODEL_METADATA.classes) {
    assert.ok(typeof res.probabilities[cls] === 'number');
    sum += res.probabilities[cls];
  }
  assert.ok(Math.abs(sum - 1.0) < 0.01);
});

test('SpatialPoseModel: verifies high accuracy on real collected gold dataset (>95%)', () => {
  const dataDir = path.join(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) return;

  const testFile = fs.existsSync(path.join(dataDir, 'legacy', 'manux_pose_snapshots_trigger_scroll.json'))
    ? path.join(dataDir, 'legacy', 'manux_pose_snapshots_trigger_scroll.json')
    : path.join(dataDir, 'manux_pose_snapshots_trigger_scroll.json');
  if (!fs.existsSync(testFile)) return;

  const raw = JSON.parse(fs.readFileSync(testFile, 'utf8'));
  let correct = 0;
  const samples = raw.samples.slice(0, 200);

  for (const s of samples) {
    const res = predictPose(s.rawLandmarks);
    if (res && res.action === 'scroll') correct++;
  }

  const acc = (correct / samples.length) * 100;
  assert.ok(acc >= 95.0, `Expected scroll accuracy >= 95%, got ${acc.toFixed(1)}%`);
});

test('SpatialPoseModel: ultra-low inference latency (< 0.1ms per frame)', () => {
  const dummy = createDummyLandmarks();
  // Warmup
  for (let i = 0; i < 100; i++) predictPose(dummy);

  const iters = 1000;
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) {
    predictPose(dummy);
  }
  const avgMs = (performance.now() - t0) / iters;
  assert.ok(avgMs < 0.1, `Inference latency too slow: ${avgMs.toFixed(4)} ms`);
});

