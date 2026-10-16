#!/usr/bin/env node
// Node 22; only the runner's preinstalled git/gh CLIs are used (never a shell).
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'release-assets');
const PROJECTS = {
  'ncm-mp3-windows': { product: 'NCM批量转MP3', prefix: 'NCM-MP3', repository: 'apameda/ncm-mp3-windows' },
  'qq-mp3-desktop': { product: 'QQ音乐转MP3', prefix: 'QQ-MP3', repository: 'apameda/qq-mp3-desktop' },
};
const PLATFORMS = ['Windows-x64', 'macOS-arm64', 'macOS-x64'];
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const fail = (message) => { throw new Error(message); };
function scrub(value) {
  let text = String(value || '');
  for (const token of [process.env.GH_TOKEN, process.env.GITHUB_TOKEN]) if (token) text = text.split(token).join('[REDACTED]');
  return text.slice(-3000);
}
function run(command, args, { allowFailure = false, timeout = 60000 } = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT, shell: false, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout,
    env: { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', GH_DEBUG: '' },
  });
  if (!allowFailure && (result.error || result.status !== 0)) fail(`${command} failed: ${scrub(result.error?.message || result.stderr)}`);
  return result;
}
async function regular(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || !Number.isSafeInteger(stat.size) || stat.size < 1) fail('Expected a nonempty regular file: ' + path.basename(file));
  return stat;
}
async function hash(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
async function describe(file) {
  const stat = await regular(file);
  return { name: path.basename(file), size: stat.size, sha256: await hash(file) };
}
async function checkDirectory(names) {
  const stat = await fs.lstat(ASSETS);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('release-assets must be a real directory');
  const entries = await fs.readdir(ASSETS);
  const unexpected = entries.filter((name) => !names.includes(name));
  if (unexpected.length) fail('Unexpected local assets; nothing will be deleted: ' + unexpected.join(', '));
  for (const name of entries) await regular(path.join(ASSETS, name));
  return entries;
}
function checkHead(commit) {
  if (run('git', ['rev-parse', 'HEAD']).stdout.trim().toLowerCase() !== commit) fail('HEAD differs from GITHUB_SHA');
  if (run('git', ['status', '--porcelain', '--untracked-files=no']).stdout.trim()) fail('Tracked source files have changed since checkout');
}
async function context() {
  if (Number(process.versions.node.split('.')[0]) < 22) fail('Node.js 22 or newer is required');
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const project = PROJECTS[pkg.name];
  if (!project || pkg.productName !== project.product) fail('Unsupported package name/productName');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) fail('Invalid package version');
  const tag = process.env.RELEASE_TAG;
  if (tag !== 'v' + pkg.version) fail('RELEASE_TAG must equal v' + pkg.version);
  const commit = String(process.env.GITHUB_SHA || '').toLowerCase();
  if (!SHA.test(commit)) fail('GITHUB_SHA must be a full 40-character commit SHA');
  checkHead(commit);
  if (!process.env.RUNNER_TEMP || !path.isAbsolute(process.env.RUNNER_TEMP)) fail('RUNNER_TEMP must be an absolute directory');
  const notes = path.join(ROOT, 'RELEASE_NOTES.md');
  run('git', ['ls-files', '--error-unmatch', 'package.json', 'RELEASE_NOTES.md']);
  await regular(notes);
  const names = [...PLATFORMS.map((suffix) => project.prefix + '-' + suffix + '.zip'), project.prefix + '-Source.zip', 'SHA256SUMS.txt'];
  return { ...project, packageName: pkg.name, version: pkg.version, tag, commit, notes, names, manifestPath: path.join(process.env.RUNNER_TEMP, 'audio-release-manifest.json') };
}
async function prepare(ctx) {
  await fs.mkdir(ASSETS, { recursive: true });
  await checkDirectory(ctx.names);
  for (const suffix of PLATFORMS) {
    const source = path.join(ROOT, 'dist', ctx.product + '-' + suffix + '.zip');
    await regular(source);
    await fs.copyFile(source, path.join(ASSETS, ctx.prefix + '-' + suffix + '.zip'));
  }
  run('git', ['archive', '--format=zip', '--prefix=' + ctx.prefix + '-Source/', '--output=' + path.join(ASSETS, ctx.prefix + '-Source.zip'), 'HEAD']);
  const zips = [];
  for (const name of ctx.names.filter((name) => name.endsWith('.zip'))) zips.push(await describe(path.join(ASSETS, name)));
  const sums = zips.map((asset) => asset.sha256 + '  ' + asset.name + '\n').join('');
  await fs.writeFile(path.join(ASSETS, 'SHA256SUMS.txt'), sums, 'utf8');
  const assets = [...zips, await describe(path.join(ASSETS, 'SHA256SUMS.txt'))];
  const manifest = {
    schema: 1, repository: ctx.repository, packageName: ctx.packageName, product: ctx.product,
    version: ctx.version, tag: ctx.tag, commit: ctx.commit, assets,
    notesSha256: await hash(ctx.notes),
  };
  await fs.writeFile(ctx.manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  console.log('Prepared 5 verified assets and ' + ctx.manifestPath);
  for (const asset of assets) console.log(`${asset.name}  ${asset.size} bytes  sha256:${asset.sha256}`);
}
async function validateLocal(ctx) {
  await regular(ctx.manifestPath);
  const manifest = JSON.parse(await fs.readFile(ctx.manifestPath, 'utf8'));
  for (const key of ['repository', 'packageName', 'product', 'version', 'tag', 'commit']) {
    if (manifest[key] !== ctx[key]) fail('Manifest context mismatch: ' + key);
  }
  if (manifest.schema !== 1 || !Array.isArray(manifest.assets) || manifest.assets.length !== 5) fail('Invalid release manifest');
  if ((await checkDirectory(ctx.names)).length !== 5) fail('Exactly 5 local assets are required');
  const entries = new Map();
  for (const expected of manifest.assets) {
    if (!ctx.names.includes(expected.name) || entries.has(expected.name) || !DIGEST.test(expected.sha256) || !Number.isSafeInteger(expected.size)) fail('Invalid manifest asset');
    const actual = await describe(path.join(ASSETS, expected.name));
    if (actual.size !== expected.size || actual.sha256 !== expected.sha256) fail('Local asset changed: ' + expected.name);
    entries.set(expected.name, expected);
  }
  if (await hash(ctx.notes) !== manifest.notesSha256) fail('Release notes changed after prepare');
  const sums = ctx.names.filter((name) => name.endsWith('.zip')).map((name) => entries.get(name).sha256 + '  ' + name + '\n').join('');
  if (await fs.readFile(path.join(ASSETS, 'SHA256SUMS.txt'), 'utf8') !== sums) fail('SHA256SUMS.txt does not match the four ZIP files');
  return entries;
}
function api(endpoint, { allow404 = false, timeout = 60000 } = {}) {
  const result = run('gh', ['api', '--hostname', 'github.com', '--method', 'GET', '--include', '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28', endpoint], { allowFailure: true, timeout });
  const output = result.stdout || '';
  const statusMatch = /^HTTP\/\S+\s+(\d{3})\b[^\r\n]*\r?\n/m.exec(output);
  const status = statusMatch ? Number(statusMatch[1]) : null;
  if (allow404 && !result.error && status === 404) return null;
  if (result.error || result.status !== 0 || status !== 200) fail(`GitHub API failed (${status ?? 'no HTTP response'}): ${endpoint}: ${scrub(result.error?.message || result.stderr)}`);
  const headerEnd = /\r?\n\r?\n/.exec(output.slice(statusMatch.index));
  if (!headerEnd) fail('GitHub API response did not contain a header/body boundary');
  return JSON.parse(output.slice(statusMatch.index + headerEnd.index + headerEnd[0].length));
}
function tagCommit(ctx, required = false) {
  const ref = api(`repos/${ctx.repository}/git/ref/tags/${encodeURIComponent(ctx.tag)}`, { allow404: !required });
  if (!ref) return null;
  let object = ref.object;
  const visited = new Set();
  for (let depth = 0; depth < 8; depth += 1) {
    if (!object || !SHA.test(object.sha) || visited.has(object.sha)) fail('Invalid or recursive Git tag');
    visited.add(object.sha);
    if (object.type === 'commit') {
      if (object.sha !== ctx.commit) fail('Remote tag points to a different commit; it will not be moved');
      return object.sha;
    }
    if (object.type !== 'tag') fail('Remote tag does not resolve to a commit');
    object = api(`repos/${ctx.repository}/git/tags/${object.sha}`).object;
  }
  fail('Git tag nesting is too deep');
}
function releaseByTag(ctx) {
  const direct = api(`repos/${ctx.repository}/releases/tags/${encodeURIComponent(ctx.tag)}`, { allow404: true });
  if (direct) return direct;
  // Authenticated draft releases are not returned by all tag lookup paths.
  for (let page = 1; page <= 20; page += 1) {
    const releases = api(`repos/${ctx.repository}/releases?per_page=100&page=${page}`);
    if (!Array.isArray(releases)) fail('Invalid release list');
    const matching = releases.filter((release) => release.tag_name === ctx.tag);
    if (matching.length > 1) fail('Multiple releases use the requested tag');
    if (matching.length) return matching[0];
    if (releases.length < 100) return null;
  }
  fail('Release list exceeded the bounded lookup limit');
}
function assertDraft(ctx, release, id) {
  if (!release || release.tag_name !== ctx.tag || !Number.isSafeInteger(release.id) || (id && release.id !== id)) fail('Release identity changed');
  if (release.draft !== true) fail('Release is already published; refusing to change it');
}
function remoteAssets(ctx, releaseId) {
  const assets = api(`repos/${ctx.repository}/releases/${releaseId}/assets?per_page=100`);
  if (!Array.isArray(assets)) fail('Invalid remote asset list');
  const seen = new Set();
  for (const asset of assets) {
    if (!ctx.names.includes(asset.name) || seen.has(asset.name)) fail('Unexpected/duplicate remote asset; nothing will be deleted: ' + asset.name);
    seen.add(asset.name);
  }
  return assets;
}
function matches(remote, local) {
  return remote && remote.name === local.name && remote.size === local.size && remote.state === 'uploaded' && remote.digest === 'sha256:' + local.sha256;
}
function verifyRemote(ctx, id, entries) {
  const assets = remoteAssets(ctx, id);
  if (assets.length !== 5) fail('Exactly 5 remote assets are required');
  for (const asset of assets) if (!matches(asset, entries.get(asset.name))) fail('Remote asset size/state/SHA-256 mismatch: ' + asset.name);
}
async function waitForTests(ctx) {
  const workflow = api(`repos/${ctx.repository}/actions/workflows/test.yml`);
  if (workflow.name !== 'Tests' || workflow.path !== '.github/workflows/test.yml' || workflow.state !== 'active') fail('Expected the active Tests workflow at .github/workflows/test.yml');
  const deadline = Date.now() + 10 * 60 * 1000;
  let lastStatus;
  while (Date.now() < deadline) {
    const response = api(`repos/${ctx.repository}/actions/workflows/test.yml/runs?head_sha=${ctx.commit}&per_page=100`, { timeout: Math.max(1, Math.min(45000, deadline - Date.now())) });
    if (!Array.isArray(response.workflow_runs)) fail('Invalid Tests workflow run response');
    const runs = response.workflow_runs.filter((run) => run.head_sha === ctx.commit && run.workflow_id === workflow.id && run.name === 'Tests')
      .sort((a, b) => (b.run_number - a.run_number) || (b.run_attempt - a.run_attempt));
    const latest = runs[0];
    if (latest?.status === 'completed') {
      if (latest.conclusion !== 'success') fail('Tests workflow did not succeed for this exact commit: ' + latest.conclusion);
      console.log('Tests succeeded for ' + ctx.commit);
      return;
    }
    const status = latest ? latest.status : 'not started';
    if (status !== lastStatus) { console.log('Waiting for Tests: ' + status); lastStatus = status; }
    await sleep(Math.max(0, Math.min(15000, deadline - Date.now())));
  }
  fail('Tests did not complete successfully within 10 minutes');
}
async function publish(ctx) {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REPOSITORY !== ctx.repository) fail('Publishing is restricted to the matching GitHub Actions repository');
  if (!process.env.GH_TOKEN) fail('GH_TOKEN must be supplied only to the publish step');
  if (process.env.GITHUB_SERVER_URL && process.env.GITHUB_SERVER_URL !== 'https://github.com') fail('Only github.com is permitted');
  let release = releaseByTag(ctx);
  if (release) assertDraft(ctx, release);
  tagCommit(ctx);
  await waitForTests(ctx);
  checkHead(ctx.commit);
  const entries = await validateLocal(ctx);
  if (release) {
    assertDraft(ctx, releaseByTag(ctx), release.id);
    remoteAssets(ctx, release.id); // Reject unexpected assets before editing anything.
    run('gh', ['release', 'edit', ctx.tag, '--repo', ctx.repository, '--draft', '--target', ctx.commit, '--title', ctx.product + ' ' + ctx.tag, '--notes-file', ctx.notes]);
  } else {
    run('gh', ['release', 'create', ctx.tag, '--repo', ctx.repository, '--draft', '--target', ctx.commit, '--title', ctx.product + ' ' + ctx.tag, '--notes-file', ctx.notes]);
  }
  release = releaseByTag(ctx);
  assertDraft(ctx, release);
  const releaseId = release.id;
  const existingTag = tagCommit(ctx);
  if (existingTag === null && release.target_commitish !== ctx.commit) fail('Draft target is not the exact build commit');
  for (const name of ctx.names) {
    assertDraft(ctx, releaseByTag(ctx), releaseId);
    tagCommit(ctx);
    const existing = remoteAssets(ctx, releaseId).find((asset) => asset.name === name);
    if (!matches(existing, entries.get(name))) {
      run('gh', ['release', 'upload', ctx.tag, path.join(ASSETS, name), '--repo', ctx.repository, '--clobber'], { timeout: 15 * 60 * 1000 });
    }
  }
  assertDraft(ctx, releaseByTag(ctx), releaseId);
  verifyRemote(ctx, releaseId, entries);
  tagCommit(ctx);
  run('gh', ['release', 'edit', ctx.tag, '--repo', ctx.repository, '--draft=false', '--prerelease=false', '--latest', '--target', ctx.commit]);
  const published = releaseByTag(ctx);
  if (!published || published.id !== releaseId || published.draft !== false || published.prerelease !== false) fail('Public release verification failed');
  tagCommit(ctx, true);
  verifyRemote(ctx, releaseId, entries);
  console.log('Published: ' + published.html_url);
}

try {
  const command = process.argv[2];
  if (!['prepare', 'publish'].includes(command) || process.argv.length !== 3) fail('Usage: node scripts/release.mjs prepare|publish');
  const ctx = await context();
  if (command === 'prepare') await prepare(ctx); else await publish(ctx);
} catch (error) {
  console.error('Release stopped: ' + scrub(error.message));
  process.exitCode = 1;
}
