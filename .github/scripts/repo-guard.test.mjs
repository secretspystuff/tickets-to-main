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

function assertWorkflowContract(candidate) {
  const job = candidate.jobs.check;
  assert.ok(job);
  assert.equal(Object.hasOwn(job, 'if'), false, 'The check job has no condition');
  assert.ok(!job['continue-on-error']);
  // Compare complete mappings, including order, rather than selected properties.
  // Every additional key or changed value requires updating this reviewed contract.
  const expectedSteps = [
    {
      uses: 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
      with: { 'fetch-depth': 0, 'persist-credentials': false },
    },
    {
      uses: 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
      with: { 'node-version': '24.18.0', cache: 'npm' },
    },
    {
      name: 'Check tracked paths',
      run: 'node .github/scripts/repo-guard.mjs paths',
    },
    {
      name: 'Check private names in tracked paths and contents',
      if: '${{ !cancelled() }}',
      run: 'node .github/scripts/repo-guard.mjs private',
    },
    {
      name: 'Install Gitleaks 8.30.1',
      if: '${{ !cancelled() }}',
      shell: 'bash',
      run: [
        'set -euo pipefail',
        'cd "$RUNNER_TEMP"',
        'curl --fail --silent --show-error --location --retry 3 \\',
        '  https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz \\',
        '  --output gitleaks.tar.gz',
        "echo '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb  gitleaks.tar.gz' | sha256sum --check",
        'mkdir -p gitleaks-bin',
        'tar -xzf gitleaks.tar.gz -C gitleaks-bin gitleaks',
        'echo "$RUNNER_TEMP/gitleaks-bin" >> "$GITHUB_PATH"',
        '',
      ].join('\n'),
    },
    {
      name: 'Scan secrets through the complete reachable history',
      if: '${{ !cancelled() }}',
      run: 'gitleaks git --redact --no-banner --ignore-gitleaks-allow --gitleaks-ignore-path .github/secret-fixtures.ignore --log-opts=HEAD .',
    },
    { run: 'npm ci --ignore-scripts --no-audit --no-fund' },
    { run: 'npm run check' },
  ];
  assert.deepEqual(job.steps, expectedSteps, 'The check steps match the complete reviewed definitions');
  assert.deepEqual(candidate, {
    name: 'check',
    on: ['push', 'pull_request'],
    permissions: { contents: 'read' },
    concurrency: {
      group: '${{ github.workflow }}-${{ github.ref }}',
      'cancel-in-progress': true,
    },
    jobs: {
      check: {
        'runs-on': 'ubuntu-latest',
        steps: expectedSteps,
      },
    },
  }, 'The entire workflow matches the reviewed definition');
}

test('the required check job runs every guard and uses pinned actions', () => {
  assertWorkflowContract(workflow);
});

for (const [label, name, edits] of [
  ['working directory', 'Check private names in tracked paths and contents', { 'working-directory': '/tmp' }],
  ['custom shell', 'Check private names in tracked paths and contents', { shell: 'bash {0}' }],
  ['working directory and custom shell', 'Check private names in tracked paths and contents', { 'working-directory': '/tmp', shell: 'bash {0}' }],
  ['secret scanner environment', 'Scan secrets through the complete reachable history', { env: { GITLEAKS_CONFIG_TOML: 'title = "override"' } }],
  ['extra condition', 'Check tracked paths', { if: true }],
  ['extra continue-on-error', 'Check tracked paths', { 'continue-on-error': false }],
]) {
  test(`workflow contract rejects ${label}`, () => {
    const modified = structuredClone(workflow);
    Object.assign(modified.jobs.check.steps.find((step) => step.name === name), edits);
    assert.throws(() => assertWorkflowContract(modified), { code: 'ERR_ASSERTION' });
  });
}

test('workflow contract rejects a job-level condition even when true', () => {
  const modified = structuredClone(workflow);
  modified.jobs.check.if = true;
  assert.throws(() => assertWorkflowContract(modified), { code: 'ERR_ASSERTION' });
});

for (const [label, mutate] of [
  ['job environment', (value) => { value.jobs.check.env = { GITLEAKS_CONFIG_TOML: 'x' }; }],
  ['job default working directory', (value) => { value.jobs.check.defaults = { run: { 'working-directory': '/tmp' } }; }],
  ['job default shell', (value) => { value.jobs.check.defaults = { run: { shell: 'bash {0}' } }; }],
  ['workflow default shell', (value) => { value.defaults = { run: { shell: 'bash {0}' } }; }],
  ['workflow environment', (value) => { value.env = { GITLEAKS_CONFIG_TOML: 'x' }; }],
  ['write permissions', (value) => { value.permissions.contents = 'write'; }],
  ['job container', (value) => { value.jobs.check.container = 'node:24'; }],
  ['job timeout', (value) => { value.jobs.check['timeout-minutes'] = 1; }],
  ['job strategy', (value) => { value.jobs.check.strategy = { 'fail-fast': false }; }],
  ['additional job', (value) => { value.jobs.extra = { 'runs-on': 'ubuntu-latest', steps: [] }; }],
]) {
  test(`workflow contract rejects ${label}`, () => {
    const modified = structuredClone(workflow);
    mutate(modified);
    assert.throws(() => assertWorkflowContract(modified), { code: 'ERR_ASSERTION' });
  });
}

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
