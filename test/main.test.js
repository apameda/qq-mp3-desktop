'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { pathToFileURL } = require('node:url');

const mainPath = path.join(__dirname, '..', 'src', 'main.js');
const clean = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

async function harness(t, convert, platform = process.platform) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'qq-main-test-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const tool = path.join(directory, 'fake-ffmpeg.exe');
  await fs.writeFile(tool, 'Only a presence check; converter is stubbed.');
  const handlers = new Map();
  const events = [];
  const calls = [];
  const waiters = new Set();
  const permissions = {};
  const io = { ...fs };
  let instance;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  class BrowserWindow {
    constructor(options) {
      this.options = options;
      this.listeners = new Map();
      this.webContents = {
        send(channel, event) {
          const entry = { channel, ...clean(event) };
          events.push(entry);
          for (const waiter of [...waiters]) waiter(entry);
        },
        setWindowOpenHandler(callback) { permissions.openWindow = callback; },
        on() {},
      };
      instance = this;
    }
    isDestroyed() { return false; }
    removeMenu() {}
    once(name, callback) { this.listeners.set(name, callback); }
    on(name, callback) { this.listeners.set(name, callback); }
    show() {}
    close() {}
    isMinimized() { return false; }
    restore() {}
    focus() {}
    loadFile(file) { this.loadedFile = file; readyResolve(); return Promise.resolve(); }
  }
  const electron = {
    app: {
      isPackaged: false,
      setName() {},
      getPath(name) { return path.join(directory, name === 'music' ? 'Music' : 'UserData'); },
      getAppPath() { return directory; },
      requestSingleInstanceLock() { return true; },
      whenReady() { return Promise.resolve(); },
      on() {},
      quit() {},
    },
    BrowserWindow,
    ipcMain: { handle(name, handler) { assert.ok(!handlers.has(name)); handlers.set(name, handler); } },
    dialog: {
      async showOpenDialog(_window, options) { permissions.lastOpenDialog = clean(options); return { canceled: true, filePaths: [] }; },
      showMessageBoxSync() { return 0; },
      showErrorBox(title, message) { readyReject(new Error(title + ': ' + message)); },
    },
    shell: { async openPath() { return ''; } },
    Menu: {
      buildFromTemplate(template) { return template; },
      setApplicationMenu(template) { permissions.applicationMenu = clean(template); },
    },
    session: { defaultSession: {
      setPermissionRequestHandler(callback) { permissions.request = callback; },
      webRequest: { onBeforeRequest(callback) { permissions.beforeRequest = callback; } },
    } },
  };
  const allowed = new Set(['node:fs/promises', 'node:path', 'node:crypto', 'node:url', 'node:fs']);
  const source = await fs.readFile(mainPath, 'utf8');
  const context = vm.createContext({
    __dirname: path.dirname(mainPath),
    // Independent process/env values keep concurrent test files isolated.
    process: { platform, resourcesPath: path.join(directory, 'resources'), env: { QQ_FFMPEG: tool, NCM_FFMPEG: tool } },
    AbortController,
    console,
    require(name) {
      if (name === 'electron') return electron;
      if (name === 'node:fs/promises') return io;
      if (name === './qmc') return require('../src/qmc');
      if (name === './converter') return { convertFile(...args) {
        calls.push({ inputPath: args[0], outputDir: args[1], options: args[2] });
        if (convert) return convert(...args);
        return Promise.resolve({ outputPath: path.join(args[1], path.basename(args[0], path.extname(args[0])) + '.mp3'), message: '转换完成' });
      } };
      assert.ok(allowed.has(name), 'unexpected dependency ' + name);
      return require(name);
    },
  });
  vm.runInContext(source, context, { filename: mainPath });
  await ready;
  assert.equal(handlers.size >= 10, true);
  const event = { sender: instance.webContents, senderFrame: { url: pathToFileURL(instance.loadedFile).href } };
  const invokeRaw = (name, customEvent, ...args) => {
    const handler = handlers.get('qq:' + name);
    assert.ok(handler, 'handler exists: ' + name);
    return handler(customEvent, ...args);
  };
  const invoke = async (name, ...args) => clean(await invokeRaw(name, event, ...args));
  function waitFor(predicate, from = 0) {
    const existing = events.slice(from).find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(listener); reject(new Error('Timed out waiting for a main-process event')); }, 10000);
      const listener = (entry) => {
        if (predicate(entry)) {
          clearTimeout(timer);
          waiters.delete(listener);
          resolve(entry);
        }
      };
      waiters.add(listener);
    });
  }
  const latest = (type) => events.findLast((entry) => entry.type === type);
  const options = { outputDir: path.join(directory, 'output'), bitrate: 320 };
  const finished = (from = 0) => waitFor((entry) => entry.type === 'batch' && entry.running === false && entry.total > 0, from);
  async function addFiles(names = ['第一首.qmcflac', '第二首.qmcflac']) {
    const inputs = [];
    for (const name of names) {
      const file = path.join(directory, name);
      await fs.writeFile(file, 'synthetic container; converter is mocked');
      inputs.push(file);
    }
    await invoke('add-paths', inputs);
    return inputs;
  }
  // Test-only inspection verifies that removed per-track secrets are actually
  // released from memory, rather than only hidden by a new queue item ID.
  const keyCount = () => vm.runInContext('songKeys.size', context);
  return { directory, tool, io, handlers, instance, permissions, event, invoke, invokeRaw, events, calls, latest, finished, options, addFiles, waitFor, keyCount };
}

test('recursive additions include only QQ music files, skip symlink loops and deduplicate real paths', async (t) => {
  const app = await harness(t);
  const inputDir = path.join(app.directory, '输入');
  const nested = path.join(inputDir, '中文子目录');
  await fs.mkdir(nested, { recursive: true });
  const first = path.join(inputDir, '歌曲一.QMCFLAC');
  const second = path.join(nested, '歌曲二.qmcflac');
  await Promise.all([
    fs.writeFile(first, 'first'), fs.writeFile(second, 'second'),
    fs.writeFile(path.join(nested, '无关.mp3'), 'not NCM'),
    fs.writeFile(path.join(nested, '说明.txt'), 'not NCM'),
  ]);
  // Windows junctions exercise the same traversal guard without requiring
  // elevated symbolic-link privileges or Developer Mode on the test runner.
  const loopPath = path.join(nested, 'loop');
  await fs.symlink(inputDir, loopPath, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await fs.lstat(loopPath)).isSymbolicLink(), true);
  let items = await app.invoke('add-paths', [inputDir, first, second]);
  assert.deepEqual(items.map((item) => item.name).sort(), ['歌曲一.QMCFLAC', '歌曲二.qmcflac']);
  assert.ok(items.every((item) => item.status === 'pending' && item.progress === 0 && item.size > 0));
  const ids = items.map((item) => item.id);
  items = await app.invoke('add-paths', [inputDir, first]);
  assert.deepEqual(items.map((item) => item.id), ids);
  assert.match(app.latest('notice').message, /重复文件会自动跳过/);
  await assert.rejects(app.invoke('add-paths', ['relative.qmcflac']), /有效的本地文件/);
});

test('simultaneous additions cannot enqueue the same encrypted file twice', async (t) => {
  const app = await harness(t);
  const input = path.join(app.directory, '同时添加.qmcflac');
  await fs.writeFile(input, 'fixture');
  const attempts = await Promise.allSettled([app.invoke('add-paths', [input]), app.invoke('add-paths', [input])]);
  assert.equal(attempts[0].status, 'fulfilled');
  assert.equal(attempts[1].status, 'rejected');
  assert.match(attempts[1].reason.message, /正在处理当前操作/);
  assert.equal(app.latest('queue').items.length, 1);
});

test('native filters and folder scanning accept all supported numeric/letter suffixes', async (t) => {
  const app = await harness(t);
  const directory = path.join(app.directory, '扩展名入口');
  await fs.mkdir(directory);
  const accepted = ['一.qmc1', '二.qmc9', '三.mflac1', '四.MGGa', '五.mflacZ', '六.mgg9', '七.mmp40', '八.qmcra', '九.FLAC'];
  const rejected = ['不是音乐.txt', '过长后缀.mflac12', '过长后缀.mggzz', '歌词.lrc'];
  for (const name of [...accepted, ...rejected]) await fs.writeFile(path.join(directory, name), 'synthetic fixture');
  const queue = await app.invoke('add-paths', [directory]);
  assert.deepEqual(queue.map((item) => item.name).sort(), accepted.slice().sort());
  await app.invoke('choose-files');
  const expected = [...'0123456789'].map((suffix) => 'qmc' + suffix).concat(['qmcflac', 'qmcogg', 'qmcra']);
  for (const base of ['mflac', 'mgg', 'mmp4']) {
    expected.push(base);
    for (const suffix of '0123456789abcdefghijklmnopqrstuvwxyz') expected.push(base + suffix);
  }
  expected.push('flac');
  assert.deepEqual(app.permissions.lastOpenDialog.filters[0].extensions.slice().sort(), expected.sort());
});

test('ordinary FLAC joins an encrypted-file batch without becoming a QMC decoder extension', async (t) => {
  const app = await harness(t);
  const inputs = await app.addFiles(['加密歌曲.qmc3', '原始音频.FLAC']);
  assert.equal(require('../src/qmc').supportedExtensions.includes('flac'), false);
  const from = app.events.length;
  await app.invoke('start', app.options);
  const batch = await app.finished(from);
  assert.equal(batch.success, 2);
  assert.deepEqual(app.calls.map((call) => call.inputPath), inputs);
  assert.equal(app.calls[1].options.externalKey, undefined);
});

test('a failed item records a useful error while the following item still succeeds', async (t) => {
  const app = await harness(t, async (inputPath, outputDir, { onUpdate }) => {
    onUpdate({ status: 'decoding', progress: 8 });
    if (path.basename(inputPath) === '损坏.qmcflac') {
      const error = new Error('raw permission details'); error.code = 'EACCES'; throw error;
    }
    onUpdate({ status: 'encoding', progress: 52 });
    return { outputPath: path.join(outputDir, '正常.mp3'), message: '已转换' };
  });
  const inputs = await app.addFiles(['损坏.qmcflac', '正常.qmcflac']);
  const from = app.events.length;
  assert.equal(await app.invoke('start', app.options), true);
  const batch = await app.finished(from);
  assert.deepEqual(app.calls.map((call) => call.inputPath), inputs);
  assert.equal(batch.total, 2);
  assert.equal(batch.completed, 2);
  assert.equal(batch.success, 1);
  assert.equal(batch.failed, 1);
  assert.equal(batch.cancelled, 0);
  const items = app.latest('queue').items;
  assert.equal(items[0].status, 'failed');
  assert.match(items[0].error, /有写入权限/);
  assert.equal(items[1].status, 'success');
  assert.equal(items[1].progress, 100);
  assert.equal(items[1].outputPath, path.join(app.options.outputDir, '正常.mp3'));
});

test('a second start is refused during preparation and during the active conversion', async (t) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const app = await harness(t, async (_input, outputDir) => {
    await held;
    return { outputPath: path.join(outputDir, '完成.mp3'), message: '完成' };
  });
  await app.addFiles(['第一首.qmcflac']);
  const id = app.latest('queue').items[0].id;
  await app.invoke('set-key', id, 'synthetic-secret-for-active-track');
  const from = app.events.length;
  const first = app.invoke('start', app.options);
  await assert.rejects(app.invoke('start', app.options), /正在处理当前操作/);
  await assert.rejects(app.invoke('set-key', id, 'cannot-change-during-startup'), /正在处理当前操作/);
  assert.equal(await first, true);
  await assert.rejects(app.invoke('start', app.options), /正在处理当前操作/);
  await assert.rejects(app.invoke('set-key', id, ''), /正在处理当前操作/);
  await assert.rejects(app.invoke('clear-queue'), /正在处理当前操作/);
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].options.externalKey, 'synthetic-secret-for-active-track');
  release();
  const batch = await app.finished(from);
  assert.equal(batch.success, 1);
});

test('cancelling startup while tool inspection is pending prevents conversion and permits retry', async (t) => {
  const app = await harness(t);
  await app.addFiles(['准备取消.qmcflac']);
  let release;
  let enteredResolve;
  const held = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  t.after(() => release());
  let block = true;
  app.io.stat = async (candidate, ...args) => {
    if (block && candidate === app.tool) {
      enteredResolve();
      await held;
    }
    return fs.stat(candidate, ...args);
  };
  const pending = app.invoke('start', app.options);
  await entered;
  await app.invoke('cancel');
  release();
  await assert.rejects(pending, /已取消转换准备，可再次开始/);
  assert.equal(app.calls.length, 0);
  assert.equal(app.latest('queue').items[0].status, 'pending');
  block = false;
  const from = app.events.length;
  await app.invoke('start', app.options);
  const batch = await app.finished(from);
  assert.equal(app.calls.length, 1);
  assert.equal(batch.success, 1);
});

test('cancellation marks remaining items cancelled, and a new start retries all of them', async (t) => {
  let retry = false;
  let enteredResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const app = await harness(t, async (inputPath, outputDir, { signal, onUpdate }) => {
    onUpdate({ status: 'decoding', progress: 12 });
    if (!retry) {
      enteredResolve();
      await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('cancelled'); error.name = 'AbortError'; reject(error);
        }, { once: true });
      });
    }
    return { outputPath: path.join(outputDir, path.basename(inputPath) + '.mp3'), message: '完成' };
  });
  const inputs = await app.addFiles(['一.qmcflac', '二.qmcflac', '三.qmcflac']);
  let from = app.events.length;
  await app.invoke('start', app.options);
  await entered;
  assert.equal(await app.invoke('cancel'), true);
  let batch = await app.finished(from);
  assert.equal(app.calls.length, 1, 'cancelled pending files are not passed to the converter');
  assert.equal(batch.completed, 3);
  assert.equal(batch.cancelled, 3);
  assert.ok(app.latest('queue').items.every((item) => item.status === 'cancelled' && item.error === '' && /再次开始/.test(item.message)));
  retry = true;
  from = app.events.length;
  await app.invoke('start', app.options);
  batch = await app.finished(from);
  assert.equal(batch.success, 3);
  assert.equal(batch.cancelled, 0);
  assert.deepEqual(app.calls.slice(1).map((call) => call.inputPath), inputs);
  assert.ok(app.latest('queue').items.every((item) => item.status === 'success'));
});

test('successful items are skipped on later starts and queue cleanup keeps pending items', async (t) => {
  const app = await harness(t);
  const first = await app.addFiles(['已完成一.qmcflac']);
  let from = app.events.length;
  await app.invoke('start', app.options);
  await app.finished(from);
  await assert.rejects(app.invoke('start', app.options), /添加需要转换/);
  const second = await app.addFiles(['已完成二.qmcflac']);
  from = app.events.length;
  await app.invoke('start', app.options);
  const batch = await app.finished(from);
  assert.equal(batch.total, 1);
  assert.deepEqual(app.calls.map((call) => call.inputPath), [...first, ...second]);
  await app.addFiles(['待处理.qmcflac']);
  const pending = await app.invoke('clear-completed');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].name, '待处理.qmcflac');
  assert.equal(pending[0].status, 'pending');
  assert.deepEqual(await app.invoke('clear-queue'), []);
  assert.deepEqual(app.latest('queue').items, []);
});

test('IPC accepts only the main window and its local document frame', async (t) => {
  const app = await harness(t);
  await app.addFiles(['保留.qmcflac']);
  const invalid = [
    { sender: {}, senderFrame: app.event.senderFrame },
    { sender: app.event.sender, senderFrame: { url: 'https://example.invalid/' } },
    { sender: app.event.sender },
  ];
  for (const event of invalid) {
    await assert.rejects(app.invokeRaw('clear-queue', event), /请求来源无效/);
    await assert.rejects(app.invokeRaw('get-settings', event), /请求来源无效/);
    await assert.rejects(app.invokeRaw('set-key', event, app.latest('queue').items[0].id, 'untrusted-secret'), /请求来源无效/);
  }
  assert.equal(app.keyCount(), 0);
  assert.equal(app.latest('queue').items.length, 1);
  const settings = await app.invoke('get-settings');
  assert.equal(settings.bitrate, 320);
  assert.ok(settings.outputDir.startsWith(app.directory));
});

test('per-track keys go only to their matching converter call and never enter public IPC or preferences', async (t) => {
  const app = await harness(t);
  const inputs = await app.addFiles(['甲.mflac', '乙.qmcflac', '丙.mgg']);
  const items = app.latest('queue').items;
  const firstKey = 'SYNTHETIC_PUBLIC_TEST_EKEY_FOR_TRACK_A';
  const thirdKey = 'SYNTHETIC_PUBLIC_TEST_EKEY_FOR_TRACK_C';
  const firstResult = await app.invoke('set-key', items[0].id, '  ' + firstKey + '\n');
  const thirdResult = await app.invoke('set-key', items[2].id, thirdKey);
  assert.equal(firstResult.hasKey, true);
  assert.equal(thirdResult.hasKey, true);
  assert.equal(app.keyCount(), 2);
  const publicQueue = await app.invoke('choose-files'); // cancelled native chooser returns the queue.
  assert.deepEqual(publicQueue.map((item) => item.hasKey), [true, false, true]);
  const from = app.events.length;
  await app.invoke('start', app.options);
  await app.finished(from);
  assert.deepEqual(app.calls.map((call) => call.inputPath), inputs);
  assert.deepEqual(app.calls.map((call) => call.options.externalKey), [firstKey, undefined, thirdKey]);
  const preferences = await fs.readFile(path.join(app.directory, 'UserData', 'settings.json'), 'utf8');
  const exposed = JSON.stringify({ firstResult, thirdResult, publicQueue, events: app.events, settings: await app.invoke('get-settings'), preferences });
  for (const secret of [firstKey, thirdKey]) assert.equal(exposed.includes(secret), false);
  assert.equal(exposed.includes('externalKey'), false);
  assert.ok(app.events.every((event) => event.channel === 'qq:event'));
  assert.ok(app.events.filter((event) => event.type === 'item').every((event) => typeof event.item.hasKey === 'boolean'));
});

test('set-key validates the queue id and type; clearing a key releases it from memory', async (t) => {
  const app = await harness(t);
  await app.addFiles(['密钥检查.mflac']);
  const id = app.latest('queue').items[0].id;
  await assert.rejects(app.invoke('set-key', 'unknown-id', 'fixture-key'), /歌曲密钥无效/);
  await assert.rejects(app.invoke('set-key', id, {}), /歌曲密钥无效/);
  await assert.rejects(app.invoke('set-key', id, 'A'.repeat(16385)), /歌曲密钥无效/);
  assert.equal(app.keyCount(), 0);
  assert.equal((await app.invoke('set-key', id, 'fixture-key')).hasKey, true);
  assert.equal(app.keyCount(), 1);
  assert.equal((await app.invoke('set-key', id, '  \t\n')).hasKey, false);
  assert.equal(app.keyCount(), 0);
  assert.equal(app.latest('item').item.hasKey, false);
});

test('removing an item or clearing the queue purges their stored per-track keys', async (t) => {
  const app = await harness(t);
  await app.addFiles(['一.mflac', '二.mgg', '三.qmc3']);
  const items = app.latest('queue').items;
  for (let i = 0; i < items.length; i += 1) await app.invoke('set-key', items[i].id, 'synthetic-key-' + i);
  assert.equal(app.keyCount(), 3);
  const left = await app.invoke('remove-item', items[1].id);
  assert.equal(app.keyCount(), 2);
  assert.ok(left.every((item) => item.id !== items[1].id && item.hasKey));
  await app.invoke('clear-queue');
  assert.equal(app.keyCount(), 0);
  assert.deepEqual(app.latest('queue').items, []);
  await app.addFiles(['一.mflac']);
  assert.equal(app.latest('queue').items[0].hasKey, false);
});

test('clear-completed removes successful tracks and their keys while failed keys remain available for retry', async (t) => {
  const app = await harness(t, async (inputPath, outputDir) => {
    if (path.basename(inputPath) === '保留失败.mflac') throw new Error('synthetic decode error');
    return { outputPath: path.join(outputDir, '完成.mp3'), message: '完成' };
  });
  await app.addFiles(['清理成功.mflac', '保留失败.mflac']);
  const items = app.latest('queue').items;
  for (const item of items) await app.invoke('set-key', item.id, 'synthetic-key-for-' + item.id);
  const from = app.events.length;
  await app.invoke('start', app.options);
  await app.finished(from);
  assert.equal(app.keyCount(), 2);
  const remaining = await app.invoke('clear-completed');
  assert.equal(app.keyCount(), 1);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].name, '保留失败.mflac');
  assert.equal(remaining[0].hasKey, true);
  await app.invoke('remove-item', remaining[0].id);
  assert.equal(app.keyCount(), 0);
});

test('macOS startup installs native app, edit and window menu roles', async (t) => {
  const app = await harness(t, undefined, 'darwin');
  assert.deepEqual(app.permissions.applicationMenu.map((entry) => entry.role), ['appMenu', 'editMenu', 'windowMenu']);
});

test('the sandbox preload exposes the qqmp3 API with only the expected qq IPC key operation', async () => {
  const calls = [];
  let name;
  let api;
  const source = await fs.readFile(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  vm.runInNewContext(source, {
    require(dependency) {
      assert.equal(dependency, 'electron');
      return {
        contextBridge: { exposeInMainWorld(key, value) { name = key; api = value; } },
        ipcRenderer: {
          invoke(channel, ...args) { calls.push([channel, ...args]); return Promise.resolve('ack'); },
          on() {}, removeListener() {},
        },
        webUtils: { getPathForFile(file) { return file.path; } },
      };
    },
  });
  assert.equal(name, 'qqmp3');
  assert.equal(Object.isFrozen(api), true);
  assert.equal(await api.setKey('track-id', 'synthetic-per-track-ekey'), 'ack');
  assert.deepEqual(calls, [['qq:set-key', 'track-id', 'synthetic-per-track-ekey']]);
  assert.equal(typeof api.onEvent, 'function');
  assert.equal(typeof api.start, 'function');
  assert.equal(api.invoke, undefined);
});
