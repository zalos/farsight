import { createHash } from 'node:crypto';
import { lstat, open, mkdir, writeFile, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, relative, isAbsolute, dirname, join } from 'node:path';

export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function within(root, path) {
  const target = resolve(root, path);
  if (!path || isAbsolute(path) || relative(root, target).startsWith('..') || path.includes(',') || path.includes('\\')) throw new Error('Unsafe corpus path');
  return target;
}
export async function readPlain(root, path, limit = 2 * 1024 * 1024) {
  const target = within(root, path);
  for (let directory = dirname(target);; directory = dirname(directory)) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Corpus parent must be a plain directory');
    if (directory === root) break;
  }
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error('Corpus file must be bounded and regular');
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.ino !== info.ino || opened.dev !== info.dev || opened.size > limit) throw new Error('Corpus file identity changed');
    return await handle.readFile();
  } finally { await handle.close(); }
}
export function validateIndex(index, texts) {
  if (index.schemaVersion !== 'sentinel-engine-corpus-v1' || index.files.length !== 12 || index.rules.length !== 2 || index.labels.length !== 18) throw new Error('Unexpected corpus inventory');
  const paths = index.files.map(f => f.path);
  if (new Set(paths).size !== paths.length || new Set(index.labels.map(l => l.id)).size !== 18) throw new Error('Duplicate corpus identity');
  if (index.files.filter(f => f.stage === 'valid').length !== 9 || index.labels.filter(l => l.label === 'positive').length !== 9 || index.labels.filter(l => l.label === 'safe').length !== 9) throw new Error('Corpus denominator mismatch');
  if (index.denominator?.validFiles !== 9 || index.denominator?.positiveSymbols !== 9 || index.denominator?.safeSymbols !== 9 || index.denominator?.controlsOutsideCapability !== 3) throw new Error('Declared denominator mismatch');
  for (const language of ['typescript', 'javascript', 'java']) {
    for (const capability of ['direct', 'local', 'cross-file']) {
      const pair = index.labels.filter(l => l.language === language && l.capability === capability);
      if (pair.length !== 2 || pair.filter(l => l.label === 'positive').length !== 1 || pair.filter(l => l.label === 'safe').length !== 1) throw new Error('Missing semantic pair');
    }
  }
  for (const label of index.labels) {
    const source = texts[label.path];
    const length = typeof source === 'string' ? source.replace(/\n$/, '').split('\n').length : 0;
    if (!Number.isInteger(label.startLine) || !Number.isInteger(label.endLine) || label.startLine < 1 || label.endLine < label.startLine || label.endLine > length) throw new Error('Invalid independent span');
    if (index.labels.some(other => other !== label && other.path === label.path && label.startLine <= other.endLine && label.endLine >= other.startLine)) throw new Error('Overlapping independent spans');
    if (!index.files.some(f => f.path === label.path && f.stage === 'valid')) throw new Error('Label outside valid source inventory');
    if (label.capability === 'cross-file') {
      const sourceLines = texts[label.sourcePath]?.replace(/\n$/, '').split('\n').length ?? 0;
      if (label.sourcePath === label.path || !Number.isInteger(label.sourceStartLine) || !Number.isInteger(label.sourceEndLine) || label.sourceStartLine < 1 || label.sourceEndLine < label.sourceStartLine || label.sourceEndLine > sourceLines) throw new Error('Invalid cross-file source boundary');
    }
  }
}
export async function loadCorpus(root) {
  root = resolve(root);
  const bytes = await readPlain(root, 'index.json');
  const index = JSON.parse(bytes), inputs = [], texts = {};
  for (const file of [...index.files, ...index.rules]) {
    const bytes = await readPlain(root, file.source);
    if (hash(bytes) !== file.sha256 || bytes.length !== file.bytes) throw new Error('Corpus source hash or byte count mismatch');
    inputs.push({ ...file, bytesData: bytes });
    if (file.path) texts[file.path] = bytes.toString('utf8');
  }
  validateIndex(index, texts);
  return { index, indexSha256: hash(bytes), inputs, texts };
}
export async function materialize(root, corpus) {
  const dirs = {};
  for (const stage of ['valid', 'partial', 'out-of-rule-language', 'oversize', 'rules']) {
    dirs[stage] = join(root, stage); await mkdir(dirs[stage]); await chmod(dirs[stage], 0o755);
  }
  const inventory = [];
  for (const input of corpus.inputs) {
    const stage = input.mode ? 'rules' : input.stage;
    const path = input.mode ? `${input.mode}.yaml` : input.path;
    const target = within(dirs[stage], path);
    await mkdir(dirname(target), { recursive: true });
    for (let directory = dirname(target); directory !== dirs[stage]; directory = dirname(directory)) await chmod(directory, 0o755);
    await writeFile(target, input.bytesData, { flag: 'wx', mode: 0o644 }); await chmod(target, 0o644);
    inventory.push({ path, stage, sha256: input.sha256, bytes: input.bytes, outputRelativePath: `${stage}/${path}` });
  }
  return { dirs, inventory };
}
