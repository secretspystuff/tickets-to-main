import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parse } from 'yaml';

const script = fileURLToPath(new URL('./repo-guard.mjs', import.meta.url));
const workflow = parse(readFileSync(new URL('../workflows/check.yml', import.meta.url), 'utf8'));

test('the required check job runs every guard and uses pinned actions', () => {
  const job = workflow.jobs.check;
  assert.ok(job);
  assert.equal(job.if, undefined);
  assert.ok(!job['continue-on-error']);
  const steps = job.steps;
  const commands = [
    'node .github/scripts/repo-guard.mjs paths',
    'node .github/scripts/repo-guard.mjs private',
    'gitleaks git --redact --no-banner --ignore-gitleaks-allow --gitleaks-ignore-path .github/secret-fixtures.ignore --log-opts=HEAD .',
    'npm ci --ignore-scripts --no-audit --no-fund',
    'npm run check',
  ];
  for (const command of commands) {
    const step = steps.find((entry) => entry.run === command);
    assert.ok(step, `Required check command missing: ${command}`);
    assert.ok(step.if === undefined || step.if === '${{ !cancelled() }}', `Disabled check command: ${command}`);
    assert.ok(!step['continue-on-error']);
  }
  const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout?.uses, 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262');
  assert.equal(checkout.with['fetch-depth'], 0);
  assert.equal(checkout.with['persist-credentials'], false);
  assert.equal(steps.find((step) => step.uses?.startsWith('actions/setup-node@'))?.uses,
    'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020');
  const install = steps.find((step) => step.name === 'Install Gitleaks 8.30.1');
  assert.ok(install?.run.includes('sha256sum --check'));
  assert.ok(install.if === undefined || install.if === '${{ !cancelled() }}');
  assert.ok(!install['continue-on-error']);
});

// Tree objects exercise the real committed-blob CLI without authors, credentials,
// checkout changes, or reading local environment files.
function scan(content, path = 'dispatcher/fixtures/boundary-probe.txt') {
  const cwd = mkdtempSync(join(tmpdir(), 'ttm-guard-test-'));
  const git = (args, input) => execFileSync('git', args, { cwd, input, encoding: 'utf8' }).trim();
  try {
    git(['init', '--quiet']);
    const oid = git(['hash-object', '-w', '--stdin'], content);
    git(['update-index', '--add', '--cacheinfo', `100644,${oid},${path}`]);
    const ref = git(['write-tree']);
    return spawnSync(process.execPath, [script, 'private', ref], { cwd, encoding: 'utf8' });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

for (const suffix of ['data', 'database', 'data_x']) {
  test(`worker path prefix rejects suffix ${suffix}`, () => {
    const result = scan(['workers', suffix].join('/'));
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Private pattern 1:/);
  });
}

test('UTF-16LE and UTF-16BE private text and arbitrary NUL blobs refuse', () => {
  const le = Buffer.from(['workers', 'data'].join('/'), 'utf16le');
  for (const content of [le, Buffer.from(le).swap16(), Buffer.from([65, 0, 66])]) {
    const result = scan(content);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /NUL-containing tracked blob:/);
  }
});

const envName = '.' + 'env';
for (const [label, content] of [
  ['command option', `node --env-file=${envName}`],
  ['brackets', `[${envName}]`],
  ['colon', `x:${envName}`],
  ['comma', `a,${envName}`],
]) {
  test(`environment filename refuses after ${label}`, () => {
    const result = scan(content);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Private pattern 3:/);
  });
}

test('environment filename in a tracked path refuses without a local file', () => {
  assert.equal(scan('fabricated', `dispatcher/${envName}.local`).status, 1);
});

test('ordinary process environment access and public text pass', () => {
  const result = scan('process.env.HOME; public Dispatcher source');
  assert.equal(result.status, 0, result.stderr);
});
