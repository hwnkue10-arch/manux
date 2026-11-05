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

test('Annotation: startAnnotation() generates structured start event and sets currentAnnotation', () => {
  const recorder = new RawTemporalRecorder();
  recorder.start({ mode: 'trigger' });

  // Record 1 unannotated baseline frame
  recorder.recordFrame({ timestamp: 1000, landmarks: createDummyLandmarks() });
  assert.equal(recorder.getCurrentAnnotation(), null);

  // Human starts "left_click" trial 1
  const startEv = recorder.startAnnotation({ actionIntent: 'left_click', trialId: 1 });
  assert.ok(startEv);
  assert.equal(startEv.type, 'annotation_start');
  assert.equal(startEv.actionIntent, 'left_click');
  assert.equal(startEv.trialId, 1);
  assert.equal(startEv.mode, 'trigger');
  assert.equal(startEv.labelSource, 'manual');
  assert.equal(startEv.startFrameId, 2);

  const cur = recorder.getCurrentAnnotation();
  assert.ok(cur);
  assert.equal(cur.actionIntent, 'left_click');
  assert.equal(cur.trialId, 1);
});

test('Annotation: frames recorded during active annotation carry actionIntent; idle frames carry null', () => {
  const recorder = new RawTemporalRecorder();
  recorder.start({ mode: 'trigger' });

  // Idle frame 1 (before trial)
  const f1 = recorder.recordFrame({ timestamp: 1000, landmarks: createDummyLandmarks() });
  assert.equal(f1.actionIntent, null, 'Frame before annotation must have actionIntent = null');

  // Start trial
  recorder.startAnnotation({ actionIntent: 'freeze', trialId: 1 });

  // Frames 2, 3 (during trial)
  const f2 = recorder.recordFrame({ timestamp: 1033.33, landmarks: createDummyLandmarks() });
  const f3 = recorder.recordFrame({ timestamp: 1066.66, landmarks: createDummyLandmarks() });
  assert.equal(f2.actionIntent, 'freeze');
  assert.equal(f3.actionIntent, 'freeze');

  // End trial
  const endEv = recorder.endAnnotation();
  assert.ok(endEv);
  assert.equal(endEv.type, 'annotation_end');
  assert.equal(endEv.actionIntent, 'freeze');
  assert.equal(endEv.frameCount, 2);

  // Idle frame 4 (after trial)
  const f4 = recorder.recordFrame({ timestamp: 1100, landmarks: createDummyLandmarks() });
  assert.equal(f4.actionIntent, null, 'Frame after annotation must have actionIntent = null');
  assert.equal(recorder.getCurrentAnnotation(), null);
});

test('Annotation: cancelAnnotation() reverts in-progress frame labels and emits annotation_cancel', () => {
  const recorder = new RawTemporalRecorder();
  recorder.start({ mode: 'trigger' });

  recorder.recordFrame({ timestamp: 1000, landmarks: createDummyLandmarks() }); // frame 1: idle

  recorder.startAnnotation({ actionIntent: 'scroll', trialId: 1 });
  const f2 = recorder.recordFrame({ timestamp: 1033, landmarks: createDummyLandmarks() });
  const f3 = recorder.recordFrame({ timestamp: 1066, landmarks: createDummyLandmarks() });
  assert.equal(f2.actionIntent, 'scroll');
  assert.equal(f3.actionIntent, 'scroll');

  // Human developer made a mistake and presses cancel/backspace
  const cancelEv = recorder.cancelAnnotation({ reason: 'user_aborted_mistake' });
  assert.ok(cancelEv);
  assert.equal(cancelEv.type, 'annotation_cancel');
  assert.equal(cancelEv.actionIntent, 'scroll');
  assert.equal(cancelEv.reason, 'user_aborted_mistake');

  // Verify that frames 2 and 3 have their actionIntent reverted to null!
  assert.equal(f2.actionIntent, null, 'Aborted trial frame 2 must be reverted to null');
  assert.equal(f3.actionIntent, null, 'Aborted trial frame 3 must be reverted to null');
  assert.equal(recorder.getCurrentAnnotation(), null);
  assert.equal(recorder.getAnnotations().length, 0, 'Cancelled trial must not be in completed annotations list');
});

test('Annotation: auto-closes in-progress annotation if stop() is called mid-trial', () => {
  const recorder = new RawTemporalRecorder();
  recorder.start({ mode: 'trigger' });

  recorder.startAnnotation({ actionIntent: 'right_click', trialId: 1 });
  recorder.recordFrame({ timestamp: 1000, landmarks: createDummyLandmarks() });
  recorder.recordFrame({ timestamp: 1033, landmarks: createDummyLandmarks() });

  const session = recorder.stop();
  assert.equal(session.annotations.length, 1);
  assert.equal(session.annotations[0].actionIntent, 'right_click');
  assert.equal(session.annotations[0].metadata.autoClosed, true);
  assert.equal(session.summary.totalAnnotations, 1);
  assert.equal(session.summary.annotationsSummary.right_click, 1);
});

test('Annotation: toJSONL() exports chronological stream of frames and annotation events', () => {
  const recorder = new RawTemporalRecorder();
  recorder.start({ mode: 'trigger' });

  recorder.recordFrame({ timestamp: 1000, landmarks: createDummyLandmarks() }); // Frame 1 (idle)

  recorder.startAnnotation({ actionIntent: 'left_click', trialId: 1 }); // Ann Start
  recorder.recordFrame({ timestamp: 1033, landmarks: createDummyLandmarks() }); // Frame 2 (left_click)
  recorder.recordFrame({ timestamp: 1066, landmarks: createDummyLandmarks() }); // Frame 3 (left_click)
  recorder.endAnnotation(); // Ann End

  recorder.recordFrame({ timestamp: 1100, landmarks: createDummyLandmarks() }); // Frame 4 (idle)

  const jsonl = recorder.toJSONL();
  const lines = jsonl.trim().split('\n');

  // Expected sequence:
  // 0: Header
  // 1: Frame 1 (idle)
  // 2: annotation_start
  // 3: Frame 2 (left_click)
  // 4: Frame 3 (left_click)
  // 5: annotation_end
  // 6: Frame 4 (idle)
  // 7: Summary
  assert.equal(lines.length, 8);

  const header = JSON.parse(lines[0]);
  assert.equal(header.type, 'header');

  const f1 = JSON.parse(lines[1]);
  assert.equal(f1.type, 'frame');
  assert.equal(f1.frameId, 1);
  assert.equal(f1.actionIntent, null);

  const aStart = JSON.parse(lines[2]);
  assert.equal(aStart.type, 'annotation_start');
  assert.equal(aStart.actionIntent, 'left_click');

  const f2 = JSON.parse(lines[3]);
  assert.equal(f2.type, 'frame');
  assert.equal(f2.actionIntent, 'left_click');

  const f3 = JSON.parse(lines[4]);
  assert.equal(f3.type, 'frame');
  assert.equal(f3.actionIntent, 'left_click');

  const aEnd = JSON.parse(lines[5]);
  assert.equal(aEnd.type, 'annotation_end');
  assert.equal(aEnd.actionIntent, 'left_click');
  assert.equal(aEnd.frameCount, 2);

  const f4 = JSON.parse(lines[6]);
  assert.equal(f4.type, 'frame');
  assert.equal(f4.actionIntent, null);

  const summary = JSON.parse(lines[7]);
  assert.equal(summary.type, 'summary');
  assert.equal(summary.totalAnnotations, 1);
  assert.equal(summary.annotationsSummary.left_click, 1);
});

test('Annotation: mode segregation preserves trigger vs index mode semantics', () => {
  const recTrigger = new RawTemporalRecorder();
  recTrigger.start({ mode: 'trigger' });
  recTrigger.startAnnotation({ actionIntent: 'freeze', trialId: 1 });
  const fT = recTrigger.recordFrame({ timestamp: 100, landmarks: createDummyLandmarks() });
  recTrigger.endAnnotation();
  const sT = recTrigger.stop();
  assert.equal(sT.mode, 'trigger');
  assert.equal(fT.mode, 'trigger');
  assert.equal(sT.annotations[0].mode, 'trigger');

  const recIndex = new RawTemporalRecorder();
  recIndex.start({ mode: 'index' });
  recIndex.startAnnotation({ actionIntent: 'move', trialId: 1 });
  const fI = recIndex.recordFrame({ timestamp: 100, landmarks: createDummyLandmarks() });
  recIndex.endAnnotation();
  const sI = recIndex.stop();
  assert.equal(sI.mode, 'index');
  assert.equal(fI.mode, 'index');
  assert.equal(sI.annotations[0].mode, 'index');
});

test('Annotation: multiple sequential trials across all 6 action classes calculate summary breakdown correctly', () => {
  const recorder = new RawTemporalRecorder();
  recorder.start({ mode: 'trigger' });

  const actions = ['move', 'freeze', 'left_click', 'right_click', 'scroll', 'idle'];
  let ts = 1000;

  for (let trial = 1; trial <= 2; trial++) {
    for (const act of actions) {
      // 1 idle frame between trials
      recorder.recordFrame({ timestamp: ts, landmarks: createDummyLandmarks() });
      ts += 33.3;

      // Start trial
      recorder.startAnnotation({ actionIntent: act, trialId: trial });

      // 3 frames per trial
      for (let i = 0; i < 3; i++) {
        recorder.recordFrame({ timestamp: ts, landmarks: createDummyLandmarks() });
        ts += 33.3;
      }

      // End trial
      recorder.endAnnotation();
    }
  }

  const session = recorder.stop();
  assert.equal(session.annotations.length, 12); // 6 actions * 2 trials
  assert.equal(session.summary.totalAnnotations, 12);
  for (const act of actions) {
    assert.equal(session.summary.annotationsSummary[act], 2);
  }
});

test('Annotation: startAnnotation auto-closes prior annotation if human switches action mid-way', () => {
  const recorder = new RawTemporalRecorder();
  recorder.start({ mode: 'trigger' });

  recorder.startAnnotation({ actionIntent: 'move', trialId: 1 });
  recorder.recordFrame({ timestamp: 1000, landmarks: createDummyLandmarks() });

  // Human starts "freeze" without explicitly closing "move"
  const secondStart = recorder.startAnnotation({ actionIntent: 'freeze', trialId: 1 });
  assert.ok(secondStart);
  assert.equal(recorder.getCurrentAnnotation().actionIntent, 'freeze');

  // Completed annotations list must now contain the auto-closed "move" annotation!
  assert.equal(recorder.getAnnotations().length, 1);
  assert.equal(recorder.getAnnotations()[0].actionIntent, 'move');
  assert.equal(recorder.getAnnotations()[0].metadata.autoClosed, true);
});

test('Annotation: cancelled trial followed by successful re-trial cleanly isolates labels', () => {
  const recorder = new RawTemporalRecorder();
  recorder.start({ mode: 'trigger' });

  // Bad trial (cancelled)
  recorder.startAnnotation({ actionIntent: 'left_click', trialId: 1 });
  const fBad = recorder.recordFrame({ timestamp: 1000, landmarks: createDummyLandmarks() });
  assert.equal(fBad.actionIntent, 'left_click');
  recorder.cancelAnnotation({ reason: 'accidental_twitch' });
  assert.equal(fBad.actionIntent, null, 'Cancelled trial frame must be reset to null');

  // Re-trial (successful)
  recorder.startAnnotation({ actionIntent: 'left_click', trialId: 1 });
  const fGood = recorder.recordFrame({ timestamp: 1033, landmarks: createDummyLandmarks() });
  assert.equal(fGood.actionIntent, 'left_click');
  recorder.endAnnotation();

  const session = recorder.stop();
  assert.equal(session.annotations.length, 1);
  assert.equal(session.annotations[0].actionIntent, 'left_click');
  assert.equal(session.summary.totalAnnotations, 1);
  assert.equal(session.summary.annotationsSummary.left_click, 1);
});

