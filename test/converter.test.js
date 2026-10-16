'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { readFileSync } = require('node:fs');
const { join, basename } = require('node:path');
const { tmpdir } = require('node:os');
const { execFile, spawnSync } = require('node:child_process');
const { promisify } = require('node:util');
const { convertFile, runFfmpeg, safeStem } = require('../src/converter');

const execute = promisify(execFile);
const FFMPEG = process.env.QQ_TEST_FFMPEG || process.env.NCM_TEST_FFMPEG || (process.platform === 'darwin'
  ? '/Applications/Downie 4.app/Contents/Resources/ffmpeg' : 'ffmpeg');
const probe = spawnSync(FFMPEG, ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
if ((process.env.QQ_TEST_FFMPEG || process.env.NCM_TEST_FFMPEG) && probe.status !== 0) {
  throw new Error('指定的测试 FFmpeg 无法运行，不能跳过集成测试：' + (probe.error?.message || probe.stderr || probe.status));
}
const external = { skip: probe.status === 0 ? false : '未找到测试用 FFmpeg；可通过 QQ_TEST_FFMPEG 指定路径' };
const vectors = join(__dirname, 'fixtures', 'reference-vectors');
const manifest = JSON.parse(readFileSync(join(vectors, 'manifest.json'), 'utf8'));
const clear = readFileSync(join(vectors, manifest.plaintext.file));
const v1 = readFileSync(join(vectors, 'v1-presburger.qmcflac'));
// Recover a public independently generated test keystream, without running this
// application's decoder or reimplementing its encryption algorithm in tests.
const independentMask = Buffer.from(v1.map((byte, index) => byte ^ clear[index]));

async function ffmpeg(args) {
  return execute(FFMPEG, ['-hide_banner', '-nostdin', '-y', ...args], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true,
  });
}

function encryptFromReference(audio, mask = independentMask) {
  assert.ok(audio.length <= mask.length, 'generated sample must fit the independently validated keystream');
  return Buffer.from(audio.map((byte, index) => byte ^ mask[index]));
}

async function workspace(t) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'qq-converter-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, outputDir: join(directory, '中文输出 & files') };
}

async function sourceFile(t, format, stem = '测试歌手 - 原创合成音 & [1]') {
  const context = await workspace(t);
  const original = join(context.directory, '无版权合成原音频.' + format);
  const codec = format === 'flac' ? ['-c:a', 'flac'] : format === 'ogg'
    ? ['-c:a', 'libvorbis', '-q:a', '4'] : ['-c:a', 'libmp3lame', '-b:a', '128k'];
  await ffmpeg([
    '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=523.25:sample_rate=48000',
    '-t', '1.35', ...codec, '-metadata', 'title=合成测试音', '-metadata', 'artist=无版权测试歌手',
    '-metadata', 'album=测试专辑', original,
  ]);
  const source = encryptFromReference(await fs.readFile(original));
  const extension = format === 'mp3' ? '.qmc3' : format === 'ogg' ? '.qmcogg' : '.qmcflac';
  const inputPath = join(context.directory, stem + extension);
  await fs.writeFile(inputPath, source);
  return { ...context, original, source, inputPath };
}

async function outputFiles(directory) {
  return fs.readdir(directory).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
}

async function audioPacketHash(file) {
  const result = await ffmpeg(['-v', 'error', '-i', file, '-map', '0:a:0', '-c:a', 'copy', '-f', 'hash', '-hash', 'sha256', '-']);
  return result.stdout.trim();
}

test('safeStem preserves native Chinese paths and neutralizes Windows invalid/reserved names', () => {
  assert.equal(safeStem(join(tmpdir(), '中文目录', '歌手 - 月亮之下.qmc3')), '歌手 - 月亮之下');
  for (const name of ['CON', 'prn', 'AUX', 'NUL', 'COM1', 'LPT9', 'con.extra']) assert.match(safeStem(name + '.mflac'), /^_/);
  assert.equal(safeStem('曲名:*?<>|".mflac'), '曲名_______');
  assert.equal(safeStem('...  .qmc3'), '音频');
  assert.doesNotMatch(safeStem('字'.repeat(179) + '.后缀.qmcflac'), /[. ]$/);
  assert.equal(safeStem('🎵'.repeat(200) + '.qmcogg'), '🎵'.repeat(90));
});

test('independently encrypted FLAC and Ogg convert to decodable 320 kbps / 44.1 kHz MP3 with tags', external, async (t) => {
  for (const format of ['flac', 'ogg']) {
    await t.test(format, async (subtest) => {
      const context = await sourceFile(subtest, format);
      const statuses = [];
      const result = await convertFile(context.inputPath, context.outputDir, {
        ffmpegPath: FFMPEG, onUpdate: (update) => statuses.push(update.status),
      });
      assert.equal(basename(result.outputPath), '测试歌手 - 原创合成音 & [1].mp3');
      assert.match(result.message, /320 kbps.*44.1 kHz/);
      const decoded = await ffmpeg(['-xerror', '-err_detect', 'explode', '-i', result.outputPath, '-map', '0:a:0', '-f', 'null', '-']);
      assert.match(decoded.stderr, /44100 Hz/);
      assert.match(decoded.stderr, /320 kb\/s/);
      assert.match(decoded.stderr, /Duration: 00:00:01\./);
      const tags = await ffmpeg(['-loglevel', 'error', '-i', result.outputPath, '-f', 'ffmetadata', '-']);
      assert.match(tags.stdout, /title=合成测试音/);
      assert.match(tags.stdout, /artist=无版权测试歌手/);
      assert.match(tags.stdout, /album=测试专辑/);
      assert.ok(statuses.includes('decoding') && statuses.includes('encoding') && statuses.includes('validating'));
      assert.deepEqual(await fs.readFile(context.inputPath), context.source);
    });
  }
});

test('MP3 QMC retains identical compressed audio packets without another lossy encode', external, async (t) => {
  const context = await sourceFile(t, 'mp3');
  const result = await convertFile(context.inputPath, context.outputDir, { ffmpegPath: FFMPEG, bitrate: 320 });
  assert.equal(await audioPacketHash(result.outputPath), await audioPacketHash(context.original));
  const decoded = await ffmpeg(['-xerror', '-err_detect', 'explode', '-i', result.outputPath, '-map', '0:a:0', '-f', 'null', '-']);
  assert.match(decoded.stderr, /48000 Hz/);
  assert.match(decoded.stderr, /128 kb\/s/);
  assert.match(result.message, /保留原音质/);
});

test('QMCv2 STag with a supplied synthetic test ekey also converts real generated audio', external, async (t) => {
  const context = await sourceFile(t, 'flac', '逐曲密钥测试');
  const original = await fs.readFile(context.original);
  const entry = manifest.records.find((item) => item.file === 'v2-rc4-data.bin');
  const encryptedReference = readFileSync(join(vectors, entry.file));
  const mask = Buffer.from(encryptedReference.map((byte, index) => byte ^ clear[index]));
  const tag = Buffer.from('123456,2,fixturetest000');
  const length = Buffer.alloc(4); length.writeUInt32BE(tag.length);
  const source = Buffer.concat([encryptFromReference(original, mask), tag, length, Buffer.from('STag')]);
  const inputPath = join(context.directory, '有外部逐曲密钥.mflac');
  await fs.writeFile(inputPath, source);
  await assert.rejects(convertFile(inputPath, context.outputDir, { ffmpegPath: FFMPEG }), { code: 'ERR_QMC_KEY_REQUIRED' });
  assert.deepEqual(await outputFiles(context.outputDir), []);
  const result = await convertFile(inputPath, context.outputDir, { ffmpegPath: FFMPEG, externalKey: entry.ekey });
  await ffmpeg(['-loglevel', 'error', '-xerror', '-err_detect', 'explode', '-i', result.outputPath, '-f', 'null', '-']);
  assert.deepEqual(await fs.readFile(inputPath), source);
});

test('duplicate output preserves existing bytes and saves a second complete MP3 as (2)', external, async (t) => {
  const context = await sourceFile(t, 'flac', '重复中文歌名');
  await fs.mkdir(context.outputDir);
  const existingPath = join(context.outputDir, '重复中文歌名.mp3');
  const existing = Buffer.from('已有成品，不能覆盖');
  await fs.writeFile(existingPath, existing);
  const result = await convertFile(context.inputPath, context.outputDir, { ffmpegPath: FFMPEG });
  assert.equal(basename(result.outputPath), '重复中文歌名 (2).mp3');
  assert.deepEqual(await fs.readFile(existingPath), existing);
  assert.deepEqual((await outputFiles(context.outputDir)).sort(), ['重复中文歌名 (2).mp3', '重复中文歌名.mp3']);
  await ffmpeg(['-loglevel', 'error', '-xerror', '-err_detect', 'explode', '-i', result.outputPath, '-f', 'null', '-']);
});

test('invalid encrypted bytes or invalid decoded audio never publish a finished MP3', external, async (t) => {
  for (const source of [Buffer.from('broken QMC'), encryptFromReference(Buffer.from('ID3this is not playable audio'))]) {
    await t.test(String(source.length), async (subtest) => {
      const context = await workspace(subtest);
      const inputPath = join(context.directory, '损坏.qmc3');
      await fs.writeFile(inputPath, source);
      await assert.rejects(convertFile(inputPath, context.outputDir, { ffmpegPath: FFMPEG }));
      assert.deepEqual(await outputFiles(context.outputDir), []);
      assert.deepEqual(await fs.readFile(inputPath), source);
    });
  }
});

test('cancelling decode or an active FFmpeg child publishes no result and keeps the original', external, async (t) => {
  for (const phase of ['decoding', 'encoding']) {
    await t.test(phase, async (subtest) => {
      const context = await sourceFile(subtest, 'flac', '取消测试');
      const controller = new AbortController();
      let reached = false;
      await assert.rejects(convertFile(context.inputPath, context.outputDir, {
        ffmpegPath: FFMPEG, signal: controller.signal,
        onUpdate: (update) => {
          if (reached || update.status !== phase) return;
          if (phase === 'decoding' && update.progress > 0) { reached = true; controller.abort(); }
          else if (phase === 'encoding') {
            reached = true;
            // Allow runFfmpeg to spawn and install its abort handler first.
            setImmediate(() => controller.abort());
          }
        },
      }), { name: 'AbortError' });
      assert.equal(reached, true);
      assert.deepEqual(await outputFiles(context.outputDir), []);
      assert.deepEqual(await fs.readFile(context.inputPath), context.source);
    });
  }
});

test('the FFmpeg runner stops an ongoing real process when progress triggers cancellation', external, async () => {
  const controller = new AbortController();
  let reached = false;
  await assert.rejects(runFfmpeg(FFMPEG, [
    '-re', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=44100', '-t', '30',
    '-f', 'null', '-', '-progress', 'pipe:1', '-nostats',
  ], {
    signal: controller.signal, duration: 30,
    onProgress: (percent) => { if (percent > 0) { reached = true; controller.abort(); } },
  }), { name: 'AbortError' });
  assert.equal(reached, true);
});


test('ordinary FLAC converts at all supported bitrates and preserves Chinese tags and source bytes', external, async (t) => {
  for (const bitrate of [320, 256, 192]) {
    await t.test(String(bitrate), async (subtest) => {
      const context = await sourceFile(subtest, 'flac');
      const inputPath = join(context.directory, '独立中文原音频.FLAC');
      await fs.rename(context.original, inputPath);
      const originalBytes = await fs.readFile(inputPath);
      const originalStat = await fs.stat(inputPath);
      assert.equal(originalBytes.subarray(0, 4).toString(), 'fLaC');
      const beforeTags = await ffmpeg(['-loglevel', 'error', '-i', inputPath, '-f', 'ffmetadata', '-']);
      const expectedTags = beforeTags.stdout.split(/\r?\n/).filter((line) => /^(title|artist|album)=/.test(line));
      assert.equal(expectedTags.length, 3);
      const updates = [];
      const result = await convertFile(inputPath, context.outputDir, {
        ffmpegPath: FFMPEG, bitrate, onUpdate: (update) => updates.push(update),
      });
      assert.equal(basename(result.outputPath), '独立中文原音频.mp3');
      assert.match(result.message, new RegExp(bitrate + ' kbps.*44.1 kHz'));
      const decoded = await ffmpeg(['-xerror', '-err_detect', 'explode', '-i', result.outputPath, '-map', '0:a:0', '-f', 'null', '-']);
      assert.match(decoded.stderr, /44100 Hz/);
      assert.match(decoded.stderr, new RegExp(bitrate + ' kb/s'));
      const tags = await ffmpeg(['-loglevel', 'error', '-i', result.outputPath, '-f', 'ffmetadata', '-']);
      for (const line of expectedTags) assert.ok(tags.stdout.includes(line), 'preserved tag: ' + line);
      assert.ok(updates.some((update) => update.status === 'decoding' && /FLAC/.test(update.message || '')));
      assert.deepEqual(await fs.readFile(inputPath), originalBytes);
      assert.equal((await fs.stat(inputPath)).mtimeMs, originalStat.mtimeMs);
    });
  }
});

test('ordinary FLAC output uses a unique name without overwriting a finished file or the source', external, async (t) => {
  const context = await sourceFile(t, 'flac');
  const originalBytes = await fs.readFile(context.original);
  await fs.mkdir(context.outputDir);
  const stem = basename(context.original, '.flac');
  const existingPath = join(context.outputDir, stem + '.mp3');
  const existing = Buffer.from('existing finished MP3; must not overwrite');
  await fs.writeFile(existingPath, existing);
  const result = await convertFile(context.original, context.outputDir, { ffmpegPath: FFMPEG });
  assert.equal(basename(result.outputPath), stem + ' (2).mp3');
  assert.deepEqual(await fs.readFile(existingPath), existing);
  assert.deepEqual(await fs.readFile(context.original), originalBytes);
  await ffmpeg(['-loglevel', 'error', '-xerror', '-err_detect', 'explode', '-i', result.outputPath, '-f', 'null', '-']);
});

test('a false FLAC extension or corrupt FLAC frames cannot publish an MP3', external, async (t) => {
  for (const source of [Buffer.from('ID3this is not a FLAC file'), Buffer.from('fLaCthis has no valid STREAMINFO or audio frames')]) {
    await t.test(source.subarray(0, 4).toString(), async (subtest) => {
      const context = await workspace(subtest);
      const inputPath = join(context.directory, '伪装或损坏.flac');
      await fs.writeFile(inputPath, source);
      await assert.rejects(convertFile(inputPath, context.outputDir, { ffmpegPath: FFMPEG }));
      assert.deepEqual(await outputFiles(context.outputDir), []);
      assert.deepEqual(await fs.readFile(inputPath), source);
    });
  }
});

test('ordinary FLAC cancellation before reading or during FFmpeg leaves no result and preserves the source', external, async (t) => {
  for (const phase of ['decoding', 'encoding']) {
    await t.test(phase, async (subtest) => {
      const context = await sourceFile(subtest, 'flac');
      const originalBytes = await fs.readFile(context.original);
      const controller = new AbortController();
      let reached = false;
      await assert.rejects(convertFile(context.original, context.outputDir, {
        ffmpegPath: FFMPEG, signal: controller.signal,
        onUpdate(update) {
          if (reached || update.status !== phase) return;
          reached = true;
          if (phase === 'encoding') setImmediate(() => controller.abort());
          else controller.abort();
        },
      }), { name: 'AbortError' });
      assert.equal(reached, true);
      assert.deepEqual(await outputFiles(context.outputDir), []);
      assert.deepEqual(await fs.readFile(context.original), originalBytes);
    });
  }
});
