'use strict';

// QMCv1 seed walk: presburger/qmc-decoder (MIT), src/seed.hpp.
// QMCv2 mask, HardenedRC4 and Tars TEA: nukemiko/libtakiyasha (MIT).
// Sources and independent reference fixtures are documented under test/fixtures.
// No account databases, network key services or account credentials are read.
const { open } = require('node:fs/promises');
const { extname } = require('node:path');

const CHUNK_BYTES = 256 * 1024;
const MAX_EKEY_BYTES = 16 * 1024;
const MAX_TAG_BYTES = 32 * 1024;
const CORE_KEY = Buffer.from('695646382b20150b', 'hex');
const ENCV2_PREFIX = Buffer.from('QQMusic EncV2,Key:');
const V1_EXTENSIONS = [...'0123456789'].map((suffix) => 'qmc' + suffix).concat(['qmcflac', 'qmcogg', 'qmcra']);
const V2_EXTENSIONS = ['mflac', 'mgg', 'mmp4'].flatMap((base) => ['', ...'0123456789abcdefghijklmnopqrstuvwxyz'].map((suffix) => base + suffix));
// One allow-list for decoding, recursive scanning and native OS file pickers.
// An allowed suffix permits an attempt, not a promise about its audio codec.
const supportedExtensions = Object.freeze([...V1_EXTENSIONS, ...V2_EXTENSIONS]);
const V1_EXTENSION_SET = new Set(V1_EXTENSIONS);
const V2_EXTENSION_SET = new Set(V2_EXTENSIONS);

function qmcError(message, code = 'ERR_QMC_INVALID') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function checkAbort(signal) {
  if (signal?.aborted) {
    const error = new Error('已取消转换');
    error.name = 'AbortError';
    error.code = 'ABORT_ERR';
    throw error;
  }
}

function keyRequired() {
  return qmcError('此文件没有内嵌可用的逐曲密钥，需要提供本文件对应的 ekey；新版加密格式也可能暂不受支持。', 'ERR_QMC_KEY_REQUIRED');
}

function parseBase64(value) {
  if (typeof value !== 'string' || value.length > MAX_EKEY_BYTES) {
    throw qmcError('逐曲 ekey 必须是长度合理的 Base64 文本', 'ERR_QMC_KEY_INVALID');
  }
  const encoded = value.trim();
  if (encoded.length < 16 || encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw qmcError('逐曲 ekey 的 Base64 编码不正确', 'ERR_QMC_KEY_INVALID');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    throw qmcError('逐曲 ekey 的 Base64 编码不正确', 'ERR_QMC_KEY_INVALID');
  }
  return bytes;
}

function teaBlockDecrypt(bytes, keyWords) {
  let left = bytes.readUInt32BE(0);
  let right = bytes.readUInt32BE(4);
  let sum = 0xe3779b90; // 0x9e3779b9 * 16, modulo 2^32 (32 half-rounds).
  for (let round = 0; round < 16; round += 1) {
    right = (right - ((((left << 4) + keyWords[2]) ^ (left + sum) ^ ((left >>> 5) + keyWords[3])) >>> 0)) >>> 0;
    left = (left - ((((right << 4) + keyWords[0]) ^ (right + sum) ^ ((right >>> 5) + keyWords[1])) >>> 0)) >>> 0;
    sum = (sum - 0x9e3779b9) >>> 0;
  }
  const output = Buffer.alloc(8);
  output.writeUInt32BE(left, 0);
  output.writeUInt32BE(right, 4);
  return output;
}

function decryptTarsTea(bytes, key) {
  if (bytes.length < 16 || bytes.length % 8 !== 0) {
    throw qmcError('逐曲密钥的加密区块长度不正确', 'ERR_QMC_KEY_INVALID');
  }
  const words = [0, 4, 8, 12].map((position) => key.readUInt32BE(position));
  const padded = Buffer.alloc(bytes.length);
  let previousIntermediate = Buffer.alloc(8);
  let previousCipher = Buffer.alloc(8);
  for (let offset = 0; offset < bytes.length; offset += 8) {
    const cipher = bytes.subarray(offset, offset + 8);
    const mixed = Buffer.alloc(8);
    for (let i = 0; i < 8; i += 1) mixed[i] = cipher[i] ^ previousIntermediate[i];
    const intermediate = teaBlockDecrypt(mixed, words);
    for (let i = 0; i < 8; i += 1) padded[offset + i] = intermediate[i] ^ previousCipher[i];
    previousIntermediate = intermediate;
    previousCipher = cipher;
  }
  const start = 1 + (padded[0] & 7) + 2;
  const end = padded.length - 7;
  if (end < start || !padded.subarray(end).every((byte) => byte === 0)) {
    throw qmcError('逐曲 ekey 校验失败，密钥可能损坏或不受支持', 'ERR_QMC_KEY_INVALID');
  }
  return padded.subarray(start, end);
}

function unwrapEkey(value) {
  const bytes = parseBase64(value);
  if (bytes.subarray(0, ENCV2_PREFIX.length).equals(ENCV2_PREFIX)) {
    throw qmcError('检测到 QQMusic EncV2 新版密钥保护，当前版本暂不支持；不会尝试输出无法播放的文件。', 'ERR_QMC_UNSUPPORTED');
  }
  if (bytes.length < 24) throw qmcError('逐曲 ekey 长度不足', 'ERR_QMC_KEY_INVALID');
  const recipe = bytes.subarray(0, 8);
  const teaKey = Buffer.alloc(16);
  for (let i = 0; i < 8; i += 1) {
    teaKey[i * 2] = CORE_KEY[i];
    teaKey[i * 2 + 1] = recipe[i];
  }
  const master = Buffer.concat([recipe, decryptTarsTea(bytes.subarray(8), teaKey)]);
  if (master.length !== 256 && master.length !== 512) {
    throw qmcError('此逐曲密钥长度不受支持，当前支持 256 字节或 512 字节的常规 QMCv2 密钥', 'ERR_QMC_UNSUPPORTED');
  }
  return master;
}

function makeV1Mask() {
  const rows = [
    [0x4a, 0xd6, 0xca, 0x90, 0x67, 0xf7, 0x52], [0x5e, 0x95, 0x23, 0x9f, 0x13, 0x11, 0x7e],
    [0x47, 0x74, 0x3d, 0x90, 0xaa, 0x3f, 0x51], [0xc6, 0x09, 0xd5, 0x9f, 0xfa, 0x66, 0xf9],
    [0xf3, 0xd6, 0xa1, 0x90, 0xa0, 0xf7, 0xf0], [0x1d, 0x95, 0xde, 0x9f, 0x84, 0x11, 0xf4],
    [0x0e, 0x74, 0xbb, 0x90, 0xbc, 0x3f, 0x92], [0x00, 0x09, 0x5b, 0x9f, 0x62, 0x66, 0xa1],
  ];
  let x = -1;
  let y = 8;
  let direction = 1;
  return Uint8Array.from({ length: 128 }, () => {
    let value;
    if (x < 0) { direction = 1; y = (8 - y) % 8; value = 0xc3; }
    else if (x > 6) { direction = -1; y = 7 - y; value = 0xd8; }
    else value = rows[y][x];
    x += direction;
    return value;
  });
}

const V1_MASK = makeV1Mask();

function maskTransform(mask) {
  return (bytes, offset) => {
    for (let i = 0; i < bytes.length; i += 1) {
      let position = offset + i;
      // Offset 32767 itself is not folded; the first skipped seed is at 32768.
      if (position > 0x7fff) position %= 0x7fff;
      bytes[i] ^= mask[position % 128];
    }
  };
}

function makeV2Transform(master) {
  if (master.length === 256) {
    const mask = Uint8Array.from({ length: 128 }, (_, position) => {
      const index = (position * position + 71214) % 256;
      const shift = ((index & 7) + 4) % 8;
      const value = master[index];
      return ((value << shift) & 0xff) | (value >> shift);
    });
    return maskTransform(mask);
  }
  if (master.includes(0)) {
    throw qmcError('此 RC4 逐曲密钥包含无效的零字节，无法安全处理', 'ERR_QMC_KEY_INVALID');
  }
  const length = master.length;
  const initialBox = Uint8Array.from({ length }, (_, i) => i % 256);
  let j = 0;
  for (let i = 0; i < length; i += 1) {
    j = (j + initialBox[i] + master[i]) % length;
    [initialBox[i], initialBox[j]] = [initialBox[j], initialBox[i]];
  }
  let hash = 1;
  for (const byte of master) {
    const next = Math.imul(hash, byte) >>> 0;
    if (next === 0 || next <= hash) break;
    hash = next;
  }
  const skipFor = (value) => Math.floor(hash / ((value + 1) * master[value % length]) * 100) % length;
  return (bytes, offset) => {
    let done = 0;
    while (done < bytes.length) {
      const absolute = offset + done;
      if (absolute < 128) {
        bytes[done] ^= master[skipFor(absolute)];
        done += 1;
        continue;
      }
      const count = Math.min(bytes.length - done, 5120 - (absolute % 5120));
      const skip = absolute % 5120 + skipFor(Math.floor(absolute / 5120));
      const box = Uint8Array.from(initialBox);
      let first = 0;
      let second = 0;
      for (let i = 0; i < skip + count; i += 1) {
        first = (first + 1) % length;
        second = (box[first] + second) % length;
        [box[first], box[second]] = [box[second], box[first]];
        if (i >= skip) bytes[done + i - skip] ^= box[(box[first] + box[second]) % length];
      }
      done += count;
    }
  };
}

function identifyAudio(bytes) {
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from('fLaC'))) return 'flac';
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from('OggS'))) return 'ogg';
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from('ID3'))) return 'mp3';
  if (bytes.length >= 4 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0
      && ((bytes[1] >> 3) & 3) !== 1 && ((bytes[1] >> 1) & 3) === 1
      && (bytes[2] >> 4) !== 0 && (bytes[2] >> 4) !== 15 && ((bytes[2] >> 2) & 3) !== 3) return 'mp3';
  throw qmcError('无法识别还原后的音频：逐曲密钥可能不匹配、文件损坏，或属于暂不支持的新版加密格式。', 'ERR_QMC_KEY_MISMATCH');
}

/**
 * Restore a supported QMC container to a NEW temporary file (never overwrite).
 * externalKey is this track's Base64 encrypted ekey, not an account credential.
 * Partial output after an error/abort is closed and left for the caller to remove.
 */
async function decodeQmc(inputPath, outputPath, { signal, onProgress, externalKey } = {}) {
  let input;
  let output;
  checkAbort(signal);
  try {
    input = await open(inputPath, 'r');
    const stat = await input.stat();
    if (!stat.isFile()) throw qmcError('请选择 QQ 音乐加密文件，不能直接读取文件夹');
    const size = stat.size;
    if (!Number.isSafeInteger(size) || size < 4) throw qmcError('文件内容不足或大小不合理，无法读取 QQ 音乐加密文件');
    async function readAt(position, count, label) {
      checkAbort(signal);
      if (!Number.isSafeInteger(position) || !Number.isSafeInteger(count) || position < 0 || count < 0 || position > size - count) {
        throw qmcError(`${label}越过文件边界，文件可能已截断`);
      }
      const bytes = Buffer.alloc(count);
      let received = 0;
      while (received < count) {
        checkAbort(signal);
        const result = await input.read(bytes, received, count - received, position + received);
        if (!result.bytesRead) throw qmcError(`${label}不完整，文件可能已截断`);
        received += result.bytesRead;
      }
      checkAbort(signal);
      return bytes;
    }
    const tail = await readAt(Math.max(0, size - 32), Math.min(32, size), '文件尾部');
    if (tail.includes(Buffer.from('musicex'))) {
      throw qmcError(externalKey
        ? '检测到 musicex 新版封装，当前版本暂不支持，已停止处理。'
        : '检测到 musicex 新版封装，文件没有可用的内嵌逐曲密钥，且当前版本暂不支持该封装。', 'ERR_QMC_UNSUPPORTED');
    }
    const last = tail.subarray(tail.length - 4);
    let audioBytes = size;
    let embeddedKey;
    let hasV2Footer = false;
    const tag = last.toString('latin1');
    if (tag === 'QTag' || tag === 'STag') {
      if (size < 8) throw qmcError('QQ 音乐尾部标签不完整');
      const footer = await readAt(size - 8, 8, '尾部标签');
      const tagLength = footer.readUInt32BE(0);
      if (!tagLength || tagLength > MAX_TAG_BYTES || tagLength > size - 8) {
        throw qmcError('QQ 音乐尾部标签长度不正确或过大');
      }
      audioBytes = size - 8 - tagLength;
      const rawTag = (await readAt(audioBytes, tagLength, '尾部标签')).toString('latin1');
      const parts = rawTag.split(',');
      if (parts.length !== 3 || !/^[0-9]+$/.test(parts[tag === 'QTag' ? 1 : 0]) || !/^[0-9]+$/.test(parts[tag === 'QTag' ? 2 : 1])) {
        throw qmcError('QQ 音乐尾部标签内容损坏');
      }
      if (tag === 'QTag') embeddedKey = parts[0];
      hasV2Footer = true;
    } else {
      const keyLength = last.readUInt32LE(0);
      if (keyLength > 0 && keyLength <= MAX_EKEY_BYTES && keyLength <= size - 4) {
        const value = (await readAt(size - 4 - keyLength, keyLength, '尾部逐曲密钥')).toString('latin1');
        // Do not mistake arbitrary QMCv1 audio for a key-length footer.
        if (/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
          embeddedKey = value;
          audioBytes = size - 4 - keyLength;
          hasV2Footer = true;
        }
      }
    }
    if (audioBytes < 4) throw qmcError('文件没有完整的音频内容');
    let transform;
    const extension = extname(inputPath).slice(1).toLowerCase();
    if (externalKey !== undefined && externalKey !== null && externalKey !== '') {
      transform = makeV2Transform(unwrapEkey(externalKey));
    } else if (embeddedKey !== undefined) {
      transform = makeV2Transform(unwrapEkey(embeddedKey));
    } else if (hasV2Footer || V2_EXTENSION_SET.has(extension)) {
      throw keyRequired();
    } else if (V1_EXTENSION_SET.has(extension)) {
      transform = maskTransform(V1_MASK);
    } else {
      throw qmcError('不是受支持的 QMC 文件扩展名；请添加 qmc0/qmc3/qmcflac/qmcogg 或常规 mflac/mgg 文件。', 'ERR_QMC_UNSUPPORTED');
    }

    let offset = 0;
    let format;
    let reported = -1;
    const progress = (value) => {
      const percent = Math.floor(Math.max(0, Math.min(100, value)));
      if (percent !== reported) { reported = percent; onProgress?.(percent); }
      checkAbort(signal);
    };
    progress(0);
    while (offset < audioBytes) {
      const bytes = await readAt(offset, Math.min(CHUNK_BYTES, audioBytes - offset), '加密音频');
      transform(bytes, offset);
      checkAbort(signal);
      if (!output) {
        format = identifyAudio(bytes);
        output = await open(outputPath, 'wx');
        checkAbort(signal);
      }
      let written = 0;
      while (written < bytes.length) {
        checkAbort(signal);
        const result = await output.write(bytes, written, bytes.length - written);
        if (!result.bytesWritten) throw qmcError('无法写入音频，请检查磁盘空间和输出目录权限');
        written += result.bytesWritten;
      }
      offset += bytes.length;
      progress(offset / audioBytes * 100);
    }
    await output.close();
    output = null;
    return { format, metadata: { title: '', artist: '', album: '', duration: null }, warnings: [] };
  } catch (error) {
    if (error.code === 'EEXIST') error.message = '输出文件已存在，为保护已有文件，本次转换已停止';
    if (error.code === 'ENOENT') error.message = '找不到输入文件或输出目录，请重新选择';
    if (error.code === 'EACCES' || error.code === 'EPERM') error.message = '没有权限读取文件或写入输出目录，请选择其他位置';
    if (error.code === 'ENOSPC') error.message = '磁盘空间不足，请清理空间后重试';
    throw error;
  } finally {
    await Promise.allSettled([output?.close(), input?.close()]);
  }
}

module.exports = { decodeQmc, supportedExtensions };
