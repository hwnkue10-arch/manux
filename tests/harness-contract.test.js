import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ContractValidationError, isSafeProjectPath, renderTaskReport, validateResult, validateTask } from '../scripts/task-contract.mjs';
import { readTaskRecord, runTaskReport } from '../scripts/task-report.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const task = {
  schemaVersion: 1, requestId: 'MANUX-42', objective: '손 추적이 사라지면 입력을 멈춘다.',
  acceptanceCriteria: ['손 추적이 사라지면 눌린 버튼을 해제한다.'],
  scope: ['src/air-mouse-controller.js', 'tests/'], baselineCommit: 'a'.repeat(40),
};
const result = {
  schemaVersion: 1, requestId: task.requestId, baselineCommit: task.baselineCommit,
  status: 'complete', summary: '손 추적 중단 시 해제 동작을 검증했다.', changedFiles: ['src/air-mouse-controller.js'],
  checks: [{ name: '손 추적 중단', command: 'node --test tests/air-mouse-controller.test.js', status: 'passed', evidence: '누름 후 추적 중단 입력에서 release 사건을 확인했다.' }],
  acceptance: [{ criterion: task.acceptanceCriteria[0], status: 'met', evidence: '해당 회귀 시나리오가 통과했다.' }],
  delivery: { integrated: false, published: false, evidence: '' },
  limitations: ['실물 웹캠 검사는 이 코드 시험에 포함되지 않았다.'], nextSteps: ['담당 리뷰어가 변경 내용과 시험 결과를 확인한다.'],
};

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'manux-contract-'));
  t.after(async () => {
    const target = resolve(base);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('manux-contract-'));
    await rm(target, { recursive: true, force: true });
  });
  const root = join(base, 'repo');
  await mkdir(root);
  await writeFile(join(root, 'task.json'), JSON.stringify(task));
  await writeFile(join(root, 'result.json'), JSON.stringify(result));
  return { base, root };
}

test('versioned examples validate while explicitly recording that no test ran', async () => {
  const exampleTask = JSON.parse(await readFile(new URL('../harness/task.example.json', import.meta.url), 'utf8'));
  const exampleResult = JSON.parse(await readFile(new URL('../harness/result.example.json', import.meta.url), 'utf8'));
  assert.equal(validateTask(exampleTask), exampleTask);
  assert.equal(validateResult(exampleResult, exampleTask), exampleResult);
  const report = renderTaskReport(exampleResult, exampleTask);
  assert.match(report, /^상태: 검토 필요/);
  assert.match(report, /미실행 1/);
});

test('renderer produces exactly the same five-line result across property ordering and calls', () => {
  const first = renderTaskReport(result, task);
  const reordered = Object.fromEntries(Object.entries(result).reverse());
  assert.equal(renderTaskReport(reordered, task), first);
  assert.equal(renderTaskReport(clone(result), clone(task)), first);
  assert.deepEqual(first.split('\n').map(line => line.split(':')[0]), ['상태', '요약', '변경', '검증', '다음']);
  assert.equal(first.split('\n')[0], '상태: 완료 | 작업: MANUX-42 | 통합: 아니오 | 게시: 아니오');
});

test('result must identify the exact task, baseline, acceptance criteria and owned paths', () => {
  for (const mutation of [
    value => { value.requestId = 'OTHER'; },
    value => { value.baselineCommit = 'b'.repeat(40); },
    value => { value.acceptance[0].criterion = '다른 기준'; },
    value => { value.changedFiles = ['src/app.js']; },
    value => { value.changedFiles = ['tests-other/file.js']; },
    value => { value.acceptance.push(clone(value.acceptance[0])); },
  ]) {
    const invalid = clone(result); mutation(invalid);
    assert.throws(() => validateResult(invalid, task), ContractValidationError);
  }
  const nested = clone(result); nested.changedFiles = ['tests/nested/camera.test.js'];
  assert.doesNotThrow(() => validateResult(nested, task));
});

test('failure, missing verification and unmet acceptance cannot become complete', () => {
  for (const mutation of [
    value => { value.checks[0].status = 'failed'; },
    value => { value.checks[0].status = 'not_run'; },
    value => { value.checks = []; },
    value => { value.checks[0].evidence = ''; },
    value => { value.checks[0].evidence = '  '; },
    value => { value.checks[0].evidence = 'not run'; },
    value => { value.checks[0].evidence = 'Tests were not run because the runtime is missing.'; },
    value => { value.acceptance[0].evidence = '아직 확인하지 않음'; },
    value => { value.acceptance[0].status = 'not_checked'; },
    value => { value.acceptance[0].status = 'not_met'; },
  ]) {
    const invalid = clone(result); mutation(invalid);
    assert.throws(() => validateResult(invalid, task), ContractValidationError);
  }
  const failed = clone(result); failed.status = 'needs_review'; failed.checks[0].status = 'failed';
  assert.throws(() => validateResult(failed, task), /차단/);
  failed.status = 'blocked';
  assert.doesNotThrow(() => validateResult(failed, task));
});

test('task completion, integration and publication remain separate recorded claims', () => {
  const published = clone(result); published.delivery.published = true;
  assert.throws(() => validateResult(published, task), ContractValidationError);
  published.delivery.evidence = 'https://github.com/example/manux/pull/42 초안 PR에 변경을 게시했다.';
  assert.doesNotThrow(() => validateResult(published, task));
  assert.match(renderTaskReport(published, task), /통합: 아니오 \| 게시: 예/);
  published.delivery.integrated = true;
  assert.match(renderTaskReport(published, task), /통합: 예 \| 게시: 예/);

  for (const status of ['needs_review', 'blocked']) {
    const draft = clone(published);
    draft.status = status;
    draft.delivery.integrated = false;
    draft.checks[0].status = status === 'blocked' ? 'failed' : 'not_run';
    draft.checks[0].evidence = status === 'blocked' ? '초안 PR의 CI 회귀 검사가 실패했다.' : '초안 PR을 게시했으나 CI 검사를 아직 실행하지 않음';
    draft.acceptance[0].status = status === 'blocked' ? 'not_met' : 'not_checked';
    draft.acceptance[0].evidence = '초안 PR은 게시되었으며 완료 기준은 아직 충족하지 못했다.';
    draft.limitations = ['초안 PR의 검증이 완료되지 않았다.'];
    assert.doesNotThrow(() => validateResult(draft, task));
    assert.match(renderTaskReport(draft, task), /통합: 아니오 \| 게시: 예/);
    draft.status = 'complete';
    assert.throws(() => validateResult(draft, task), ContractValidationError);
  }

  const integrated = clone(result);
  integrated.delivery.integrated = true;
  assert.throws(() => validateResult(integrated, task), ContractValidationError);
  integrated.delivery.evidence = '공유 checkout 기준 커밋에 검토한 변경을 통합했다.';
  assert.doesNotThrow(() => validateResult(integrated, task));
});

test('paths reject traversal, absolute paths, secrets and directory prefix confusion', () => {
  for (const path of ['../private.txt', 'src/../private.txt', '/etc/passwd', 'C:/Users/private.txt', 'src\\file.js', '.env', 'config/.env.local', 'secrets.json', '.git/config', '.claude/settings.local.json', '.CLAUDE/SETTINGS.LOCAL.JSON', 'tests//bad.js', 'tests/', 'tests/./bad.js']) {
    assert.equal(isSafeProjectPath(path), false, path);
    const invalid = clone(result); invalid.changedFiles = [path];
    assert.throws(() => validateResult(invalid, task), ContractValidationError);
  }
  assert.equal(isSafeProjectPath('tests/', { directory: true }), true);
});

test('credentials and private local paths are rejected without reflecting values in errors', () => {
  const privateValues = [
    'DISCORD_TOKEN=synthetic-private-value', 'sk-ant-' + 'x'.repeat(30), 'https://user:secret@example.com/path',
    'https://example.com?token=private', 'C:\\Users\\Private\\file.txt', '/home/private/file.txt',
    '`C:/Users/Private/file.txt`', '/arbitrary/private/file.txt', 'https://discord.com/api/webhooks/123/private',
  ];
  for (const value of privateValues) {
    const invalid = clone(result); invalid.summary = value;
    assert.throws(() => validateResult(invalid, task), error => error instanceof ContractValidationError && !error.message.includes(value));
  }
  const unknown = clone(result); unknown.privateToken = 'private-contents';
  assert.throws(() => validateResult(unknown, task), error => !error.message.includes('private-contents'));
});

test('long reports stay within Discord limits and preserve failure counts and safe Unicode', () => {
  const longTask = clone(task); longTask.scope = ['src/'];
  const long = clone(result); long.status = 'blocked'; long.summary = '😀'.repeat(800);
  long.changedFiles = Array.from({ length: 60 }, (_, i) => `src/${'a'.repeat(160)}${i}.js`);
  long.checks = Array.from({ length: 20 }, (_, i) => ({ name: `검사 ${i}`, command: 'npm test', status: i === 19 ? 'failed' : 'passed', evidence: '결과'.repeat(300) }));
  long.limitations = ['@everyone ' + '한계'.repeat(100)];
  long.nextSteps = ['@here ' + '확인'.repeat(100)];
  const report = renderTaskReport(long, longTask);
  assert.ok(report.length <= 1900, report.length);
  assert.ok(report.isWellFormed());
  assert.equal(report.split('\n').length, 5);
  assert.match(report, /실패 1/);
  assert.match(report, /실패 · 검사 19/);
  assert.doesNotMatch(report, /@everyone|@here/);
});

test('record paths are confined to the workspace', async t => {
  const { base, root } = await fixture(t);
  const outside = join(base, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'record.json'), JSON.stringify(task));
  await assert.rejects(readTaskRecord('../outside/record.json', { root }), ContractValidationError);
  assert.deepEqual(await readTaskRecord('task.json', { root }), task);
});

test('symlink/junction escapes are confined to the workspace', async t => {
  const { base, root } = await fixture(t);
  const outside = join(base, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'record.json'), JSON.stringify(task));
  try {
    await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error;
    t.skip('This environment does not permit creating symbolic links/junctions.');
    return;
  }
  await assert.rejects(readTaskRecord('escape/record.json', { root }), ContractValidationError);
});

test('CLI validates and renders data without executing the recorded command', async t => {
  const { root } = await fixture(t);
  const value = clone(result);
  value.checks[0].command = 'node -e "require(\'fs\').writeFileSync(\'should-not-exist\',\'x\')"';
  await writeFile(join(root, 'result.json'), JSON.stringify(value));
  const cli = fileURLToPath(new URL('../scripts/task-report.mjs', import.meta.url));
  const output = execFileSync(process.execPath, [cli, 'task.json', 'result.json'], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(output.trimEnd(), renderTaskReport(value, task));
  await assert.rejects(access(join(root, 'should-not-exist')));
  const messages = [];
  assert.equal(await runTaskReport(['task.json', 'result.json', '--check'], { root, output: text => messages.push(text) }), 0);
  assert.deepEqual(messages, ['작업 기록 검증 통과: MANUX-42']);
});

test('invalid JSON, too-large inputs and unsupported CLI flags fail without leaking source content', async t => {
  const { root } = await fixture(t);
  const errors = [];
  await writeFile(join(root, 'result.json'), 'private-token-invalid-json');
  assert.equal(await runTaskReport(['task.json', 'result.json'], { root, error: text => errors.push(text) }), 1);
  await writeFile(join(root, 'result.json'), ' '.repeat(65_537));
  assert.equal(await runTaskReport(['task.json', 'result.json'], { root, error: text => errors.push(text) }), 1);
  assert.equal(await runTaskReport(['task.json', 'result.json', '--execute'], { root, error: text => errors.push(text) }), 1);
  assert.ok(errors.every(text => !text.includes('private-token-invalid-json')));
});
