import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { buildBundle } from './lib/bundle-build.mjs';

const execFileAsync = promisify(execFile);
const canonicalRepository = ['https://github', '.com/jiuchuan', 'll/project-lifecycle'].join('');
const generatedBundlePath = 'dist/project-lifecycle.mjs';
const compareCodePoints = (left, right) => {
  const leftPoints = [...left].map((character) => character.codePointAt(0));
  const rightPoints = [...right].map((character) => character.codePointAt(0));
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
};

const rules = [
  {
    code: 'PRIVACY_ABSOLUTE_PATH',
    pattern: /(?:^|[^A-Za-z0-9_])(?:\/Users\/[^/\s"'`]+|\/home\/[^/\s"'`]+|[A-Za-z]:\\Users\\[^\\\s"'`]+)/,
  },
  {
    code: 'PRIVACY_SECRET_PATTERN',
    pattern: /(?:^|[^A-Za-z0-9_])["']?(?:token|api[_-]?key|password|secret)["']?\s*[:=]\s*["']?[^\s"'`,;]+["']?/i,
  },
  {
    code: 'PRIVACY_PRIVATE_LOCATOR',
    pattern: /(?:https?:\/\/|git@)?github\.com[/:](?!sponsors(?:\/|$))[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/i,
  },
];

const excluded = (path) => path.split('/').some((segment) => (
  segment === '.git' || segment === 'node_modules' || segment === '.privacy-test-tmp'
));

const insideRoot = (root, candidate) => {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

const trackedFiles = async (root) => {
  const { stdout } = await execFileAsync('git', ['-C', root, 'ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.split('\0').filter(Boolean).sort(compareCodePoints);
};

export const checkPrivacy = async (rootValue) => {
  const root = resolve(rootValue);
  const findings = [];
  let scannedFiles = 0;
  const files = await trackedFiles(root);
  let expectedBundle = null;
  if (files.includes(generatedBundlePath)) {
    const built = await buildBundle({ repositoryRoot: root, write: false });
    expectedBundle = built.outputFiles?.find(({ path }) => path.endsWith(generatedBundlePath))?.contents ?? null;
  }

  for (const path of files) {
    if (excluded(path)) continue;
    const absolute = resolve(root, path);
    if (!insideRoot(root, absolute)) continue;
    const stats = await lstat(absolute);
    if (!stats.isFile()) continue;
    const content = await readFile(absolute);
    if (content.includes(0)) continue;
    scannedFiles += 1;
    if (path === generatedBundlePath) {
      if (expectedBundle === null || !content.equals(expectedBundle)) {
        findings.push({ code: 'PRIVACY_GENERATED_ARTIFACT_MISMATCH', path, line: 1 });
      }
      continue;
    }
    for (const [index, line] of content.toString('utf8').split(/\r?\n/).entries()) {
      const scannedLine = line.replaceAll(canonicalRepository, '');
      for (const { code, pattern } of rules) {
        if (pattern.test(scannedLine)) findings.push({ code, path, line: index + 1 });
      }
    }
  }

  findings.sort((left, right) => compareCodePoints(left.path, right.path)
    || left.line - right.line
    || compareCodePoints(left.code, right.code));
  return { ok: findings.length === 0, scanned_files: scannedFiles, findings };
};

try {
  const summary = await checkPrivacy(process.argv[2] ?? process.cwd());
  console.log(JSON.stringify(summary));
  if (!summary.ok) process.exitCode = 1;
} catch {
  console.log(JSON.stringify({
    ok: false,
    scanned_files: 0,
    findings: [],
    errors: [{ code: 'PRIVACY_SCAN_ERROR' }],
  }));
  process.exitCode = 2;
}
