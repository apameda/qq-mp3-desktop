'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, session, Menu } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { convertFile } = require('./converter');
const { supportedExtensions: qmcExtensions } = require('./qmc');
const extensions = Object.freeze([...qmcExtensions, 'flac']);

app.setName('QQ音乐转MP3');
let window;
let queue = [];
const songKeys = new Map();
const extensionSet = new Set(extensions);
const isSupported = name => extensionSet.has(path.extname(name).slice(1).toLowerCase());
const publicItem = item => ({ ...item, hasKey: songKeys.has(item.id) });
const publicQueue = () => queue.map(publicItem);
let running = false;
let starting = false;
let scanning = false;
let activeBatch = null;
let closing = false;
let controller = null;
let settings;
let batch = { running: false, total: 0, completed: 0, success: 0, failed: 0, cancelled: 0 };
const page = path.join(__dirname, 'renderer', 'index.html');

function send(event) {
  if (window && !window.isDestroyed()) window.webContents.send('qq:event', event);
}

function sendQueue() { send({ type: 'queue', items: publicQueue() }); }
function sendBatch() { send({ type: 'batch', ...batch }); }
function ensureIdle() { if (running || starting || scanning) throw new Error('正在处理当前操作，请稍候再试。'); }
function userError(error) {
  if (error.code === 'ENOSPC') return '磁盘空间不足，请清理空间后重试。';
  if (['EACCES', 'EPERM', 'EROFS'].includes(error.code)) return '无法写入文件，请换一个有写入权限的输出文件夹。';
  if (error.code === 'ENOENT') return '找不到文件，文件可能已被移动或删除。';
  return error.message || '转换失败，请检查文件后重试。';
}

async function findFfmpeg() {
  const choices = [
    path.join(app.getAppPath(), 'resources', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
    path.join(process.resourcesPath, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'),
  ];
  if (!app.isPackaged && (process.env.QQ_FFMPEG || process.env.NCM_FFMPEG)) choices.unshift(process.env.QQ_FFMPEG || process.env.NCM_FFMPEG);
  for (const candidate of choices) {
    try { if ((await fs.stat(candidate)).isFile()) return candidate; } catch {}
  }
  throw new Error('软件中的转码工具缺失。请重新完整解压下载的 ZIP，不要只复制 EXE。');
}

async function loadSettings() {
  settings = { outputDir: path.join(app.getPath('music'), 'QQ转MP3'), bitrate: 320 };
  try {
    const saved = JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'settings.json'), 'utf8'));
    if (typeof saved.outputDir === 'string' && path.isAbsolute(saved.outputDir)) settings.outputDir = saved.outputDir;
    if ([192, 256, 320].includes(saved.bitrate)) settings.bitrate = saved.bitrate;
  } catch {}
}

async function saveSettings() {
  try {
    await fs.mkdir(app.getPath('userData'), { recursive: true });
    await fs.writeFile(path.join(app.getPath('userData'), 'settings.json'), JSON.stringify(settings), 'utf8');
  } catch { /* Conversion remains usable if preference storage is unavailable. */ }
}

async function addPaths(paths) {
  ensureIdle();
  if (!Array.isArray(paths) || paths.length > 10000 || paths.some(p => typeof p !== 'string' || !path.isAbsolute(p))) {
    throw new Error('请选择有效的本地文件或文件夹。');
  }
  const keyFor = p => process.platform === 'win32' ? p.toLowerCase() : p;
  const existing = new Set(queue.map(item => keyFor(item.path)));
  const visited = new Set();
  let ignored = 0;
  let added = 0;
  async function walk(candidate) {
    if (queue.length >= 10000) throw new Error('一次最多添加 10000 个文件，请分批转换。');
    let stat;
    let real;
    try {
      real = await fs.realpath(candidate);
      stat = await fs.stat(real);
    } catch { ignored++; return; }
    if (stat.isDirectory()) {
      const key = keyFor(real);
      if (visited.has(key)) return;
      visited.add(key);
      let entries;
      try { entries = await fs.readdir(real, { withFileTypes: true }); } catch { ignored++; return; }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory() || isSupported(entry.name)) await walk(path.join(real, entry.name));
      }
      return;
    }
    if (!stat.isFile() || !isSupported(real)) return;
    const key = keyFor(real);
    if (existing.has(key)) return;
    existing.add(key);
    queue.push({ id: randomUUID(), name: path.basename(real), path: real, size: stat.size, status: 'pending', progress: 0, error: '', message: '' });
    added++;
  }
  scanning = true;
  try { for (const candidate of paths) await walk(candidate); }
  finally { scanning = false; sendQueue(); }
  if (ignored) send({ type: 'notice', message: `已跳过 ${ignored} 个无法读取的文件或文件夹。` });
  else if (!added) send({ type: 'notice', message: '没有发现新的 QQ 音乐或 FLAC 文件，重复文件会自动跳过。' });
  return publicQueue();
}

async function processBatch(items, ffmpegPath) {
  const signal = controller.signal;
  try {
    for (const item of items) {
      batch.currentName = item.name;
      sendBatch();
      try {
        if (signal.aborted) {
          const error = new Error('已取消转换'); error.name = 'AbortError'; throw error;
        }
        let lastSent = 0;
        const result = await convertFile(item.path, settings.outputDir, {
          ffmpegPath, bitrate: settings.bitrate, signal, externalKey: songKeys.get(item.id),
          onUpdate(update) {
            const oldStatus = item.status;
            Object.assign(item, update);
            const now = Date.now();
            if (oldStatus !== item.status || now - lastSent >= 80) {
              lastSent = now; send({ type: 'item', item: publicItem(item) });
            }
          },
        });
        Object.assign(item, result, { status: 'success', progress: 100, error: '' });
        batch.success++;
      } catch (error) {
        const cancelled = error.name === 'AbortError' || signal.aborted;
        Object.assign(item, { status: cancelled ? 'cancelled' : 'failed', error: cancelled ? '' : userError(error), message: cancelled ? '已取消，可再次开始' : '', progress: 0 });
        if (cancelled) batch.cancelled++;
        else batch.failed++;
      }
      batch.completed++;
      send({ type: 'item', item: publicItem(item) });
      sendBatch();
    }
  } finally {
    running = false;
    controller = null;
    batch.running = false;
    batch.currentName = '';
    sendBatch();
    sendQueue();
  }
}

function installHandlers() {
  function handle(name, callback) {
    ipcMain.handle('qq:' + name, async (event, ...args) => {
      if (!window || event.sender !== window.webContents || event.senderFrame?.url !== pathToFileURL(page).href) {
        throw new Error('请求来源无效。');
      }
      return callback(...args);
    });
  }
  handle('get-settings', () => ({ ...settings }));
  handle('choose-files', async () => {
    ensureIdle();
    const result = await dialog.showOpenDialog(window, { title: '选择 QQ 音乐或 FLAC 文件', properties: ['openFile', 'multiSelections'], filters: [{ name: 'QQ 音乐及 FLAC 文件', extensions }] });
    return result.canceled ? publicQueue() : addPaths(result.filePaths);
  });
  handle('choose-folder', async () => {
    ensureIdle();
    const result = await dialog.showOpenDialog(window, { title: '选择音乐文件夹（包含子文件夹）', properties: ['openDirectory'] });
    return result.canceled ? publicQueue() : addPaths(result.filePaths);
  });
  handle('add-paths', addPaths);
  handle('choose-output', async () => {
    ensureIdle();
    const result = await dialog.showOpenDialog(window, { title: '选择 MP3 保存位置', defaultPath: settings.outputDir, properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled) return null;
    settings.outputDir = result.filePaths[0];
    await saveSettings();
    return settings.outputDir;
  });
  handle('clear-completed', () => { ensureIdle(); for (const item of queue) if (item.status === 'success') songKeys.delete(item.id); queue = queue.filter(item => item.status !== 'success'); sendQueue(); return publicQueue(); });
  handle('clear-queue', () => { ensureIdle(); queue = []; songKeys.clear(); sendQueue(); return publicQueue(); });
  handle('remove-item', (id) => { ensureIdle(); queue = queue.filter(item => item.id !== id); songKeys.delete(id); sendQueue(); return publicQueue(); });
  handle('set-key', (id, key) => {
    ensureIdle();
    const item = queue.find(entry => entry.id === id);
    if (!item || typeof key !== 'string' || key.length > 16384) throw new Error('歌曲密钥无效，请重新输入。');
    const value = key.trim();
    if (value) songKeys.set(id, value); else songKeys.delete(id);
    const updated = publicItem(item);
    send({ type: 'item', item: updated });
    return updated;
  });
  handle('open-output', async () => {
    await fs.mkdir(settings.outputDir, { recursive: true });
    const error = await shell.openPath(settings.outputDir);
    if (error) throw new Error('无法打开输出文件夹：' + error);
  });
  handle('start', async (options) => {
    ensureIdle();
    starting = true;
    const startupController = new AbortController();
    controller = startupController;
    const checkStartup = () => {
      if (startupController.signal.aborted) throw new Error('已取消转换准备，可再次开始。');
    };
    try {
    if (!options || typeof options.outputDir !== 'string' || !path.isAbsolute(options.outputDir) || ![192, 256, 320].includes(options.bitrate)) throw new Error('请先选择保存位置和音质。');
    const items = queue.filter(item => ['pending', 'failed', 'cancelled'].includes(item.status));
    if (!items.length) throw new Error('请先添加需要转换的 QQ 音乐或 FLAC 文件。');
    const ffmpegPath = await findFfmpeg();
    checkStartup();
    await fs.mkdir(options.outputDir, { recursive: true });
    checkStartup();
    await fs.access(options.outputDir, require('node:fs').constants.W_OK);
    checkStartup();
    settings = { outputDir: options.outputDir, bitrate: options.bitrate };
    await saveSettings();
    checkStartup();
    for (const item of items) Object.assign(item, { status: 'pending', progress: 0, error: '', message: '', outputPath: undefined });
    running = true;
    batch = { running: true, total: items.length, completed: 0, success: 0, failed: 0, cancelled: 0, currentName: '' };
    sendQueue(); sendBatch();
    activeBatch = processBatch(items, ffmpegPath).catch(error => {
      send({ type: 'notice', message: userError(error) });
    });
    return true;
    } finally { starting = false; if (!running && controller === startupController) controller = null; }
  });
  handle('cancel', () => { controller?.abort(); return true; });
}

function createWindow() {
  window = new BrowserWindow({
    title: 'QQ音乐转MP3', width: 1120, height: 820, minWidth: 920, minHeight: 680,
    backgroundColor: '#f6f7fb', show: false, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false },
  });
  window.removeMenu();
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.once('ready-to-show', () => window.show());
  window.on('close', event => {
    if (closing) return;
    if (!running && !starting) return;
    const choice = dialog.showMessageBoxSync(window, { type: 'question', title: '转换尚未完成', message: '要取消转换并退出吗？', detail: '已完成的 MP3 会保留，原始 QQ 音乐文件不会改变。', buttons: ['继续转换', '取消并退出'], defaultId: 0, cancelId: 0 });
    event.preventDefault();
    if (choice === 1) {
      controller?.abort();
      const finishClosing = () => { closing = true; if (!window.isDestroyed()) window.close(); };
      if (activeBatch && running) void activeBatch.finally(finishClosing);
      else finishClosing();
    }
  });
  window.loadFile(page);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
  app.whenReady().then(async () => {
    await loadSettings();
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^(https?|wss?|ftp):/i.test(details.url) }));
    if (process.platform === 'darwin') Menu.setApplicationMenu(Menu.buildFromTemplate([{role:'appMenu'}, {role:'editMenu'}, {role:'windowMenu'}]));
    installHandlers(); createWindow();
  }).catch(error => { dialog.showErrorBox('软件启动失败', userError(error)); app.quit(); });
  app.on('window-all-closed', () => app.quit());
}
