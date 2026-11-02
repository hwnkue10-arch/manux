import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ContractValidationError, renderTaskReport, validateResult } from './task-contract.mjs';

function inside(root, target) {
  const child = relative(root, target);
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

export async function readTaskRecord(path, { root = process.cwd() } = {}) {
  let handle;
  try {
    const base = await realpath(root);
    const target = await realpath(resolve(base, path));
    if (!inside(base, target) || !target.toLowerCase().endsWith('.json')) throw new Error('Invalid record path');
    handle = await open(target, 'r');
    const info = await handle.stat();
    if (!info.isFile() || info.size > 65_536) throw new Error('Invalid record');
    const buffer = Buffer.alloc(65_537);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 65_536) throw new Error('Record too large');
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } catch {
    throw new ContractValidationError(['입력 파일: 저장소 안의 64KB 이하 JSON 파일 두 개를 지정하세요']);
  } finally { await handle?.close().catch(() => {}); }
}

export async function runTaskReport(args = process.argv.slice(2), { root = process.cwd(), output = console.log, error = console.error } = {}) {
  try {
    if (args.length < 2 || args.length > 3 || (args.length === 3 && args[2] !== '--check')) throw new ContractValidationError(['사용법: node scripts/task-report.mjs TASK.json RESULT.json [--check]']);
    const [task, result] = await Promise.all(args.slice(0, 2).map(path => readTaskRecord(path, { root })));
    validateResult(result, task);
    output(args[2] === '--check' ? `작업 기록 검증 통과: ${result.requestId}` : renderTaskReport(result, task));
    return 0;
  } catch (failure) {
    error(failure instanceof ContractValidationError ? failure.message : '작업 기록을 처리하지 못했습니다.');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await runTaskReport();
