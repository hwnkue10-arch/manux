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
  for (let i = 0; i < 21; i++) {
    feats.push((pts[i].x - p0.x) / palm);
    feats.push((pts[i].y - p0.y) / palm);
    feats.push((((pts[i].z ?? 0) - (p0.z ?? 0)) * 0.45) / palm);
  }

  [4, 8, 12, 16, 20].forEach(tip => {
    feats.push(Math.hypot(pts[tip].x - p0.x, pts[tip].y - p0.y) / palm);
  });

  feats.push(Math.hypot(pts[4].x - pts[5].x, pts[4].y - pts[5].y) / palm);
  feats.push(Math.hypot(pts[20].x - pts[17].x, pts[20].y - pts[17].y) / palm);
  feats.push(Math.hypot(pts[20].x - pts[16].x, pts[20].y - pts[16].y) / palm);
  feats.push(Math.hypot(pts[8].x - pts[12].x, pts[8].y - pts[12].y) / palm);
  feats.push(Math.hypot(pts[4].x - pts[20].x, pts[4].y - pts[20].y) / palm);
  feats.push(Math.hypot(pts[4].x - pts[9].x, pts[4].y - pts[9].y) / palm);
  feats.push(Math.hypot(pts[4].x - pts[2].x, pts[4].y - pts[2].y) / palm);
  feats.push(Math.hypot(pts[20].x - pts[9].x, pts[20].y - pts[9].y) / palm);

  feats.push(cos3D(pts[2], pts[3], pts[4]));
  feats.push(cos3D(pts[1], pts[2], pts[4]));
  feats.push(cos3D(pts[5], pts[6], pts[8]));
  feats.push(cos3D(pts[9], pts[10], pts[12]));
  feats.push(cos3D(pts[13], pts[14], pts[16]));
  feats.push(cos3D(pts[17], pts[18], pts[20]));
  feats.push(dist3D(pts[4], pts[6]) / palm3D);
  const ringSpan = Math.max(0.20 * palm3D, dist3D(pts[16], pts[13]));
  feats.push(Math.min(4.0, dist3D(pts[20], pts[17]) / ringSpan));
  feats.push(projV(pts[20], pts[17]));
  feats.push(projV(pts[8], pts[5]));
  feats.push(projV(pts[12], pts[9]));
  feats.push(projU(pts[4], pts[2]));

  return feats;
}

function findJsonFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findJsonFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith('.json')) results.push(fullPath);
  }
  return results;
}

const allSamples = [];
const dataFiles = findJsonFiles(DATA_DIR);
for (const filePath of dataFiles) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const samples = data.samples || (Array.isArray(data) ? data : []);
  for (const s of samples) {
    if (!s.rawLandmarks || s.rawLandmarks.length !== 21) continue;
    const action = s.groundTruthAction || s.action;
    const y = CLASS_TO_IDX[action];
    if (y !== undefined) {
      allSamples.push({
        x: extractFeatures(s.rawLandmarks),
        y,
        cls: action
      });
    }
  }
}

console.log(`=== 5-FOLD CROSS VALIDATION (${allSamples.length} samples) ===`);

let seed = 12345;
function random() {
  seed = (seed * 9301 + 49297) % 233280;
  return seed / 233280;
}

for (let i = allSamples.length - 1; i > 0; i--) {
  const j = Math.floor(random() * (i + 1));
  [allSamples[i], allSamples[j]] = [allSamples[j], allSamples[i]];
}

const K = 5;
const foldSize = Math.floor(allSamples.length / K);
const foldAccs = [];

const featDim = allSamples[0].x.length;
const H = 64;
const NUM_CLASSES = 6;

function randn() {
  const u1 = Math.max(1e-7, random());
  const u2 = random();
  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
}

for (let k = 0; k < K; k++) {
  const testStart = k * foldSize;
  const testEnd = k === K - 1 ? allSamples.length : (k + 1) * foldSize;
  const testSet = allSamples.slice(testStart, testEnd);
  const trainSet = [...allSamples.slice(0, testStart), ...allSamples.slice(testEnd)];

  const W1 = Array.from({ length: H }, () => Array.from({ length: featDim }, () => randn() * Math.sqrt(2.0 / featDim)));
  const b1 = new Array(H).fill(0.01);
  const W2 = Array.from({ length: NUM_CLASSES }, () => Array.from({ length: H }, () => randn() * Math.sqrt(2.0 / H)));
  const b2 = new Array(NUM_CLASSES).fill(0.0);

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
      for (let j = 0; j < featDim; j++) sum += w1_i[j] * x[j];
      h[i] = sum > 0 ? sum : sum * 0.05;
    }
    const logits = new Float64Array(NUM_CLASSES);
    let maxLogit = -Infinity;
    for (let c = 0; c < NUM_CLASSES; c++) {
      let sum = b2[c];
      const w2_c = W2[c];
      for (let i = 0; i < H; i++) sum += w2_c[i] * h[i];
      logits[c] = sum;
      if (sum > maxLogit) maxLogit = sum;
    }
    const probs = new Float64Array(NUM_CLASSES);
    let sumExp = 0;
    for (let c = 0; c < NUM_CLASSES; c++) {
      const e = Math.exp(logits[c] - maxLogit);
      probs[c] = e;
      sumExp += e;
    }
    for (let c = 0; c < NUM_CLASSES; c++) probs[c] /= sumExp;
    return { h, probs };
  }

  const EPOCHS = 35;
  const BATCH_SIZE = 64;
  const LR = 0.003;
  const BETA1 = 0.9, BETA2 = 0.999, EPS = 1e-8, L2 = 1e-4;
  let t = 0;

  for (let ep = 1; ep <= EPOCHS; ep++) {
    for (let bStart = 0; bStart < trainSet.length; bStart += BATCH_SIZE) {
      const batch = trainSet.slice(bStart, bStart + BATCH_SIZE);
      const B = batch.length;
      t++;

      const gW1 = Array.from({ length: H }, () => new Float64Array(featDim));
      const gb1 = new Float64Array(H);
      const gW2 = Array.from({ length: NUM_CLASSES }, () => new Float64Array(H));
      const gb2 = new Float64Array(NUM_CLASSES);

      for (const s of batch) {
        const { h, probs } = forward(s.x);
        const dLogits = new Float64Array(NUM_CLASSES);
        for (let c = 0; c < NUM_CLASSES; c++) {
          dLogits[c] = probs[c] - (c === s.y ? 1.0 : 0.0);
          gb2[c] += dLogits[c] / B;
          for (let i = 0; i < H; i++) gW2[c][i] += (dLogits[c] * h[i]) / B;
        }
        for (let i = 0; i < H; i++) {
          let dh = 0;
          for (let c = 0; c < NUM_CLASSES; c++) dh += dLogits[c] * W2[c][i];
          const dhRelu = h[i] > 0 ? dh : dh * 0.05;
          gb1[i] += dhRelu / B;
          for (let j = 0; j < featDim; j++) gW1[i][j] += (dhRelu * s.x[j]) / B;
        }
      }

      const lr_t = LR * Math.sqrt(1 - Math.pow(BETA2, t)) / (1 - Math.pow(BETA1, t));
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
  }

  let correct = 0;
  for (const s of testSet) {
    const { probs } = forward(s.x);
    let pred = 0, maxP = probs[0];
    for (let c = 1; c < NUM_CLASSES; c++) {
      if (probs[c] > maxP) { maxP = probs[c]; pred = c; }
    }
    if (pred === s.y) correct++;
  }
  const acc = (correct / testSet.length) * 100;
  foldAccs.push(acc);
  console.log(`Fold ${k + 1}/5 Accuracy: ${acc.toFixed(2)}% (${correct}/${testSet.length})`);
}

const meanAcc = foldAccs.reduce((a, b) => a + b, 0) / K;
console.log(`\n>>> 5-Fold Cross Validation Mean Accuracy: ${meanAcc.toFixed(2)}% <<<`);

