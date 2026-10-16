'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { createHash } = require('node:crypto');
const { decodeQmc } = require('../src/qmc');

const FIXTURES = join(__dirname, 'fixtures', 'reference-vectors');
const manifest = JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf8'));
const clear = readFileSync(join(FIXTURES, manifest.plaintext.file));
const record = (name) => manifest.records.find((entry) => entry.file === name);
const v1 = readFileSync(join(FIXTURES, 'v1-presburger.qmcflac'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function workspace(t, bytes, name = '中文歌曲 & [1].qmcflac') {
  const directory = await fs.mkdtemp(join(tmpdir(), 'qq-decoder-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const inputPath = join(directory, name);
  const outputPath = join(directory, 'restored.audio');
  await fs.writeFile(inputPath, bytes);
  return { directory, inputPath, outputPath };
}

async function missing(file) {
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
}

function withHeader(encrypted, header) {
  // XOR is linear: patch only the header of an independently generated vector.
  // The cipher implementation under test never constructs these fixtures.
  const bytes = Buffer.from(encrypted);
  for (let i = 0; i < header.length; i += 1) bytes[i] ^= clear[i] ^ header[i];
  return bytes;
}

function lengthFooter(payload, ekey) {
  const key = Buffer.from(ekey);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(key.length);
  return Buffer.concat([payload, key, length]);
}

function tagFooter(payload, content, kind = 'QTag') {
  const tag = Buffer.from(content);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(tag.length);
  return Buffer.concat([payload, tag, length, Buffer.from(kind)]);
}

test('independent public reference vectors have the recorded provenance and SHA-256 digests', async () => {
  assert.match(manifest.fixtureType, /not a real song/);
  assert.match(manifest.provenance.libtakiyashaWheel, /files\.pythonhosted\.org/);
  assert.match(manifest.provenance.presburgerSource, /github\.com\/presburger\/qmc-decoder/);
  assert.equal(hash(clear), manifest.plaintext.sha256);
  assert.ok(clear.length > 2 * 256 * 1024);
  for (const entry of manifest.records) {
    const bytes = await fs.readFile(join(FIXTURES, entry.file));
    assert.equal(bytes.length, entry.bytes, entry.file + ' length');
    assert.equal(hash(bytes), entry.sha256, entry.file + ' SHA-256');
  }
  assert.equal(manifest.v1IndependentAgreement.bytesCompared, clear.length);
  const mask = Buffer.from(v1.map((byte, index) => byte ^ clear[index]));
  assert.equal(hash(mask), manifest.v1IndependentAgreement.maskSha256);
  for (const [position, expected] of Object.entries(manifest.v1IndependentAgreement.boundaryMaskBytes)) {
    assert.equal(mask.subarray(Number(position), Number(position) + 8).toString('hex'), expected);
  }
});

test('QMCv1 matches the original C++ seed walk across 32767, 65534 and streaming block boundaries', async (t) => {
  const paths = await workspace(t, v1, '测试歌手 - 参考向量.qmcflac');
  const progress = [];
  const result = await decodeQmc(paths.inputPath, paths.outputPath, { onProgress: (value) => progress.push(value) });
  assert.equal(result.format, 'flac');
  assert.deepEqual(result.metadata, { title: '', artist: '', album: '', duration: null });
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(await fs.readFile(paths.outputPath), clear);
  assert.deepEqual(await fs.readFile(paths.inputPath), v1);
  assert.equal(progress[0], 0);
  assert.equal(progress.at(-1), 100);
  assert.ok(progress.some((value) => value > 0 && value < 100));
  assert.ok(progress.every((value, index) => value >= 0 && value <= 100 && (!index || value >= progress[index - 1])));
});

test('QMCv2 Map and HardenedRC4 match the original released Python implementation', async (t) => {
  for (const entry of manifest.records.filter((item) => ['length', 'QTag'].includes(item.footer))) {
    await t.test(entry.file, async (subtest) => {
      const source = await fs.readFile(join(FIXTURES, entry.file));
      const paths = await workspace(subtest, source, entry.file);
      const result = await decodeQmc(paths.inputPath, paths.outputPath);
      assert.equal(result.format, 'flac');
      assert.deepEqual(await fs.readFile(paths.outputPath), clear);
      assert.deepEqual(await fs.readFile(paths.inputPath), source);
    });
  }
});

test('STag requires a per-track ekey and succeeds with the matching public test ekey', async (t) => {
  for (const entry of manifest.records.filter((item) => item.footer === 'STag')) {
    await t.test(entry.file, async (subtest) => {
      const source = await fs.readFile(join(FIXTURES, entry.file));
      const paths = await workspace(subtest, source, entry.file);
      await assert.rejects(decodeQmc(paths.inputPath, paths.outputPath), { code: 'ERR_QMC_KEY_REQUIRED', message: /需要提供.*ekey/ });
      await missing(paths.outputPath);
      const result = await decodeQmc(paths.inputPath, paths.outputPath, { externalKey: '  ' + entry.ekey.replace(/=+$/, '') + '\n' });
      assert.equal(result.format, 'flac');
      assert.deepEqual(await fs.readFile(paths.outputPath), clear);
    });
  }
});

test('footerless QMCv2 accepts only a supplied per-track ekey', async (t) => {
  for (const kind of ['map', 'rc4']) {
    await t.test(kind, async (subtest) => {
      const entry = record(`v2-${kind}-data.bin`);
      const paths = await workspace(subtest, await fs.readFile(join(FIXTURES, entry.file)), `没有内嵌密钥-${kind}.mgg`);
      await assert.rejects(decodeQmc(paths.inputPath, paths.outputPath), { code: 'ERR_QMC_KEY_REQUIRED' });
      await missing(paths.outputPath);
      await decodeQmc(paths.inputPath, paths.outputPath, { externalKey: entry.ekey });
      assert.deepEqual(await fs.readFile(paths.outputPath), clear);
    });
  }
});

test('the recovered header determines MP3, FLAC or Ogg independently of the filename', async (t) => {
  const cases = [
    { name: 'id3.qmc3', header: Buffer.from('ID3\x04'), format: 'mp3' },
    { name: 'frame.qmc0', header: Buffer.from([0xff, 0xfb, 0x90, 0x64]), format: 'mp3' },
    { name: 'ogg.qmcflac', header: Buffer.from('OggS'), format: 'ogg' },
    { name: 'flac.qmcogg', header: Buffer.from('fLaC'), format: 'flac' },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async (subtest) => {
      const paths = await workspace(subtest, withHeader(v1, entry.header), entry.name);
      const result = await decodeQmc(paths.inputPath, paths.outputPath);
      assert.equal(result.format, entry.format);
      const expected = Buffer.from(clear);
      entry.header.copy(expected);
      assert.deepEqual(await fs.readFile(paths.outputPath), expected);
    });
  }
});

test('invalid keys, mismatched keys and unsupported EncV2 fail before creating output', async (t) => {
  const map = record('v2-map-data.bin');
  const rc4 = record('v2-rc4-data.bin');
  const payload = await fs.readFile(join(FIXTURES, map.file));
  const damaged = Buffer.from(map.ekey, 'base64');
  damaged[damaged.length - 1] ^= 0x11;
  const cases = [
    { name: 'bad text', key: 'not a Base64 ekey', code: 'ERR_QMC_KEY_INVALID' },
    { name: 'huge key', key: 'A'.repeat(16 * 1024 + 1), code: 'ERR_QMC_KEY_INVALID' },
    { name: 'wrong type', key: {}, code: 'ERR_QMC_KEY_INVALID' },
    { name: 'short encrypted key', key: Buffer.alloc(12).toString('base64'), code: 'ERR_QMC_KEY_INVALID' },
    { name: 'bad key padding', key: damaged.toString('base64'), code: 'ERR_QMC_KEY_INVALID' },
    { name: 'key from a different track', key: rc4.ekey, code: 'ERR_QMC_KEY_MISMATCH' },
    { name: 'EncV2', key: Buffer.concat([Buffer.from('QQMusic EncV2,Key:'), Buffer.alloc(64)]).toString('base64'), code: 'ERR_QMC_UNSUPPORTED' },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async (subtest) => {
      const paths = await workspace(subtest, payload, '密钥检查.mflac');
      await assert.rejects(decodeQmc(paths.inputPath, paths.outputPath, { externalKey: entry.key }), { code: entry.code });
      await missing(paths.outputPath);
      assert.deepEqual(await fs.readFile(paths.inputPath), payload);
    });
  }
});

test('embedded EncV2 and musicex are identified explicitly without pretending to decode them', async (t) => {
  const key = Buffer.concat([Buffer.from('QQMusic EncV2,Key:'), Buffer.alloc(64)]).toString('base64');
  const cases = [
    { source: lengthFooter(v1, key), message: /EncV2/ },
    { source: tagFooter(v1, key + ',123456,2'), message: /EncV2/ },
    { source: Buffer.concat([v1, Buffer.from('musicex\0')]), message: /musicex.*逐曲密钥/ },
    { source: Buffer.concat([v1, Buffer.from('musicex\0')]), options: { externalKey: record('v2-map-data.bin').ekey }, message: /musicex.*暂不支持/ },
  ];
  for (let i = 0; i < cases.length; i += 1) {
    await t.test(String(i + 1), async (subtest) => {
      const entry = cases[i];
      const paths = await workspace(subtest, entry.source, '新版.mflac');
      await assert.rejects(decodeQmc(paths.inputPath, paths.outputPath, entry.options), { code: 'ERR_QMC_UNSUPPORTED', message: entry.message });
      await missing(paths.outputPath);
    });
  }
});

test('truncated or oversized tags, invalid audio and empty files cannot create an output', async (t) => {
  const tooLarge = Buffer.concat([v1, Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from('QTag')]);
  const cases = [
    { bytes: Buffer.alloc(0), message: /内容不足/ },
    { bytes: Buffer.alloc(3), message: /内容不足/ },
    { bytes: Buffer.from('QTag'), message: /标签不完整/ },
    { bytes: tooLarge, message: /标签长度不正确或过大/ },
    { bytes: tagFooter(v1, 'bad,tag'), message: /标签内容损坏/ },
    { bytes: tagFooter(v1, '1,2', 'STag'), message: /标签内容损坏/ },
    { bytes: tagFooter(Buffer.alloc(0), 'a,1,2'), message: /没有完整的音频/ },
    { bytes: withHeader(v1, Buffer.from('RIFF')), name: 'unknown.qmcflac', message: /无法识别还原后的音频/ },
  ];
  for (let i = 0; i < cases.length; i += 1) {
    await t.test(String(i + 1), async (subtest) => {
      const entry = cases[i];
      const paths = await workspace(subtest, entry.bytes, entry.name || '损坏.mflac');
      await assert.rejects(decodeQmc(paths.inputPath, paths.outputPath), entry.message);
      await missing(paths.outputPath);
      assert.deepEqual(await fs.readFile(paths.inputPath), entry.bytes);
    });
  }
});

test('existing destination and the original file can never be overwritten', async (t) => {
  const paths = await workspace(t, v1);
  const existing = Buffer.from('已有成品');
  await fs.writeFile(paths.outputPath, existing);
  await assert.rejects(decodeQmc(paths.inputPath, paths.outputPath), { code: 'EEXIST' });
  assert.deepEqual(await fs.readFile(paths.outputPath), existing);
  await assert.rejects(decodeQmc(paths.inputPath, paths.inputPath), { code: 'EEXIST' });
  assert.deepEqual(await fs.readFile(paths.inputPath), v1);
});

test('pre-aborted work creates no file; midstream cancellation closes a bounded partial output', async (t) => {
  const entry = record('v2-rc4-QTag.mflac');
  const source = await fs.readFile(join(FIXTURES, entry.file));
  const paths = await workspace(t, source, '取消测试.mflac');
  const before = new AbortController();
  before.abort();
  await assert.rejects(decodeQmc(paths.inputPath, paths.outputPath, { signal: before.signal }), { name: 'AbortError', code: 'ABORT_ERR' });
  await missing(paths.outputPath);
  const during = new AbortController();
  await assert.rejects(decodeQmc(paths.inputPath, paths.outputPath, {
    signal: during.signal, onProgress: (percent) => { if (percent > 0) during.abort(); },
  }), { name: 'AbortError', code: 'ABORT_ERR' });
  const partial = await fs.readFile(paths.outputPath);
  assert.ok(partial.length > 0 && partial.length <= 256 * 1024 && partial.length < clear.length);
  assert.deepEqual(partial, clear.subarray(0, partial.length));
  assert.deepEqual(await fs.readFile(paths.inputPath), source);
  await fs.rename(paths.outputPath, join(paths.directory, 'cancelled.tmp'));
});
