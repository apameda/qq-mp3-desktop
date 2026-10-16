#!/usr/bin/env node
/** Local, dependency-free desktop packaging. Mac packaging requires macOS. */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDeflateRaw, createGunzip } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import os from 'node:os';


const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRODUCT = 'QQ音乐转MP3';
const BUNDLE_ID = 'com.local.qqmp3';
const ELECTRON_VERSION = '44.7.2';
const ELECTRON_BASE = 'https://github.com/electron/electron/releases/download/v' + ELECTRON_VERSION;
const STATIC_TAG = 'b6.1.1';
const STATIC_BASE = 'https://github.com/eugeneware/ffmpeg-static/releases/download/' + STATIC_TAG;
const STATIC_RELEASE = 'https://github.com/eugeneware/ffmpeg-static/releases/tag/' + STATIC_TAG;
const OLD_CACHE = path.resolve(ROOT, '..', 'ncm-mp3-windows', '.cache', 'windows');
const WIN_FFMPEG_ZIP = 'ffmpeg-9.0.2-essentials_build.zip';
const WIN_FFMPEG_URL = 'https://www.gyan.dev/ffmpeg/builds/packages/' + WIN_FFMPEG_ZIP;
const WIN_FFMPEG_HASH = '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba';
const GPL_HASH = '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903';
const MARTIN_BASE = 'https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2';
const MARTIN_ZIP = 'ffmpeg-martin-9.0.2-darwin-arm64.zip';
const MARTIN_HASH = 'c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924';
const MARTIN_VERSIONS_HASH = 'fc92572e752e09b20e7ff28d64fb7096f7bc1a0d589b2e40f17ac91b7fd0ca61';
const TARGETS = {
  'darwin-arm64': {
    suffix: 'macOS-arm64', platform: 'darwin', arch: 'arm64',
    electron: '07d73d3d6dd0b8679c2f1849e30df179ea50c1d6b17630fcc398ae05221f0bd2',
  },
  'darwin-x64': {
    suffix: 'macOS-x64', platform: 'darwin', arch: 'x64',
    electron: '915cb638692e3595926fa64903ee0562c3c0c5a1febb84724175756ca2f0f3b7',
    compressed: '929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106',
    binary: 'ebdddc936f61e14049a2d4b549a412b8a40deeff6540e58a9f2a2da9e6b18894',
    license: '2e1d16c72fd74e12063776371da757322f8b77589386532f4fd8634bde7de1af',
    readme: 'e88a0325f8e5b75210355e37341824f074d3cd82def2125be54c914b62848a36',
  },
  'win32-x64': {
    suffix: 'Windows-x64', platform: 'win32', arch: 'x64',
    electron: '10a89447ef64ac5cb9f782af48ffd83734a40ae91681259d1048ca3c9e6c5da4',
  },
};
let options;

function parseOptions(args) {
  const result = { offline: false, cache: path.join(ROOT, '.cache', 'package'), targets: ['darwin-arm64', 'win32-x64', 'darwin-x64'], unpacked: true };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--offline') result.offline = true;
    else if (args[i] === '--cache-dir' && args[i + 1]) result.cache = path.resolve(args[++i]);
    else if (args[i] === '--target' && args[i + 1]) result.targets = args[++i] === 'all' ? ['darwin-arm64', 'win32-x64', 'darwin-x64'] : args[i].split(',');
    else if (args[i] === '--no-unpacked') result.unpacked = false;
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log('用法：node scripts/package.mjs [--target all|darwin-arm64|darwin-x64|win32-x64] [--offline] [--cache-dir 目录] [--no-unpacked]\n默认生成三份ZIP并保留解压目录；Mac打包需要macOS、ditto和codesign。');
      process.exit(0);
    } else throw new Error('未知参数：' + args[i]);
  }
  if (!result.targets.length || result.targets.some(target => !Object.hasOwn(TARGETS, target))) throw new Error('不支持的目标平台。');
  result.targets = [...new Set(result.targets)];
  return result;
}

async function exists(file) {
  return fs.access(file).then(() => true, () => false);
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function cachedDownload(url, filename) {
  const destination = path.join(options.cache, filename);
  if (await exists(destination)) return destination;
  if (options.offline) throw new Error(`离线缓存缺少 ${filename}。请按 docs/打包说明.md 下载到 ${options.cache}`);
  console.log(`下载 ${filename}`);
  const partial = `${destination}.download-${process.pid}`;
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15 * 60 * 1000),
      headers: { 'User-Agent': 'ncm-mp3-windows-local-packager/1.0' },
    });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { flags: 'wx' }));
    await fs.rename(partial, destination);
    return destination;
  } catch (error) {
    await fs.rm(partial, { force: true });
    throw new Error(`下载 ${filename} 失败：${error.message}。可手动下载审核URL到缓存后用 --offline 重试。`, { cause: error });
  }
}

async function requireHash(file, expected) {
  const actual = await sha256(file);
  if (actual !== expected.toLowerCase()) {
    throw new Error(`SHA-256 不符，拒绝使用 ${path.basename(file)}\n预期 ${expected}\n实际 ${actual}\n请删除该缓存并重新下载。`);
  }
  console.log(`校验通过 ${path.basename(file)} (${actual})`);
  return actual;
}

function run(command, args, extra = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...extra });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} 失败：${result.error?.message || result.stderr || result.stdout}`);
  }
  return result.stdout;
}

async function extractZip(archive, destination) {
  const entries = run('unzip', ['-Z1', archive]).split(/\r?\n/).filter(Boolean);
  // Even verified upstream archives must not escape the build directory.
  for (const entry of entries) {
    const normalized = entry.replaceAll('\\', '/');
    if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..')) {
      throw new Error(`压缩包含不安全路径：${entry}`);
    }
  }
  await fs.mkdir(destination, { recursive: true });
  run('unzip', ['-q', archive, '-d', destination]);
}

async function listFiles(directory, prefix = '') {
  const result = [];
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(path.join(directory, entry.name), relative));
    else if (entry.isFile()) result.push(relative);
    else throw new Error(`打包目录中不允许符号链接或特殊文件：${relative}`);
  }
  return result;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let i = 0; i < 8; i += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : crc >>> 1;
  return crc >>> 0;
});

/** Streaming ZIP32 with UTF-8 names, DEFLATE, and data descriptors. */
export async function createZip(sourceDirectory, rootName, destination) {
  const output = await fs.open(destination, 'wx');
  let offset = 0;
  const central = [];
  const write = async (buffer) => {
    let written = 0;
    while (written < buffer.length) written += (await output.write(buffer, written, buffer.length - written, offset + written)).bytesWritten;
    offset += buffer.length;
    if (offset >= 0xffffffff) throw new Error('便携包超过 ZIP32 大小限制。');
  };
  try {
    const files = await listFiles(sourceDirectory);
    if (files.length > 0xffff) throw new Error('便携包文件数超过 ZIP32 限制。');
    for (const relative of files) {
      const source = path.join(sourceDirectory, relative);
      const stat = await fs.stat(source);
      if (stat.size >= 0xffffffff) throw new Error(`文件过大：${relative}`);
      const name = Buffer.from(`${rootName}/${relative}`, 'utf8');
      if (name.length > 0xffff) throw new Error(`文件名过长：${relative}`);
      const year = Math.min(2107, Math.max(1980, stat.mtime.getFullYear()));
      const dosDate = ((year - 1980) << 9) | ((stat.mtime.getMonth() + 1) << 5) | stat.mtime.getDate();
      const dosTime = (stat.mtime.getHours() << 11) | (stat.mtime.getMinutes() << 5) | Math.floor(stat.mtime.getSeconds() / 2);
      const localOffset = offset;
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0x0808, 6); // UTF-8 filename + data descriptor.
      header.writeUInt16LE(8, 8);
      header.writeUInt16LE(dosTime, 10);
      header.writeUInt16LE(dosDate, 12);
      header.writeUInt16LE(name.length, 26);
      await write(header);
      await write(name);
      let crc = 0xffffffff;
      let originalSize = 0;
      let compressedSize = 0;
      const checksum = new Transform({ transform(chunk, encoding, callback) {
        for (const byte of chunk) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
        originalSize += chunk.length;
        callback(null, chunk);
      } });
      const sink = new Writable({ write(chunk, encoding, callback) {
        compressedSize += chunk.length;
        write(chunk).then(() => callback(), callback);
      } });
      await pipeline(createReadStream(source), checksum, createDeflateRaw({ level: 6 }), sink);
      if (originalSize !== stat.size || compressedSize >= 0xffffffff) throw new Error(`压缩时文件发生变化或过大：${relative}`);
      crc = (crc ^ 0xffffffff) >>> 0;
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(compressedSize, 8);
      descriptor.writeUInt32LE(originalSize, 12);
      await write(descriptor);
      const directory = Buffer.alloc(46);
      directory.writeUInt32LE(0x02014b50, 0);
      // Unix creator prevents legacy macOS unzip from converting UTF-8 as OEM.
      directory.writeUInt16LE(0x0314, 4);
      directory.writeUInt16LE(20, 6);
      directory.writeUInt16LE(0x0808, 8);
      directory.writeUInt16LE(8, 10);
      directory.writeUInt16LE(dosTime, 12);
      directory.writeUInt16LE(dosDate, 14);
      directory.writeUInt32LE(crc, 16);
      directory.writeUInt32LE(compressedSize, 20);
      directory.writeUInt32LE(originalSize, 24);
      directory.writeUInt16LE(name.length, 28);
      directory.writeUInt32LE(0o100644 * 0x10000, 38);
      directory.writeUInt32LE(localOffset, 42);
      central.push(directory, name);
    }
    const centralOffset = offset;
    for (const item of central) await write(item);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(offset - centralOffset, 12);
    end.writeUInt32LE(centralOffset, 16);
    await write(end);
    await output.sync();
  } finally {
    await output.close();
  }
}


async function asset(filename, url, expected, reuseOld = false) {
  const local = path.join(options.cache, filename);
  let file = local;
  if (!await exists(local) && reuseOld && await exists(path.join(OLD_CACHE, filename))) file = path.join(OLD_CACHE, filename);
  else file = await cachedDownload(url, filename);
  if (expected) await requireHash(file, expected);
  return file;
}

async function electronArchive(target) {
  const checksumsName = 'electron-v' + ELECTRON_VERSION + '-SHASUMS256.txt';
  const checksums = await asset(checksumsName, ELECTRON_BASE + '/SHASUMS256.txt', null, true);
  const name = 'electron-v' + ELECTRON_VERSION + '-' + target + '.zip';
  const line = (await fs.readFile(checksums, 'utf8')).split(/\r?\n/).find(value => value.trim().split(/\s+/).at(-1)?.replace(/^\*/, '') === name);
  if (line?.trim().split(/\s+/)[0]?.toLowerCase() !== TARGETS[target].electron) throw new Error('Electron 官方清单与固定审核哈希不符：' + target);
  return asset(name, ELECTRON_BASE + '/' + name, TARGETS[target].electron, true);
}

async function gplText() {
  const destination = path.join(options.cache, 'GPL-3.0.txt');
  const prior = path.join(OLD_CACHE, WIN_FFMPEG_ZIP);
  if (!await exists(destination) && await exists(prior)) {
    // The exact same GPL text is a published ffmpeg-static release asset.
    // Reuse only the text from a verified existing archive, never its Mac binaries.
    await requireHash(prior, WIN_FFMPEG_HASH);
    const text = run('unzip', ['-p', prior, '*/LICENSE']);
    if (createHash('sha256').update(text).digest('hex') !== GPL_HASH) throw new Error('已有GPL文本校验失败。');
    await fs.writeFile(destination, text, { flag: 'wx' });
  }
  return asset('GPL-3.0.txt', STATIC_BASE + '/linux-arm.LICENSE', GPL_HASH);
}

async function prepareFfmpeg(target, staging) {
  const definition = TARGETS[target];
  const licenses = path.join(staging, 'ffmpeg-licenses');
  await fs.mkdir(licenses, { recursive: true });
  if (definition.platform === 'win32') {
    const checksum = await asset(WIN_FFMPEG_ZIP + '.sha256', WIN_FFMPEG_URL + '.sha256', null, true);
    if ((await fs.readFile(checksum, 'utf8')).trim().split(/\s+/)[0]?.toLowerCase() !== WIN_FFMPEG_HASH) throw new Error('Gyan校验值与固定值不符。');
    const archive = await asset(WIN_FFMPEG_ZIP, WIN_FFMPEG_URL, WIN_FFMPEG_HASH, true);
    const extracted = path.join(staging, 'ffmpeg-upstream');
    await extractZip(archive, extracted);
    const candidates = (await listFiles(extracted)).filter(name => name.endsWith('/bin/ffmpeg.exe'));
    if (candidates.length !== 1) throw new Error('Gyan发行包结构不符。');
    const binary = path.join(extracted, candidates[0]);
    const base = path.dirname(path.dirname(binary));
    for (const name of ['LICENSE', 'README.txt']) await fs.copyFile(path.join(base, name), path.join(licenses, name));
    return { binary, licenses, source: { distribution: 'Gyan 9.0.2 essentials', url: WIN_FFMPEG_URL, archiveSha256: WIN_FFMPEG_HASH, binarySha256: await sha256(binary), license: 'GPLv3', sourceRevision: 'https://github.com/FFmpeg/FFmpeg/commit/946fcce07b' } };
  }
  if (target === 'darwin-arm64') {
    if (!/^[a-f0-9]{64}$/.test(MARTIN_HASH)) throw new Error('Martin ARM发行包的审核校验值尚未固定。');
    const checksum = await asset(MARTIN_ZIP + '.sha256', MARTIN_BASE + '/ffmpeg.zip.sha256');
    if ((await fs.readFile(checksum, 'utf8')).match(/[a-f0-9]{64}/i)?.[0]?.toLowerCase() !== MARTIN_HASH) throw new Error('Martin维护方校验值与审核固定值不符。');
    const [archive, versions, fullGpl] = await Promise.all([
      asset(MARTIN_ZIP, MARTIN_BASE + '/ffmpeg.zip', MARTIN_HASH),
      asset('ffmpeg-martin-9.0.2-darwin-arm64.versions.txt', MARTIN_BASE + '/versions.txt', MARTIN_VERSIONS_HASH),
      gplText(),
    ]);
    const extracted = path.join(staging, 'ffmpeg-upstream');
    await extractZip(archive, extracted);
    const names = (await listFiles(extracted)).filter(name => path.basename(name) === 'ffmpeg');
    if (names.length !== 1) throw new Error('Martin ARM发行包目录结构不符。');
    const binary = path.join(extracted, names[0]);
    await fs.chmod(binary, 0o755);
    const inspection = await inspectMacFfmpeg(binary, definition.arch);
    await fs.copyFile(versions, path.join(licenses, 'README.txt'));
    await fs.copyFile(fullGpl, path.join(licenses, 'COPYING.GPLv3'));
    await fs.writeFile(path.join(licenses, 'SOURCE.txt'), 'FFmpeg 9.0.2 ARM64 static build by Martin Riedl.\nBinary archive: ' + MARTIN_BASE + '/ffmpeg.zip\nBuild metadata: ' + MARTIN_BASE + '/versions.txt\nFFmpeg source: https://github.com/FFmpeg/FFmpeg/commit/946fcce07b\nBuild script project: https://git.martin-riedl.de/ffmpeg/build-script\nExact build-script revision and all dependency source inputs have not been independently reconstructed.\n');
    return { binary, licenses, source: { distribution: 'Martin Riedl', version: '9.0.2', url: MARTIN_BASE + '/ffmpeg.zip', archiveSha256: MARTIN_HASH, checksumUrl: MARTIN_BASE + '/ffmpeg.zip.sha256', binarySha256: await sha256(binary), binaryHashEvidence: 'computed locally from archive verified against maintainer checksum', versionsUrl: MARTIN_BASE + '/versions.txt', versionsSha256: MARTIN_VERSIONS_HASH, license: 'GPLv3; enable-gpl and enable-version3 present, enable-nonfree absent', sourceRevision: 'https://github.com/FFmpeg/FFmpeg/commit/946fcce07b', buildScriptProject: 'https://git.martin-riedl.de/ffmpeg/build-script', ...inspection } };
  }
  const name = 'ffmpeg-' + target + '.gz';
  const [compressed, originalLicense, originalReadme, fullGpl] = await Promise.all([
    asset(name, STATIC_BASE + '/' + name, definition.compressed),
    asset(target + '.LICENSE', STATIC_BASE + '/' + target + '.LICENSE', definition.license),
    asset(target + '.README', STATIC_BASE + '/' + target + '.README', definition.readme),
    gplText(),
  ]);
  const binary = path.join(staging, 'ffmpeg');
  await pipeline(createReadStream(compressed), createGunzip(), createWriteStream(binary, { flags: 'wx', mode: 0o755 }));
  await requireHash(binary, definition.binary);
  await fs.chmod(binary, 0o755);
  await fs.copyFile(originalLicense, path.join(licenses, 'LICENSE.md'));
  await fs.copyFile(originalReadme, path.join(licenses, 'README.txt'));
  await fs.copyFile(fullGpl, path.join(licenses, 'COPYING.GPLv3'));
  const inspection = await inspectMacFfmpeg(binary, definition.arch);
  await fs.writeFile(path.join(licenses, 'SOURCE.txt'), 'Intel binary: FFmpeg 6.1.1-tessus, identified by its compiled banner string.\nDistribution release: ' + STATIC_RELEASE + '\nOriginal builder: https://evermeet.cx/ffmpeg/\nDistribution download script: https://github.com/eugeneware/ffmpeg-static/blob/b6.1.1/download-binaries/index.sh\nFFmpeg source tag: https://github.com/FFmpeg/FFmpeg/tree/n6.1.1\nThe upstream distribution README describes an 8.0 release and is retained unchanged; it is not a matching version manifest for this binary.\nExact builder patches, scripts and all dependency sources have not been independently reconstructed.\n');
  return { binary, licenses, source: { distribution: 'eugeneware/ffmpeg-static', releaseTag: STATIC_TAG, releaseUrl: STATIC_RELEASE, url: STATIC_BASE + '/' + name, gzipSha256: definition.compressed, binarySha256: definition.binary, checksumsSource: 'GitHub release asset digests', licenseNoticeSha256: definition.license, readmeSha256: definition.readme, upstreamReadmeCaution: 'README refers to 8.0; compiled binary banner is 6.1.1-tessus', ...inspection } };
}

async function inspectMacFfmpeg(binary, arch) {
  const architecture = run('/usr/bin/lipo', ['-archs', binary]).trim();
  if (architecture !== (arch === 'arm64' ? 'arm64' : 'x86_64')) throw new Error('FFmpeg架构不符：' + architecture);
  const libraries = run('/usr/bin/otool', ['-L', binary]).split(/\r?\n/).slice(1).filter(line => line.trim());
  if (libraries.some(line => !/^\s*\/(usr\/lib|System\/Library)\//.test(line))) throw new Error('FFmpeg含非系统动态依赖，拒绝打包：' + libraries.join('\n'));
  const strings = (await fs.readFile(binary)).toString('latin1');
  const configurations = strings.match(/--prefix=[\x20-\x7e]+/g) || [];
  if (!configurations.length || configurations.some(value => value.includes('--enable-nonfree'))) throw new Error('FFmpeg未能确认干净构建配置，或存在enable-nonfree。');
  const banner = strings.match(/%s version ([^\x00\r\n]+)/)?.[1];
  return { architecture, actualFfmpegVersion: banner || 'No compiled version banner located', versionEvidence: 'Static inspection of compiled banner; not an execution test on the other architecture', compiledConfiguration: configurations[0], dynamicDependencies: libraries.map(line => line.trim()) };
}

async function appFiles(destination) {
  await fs.mkdir(destination, { recursive: true });
  await fs.cp(path.join(ROOT, 'src'), path.join(destination, 'src'), { recursive: true });
  for (const name of ['package.json', 'README.md', 'THIRD_PARTY_NOTICES.md', 'LICENSE']) await fs.copyFile(path.join(ROOT, name), path.join(destination, name));
  if (await exists(path.join(ROOT, 'resources'))) await fs.cp(path.join(ROOT, 'resources'), path.join(destination, 'resources'), { recursive: true });
  await fs.mkdir(path.join(destination, 'resources'), { recursive: true });
}

async function rootFiles(portable) {
  for (const name of ['README.md', 'THIRD_PARTY_NOTICES.md', 'LICENSE', 'RELEASE_NOTES.md']) {
    if (await exists(path.join(ROOT, name))) await fs.copyFile(path.join(ROOT, name), path.join(portable, name));
  }
  if (await exists(path.join(ROOT, 'docs'))) await fs.cp(path.join(ROOT, 'docs'), path.join(portable, 'docs'), { recursive: true });
}

async function walkBundle(directory) {
  const files = [];
  const bundles = [];
  const symlinks = [];
  async function walk(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        const resolved = path.resolve(path.dirname(full), await fs.readlink(full));
        if (resolved !== directory && !resolved.startsWith(directory + path.sep)) throw new Error('App包含指向包外的符号链接：' + full);
        symlinks.push(full);
      } else if (entry.isDirectory()) {
        if (/\.(app|framework)$/.test(entry.name)) bundles.push(full);
        await walk(full);
      } else if (entry.isFile()) files.push(full);
      else throw new Error('App含特殊文件：' + full);
    }
  }
  await walk(directory);
  return { files, bundles, symlinks };
}

function plist(file, key, value) {
  const result = spawnSync('/usr/bin/plutil', ['-replace', key, '-string', value, file], { encoding: 'utf8' });
  if (result.status !== 0) run('/usr/bin/plutil', ['-insert', key, '-string', value, file]);
}

async function brandMac(app, version) {
  const info = path.join(app, 'Contents', 'Info.plist');
  await fs.rename(path.join(app, 'Contents', 'MacOS', 'Electron'), path.join(app, 'Contents', 'MacOS', PRODUCT));
  for (const [key, value] of Object.entries({ CFBundleName: PRODUCT, CFBundleDisplayName: PRODUCT, CFBundleExecutable: PRODUCT, CFBundleIdentifier: BUNDLE_ID, CFBundleShortVersionString: version, CFBundleVersion: version })) plist(info, key, value);
  for (const bundle of (await walkBundle(app)).bundles.filter(name => name.endsWith('.app'))) {
    const helperInfo = path.join(bundle, 'Contents', 'Info.plist');
    if (!await exists(helperInfo)) continue;
    const oldId = run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', helperInfo]).trim();
    plist(helperInfo, 'CFBundleIdentifier', oldId.replace(/^com\.github\.Electron/, BUNDLE_ID));
    plist(helperInfo, 'CFBundleDisplayName', path.basename(bundle, '.app').replace(/^Electron/, PRODUCT));
  }
}

async function adHocSign(app) {
  // Only remove signing-incompatible Finder/resource-fork metadata from this
  // newly assembled artifact. Do not remove quarantine or change OS trust rules.
  for (const attribute of ['com.apple.FinderInfo', 'com.apple.ResourceFork']) {
    spawnSync('/usr/bin/xattr', ['-r', '-d', attribute, app], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  }
  const { files, bundles } = await walkBundle(app);
  // A framework executable may be treated as its enclosing bundle by codesign;
  // all of its nested helpers must therefore be signed before that executable.
  files.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
  const machO = new Set(['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);
  for (const file of files) {
    const handle = await fs.open(file, 'r');
    const header = Buffer.alloc(4);
    try { await handle.read(header, 0, 4, 0); } finally { await handle.close(); }
    if (!machO.has(header.toString('hex'))) continue;
    const signed = spawnSync('/usr/bin/codesign', ['-dv', file], { encoding: 'utf8' }).status === 0;
    const args = ['--force', '--sign', '-', '--timestamp=none'];
    if (signed) args.push('--preserve-metadata=entitlements');
    run('/usr/bin/codesign', [...args, file]);
  }
  bundles.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
  for (const bundle of [...bundles, app]) run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', '--preserve-metadata=entitlements', bundle]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
}

async function verifyMacZip(archive, name, staging, arch) {
  const restored = path.join(staging, 'archive-roundtrip');
  await fs.mkdir(restored);
  run('/usr/bin/ditto', ['-x', '-k', archive, restored]);
  const app = path.join(restored, name, PRODUCT + '.app');
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  for (const executable of [path.join(app, 'Contents', 'MacOS', PRODUCT), path.join(app, 'Contents', 'Resources', 'app', 'resources', 'ffmpeg')]) {
    if (!((await fs.stat(executable)).mode & 0o111)) throw new Error('ZIP解压后缺少可执行权限。');
  }
  const link = path.join(app, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'Current');
  if (!(await fs.lstat(link)).isSymbolicLink()) throw new Error('ZIP未保留Framework符号链接。');
  const actual = run('/usr/bin/lipo', ['-archs', path.join(app, 'Contents', 'MacOS', PRODUCT)]).trim();
  if (actual !== (arch === 'arm64' ? 'arm64' : 'x86_64')) throw new Error('ZIP解压后架构不符。');
  await fs.rm(restored, { recursive: true, force: true });
  console.log('Mac ZIP解压复验通过：严格签名、可执行权限、符号链接与架构。');
}

async function build(target, packageJson) {
  const definition = TARGETS[target];
  const name = PRODUCT + '-' + definition.suffix;
  // Keep signed bundles away from cloud File Providers, which may attach
  // Finder metadata while codesign is sealing or verifying the app.
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-mp3-build-' + target + '-'));
  const portable = path.join(staging, name);
  const dist = path.join(ROOT, 'dist');
  const zip = path.join(dist, name + '.zip');
  const temporaryZip = path.join(staging, name + '.zip');
  try {
    const prerequisites = await Promise.allSettled([electronArchive(target), prepareFfmpeg(target, staging)]);
    const failure = prerequisites.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    const [electron, ffmpeg] = prerequisites.map(result => result.value);
    let packagedFfmpeg;
    let executable;
    let app = null;
    if (definition.platform === 'win32') {
      await extractZip(electron, portable);
      await fs.rename(path.join(portable, 'electron.exe'), path.join(portable, PRODUCT + '.exe'));
      await fs.rename(path.join(portable, 'LICENSE'), path.join(portable, 'LICENSE-electron'));
      const resources = path.join(portable, 'resources');
      await fs.rm(path.join(resources, 'default_app.asar'), { force: true });
      await appFiles(path.join(resources, 'app'));
      packagedFfmpeg = path.join(resources, 'app', 'resources', 'ffmpeg.exe');
      await fs.copyFile(ffmpeg.binary, packagedFfmpeg);
      executable = path.join(portable, PRODUCT + '.exe');
    } else {
      const extracted = path.join(staging, 'electron');
      await fs.mkdir(extracted);
      run('/usr/bin/ditto', ['-x', '-k', electron, extracted]);
      await fs.mkdir(portable);
      app = path.join(portable, PRODUCT + '.app');
      await fs.rename(path.join(extracted, 'Electron.app'), app);
      const resources = path.join(app, 'Contents', 'Resources');
      await fs.rm(path.join(resources, 'default_app.asar'), { force: true });
      await appFiles(path.join(resources, 'app'));
      packagedFfmpeg = path.join(resources, 'app', 'resources', 'ffmpeg');
      await fs.copyFile(ffmpeg.binary, packagedFfmpeg);
      await fs.chmod(packagedFfmpeg, 0o755);
      for (const license of ['LICENSE', 'LICENSES.chromium.html']) {
        for (const source of [path.join(extracted, license), path.join(resources, license)]) {
          if (await exists(source)) { await fs.copyFile(source, path.join(portable, license === 'LICENSE' ? 'LICENSE-electron' : license)); break; }
        }
      }
      if (!await exists(path.join(portable, 'LICENSE-electron'))) throw new Error('Electron原始许可文件缺失。');
      await fs.copyFile(path.join(portable, 'LICENSE-electron'), path.join(resources, 'LICENSE-electron'));
      if (await exists(path.join(portable, 'LICENSES.chromium.html'))) await fs.copyFile(path.join(portable, 'LICENSES.chromium.html'), path.join(resources, 'LICENSES.chromium.html'));
      await fs.cp(ffmpeg.licenses, path.join(resources, 'licenses', 'ffmpeg'), { recursive: true });
      await brandMac(app, packageJson.version);
      await adHocSign(app);
      const actual = run('/usr/bin/lipo', ['-archs', path.join(app, 'Contents', 'MacOS', PRODUCT)]).trim();
      if (actual !== (definition.arch === 'arm64' ? 'arm64' : 'x86_64')) throw new Error('Electron App架构不符：' + actual);
      executable = path.join(app, 'Contents', 'MacOS', PRODUCT);
    }
    await fs.cp(ffmpeg.licenses, path.join(portable, 'licenses', 'ffmpeg'), { recursive: true });
    await rootFiles(portable);
    const manifest = {
      product: PRODUCT, version: packageJson.version, target, builtAt: new Date().toISOString(),
      electron: { version: ELECTRON_VERSION, url: ELECTRON_BASE + '/' + path.basename(electron), sha256: definition.electron, checksumsUrl: ELECTRON_BASE + '/SHASUMS256.txt' },
      ffmpeg: { ...ffmpeg.source, packagedBinarySha256: await sha256(packagedFfmpeg) },
      signing: definition.platform === 'darwin' ? { identity: 'ad-hoc', developerIdSigned: false, notarized: false, localSignatureVerification: 'codesign --verify --deep --strict passed; not a Gatekeeper assessment' } : { developerSigned: false },
      executableSha256: await sha256(executable),
    };
    await fs.writeFile(path.join(portable, 'BUILD-MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
    await fs.mkdir(dist, { recursive: true });
    if (definition.platform === 'darwin') run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', portable, temporaryZip]);
    else await createZip(portable, name, temporaryZip);
    run('unzip', ['-tq', temporaryZip]);
    if (definition.platform === 'darwin') await verifyMacZip(temporaryZip, name, staging, definition.arch);
    const hash = await sha256(temporaryZip);
    await fs.rename(temporaryZip, zip);
    await fs.writeFile(zip + '.sha256', hash + '  ' + path.basename(zip) + '\n');
    if (options.unpacked) {
      let unpacked;
      if (definition.platform === 'darwin') {
        const retained = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-mp3-unpacked-' + target + '-'));
        unpacked = path.join(retained, name);
      } else {
        unpacked = path.join(dist, name);
        await fs.rm(unpacked, { recursive: true, force: true });
      }
      await fs.rename(portable, unpacked);
      console.log('可运行目录：' + unpacked);
    }
    console.log('完成：' + zip + '\nSHA-256：' + hash);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
    await fs.rm(temporaryZip, { force: true });
  }
}

async function main() {
  options = parseOptions(process.argv.slice(2));
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('需要Node.js 20或更新版本。');
  if (options.targets.some(target => target.startsWith('darwin-')) && process.platform !== 'darwin') throw new Error('Mac App重签名必须在macOS构建机运行。');
  run('unzip', ['-v']);
  for (const name of ['package.json', 'src/main.js', 'README.md', 'THIRD_PARTY_NOTICES.md', 'LICENSE']) if (!await exists(path.join(ROOT, name))) throw new Error('缺少应用文件：' + name);
  const packageJson = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  if (packageJson.main !== 'src/main.js') throw new Error('package.json main必须为src/main.js。');
  if (Object.keys(packageJson.dependencies || {}).length) throw new Error('运行时npm依赖尚未纳入此手动打包脚本。');
  await fs.mkdir(options.cache, { recursive: true });
  for (const target of options.targets) await build(target, packageJson);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error('打包失败：' + error.message);
  process.exitCode = 1;
});
