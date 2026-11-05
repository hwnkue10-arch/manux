import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const CLASSES = ['move', 'left_click', 'right_click', 'both_click', 'scroll', 'idle'];
const CLASS_TO_IDX = Object.fromEntries(CLASSES.map((c, i) => [c, i]));

function extractFeatures(pts) {
  const p0 = pts[0];
  const p9 = pts[9];
  const palm = Math.hypot(p9.x - p0.x, p9.y - p0.y) || 1e-4;

  const feats = [];
  // 1. Normalized 3D relative positions (21 * 3 = 63 features)
  for (let i = 0; i < 21; i++) {
    feats.push((pts[i].x - p0.x) / palm);
    feats.push((pts[i].y - p0.y) / palm);
    feats.push((((pts[i].z ?? 0) - (p0.z ?? 0)) * 0.45) / palm);
  }

  // 2. Key anatomical finger-to-palm distances (5 features)
  // Thumb tip (4), Index tip (8), Middle tip (12), Ring tip (16), Pinky tip (20)
  [4, 8, 12, 16, 20].forEach(tip => {
    feats.push(Math.hypot(pts[tip].x - p0.x, pts[tip].y - p0.y) / palm);
  });

  // 3. Inter-finger clearances (8 features)
  feats.push(Math.hypot(pts[4].x - pts[5].x, pts[4].y - pts[5].y) / palm); // Thumb to Index MCP
  feats.push(Math.hypot(pts[20].x - pts[17].x, pts[20].y - pts[17].y) / palm); // Pinky to Pinky MCP
  feats.push(Math.hypot(pts[20].x - pts[16].x, pts[20].y - pts[16].y) / palm); // Pinky tip to Ring tip
  feats.push(Math.hypot(pts[8].x - pts[12].x, pts[8].y - pts[12].y) / palm); // Index tip to Middle tip (V-sign)
  feats.push(Math.hypot(pts[4].x - pts[20].x, pts[4].y - pts[20].y) / palm); // Thumb tip to Pinky tip (both vs right)
  feats.push(Math.hypot(pts[4].x - pts[9].x, pts[4].y - pts[9].y) / palm); // Thumb tip to Middle MCP
  feats.push(Math.hypot(pts[4].x - pts[2].x, pts[4].y - pts[2].y) / palm); // Thumb tip to Thumb CMC
  feats.push(Math.hypot(pts[20].x - pts[9].x, pts[20].y - pts[9].y) / palm); // Pinky tip to Middle MCP

  return feats;
}

function findJsonFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findJsonFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      results.push(fullPath);
    }
  }
  return results;
}

console.log('Loading dataset from:', DATA_DIR);
const allSamples = [];

const dataFiles = findJsonFiles(DATA_DIR);
console.log(`Discovered ${dataFiles.length} JSON data files:`);
for (const filePath of dataFiles) {
  const rel = path.relative(DATA_DIR, filePath);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const samples = data.samples || (Array.isArray(data) ? data : []);
  let fileValid = 0;
  for (const s of samples) {
    if (!s.rawLandmarks || s.rawLandmarks.length !== 21) continue;
    const action = s.groundTruthAction || s.action;
    const y = CLASS_TO_IDX[action];
    if (y !== undefined) {
      const x = extractFeatures(s.rawLandmarks);
      allSamples.push({ x, y, cls: action });
      fileValid++;
    }
  }
  console.log(` - ${rel}: ${fileValid} valid samples`);
}

console.log(`Loaded ${allSamples.length} total valid samples.`);
const featDim = allSamples[0].x.length;
console.log(`Feature vector dimension: ${featDim}`);

// Shuffle dataset with fixed seed for determinism
let seed = 42;
function random() {
  seed = (seed * 9301 + 49297) % 233280;
  return seed / 233280;
}

for (let i = allSamples.length - 1; i > 0; i--) {
  const j = Math.floor(random() * (i + 1));
  [allSamples[i], allSamples[j]] = [allSamples[j], allSamples[i]];
}

// 80/20 train/test split
const splitIdx = Math.floor(allSamples.length * 0.8);
const trainData = allSamples.slice(0, splitIdx);
const testData = allSamples.slice(splitIdx);
console.log(`Train samples: ${trainData.length}, Test samples: ${testData.length}`);

// Neural Network Architecture: 2-Layer MLP (featDim -> H -> 6)
const H = 64; // hidden units (expanded to 64 for 2nd vulnerability precision)
const NUM_CLASSES = 6;

// He initialization
function randn() {
  const u1 = Math.max(1e-7, random());
  const u2 = random();
  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
}

const W1 = Array.from({ length: H }, () => Array.from({ length: featDim }, () => randn() * Math.sqrt(2.0 / featDim)));
const b1 = new Array(H).fill(0.01);
const W2 = Array.from({ length: NUM_CLASSES }, () => Array.from({ length: H }, () => randn() * Math.sqrt(2.0 / H)));
const b2 = new Array(NUM_CLASSES).fill(0.0);

// Adam Optimizer State
function createAdam(shape) {
  return {
    m: Array.isArray(shape) ? shape.map(row => new Array(row).fill(0)) : new Array(shape).fill(0),
    v: Array.isArray(shape) ? shape.map(row => new Array(row).fill(0)) : new Array(shape).fill(0)
  };
}

const adamW1_m = Array.from({ length: H }, () => new Array(featDim).fill(0));
const adamW1_v = Array.from({ length: H }, () => new Array(featDim).fill(0));
const adamb1_m = new Array(H).fill(0);
const adamb1_v = new Array(H).fill(0);

const adamW2_m = Array.from({ length: NUM_CLASSES }, () => new Array(H).fill(0));
const adamW2_v = Array.from({ length: NUM_CLASSES }, () => new Array(H).fill(0));
const adamb2_m = new Array(NUM_CLASSES).fill(0);
const adamb2_v = new Array(NUM_CLASSES).fill(0);

function forward(x) {
  const h = new Float64Array(H);
  for (let i = 0; i < H; i++) {
    let sum = b1[i];
    const w1_i = W1[i];
    for (let j = 0; j < featDim; j++) {
      sum += w1_i[j] * x[j];
    }
    // LeakyReLU
    h[i] = sum > 0 ? sum : sum * 0.05;
  }

  const logits = new Float64Array(NUM_CLASSES);
  let maxLogit = -Infinity;
  for (let c = 0; c < NUM_CLASSES; c++) {
    let sum = b2[c];
    const w2_c = W2[c];
    for (let i = 0; i < H; i++) {
      sum += w2_c[i] * h[i];
    }
    logits[c] = sum;
    if (sum > maxLogit) maxLogit = sum;
  }

  // Softmax
  const probs = new Float64Array(NUM_CLASSES);
  let sumExp = 0;
  for (let c = 0; c < NUM_CLASSES; c++) {
    const e = Math.exp(logits[c] - maxLogit);
    probs[c] = e;
    sumExp += e;
  }
  for (let c = 0; c < NUM_CLASSES; c++) {
    probs[c] /= sumExp;
  }

  return { h, logits, probs };
}

function evaluate(data) {
  let correct = 0;
  const cm = Array.from({ length: 6 }, () => new Array(6).fill(0));
  for (const s of data) {
    const { probs } = forward(s.x);
    let pred = 0;
    let maxP = probs[0];
    for (let c = 1; c < 6; c++) {
      if (probs[c] > maxP) {
        maxP = probs[c];
        pred = c;
      }
    }
    if (pred === s.y) correct++;
    cm[s.y][pred]++;
  }
  const acc = (correct / data.length) * 100;
  return { acc, correct, total: data.length, cm };
}

// Hyperparameters
const EPOCHS = 40;
const BATCH_SIZE = 64;
const LR = 0.003;
const BETA1 = 0.9, BETA2 = 0.999, EPS = 1e-8, L2 = 1e-4;
let t = 0;

console.log(`Starting training for ${EPOCHS} epochs...`);
const startTime = Date.now();

for (let ep = 1; ep <= EPOCHS; ep++) {
  // Shuffle training data per epoch
  for (let i = trainData.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [trainData[i], trainData[j]] = [trainData[j], trainData[i]];
  }

  for (let bStart = 0; bStart < trainData.length; bStart += BATCH_SIZE) {
    const batch = trainData.slice(bStart, bStart + BATCH_SIZE);
    const B = batch.length;
    t++;

    const gW1 = Array.from({ length: H }, () => new Float64Array(featDim));
    const gb1 = new Float64Array(H);
    const gW2 = Array.from({ length: NUM_CLASSES }, () => new Float64Array(H));
    const gb2 = new Float64Array(NUM_CLASSES);

    for (const s of batch) {
      const { h, probs } = forward(s.x);

      // Gradient of cross-entropy w.r.t logits
      const dLogits = new Float64Array(NUM_CLASSES);
      for (let c = 0; c < NUM_CLASSES; c++) {
        dLogits[c] = probs[c] - (c === s.y ? 1.0 : 0.0);
        gb2[c] += dLogits[c] / B;
        const w2_c = W2[c];
        for (let i = 0; i < H; i++) {
          gW2[c][i] += (dLogits[c] * h[i]) / B;
        }
      }

      // Backprop into hidden layer
      for (let i = 0; i < H; i++) {
        let dh = 0;
        for (let c = 0; c < NUM_CLASSES; c++) {
          dh += dLogits[c] * W2[c][i];
        }
        const dhRelu = h[i] > 0 ? dh : dh * 0.05;
        gb1[i] += dhRelu / B;
        for (let j = 0; j < featDim; j++) {
          gW1[i][j] += (dhRelu * s.x[j]) / B;
        }
      }
    }

    // Adam step
    const lr_t = LR * Math.sqrt(1 - Math.pow(BETA2, t)) / (1 - Math.pow(BETA1, t));

    // Update W2, b2
    for (let c = 0; c < NUM_CLASSES; c++) {
      adamb2_m[c] = BETA1 * adamb2_m[c] + (1 - BETA1) * gb2[c];
      adamb2_v[c] = BETA2 * adamb2_v[c] + (1 - BETA2) * (gb2[c] * gb2[c]);
      b2[c] -= lr_t * adamb2_m[c] / (Math.sqrt(adamb2_v[c]) + EPS);

      for (let i = 0; i < H; i++) {
        const grad = gW2[c][i] + L2 * W2[c][i];
        adamW2_m[c][i] = BETA1 * adamW2_m[c][i] + (1 - BETA1) * grad;
        adamW2_v[c][i] = BETA2 * adamW2_v[c][i] + (1 - BETA2) * (grad * grad);
        W2[c][i] -= lr_t * adamW2_m[c][i] / (Math.sqrt(adamW2_v[c][i]) + EPS);
      }
    }

    // Update W1, b1
    for (let i = 0; i < H; i++) {
      adamb1_m[i] = BETA1 * adamb1_m[i] + (1 - BETA1) * gb1[i];
      adamb1_v[i] = BETA2 * adamb1_v[i] + (1 - BETA2) * (gb1[i] * gb1[i]);
      b1[i] -= lr_t * adamb1_m[i] / (Math.sqrt(adamb1_v[i]) + EPS);

      for (let j = 0; j < featDim; j++) {
        const grad = gW1[i][j] + L2 * W1[i][j];
        adamW1_m[i][j] = BETA1 * adamW1_m[i][j] + (1 - BETA1) * grad;
        adamW1_v[i][j] = BETA2 * adamW1_v[i][j] + (1 - BETA2) * (grad * grad);
        W1[i][j] -= lr_t * adamW1_m[i][j] / (Math.sqrt(adamW1_v[i][j]) + EPS);
      }
    }
  }

  if (ep % 10 === 0 || ep === EPOCHS) {
    const tr = evaluate(trainData);
    const te = evaluate(testData);
    console.log(`Epoch ${ep}/${EPOCHS} - Train Acc: ${tr.acc.toFixed(2)}%, Test Acc: ${te.acc.toFixed(2)}%`);
  }
}

const elapsed = Date.now() - startTime;
console.log(`Training completed in ${elapsed}ms (${(elapsed/1000).toFixed(2)}s)`);

const testEval = evaluate(testData);
console.log(`\nFinal Test Accuracy: ${testEval.acc.toFixed(2)}% (${testEval.correct}/${testEval.total})`);

console.log('\nTest Confusion Matrix:');
console.log('GT \\ Pred\t' + CLASSES.join('\t'));
for (let i = 0; i < 6; i++) {
  console.log(`${CLASSES[i]}\t\t${testEval.cm[i].join('\t')}`);
}

// Measure single-frame inference latency (micro-benchmark)
const benchIters = 10000;
const benchStart = performance.now();
for (let b = 0; b < benchIters; b++) {
  forward(testData[b % testData.length].x);
}
const benchTime = (performance.now() - benchStart) / benchIters;
console.log(`\nAverage single-frame inference latency: ${(benchTime * 1000).toFixed(2)} microseconds (${benchTime.toFixed(4)} ms)`);

// Export trained weights as standalone pure JS module
const modelWeights = {
  version: '1.0.0',
  architecture: '2-Layer MLP (LeakyReLU + Softmax)',
  featDim,
  hiddenUnits: H,
  numClasses: NUM_CLASSES,
  classes: CLASSES,
  testAccuracy: Number(testEval.acc.toFixed(2)),
  W1: W1.map(row => row.map(v => Number(v.toFixed(5)))),
  b1: b1.map(v => Number(v.toFixed(5))),
  W2: W2.map(row => row.map(v => Number(v.toFixed(5)))),
  b2: b2.map(v => Number(v.toFixed(5))),
};

const modelCode = `/**
 * SpatialPoseModel (ManuX Lightweight Spatial Landmark Classifier)
 * Auto-generated by scripts/train-spatial-model.mjs
 * Test Accuracy: ${testEval.acc.toFixed(2)}% across ${testEval.total} held-out test samples.
 * Zero-dependency, pure JavaScript, zero-GC inference (< 0.05ms per frame).
 */

export const MODEL_METADATA = ${JSON.stringify({
  version: '1.0.0',
  classes: CLASSES,
  testAccuracy: Number(testEval.acc.toFixed(2)),
  featDim,
  hiddenUnits: H,
  trainedAt: new Date().toISOString(),
}, null, 2)};

const W1 = ${JSON.stringify(modelWeights.W1)};
const b1 = ${JSON.stringify(modelWeights.b1)};
const W2 = ${JSON.stringify(modelWeights.W2)};
const b2 = ${JSON.stringify(modelWeights.b2)};

const CLASSES = ${JSON.stringify(CLASSES)};
const H = ${H};
const NUM_CLASSES = ${NUM_CLASSES};
const FEAT_DIM = ${featDim};

// Pre-allocated buffers for zero-GC inference
const featBuf = new Float64Array(FEAT_DIM);
const hBuf = new Float64Array(H);
const logitsBuf = new Float64Array(NUM_CLASSES);
const probsBuf = new Float64Array(NUM_CLASSES);

export function extractPoseFeatures(pts, outBuf = featBuf) {
  if (!pts || pts.length !== 21) return null;
  const p0 = pts[0];
  const p9 = pts[9];
  const palm = Math.hypot(p9.x - p0.x, p9.y - p0.y) || 1e-4;

  let idx = 0;
  for (let i = 0; i < 21; i++) {
    const pt = pts[i];
    outBuf[idx++] = (pt.x - p0.x) / palm;
    outBuf[idx++] = (pt.y - p0.y) / palm;
    outBuf[idx++] = (((pt.z ?? 0) - (p0.z ?? 0)) * 0.45) / palm;
  }

  // Key finger distances from wrist
  outBuf[idx++] = Math.hypot(pts[4].x - p0.x, pts[4].y - p0.y) / palm;
  outBuf[idx++] = Math.hypot(pts[8].x - p0.x, pts[8].y - p0.y) / palm;
  outBuf[idx++] = Math.hypot(pts[12].x - p0.x, pts[12].y - p0.y) / palm;
  outBuf[idx++] = Math.hypot(pts[16].x - p0.x, pts[16].y - p0.y) / palm;
  outBuf[idx++] = Math.hypot(pts[20].x - p0.x, pts[20].y - p0.y) / palm;

  // Inter-finger clearances (8 features)
  outBuf[idx++] = Math.hypot(pts[4].x - pts[5].x, pts[4].y - pts[5].y) / palm;
  outBuf[idx++] = Math.hypot(pts[20].x - pts[17].x, pts[20].y - pts[17].y) / palm;
  outBuf[idx++] = Math.hypot(pts[20].x - pts[16].x, pts[20].y - pts[16].y) / palm;
  outBuf[idx++] = Math.hypot(pts[8].x - pts[12].x, pts[8].y - pts[12].y) / palm;
  outBuf[idx++] = Math.hypot(pts[4].x - pts[20].x, pts[4].y - pts[20].y) / palm;
  outBuf[idx++] = Math.hypot(pts[4].x - pts[9].x, pts[4].y - pts[9].y) / palm;
  outBuf[idx++] = Math.hypot(pts[4].x - pts[2].x, pts[4].y - pts[2].y) / palm;
  outBuf[idx++] = Math.hypot(pts[20].x - pts[9].x, pts[20].y - pts[9].y) / palm;

  return outBuf;
}

export function predictPose(pts) {
  const x = extractPoseFeatures(pts, featBuf);
  if (!x) return null;

  // Hidden Layer with LeakyReLU
  for (let i = 0; i < H; i++) {
    let sum = b1[i];
    const w1_i = W1[i];
    for (let j = 0; j < FEAT_DIM; j++) {
      sum += w1_i[j] * x[j];
    }
    hBuf[i] = sum > 0 ? sum : sum * 0.05;
  }

  // Output Layer
  let maxLogit = -Infinity;
  for (let c = 0; c < NUM_CLASSES; c++) {
    let sum = b2[c];
    const w2_c = W2[c];
    for (let i = 0; i < H; i++) {
      sum += w2_c[i] * hBuf[i];
    }
    logitsBuf[c] = sum;
    if (sum > maxLogit) maxLogit = sum;
  }

  // Softmax
  let sumExp = 0;
  for (let c = 0; c < NUM_CLASSES; c++) {
    const e = Math.exp(logitsBuf[c] - maxLogit);
    probsBuf[c] = e;
    sumExp += e;
  }

  let bestClass = CLASSES[0];
  let maxProb = 0;
  const probabilities = {};

  for (let c = 0; c < NUM_CLASSES; c++) {
    const p = probsBuf[c] / sumExp;
    probabilities[CLASSES[c]] = Number(p.toFixed(4));
    if (p > maxProb) {
      maxProb = p;
      bestClass = CLASSES[c];
    }
  }

  return {
    action: bestClass,
    confidence: Number(maxProb.toFixed(4)),
    probabilities,
  };
}
`;

fs.writeFileSync(path.join(process.cwd(), 'src', 'spatial-pose-model.js'), modelCode, 'utf8');
console.log('Model generated and exported to src/spatial-pose-model.js successfully!');

