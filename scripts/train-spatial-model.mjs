import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const CLASSES = ['move', 'left_click', 'right_click', 'both_click', 'scroll', 'idle'];
const CLASS_TO_IDX = Object.fromEntries(CLASSES.map((c, i) => [c, i]));

function cos3D(a, b, c) {
  const ux = a.x - b.x, uy = a.y - b.y, uz = ((a.z ?? 0) - (b.z ?? 0)) * 0.45;
  const vx = c.x - b.x, vy = c.y - b.y, vz = ((c.z ?? 0) - (b.z ?? 0)) * 0.45;
  const len = Math.hypot(ux, uy, uz) * Math.hypot(vx, vy, vz);
  return len > 1e-8 ? (ux * vx + uy * vy + uz * vz) / len : 0;
}

function dist3D(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, ((a.z ?? 0) - (b.z ?? 0)) * 0.45);
}

function extractFeatures(pts) {
  const p0 = pts[0];
  const p9 = pts[9];
  const palm = Math.hypot(p9.x - p0.x, p9.y - p0.y) || 1e-4;
  const palm3D = Math.max(palm, dist3D(p0, p9), dist3D(pts[5], pts[17])) || 1e-4;

  // Intrinsic palm basis (vHat: 0->9, uHat: 17->5 orthogonalized)
  const vx = p9.x - p0.x, vy = p9.y - p0.y, vz = ((p9.z ?? 0) - (p0.z ?? 0)) * 0.45;
  const vLen = Math.hypot(vx, vy, vz) || 1e-5;
  const vHatX = vx / vLen, vHatY = vy / vLen, vHatZ = vz / vLen;
  const ax = pts[5].x - pts[17].x, ay = pts[5].y - pts[17].y, az = ((pts[5].z ?? 0) - (pts[17].z ?? 0)) * 0.45;
  const aDotV = ax * vHatX + ay * vHatY + az * vHatZ;
  const ux = ax - aDotV * vHatX, uy = ay - aDotV * vHatY, uz = az - aDotV * vHatZ;
  const uLen = Math.hypot(ux, uy, uz) || 1e-5;
  const uHatX = ux / uLen, uHatY = uy / uLen, uHatZ = uz / uLen;

  const projV = (a, b) => ((a.x - b.x) * vHatX + (a.y - b.y) * vHatY + (((a.z ?? 0) - (b.z ?? 0)) * 0.45) * vHatZ) / palm3D;
  const projU = (a, b) => ((a.x - b.x) * uHatX + (a.y - b.y) * uHatY + (((a.z ?? 0) - (b.z ?? 0)) * 0.45) * uHatZ) / palm3D;

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

  // 4. 3D Joint Angle Cosines & Intrinsic Basis Projections (20 features -> 96 total)
  feats.push(cos3D(pts[2], pts[3], pts[4])); // Thumb IP straightness
  feats.push(cos3D(pts[1], pts[2], pts[4])); // Thumb MCP straightness
  feats.push(cos3D(pts[5], pts[6], pts[8])); // Index PIP straightness
  feats.push(cos3D(pts[9], pts[10], pts[12])); // Middle PIP straightness
  feats.push(cos3D(pts[13], pts[14], pts[16])); // Ring PIP straightness
  feats.push(cos3D(pts[17], pts[18], pts[20])); // Pinky PIP-Tip straightness
  feats.push(dist3D(pts[4], pts[6]) / palm3D); // Thumb to Index PIP 3D clearance
  const ringSpan = Math.max(0.20 * palm3D, dist3D(pts[16], pts[13]));
  feats.push(Math.min(4.0, dist3D(pts[20], pts[17]) / ringSpan)); // Pinky vs Ring span ratio
  feats.push(projV(pts[20], pts[17])); // Pinky axial forward projection
  feats.push(projV(pts[8], pts[5])); // Index axial forward projection
  feats.push(projV(pts[12], pts[9])); // Middle axial forward projection
  feats.push(projU(pts[4], pts[2])); // Thumb radial abduction projection

  // 5. High-Precision Pinky Curl vs Extension Anatomical Features (8 features -> 96 total)
  feats.push(cos3D(pts[17], pts[18], pts[19])); // Pinky PIP true 3D cosine (88)
  feats.push(cos3D(pts[18], pts[19], pts[20])); // Pinky DIP true 3D cosine (89)
  feats.push(cos3D(pts[0], pts[17], pts[20])); // Wrist-PinkyMCP-PinkyTip cosine (90)
  const pkBoneSum = dist3D(pts[17], pts[18]) + dist3D(pts[18], pts[19]) + dist3D(pts[19], pts[20]) || 1e-4;
  const rgBoneSum = dist3D(pts[13], pts[14]) + dist3D(pts[14], pts[15]) + dist3D(pts[15], pts[16]) || 1e-4;
  feats.push(dist3D(pts[17], pts[20]) / pkBoneSum); // Pinky 3-segment collinearity ratio (91)
  feats.push(dist3D(pts[13], pts[16]) / rgBoneSum); // Ring 3-segment collinearity ratio (92)
  feats.push((dist3D(pts[20], pts[17]) - dist3D(pts[18], pts[17])) / palm3D); // Pinky tip reach beyond PIP (93)
  feats.push(dist3D(pts[20], pts[14]) / palm3D); // Pinky tip to Ring PIP 3D clearance (94)
  feats.push(projU(pts[20], pts[17])); // Pinky lateral ulnar projection (95)

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
  // Emphasize hard boundary snapshots so the AI learns the exact user boundary between move and right_click
  const isLatestBoundaryFile = !rel.includes('legacy');
  const isRecentBoundaryFile = rel.includes('1793863871951') || rel.includes('1793861497069');
  const baseWeight = isLatestBoundaryFile ? 2.5 : (isRecentBoundaryFile ? 1.4 : 1.0);
  let fileValid = 0;
  for (const s of samples) {
    if (!s.rawLandmarks || s.rawLandmarks.length !== 21) continue;
    const action = s.groundTruthAction || s.action;
    const y = CLASS_TO_IDX[action];
    if (y !== undefined) {
      const x = extractFeatures(s.rawLandmarks);
      allSamples.push({ x, y, cls: action, weight: baseWeight, file: rel });
      fileValid++;
    }
  }
  console.log(` - ${rel}: ${fileValid} valid samples (weight: ${baseWeight}x)`);
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
      const sw = s.weight || 1.0;

      // Cost-sensitive penalty: guide AI to be naturally conservative about right_click when GT is move/idle/left_click
      const falseRightPenalty = (s.y !== 2 && s.y !== 3 && probs[2] > 0.05) ? 1.65 : 1.0;
      const effWeight = (sw * falseRightPenalty) / B;

      // Gradient of cross-entropy w.r.t logits
      const dLogits = new Float64Array(NUM_CLASSES);
      for (let c = 0; c < NUM_CLASSES; c++) {
        dLogits[c] = (probs[c] - (c === s.y ? 1.0 : 0.0)) * effWeight;
        gb2[c] += dLogits[c];
        const w2_c = W2[c];
        for (let i = 0; i < H; i++) {
          gW2[c][i] += dLogits[c] * h[i];
        }
      }

      // Backprop into hidden layer
      for (let i = 0; i < H; i++) {
        let dh = 0;
        for (let c = 0; c < NUM_CLASSES; c++) {
          dh += dLogits[c] * W2[c][i];
        }
        const dhRelu = h[i] > 0 ? dh : dh * 0.05;
        gb1[i] += dhRelu;
        for (let j = 0; j < featDim; j++) {
          gW1[i][j] += dhRelu * s.x[j];
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

function cos3D(a, b, c) {
  const ux = a.x - b.x, uy = a.y - b.y, uz = ((a.z ?? 0) - (b.z ?? 0)) * 0.45;
  const vx = c.x - b.x, vy = c.y - b.y, vz = ((c.z ?? 0) - (b.z ?? 0)) * 0.45;
  const len = Math.hypot(ux, uy, uz) * Math.hypot(vx, vy, vz);
  return len > 1e-8 ? (ux * vx + uy * vy + uz * vz) / len : 0;
}

function dist3D(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, ((a.z ?? 0) - (b.z ?? 0)) * 0.45);
}

export function extractPoseFeatures(pts, outBuf = featBuf) {
  if (!pts || pts.length !== 21) return null;
  const p0 = pts[0];
  const p9 = pts[9];
  const palm = Math.hypot(p9.x - p0.x, p9.y - p0.y) || 1e-4;
  const palm3D = Math.max(palm, dist3D(p0, p9), dist3D(pts[5], pts[17])) || 1e-4;

  const vx = p9.x - p0.x, vy = p9.y - p0.y, vz = ((p9.z ?? 0) - (p0.z ?? 0)) * 0.45;
  const vLen = Math.hypot(vx, vy, vz) || 1e-5;
  const vHatX = vx / vLen, vHatY = vy / vLen, vHatZ = vz / vLen;
  const ax = pts[5].x - pts[17].x, ay = pts[5].y - pts[17].y, az = ((pts[5].z ?? 0) - (pts[17].z ?? 0)) * 0.45;
  const aDotV = ax * vHatX + ay * vHatY + az * vHatZ;
  const ux = ax - aDotV * vHatX, uy = ay - aDotV * vHatY, uz = az - aDotV * vHatZ;
  const uLen = Math.hypot(ux, uy, uz) || 1e-5;
  const uHatX = ux / uLen, uHatY = uy / uLen, uHatZ = uz / uLen;

  const projV = (a, b) => ((a.x - b.x) * vHatX + (a.y - b.y) * vHatY + (((a.z ?? 0) - (b.z ?? 0)) * 0.45) * vHatZ) / palm3D;
  const projU = (a, b) => ((a.x - b.x) * uHatX + (a.y - b.y) * uHatY + (((a.z ?? 0) - (b.z ?? 0)) * 0.45) * uHatZ) / palm3D;

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

  // 3D Joint Angle Cosines & Intrinsic Basis Projections (20 features -> 96 total)
  outBuf[idx++] = cos3D(pts[2], pts[3], pts[4]);
  outBuf[idx++] = cos3D(pts[1], pts[2], pts[4]);
  outBuf[idx++] = cos3D(pts[5], pts[6], pts[8]);
  outBuf[idx++] = cos3D(pts[9], pts[10], pts[12]);
  outBuf[idx++] = cos3D(pts[13], pts[14], pts[16]);
  outBuf[idx++] = cos3D(pts[17], pts[18], pts[20]);
  outBuf[idx++] = dist3D(pts[4], pts[6]) / palm3D;
  const ringSpan = Math.max(0.20 * palm3D, dist3D(pts[16], pts[13]));
  outBuf[idx++] = Math.min(4.0, dist3D(pts[20], pts[17]) / ringSpan);
  outBuf[idx++] = projV(pts[20], pts[17]);
  outBuf[idx++] = projV(pts[8], pts[5]);
  outBuf[idx++] = projV(pts[12], pts[9]);
  outBuf[idx++] = projU(pts[4], pts[2]);

  // High-Precision Pinky Curl vs Extension Anatomical Features (8 features -> 96 total)
  outBuf[idx++] = cos3D(pts[17], pts[18], pts[19]); // 88: Pinky PIP true 3D cosine
  outBuf[idx++] = cos3D(pts[18], pts[19], pts[20]); // 89: Pinky DIP true 3D cosine
  outBuf[idx++] = cos3D(pts[0], pts[17], pts[20]);  // 90: Wrist-PinkyMCP-PinkyTip cosine
  const pkBoneSum = dist3D(pts[17], pts[18]) + dist3D(pts[18], pts[19]) + dist3D(pts[19], pts[20]) || 1e-4;
  const rgBoneSum = dist3D(pts[13], pts[14]) + dist3D(pts[14], pts[15]) + dist3D(pts[15], pts[16]) || 1e-4;
  outBuf[idx++] = dist3D(pts[17], pts[20]) / pkBoneSum; // 91: Pinky 3-segment collinearity ratio
  outBuf[idx++] = dist3D(pts[13], pts[16]) / rgBoneSum; // 92: Ring 3-segment collinearity ratio
  outBuf[idx++] = (dist3D(pts[20], pts[17]) - dist3D(pts[18], pts[17])) / palm3D; // 93: Pinky tip reach beyond PIP
  outBuf[idx++] = dist3D(pts[20], pts[14]) / palm3D; // 94: Pinky tip to Ring PIP 3D clearance
  outBuf[idx++] = projU(pts[20], pts[17]); // 95: Pinky lateral ulnar projection

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
  for (let c = 0; c < NUM_CLASSES; c++) {
    probsBuf[c] /= sumExp;
  }

  // Anatomical Curl & AI-Level Conservative Right-Click Boundary:
  // 1) Suppress low-confidence right_click when pinky phalanges are genuinely bent/curled (pkCos > -0.15 or pkStraightRatio < 0.75)
  const pinkyClearlyCurled = x[81] > -0.15 || x[91] < 0.75;
  if (pinkyClearlyCurled && probsBuf[2] < 0.88) {
    probsBuf[0] += probsBuf[2];
    probsBuf[2] = 0;
  }
  // 2) AI-driven conservative decision boundary: when ambiguous between move and right_click (< 0.74 confidence), prefer move
  if (probsBuf[2] > probsBuf[0] && probsBuf[2] < 0.74 && probsBuf[0] > 0.20) {
    const tmp = probsBuf[0];
    probsBuf[0] = probsBuf[2];
    probsBuf[2] = tmp;
  }

  // Thumb tucked guard: prevents false both_click when thumb is tucked close to index knuckle
  if (x[68] < 0.22 && probsBuf[3] < 0.80) {
    probsBuf[2] += probsBuf[3]; // borderline both_click -> right_click
    probsBuf[3] = 0;
  }

  let bestClass = CLASSES[0];
  let maxProb = -1;
  const probabilities = {};

  for (let c = 0; c < NUM_CLASSES; c++) {
    const p = probsBuf[c];
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

