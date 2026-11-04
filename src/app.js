import {VisionClient} from './vision-client.js';
import {cameraConstraints, describeCamera} from './camera.js';
import {MouseWorkspace} from './mouse-workspace.js';

const $ = selector => document.querySelector(selector);
const camera = $('#camera');
const canvas = $('#landmarks');
const ctx = canvas.getContext('2d');
const cameraPreview = $('.camera-wrap');

const connections = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],
  [13,17],[0,17],[17,18],[18,19],[19,20]
];

let vision = null;
let stream = null;
let ready = false;
let session = 0;
let raf = 0;
let lastVideoTime = -1;
let lastInference = 0;
let cameraInfo = null;
let lastResultAt = null;
let fps = 0;
let lastStatsAt = 0;
let previewMoveId = 0;

const mouse = new MouseWorkspace();

function message(id, text, error = false) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('error', error);
}

function badge(text, kind = '') {
  const el = $('#camera-badge');
  if (!el) return;
  el.textContent = text;
  el.className = `status-pill ${kind}`;
}

function evaluateHandQuality(landmarks, {width, height}) {
  if (!landmarks || landmarks.length < 21) return { ok: false, spanPx: 0, reason: 'no-hand' };
  let minX = 1, maxX = 0, minY = 1, maxY = 0;
  for (const pt of landmarks) {
    if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return { ok: false, spanPx: 0, reason: 'degenerate' };
    if (pt.x < minX) minX = pt.x;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.y > maxY) maxY = pt.y;
  }
  const spanPx = Math.hypot((maxX - minX) * width, (maxY - minY) * height);
  if (spanPx < 35) return { ok: false, spanPx, reason: 'hand-too-small' };
  return { ok: true, spanPx };
}

function drawHands(landmarks) {
  const width = camera.videoWidth || 640;
  const height = camera.videoHeight || 480;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    cameraPreview.style.aspectRatio = `${width} / ${height}`;
    cameraPreview.style.setProperty('--camera-aspect', width / height);
  }
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = '#46e5bd';
  ctx.lineWidth = Math.max(2, width / 400);
  ctx.fillStyle = '#ffffff';

  for (const hand of landmarks || []) {
    for (const [a, b] of connections) {
      ctx.beginPath();
      ctx.moveTo(hand[a].x * width, hand[a].y * height);
      ctx.lineTo(hand[b].x * width, hand[b].y * height);
      ctx.stroke();
    }
    for (const point of hand) {
      ctx.beginPath();
      ctx.arc(point.x * width, point.y * height, Math.max(2, width / 350), 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function processResult(packet, now, roundTripMs) {
  const result = packet.result;
  const landmarks = result.landmarks?.[0];
  const handPresent = Boolean(landmarks);
  const dimensions = {width: camera.videoWidth, height: camera.videoHeight};
  const quality = evaluateHandQuality(landmarks, dimensions);

  drawHands(result.landmarks);

  if (lastResultAt !== null) {
    fps = fps ? fps * 0.8 + (1000 / (now - lastResultAt)) * 0.2 : 1000 / (now - lastResultAt);
  }
  lastResultAt = now;

  if (now - lastStatsAt > 500) {
    lastStatsAt = now;
    const statsEl = $('#camera-stats');
    if (statsEl && cameraInfo) {
      statsEl.textContent = `실제 입력 ${cameraInfo.label}${cameraInfo.reduced ? ' · 요청보다 낮음' : ''} | 처리 ${fps.toFixed(1)} fps · 모델 ${Math.round(packet.inferenceMs)}ms · 지연 ${Math.round(roundTripMs)}ms`;
    }
  }

  const mouseQualityOk = handPresent && quality.ok;
  const handedness = result.handedness?.[0]?.[0]?.categoryName || null;
  const state = mouse.update({
    landmarks,
    now,
    quality: mouseQualityOk,
    handedness,
    ...dimensions,
    latency: roundTripMs,
  });

  const recogEl = $('#recognition-label');
  if (recogEl) {
    recogEl.textContent = !handPresent ? '손을 보여주세요' : (!mouseQualityOk ? '입력 보류' : (mouse.getModeLabel(state?.mode) || '인식 중'));
  }
  const confEl = $('#confidence');
  if (confEl) {
    confEl.textContent = !handPresent ? '' : '👆조준 · 👍좌클 · 🤙우클 · 🖐휠';
  }
}

function infer(token) {
  if (token !== session || !ready) return;
  raf = globalThis.manuxDesktop ? setTimeout(() => infer(token), 16) : requestAnimationFrame(() => infer(token));
  const now = performance.now();
  if (!vision || vision.busy || now - lastInference < 10 || camera.readyState < 2 || camera.currentTime === lastVideoTime) return;
  lastInference = now;
  lastVideoTime = camera.currentTime;
  const client = vision;
  client.recognize(camera, now).then(packet => {
    if (!packet || token !== session || !ready) return;
    processResult(packet, performance.now(), performance.now() - now);
  }).catch(error => {
    if (token !== session) return;
    stopCamera();
    badge('인식 오류', 'error');
    message('#camera-message', `인식이 중단되었습니다. 카메라를 다시 시작하세요. (${error.message})`, true);
  });
}

function stopCamera() {
  mouse.setReady(false);
  session++;
  ready = false;
  if (globalThis.manuxDesktop) clearTimeout(raf); else cancelAnimationFrame(raf);
  vision?.close();
  vision = null;
  stream?.getTracks().forEach(track => track.stop());
  stream = null;
  camera.srcObject = null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const emptyEl = $('#camera-empty');
  if (emptyEl) emptyEl.hidden = false;
  const startBtn = $('#camera-start');
  if (startBtn) { startBtn.disabled = false; startBtn.textContent = '카메라 시작'; }
  const stopBtn = $('#camera-stop');
  if (stopBtn) stopBtn.disabled = true;
  const resSelect = $('#resolution');
  if (resSelect) resSelect.disabled = false;
  const recogEl = $('#recognition-label');
  if (recogEl) recogEl.textContent = '대기 중';
  const confEl = $('#confidence');
  if (confEl) confEl.textContent = '';
  badge('카메라 꺼짐');
}

async function startCamera() {
  const token = ++session;
  const startBtn = $('#camera-start');
  const stopBtn = $('#camera-stop');
  const resSelect = $('#resolution');

  if (startBtn) { startBtn.disabled = true; startBtn.textContent = '준비 중…'; }
  if (stopBtn) stopBtn.disabled = false;
  if (resSelect) resSelect.disabled = true;
  badge('연결 중');
  message('#camera-message', '카메라 접근을 허용하세요. 인식 모델을 준비합니다.');

  let acquired;
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('카메라는 HTTPS 또는 localhost 주소에서 사용할 수 있습니다.');
    }
    const resolutionVal = resSelect?.value || '480';
    acquired = await navigator.mediaDevices.getUserMedia(cameraConstraints(resolutionVal));
    if (token !== session) { acquired.getTracks().forEach(track => track.stop()); return; }
    stream = acquired;
    for (const track of stream.getVideoTracks()) {
      track.addEventListener('ended', () => {
        if (token === session) {
          stopCamera();
          message('#camera-message', '카메라 연결이 끊겼습니다. 다시 연결한 뒤 시작하세요.', true);
        }
      });
    }
    camera.srcObject = stream;
    await camera.play();
    if (token !== session) return;

    cameraInfo = describeCamera(stream.getVideoTracks()[0], camera, resolutionVal);
    const statsEl = $('#camera-stats');
    if (statsEl) {
      statsEl.textContent = `실제 입력 ${cameraInfo.label}${cameraInfo.reduced ? ' · 요청한 해상도보다 낮게 연결됨' : ''}`;
    }

    const client = new VisionClient();
    vision = client;
    await client.init();
    if (token !== session) return;

    message('#camera-message', '첫 영상으로 인식을 준비하고 있습니다. 잠시만 기다려주세요.');
    const warmupStarted = performance.now();
    const warmup = await client.recognize(camera, warmupStarted);
    if (token !== session) return;

    if (stream.getVideoTracks().some(track => track.readyState !== 'live')) {
      throw new Error('카메라 연결이 종료되었습니다.');
    }

    ready = true;
    lastVideoTime = -1;
    lastInference = 0;
    lastResultAt = null;
    fps = 0;

    mouse.setReady(true);
    const emptyEl = $('#camera-empty');
    if (emptyEl) emptyEl.hidden = true;
    if (startBtn) startBtn.textContent = '카메라 연결됨';
    badge('인식 중', 'on');
    if (warmup) drawHands(warmup.result.landmarks);
    infer(token);
    message('#camera-message', '카메라 준비 완료. 마우스 제어를 시작할 수 있습니다.');
  } catch (error) {
    if (token !== session) return;
    acquired?.getTracks().forEach(track => track.stop());
    stopCamera();
    badge('연결 실패', 'error');
    message('#camera-message', `모델 또는 카메라를 준비하지 못했습니다. ${error.message}`, true);
  }
}

$('#camera-start')?.addEventListener('click', startCamera);
$('#camera-stop')?.addEventListener('click', () => {
  stopCamera();
  message('#camera-message', '카메라와 손동작 제어를 종료했습니다.');
});

function moveCameraPreview(host) {
  if (!host) return;
  const moveId = ++previewMoveId;
  host.append(cameraPreview);
  if (ready && camera.srcObject) {
    const token = session;
    void camera.play().catch(error => {
      if (token !== session || moveId !== previewMoveId) return;
      stopCamera();
      message('#camera-message', `카메라 미리보기를 다시 시작하지 못했습니다. ${error.message}`, true);
    });
  }
}

$('#overlay-pip-btn')?.addEventListener('click', () => {
  if (document.body.classList.contains('show-pip')) {
    moveCameraPreview($('#overlay-pip-box'));
  } else {
    moveCameraPreview($('#camera-preview-home'));
  }
});
$('#overlay-exit-btn')?.addEventListener('click', () => {
  moveCameraPreview($('#camera-preview-home'));
});
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && document.body.classList.contains('overlay-mode')) {
    moveCameraPreview($('#camera-preview-home'));
  }
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    mouse.stop('Esc를 눌러 마우스 제어를 껐습니다.');
    message('#camera-message', 'Esc를 눌러 마우스 제어를 껐습니다.');
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && !mouse.backgroundAllowed) {
    mouse.stop('창을 벗어나 마우스 제어를 껐습니다.');
  }
});

window.addEventListener('beforeunload', () => {
  stopCamera();
});

// Auto-start camera in desktop app
if (globalThis.manuxDesktop) {
  setTimeout(() => {
    if (!ready && !$('#camera-start')?.disabled) {
      startCamera();
    }
  }, 350);
}

// Global hook for direct start button in mouse-workspace
window.startManuxCamera = startCamera;
window.isManuxCameraReady = () => ready;
