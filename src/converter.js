'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { decodeQmc } = require('./qmc');

function checkCancelled(signal) {
  if (signal?.aborted) {
    const error = new Error('已取消转换');
    error.name = 'AbortError';
    throw error;
  }
}

function safeStem(inputPath) {
  let name = path.basename(inputPath, path.extname(inputPath))
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '');
  let shortened = '';
  for (const character of name) {
    if (shortened.length + character.length > 180) break;
    shortened += character;
  }
  name = shortened.replace(/[. ]+$/g, '') || '音频';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
  return name;
}

function runFfmpeg(binary, args, { signal, onProgress, duration } = {}) {
  checkCancelled(signal);
  return new Promise((resolve, reject) => {
    let child;
    let stderr = '';
    let progressBuffer = '';
    let settled = false;
    const abort = () => child?.kill();
    const finish = (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) {
        try { checkCancelled(signal); } catch (cancelled) { reject(cancelled); }
      } else if (error) reject(error);
      else resolve();
    };
    try {
      child = spawn(binary, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args], {
        windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) { finish(error); return; }
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      progressBuffer += chunk;
      const lines = progressBuffer.split(/\r?\n/);
      progressBuffer = lines.pop().slice(-4096);
      for (const line of lines) {
        if (line.startsWith('out_time_us=') && duration > 0) {
          const seconds = Number(line.slice(12)) / 1e6;
          if (Number.isFinite(seconds)) onProgress?.(Math.max(0, Math.min(100, seconds / duration * 100)));
        }
      }
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-16000); });
    child.on('error', (error) => {
      finish(new Error(error.code === 'ENOENT' ? '找不到转码工具，请完整解压软件后重试。' : '无法运行转码工具：' + error.message));
    });
    child.on('close', (code) => {
      if (code === 0) finish();
      else finish(new Error('音频处理失败：' + (stderr.trim() || `转码工具退出代码 ${code}`)));
    });
  });
}

async function publishUnique(encoded, outputDir, stem) {
  for (let index = 1; index <= 100000; index++) {
    const suffix = index === 1 ? '' : ` (${index})`;
    const target = path.join(outputDir, stem + suffix + '.mp3');
    try {
      await fs.copyFile(encoded, target, constants.COPYFILE_EXCL);
      return target;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('同名文件过多，请更换输出文件夹。');
}

async function inspectFlac(inputPath, signal) {
  checkCancelled(signal);
  const input = await fs.open(inputPath, 'r');
  try {
    if (!(await input.stat()).isFile()) throw new Error('请选择 FLAC 文件，不能直接转换文件夹。');
    const magic = Buffer.alloc(4);
    const { bytesRead } = await input.read(magic, 0, 4, 0);
    checkCancelled(signal);
    if (bytesRead !== 4 || !magic.equals(Buffer.from('fLaC'))) {
      const error = new Error('FLAC 文件头不正确，这不是有效的原始 FLAC 音频；请勿只修改文件后缀。');
      error.code = 'ERR_FLAC_INVALID';
      throw error;
    }
    return { format: 'flac', metadata: { title: '', artist: '', album: '', duration: null }, warnings: [] };
  } finally {
    await input.close();
  }
}

async function convertFile(inputPath, outputDir, { ffmpegPath, bitrate = 320, signal, externalKey, onUpdate = () => {} } = {}) {
  if (![192, 256, 320].includes(bitrate)) throw new Error('请选择支持的 MP3 音质。');
  if (!ffmpegPath) throw new Error('找不到转码工具。');
  checkCancelled(signal);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-mp3-'));
  const restored = path.join(temporary, 'source.audio');
  const encoded = path.join(temporary, 'converted.mp3');
  try {
    const directFlac = path.extname(inputPath).toLowerCase() === '.flac';
    onUpdate({ status: 'decoding', progress: 0, message: directFlac ? '正在读取 FLAC' : '正在读取 QQ 音乐文件' });
    const decoded = directFlac ? await inspectFlac(inputPath, signal) : await decodeQmc(inputPath, restored, {
      signal, externalKey, onProgress: (progress) => onUpdate({ status: 'decoding', progress: progress * 0.3 }),
    });
    const audioInput = directFlac ? inputPath : restored;
    checkCancelled(signal);
    const message = decoded.format === 'mp3' ? '原音频为 MP3，保留原音质' : `正在转换为 ${bitrate} kbps MP3`;
    onUpdate({ status: 'encoding', progress: 30, message });
    const args = ['-xerror', '-i', audioInput, '-map', '0:a:0', '-map_metadata', decoded.format === 'ogg' ? '0:s:a:0' : '0'];
    if (decoded.format === 'mp3') args.push('-c:a', 'copy');
    else args.push('-c:a', 'libmp3lame', '-b:a', bitrate + 'k', '-ar', '44100');
    args.push('-id3v2_version', '3');
    for (const key of ['title', 'artist', 'album']) {
      if (decoded.metadata[key]) args.push('-metadata', key + '=' + decoded.metadata[key]);
    }
    args.push('-progress', 'pipe:1', '-nostats', '-n', encoded);
    await runFfmpeg(ffmpegPath, args, {
      signal, duration: decoded.metadata.duration,
      onProgress: (progress) => onUpdate({ status: 'encoding', progress: 30 + progress * 0.5 }),
    });
    checkCancelled(signal);
    onUpdate({ status: 'validating', progress: 80, message: '正在检查音频完整性' });
    await runFfmpeg(ffmpegPath, ['-xerror', '-err_detect', 'explode', '-i', encoded, '-map', '0:a:0', '-vn', '-sn', '-dn', '-f', 'null', '-', '-progress', 'pipe:1', '-nostats'], {
      signal, duration: decoded.metadata.duration,
      onProgress: (progress) => onUpdate({ status: 'validating', progress: 80 + progress * 0.19 }),
    });
    checkCancelled(signal);
    if ((await fs.stat(encoded)).size < 1) throw new Error('转换结果为空，未保存文件。');
    await fs.mkdir(outputDir, { recursive: true });
    const outputPath = await publishUnique(encoded, outputDir, safeStem(inputPath));
    const warnings = decoded.warnings || [];
    return { outputPath, message: [decoded.format === 'mp3' ? '已还原 MP3，保留原音质' : `${bitrate} kbps · 44.1 kHz`, ...warnings].join('；') };
  } finally {
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { convertFile, runFfmpeg, safeStem, publishUnique };
