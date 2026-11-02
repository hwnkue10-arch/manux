import { readFileSync } from 'node:fs';

const taskSchema = JSON.parse(readFileSync(new URL('../harness/task.schema.json', import.meta.url), 'utf8'));
const resultSchema = JSON.parse(readFileSync(new URL('../harness/result.schema.json', import.meta.url), 'utf8'));
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const RESULT_LABELS = Object.freeze({ blocked: '차단', needs_review: '검토 필요', complete: '완료' });
const checkLabels = Object.freeze({ passed: '통과', failed: '실패', not_run: '미실행' });

export class ContractValidationError extends Error {
  constructor(errors) {
    super(`작업 기록 형식 오류: ${errors.slice(0, 12).join('; ')}`);
    this.name = 'ContractValidationError';
    this.code = 'TASK_CONTRACT';
    this.errors = errors.slice(0, 12);
  }
}

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// This is deliberately a validator for the small schema subset used by these
// versioned contracts, not a general-purpose JSON Schema implementation.
function schemaErrors(value, schema, path = '$') {
  const errors = [];
  const fail = label => errors.push(`${path}: ${label}`);
  if (Object.hasOwn(schema, 'const') && !equal(value, schema.const)) fail('고정 값 불일치');
  if (schema.enum && !schema.enum.some(option => equal(value, option))) fail('허용 값 아님');
  const type = schema.type;
  if (type && !({ object: plainObject(value), array: Array.isArray(value), string: typeof value === 'string', boolean: typeof value === 'boolean' }[type])) {
    fail('자료형 불일치');
    return errors;
  }
  if (plainObject(value)) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: 필수 항목 누락`);
    if (schema.additionalProperties === false && Object.keys(value).some(key => !Object.hasOwn(schema.properties ?? {}, key))) fail('알 수 없는 항목');
    for (const [key, rule] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) errors.push(...schemaErrors(value[key], rule, `${path}.${key}`));
    }
  }
  if (typeof value === 'string') {
    const length = Array.from(value).length;
    if (schema.minLength !== undefined && length < schema.minLength) fail('내용이 너무 짧음');
    if (schema.maxLength !== undefined && length > schema.maxLength) fail('내용이 너무 김');
    if (schema.pattern && !(new RegExp(schema.pattern, 'u')).test(value)) fail('문자 형식 불일치');
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail('항목 부족');
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail('항목 초과');
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) fail('중복 항목');
    if (schema.items) value.forEach((item, index) => errors.push(...schemaErrors(item, schema.items, `${path}[${index}]`)));
  }
  for (const rule of schema.allOf ?? []) errors.push(...schemaErrors(value, rule, path));
  if (schema.if) {
    const branch = schemaErrors(value, schema.if, path).length ? schema.else : schema.then;
    if (branch) errors.push(...schemaErrors(value, branch, path));
  }
  return errors;
}

export function assertPublicText(value, path = '$') {
  if (typeof value === 'string') {
    if (!value.isWellFormed()) throw new ContractValidationError([`${path}: 잘못된 Unicode`]);
    const sensitive = [
      /\b[A-Z_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z_]*\s*[:=]\s*\S+/i,
      /\bAuthorization\s*[:=]\s*\S+/i,
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:ant-)?[A-Za-z0-9_-]{20,}|mfa\.[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/,
      /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}\b/,
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
      /https?:\/\/[^\s/@]+:[^\s/@]+@/i,
      /https?:\/\/(?:[a-z0-9-]+\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\//i,
      /[?&](?:access_token|token|api_key|secret|password|signature)=/i,
      /(?:^|[\s("'`=:\[])[a-z]:[\\/]/i,
      /(?:^|[\s("'`=:\[])(?:\\\\|~[\\/]|\/(?:[A-Za-z0-9._-]+\/|home\b|Users\b|etc\b|var\b|tmp\b|root\b))/,
    ];
    if (sensitive.some(pattern => pattern.test(value))) throw new ContractValidationError([`${path}: 비밀 값 또는 개인 절대 경로를 제거하세요`]);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => assertPublicText(item, `${path}[${index}]`));
  } else if (plainObject(value)) {
    // Field names have already been checked against the fixed schema.
    for (const [key, item] of Object.entries(value)) assertPublicText(item, `${path}.${key}`);
  }
}

export function isSafeProjectPath(value, { directory = false } = {}) {
  if (typeof value !== 'string' || !value || value.length > 240 || /[\\<>:"|?*\x00-\x1f\x7f]/.test(value) || value.startsWith('/')) return false;
  const candidate = directory && value.endsWith('/') ? value.slice(0, -1) : value;
  const parts = candidate.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) return false;
  if (parts.some(part => ['.git', 'node_modules', '.aws', '.ssh'].includes(part.toLowerCase()))) return false;
  if (parts.some(part => /^\.env(?:\.|$)/i.test(part))) return false;
  if (value.toLowerCase() === '.claude/settings.local.json') return false;
  const leaf = parts.at(-1);
  return !/(?:^|[._-])(?:credentials?|secrets?|tokens?|private[._-]?key)(?:[._-]|$)/i.test(leaf)
    && !/\.(?:pem|key|p12|pfx)$/i.test(leaf)
    && !/^(?:id_rsa|id_ed25519|\.npmrc|\.netrc|access\.json)$/i.test(leaf);
}

function checked(value, schema) {
  const errors = schemaErrors(value, schema);
  if (errors.length) throw new ContractValidationError(errors);
  assertPublicText(value);
  return value;
}

export function validateTask(task) {
  checked(task, taskSchema);
  if (task.scope.some(path => !isSafeProjectPath(path, { directory: true }))) throw new ContractValidationError(['$.scope: 저장소 안의 안전한 상대 경로만 허용']);
  return task;
}

/** Validate the recorded claims. This does not run checks or prove their truth. */
export function validateResult(result, task) {
  validateTask(task);
  checked(result, resultSchema);
  const errors = [];
  if (result.requestId !== task.requestId) errors.push('$.requestId: 요청 기록과 불일치');
  if (result.baselineCommit !== task.baselineCommit) errors.push('$.baselineCommit: 기준 커밋 불일치');
  if (result.changedFiles.some(path => !isSafeProjectPath(path))) errors.push('$.changedFiles: 저장소 안의 안전한 파일 경로만 허용');
  if (result.changedFiles.some(path => !task.scope.some(scope => scope.endsWith('/') ? path.startsWith(scope) : path === scope))) errors.push('$.changedFiles: 담당 범위 밖의 변경');
  const criteria = result.acceptance.map(item => item.criterion);
  if (new Set(criteria).size !== criteria.length || criteria.length !== task.acceptanceCriteria.length
    || task.acceptanceCriteria.some(criterion => !criteria.includes(criterion))) errors.push('$.acceptance: 완료 기준을 빠짐없이 한 번씩 기록하세요');
  if (new Set(result.checks.map(check => check.name)).size !== result.checks.length) errors.push('$.checks: 검사 이름 중복');
  if (result.checks.some(check => check.status === 'failed') && result.status !== 'blocked') errors.push('$.status: 실패한 검사가 있으면 차단으로 기록하세요');
  const notVerified = /미실행|미검증|(?:실행|수행|검증|확인)\s*(?:안\s*(?:함|했|됨)|하지\s*않)|\bnot (?:run|tested|executed|checked|verified)\b|^(?:pending|todo)[.! ]*$/i;
  if (result.checks.some(check => check.status === 'passed' && notVerified.test(check.evidence))) errors.push('$.checks: 통과와 미실행 근거가 충돌합니다');
  if (result.acceptance.some(item => item.status === 'met' && notVerified.test(item.evidence))) errors.push('$.acceptance: 충족과 미검증 근거가 충돌합니다');
  if (errors.length) throw new ContractValidationError(errors);
  return result;
}

function clip(value, limit) {
  if (value.length <= limit) return value;
  let end = value.slice(0, limit - 1);
  if (/[\uD800-\uDBFF]$/.test(end)) end = end.slice(0, -1);
  return `${end}…`;
}
const display = value => String(value).replace(/\s+/g, ' ').trim().replaceAll('@', '@\u200b');

/** Stable five-line format used verbatim by the Discord output guard. */
export function renderTaskReport(result, task) {
  validateResult(result, task);
  const counts = Object.fromEntries(['passed', 'failed', 'not_run'].map(status => [status, result.checks.filter(check => check.status === status).length]));
  const checkSummary = `통과 ${counts.passed} / 실패 ${counts.failed} / 미실행 ${counts.not_run}`;
  const orderedChecks = [...result.checks].sort((a, b) => ['failed', 'not_run', 'passed'].indexOf(a.status) - ['failed', 'not_run', 'passed'].indexOf(b.status));
  const details = orderedChecks.map(check => `${checkLabels[check.status]} · ${display(check.name)} (${display(check.command)}): ${display(check.evidence)}`).join('; ');
  const criteriaMet = result.acceptance.filter(item => item.status === 'met').length;
  const changed = result.changedFiles.length ? `${result.changedFiles.length}개 · ${result.changedFiles.join(', ')}` : '파일 변경 없음';
  const next = `${result.nextSteps.map(display).join('; ')}${result.limitations.length ? ` | 한계: ${result.limitations.map(display).join('; ')}` : ''}`;
  return [
    `상태: ${RESULT_LABELS[result.status]} | 작업: ${result.requestId} | 통합: ${result.delivery.integrated ? '예' : '아니오'} | 게시: ${result.delivery.published ? '예' : '아니오'}`,
    clip(`요약: ${display(result.summary)}`, 380),
    clip(`변경: ${display(changed)}`, 280),
    clip(`검증: ${checkSummary} · 완료 기준 ${criteriaMet}/${task.acceptanceCriteria.length} | ${details}`, 650),
    clip(`다음: ${next}`, 380),
  ].join('\n');
}
