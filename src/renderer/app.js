(() => {
  'use strict';

  const api = window.qqmp3;
  const byId = (id) => document.getElementById(id);
  const elements = Object.fromEntries([
    'file-count', 'add-files', 'add-folder', 'clear-queue', 'drop-area',
    'queue-empty', 'empty-add-files', 'file-table', 'file-list', 'drop-overlay',
    'drop-hint', 'output-dir', 'choose-output', 'bitrate', 'batch-title',
    'batch-detail', 'batch-percentage', 'overall-track', 'overall-progress',
    'open-output', 'start', 'cancel', 'toast', 'toast-message', 'toast-close',
    'key-dialog', 'key-form', 'key-song-name', 'song-key', 'key-current-status',
    'key-close', 'key-cancel', 'key-clear', 'key-save', 'key-error',
  ].map((id) => [id, byId(id)]));

  const statusLabels = {
    pending: '等待转换', decoding: '正在解析', encoding: '正在转码',
    validating: '校验音频', success: '已完成', failed: '转换失败', cancelled: '已取消',
  };
  const activeStatuses = new Set(['decoding', 'encoding', 'validating']);
  const retryableStatuses = new Set(['pending', 'failed', 'cancelled']);
  const isFlac = item => /\.flac$/i.test(item.name || item.path || '');
  const state = { items: [], outputDir: '', running: false, busy: false, cancelling: false, batch: null, keyItemId: null };
  const rowElements = new Map();
  let toastTimer;
  let dragDepth = 0;

  function icon(name, className = 'icon') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', className);
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#icon-${name}`);
    svg.appendChild(use);
    return svg;
  }

  function textElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function showToast(message, duration = 6500) {
    clearTimeout(toastTimer);
    elements['toast-message'].textContent = String(message || '操作未完成，请重试。');
    elements.toast.hidden = false;
    toastTimer = setTimeout(() => { elements.toast.hidden = true; }, duration);
  }

  function errorText(error) {
    return String(error?.message || error || '操作未完成，请重试。').replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '');
  }

  function formatSize(size) {
    if (!Number.isFinite(Number(size)) || Number(size) < 0) return '—';
    const bytes = Number(size);
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  function progressFor(item) {
    return item.status === 'success' ? 100 : Math.max(0, Math.min(100, Number(item.progress) || 0));
  }

  function createRow(item) {
    const row = textElement('div', 'file-row');
    row.setAttribute('role', 'listitem');
    const primary = textElement('div', 'file-primary');
    const fileIcon = textElement('span', 'file-icon');
    fileIcon.appendChild(icon('music'));
    const copy = textElement('div', 'file-copy');
    const name = textElement('span', 'file-name');
    const caption = textElement('span', 'file-caption');
    copy.append(name, caption);
    primary.append(fileIcon, copy);
    const size = textElement('span', 'file-size');
    const status = textElement('span', 'file-status');
    const progress = textElement('div', 'row-progress');
    const progressText = textElement('span');
    const progressTrack = textElement('div', 'row-progress-track');
    const progressFill = textElement('div', 'row-progress-fill');
    progressTrack.appendChild(progressFill);
    progress.append(progressText, progressTrack);
    const keyButton = textElement('button', 'key-button');
    keyButton.append(icon('key'), textElement('span', '', '歌曲密钥'));
    keyButton.addEventListener('click', () => openKeyDialog(item.id));
    const removeButton = textElement('button', 'remove-item');
    removeButton.appendChild(icon('cross'));
    removeButton.title = '从列表中移除，不删除文件';
    removeButton.addEventListener('click', async () => {
      if (!api || state.running || state.busy) return;
      state.busy = true;
      renderSummary();
      try { updateQueue(await api.removeItem(item.id)); state.batch = null; }
      catch (error) { showToast(errorText(error)); }
      finally { state.busy = false; renderSummary(); }
    });
    row.append(primary, size, status, progress, keyButton, removeButton);
    return { row, name, caption, size, status, progressText, progressFill, keyButton, removeButton };
  }

  function updateRow(item) {
    let row = rowElements.get(item.id);
    if (!row) {
      row = createRow(item);
      rowElements.set(item.id, row);
      elements['file-list'].appendChild(row.row);
    }
    const status = statusLabels[item.status] ? item.status : 'pending';
    const progress = progressFor(item);
    row.isFlac = isFlac(item);
    row.name.textContent = item.name || '未命名文件';
    row.removeButton.setAttribute('aria-label', `从列表移除 ${item.name || '未命名文件'}`);
    row.keyButton.classList.toggle('has-key', !isFlac(item) && Boolean(item.hasKey));
    row.keyButton.lastChild.textContent = isFlac(item) ? '无需密钥' : item.hasKey ? '已设密钥' : '歌曲密钥';
    row.keyButton.setAttribute('aria-label', isFlac(item) ? `FLAC 无需密钥：${item.name}` : `${item.hasKey ? '修改' : '设置'}歌曲密钥：${item.name || '未命名文件'}`);
    row.keyButton.title = isFlac(item) ? '普通 FLAC 文件无需歌曲密钥，可直接转换' : item.hasKey ? '修改或清除这一首的密钥，不显示原密钥' : '可选：仅为这一首设置对应的 ekey';
    row.name.title = item.path || item.name || '';
    row.size.textContent = formatSize(item.size);
    row.status.className = `file-status ${status}`;
    row.status.replaceChildren();
    if (activeStatuses.has(status)) row.status.appendChild(textElement('span', 'spinner'));
    else if (status === 'success') row.status.appendChild(icon('check'));
    else if (status === 'failed') row.status.appendChild(icon('alert'));
    row.status.appendChild(document.createTextNode(statusLabels[status]));
    row.caption.className = `file-caption ${status}`;
    const caption = status === 'failed' ? (item.error || '转换失败，请重试。')
      : status === 'success' ? (item.message || 'MP3 已保存')
      : status === 'cancelled' ? '可点击「重试未完成」继续转换'
      : (item.message || (isFlac(item) ? 'FLAC 音频 · 转换为 MP3' : 'QQ 音乐加密文件'));
    row.caption.textContent = caption;
    row.caption.title = status === 'success' && item.outputPath ? `${caption}\n${item.outputPath}` : caption;
    row.progressText.textContent = status === 'pending' ? '—' : `${Math.floor(progress)}%`;
    row.progressFill.className = `row-progress-fill ${status}`;
    row.progressFill.style.width = `${progress}%`;
    row.row.setAttribute('aria-label', `${item.name || '未命名文件'}，${statusLabels[status]}${status === 'failed' ? `，${caption}` : ''}`);
  }

  function updateQueue(items) {
    if (!Array.isArray(items)) return;
    state.items = items;
    const ids = new Set(items.map((item) => item.id));
    for (const [id, row] of rowElements) {
      if (!ids.has(id)) { row.row.remove(); rowElements.delete(id); }
    }
    for (const item of items) updateRow(item);
    renderSummary();
  }

  function queueCounts() {
    return state.items.reduce((counts, item) => {
      if (item.status === 'success') counts.success++;
      if (item.status === 'failed') counts.failed++;
      if (retryableStatuses.has(item.status)) counts.ready++;
      if (item.status === 'pending') counts.pending++;
      return counts;
    }, { success: 0, failed: 0, ready: 0, pending: 0 });
  }

  function renderSummary() {
    const counts = queueCounts();
    const locked = state.running || state.busy;
    const hasItems = state.items.length > 0;
    elements['file-count'].textContent = `${state.items.length} 个文件`;
    elements['queue-empty'].hidden = hasItems;
    elements['file-table'].hidden = !hasItems;
    elements['add-files'].disabled = locked;
    elements['add-folder'].disabled = locked;
    elements['empty-add-files'].disabled = locked;
    elements['clear-queue'].disabled = locked || !hasItems;
    for (const row of rowElements.values()) {
      row.removeButton.disabled = locked;
      row.keyButton.disabled = locked || row.isFlac;
    }
    elements['choose-output'].disabled = locked;
    elements.bitrate.disabled = locked;
    if (state.running && elements['key-dialog'].open) closeKeyDialog(true);
    for (const id of ['key-save', 'key-clear', 'key-cancel', 'key-close', 'song-key']) elements[id].disabled = locked;
    elements['open-output'].disabled = !state.outputDir;
    elements.start.disabled = locked || counts.ready === 0 || !state.outputDir;
    elements.start.hidden = state.running;
    elements.cancel.hidden = !state.running;
    elements.cancel.disabled = state.cancelling;
    elements.cancel.lastChild.textContent = state.cancelling ? '正在取消…' : '取消转换';
    elements['drop-hint'].textContent = state.running ? '转换中，请等待当前任务结束后再添加文件' : '还可以继续拖入文件或文件夹';
    elements.start.firstChild.textContent = counts.ready > 0 && counts.pending === 0 ? '重试未完成' : '开始转换';
    elements['output-dir'].value = state.outputDir || '请选择输出文件夹';
    elements['output-dir'].title = state.outputDir;

    const batch = state.batch;
    const visibleProgress = Boolean(batch && batch.total > 0);
    elements['overall-track'].hidden = !visibleProgress;
    if (state.running && batch) {
      const active = state.items.find((item) => activeStatuses.has(item.status));
      const currentProgress = active ? progressFor(active) / 100 : 0;
      const percentage = Math.min(100, Math.floor(((Number(batch.completed) || 0) + currentProgress) / Math.max(1, batch.total) * 100));
      elements['batch-title'].textContent = state.cancelling ? '正在取消转换…' : `正在转换 · ${batch.completed || 0} / ${batch.total}`;
      elements['batch-detail'].textContent = batch.currentName || active?.name || '正在准备音频…';
      elements['batch-percentage'].textContent = `${percentage}%`;
      elements['overall-progress'].style.width = `${percentage}%`;
      elements['overall-track'].setAttribute('aria-valuenow', String(percentage));
    } else if (batch && batch.total > 0) {
      const cancelled = Number(batch.cancelled) || 0;
      const failed = Number(batch.failed) || 0;
      const success = Number(batch.success) || 0;
      const percentage = Math.min(100, Math.floor(Math.max(0, (Number(batch.completed) || 0) - cancelled) / batch.total * 100));
      elements['batch-title'].textContent = cancelled > 0 ? '转换已取消' : failed > 0 ? '转换结束，部分文件需要重试' : '转换完成，音乐已就绪';
      elements['batch-detail'].textContent = `成功 ${success} 个${failed ? ` · 失败 ${failed} 个` : ''}${cancelled ? ` · 已取消 ${cancelled} 个` : ''}${counts.ready ? ` · 可继续转换 ${counts.ready} 个文件` : ' · 点击「打开输出文件夹」查看 MP3'}`;
      elements['batch-percentage'].textContent = `${percentage}%`;
      elements['overall-progress'].style.width = `${percentage}%`;
      elements['overall-track'].setAttribute('aria-valuenow', String(percentage));
    } else {
      elements['batch-title'].textContent = hasItems ? `已添加 ${state.items.length} 个文件` : '准备好，开始听音乐';
      elements['batch-detail'].textContent = hasItems ? `等待转换 ${counts.ready} 个${counts.success ? ` · 已完成 ${counts.success} 个` : ''}${counts.failed ? ` · 失败 ${counts.failed} 个` : ''}` : '添加 QQ 音乐或 FLAC 文件后，点击「开始转换」。';
      elements['batch-percentage'].textContent = '';
    }
  }

  function openKeyDialog(id) {
    if (!api || state.running || state.busy) return;
    const item = state.items.find(entry => entry.id === id);
    if (!item || isFlac(item)) return;
    state.keyItemId = id;
    elements['song-key'].value = '';
    elements['key-song-name'].textContent = item.name || '未命名文件';
    elements['key-song-name'].title = item.path || item.name || '';
    elements['key-current-status'].hidden = !item.hasKey;
    elements['key-clear'].hidden = !item.hasKey;
    elements['key-error'].textContent = '';
    elements['key-error'].hidden = true;
    elements['key-dialog'].showModal();
    elements['song-key'].focus();
  }

  function clearKeyInput() {
    elements['song-key'].value = '';
    elements['key-error'].textContent = '';
    elements['key-error'].hidden = true;
    state.keyItemId = null;
  }

  function closeKeyDialog(force = false) {
    if (state.busy && !force) return;
    clearKeyInput();
    if (elements['key-dialog'].open) elements['key-dialog'].close();
  }

  async function saveSongKey(clear = false) {
    if (!api || state.running || state.busy || state.keyItemId === null) return;
    const id = state.keyItemId;
    if (!clear && !elements['song-key'].value.trim()) {
      elements['key-error'].textContent = '请粘贴这首歌的密钥，或点击「取消」先尝试转换。';
      elements['key-error'].hidden = false;
      elements['song-key'].focus();
      return;
    }
    state.busy = true;
    elements['key-save'].textContent = '正在保存…';
    elements['key-error'].hidden = true;
    renderSummary();
    try {
      const updated = await api.setKey(id, clear ? '' : elements['song-key'].value);
      if (updated) onEvent({ type: 'item', item: updated });
      closeKeyDialog(true);
      showToast(clear ? '已清除这首歌的密钥。' : '已为这首歌设置密钥，仅本次应用内使用。');
    } catch (error) {
      elements['key-error'].textContent = errorText(error);
      elements['key-error'].hidden = false;
    } finally {
      state.busy = false;
      elements['key-save'].textContent = '保存密钥';
      renderSummary();
    }
  }

  async function addFiles(kind, paths) {
    if (!api || state.running || state.busy) return;
    state.busy = true;
    renderSummary();
    try {
      const previousCount = state.items.length;
      const items = kind === 'files' ? await api.chooseFiles()
        : kind === 'folder' ? await api.chooseFolder() : await api.addPaths(paths);
      updateQueue(items);
      const added = state.items.length - previousCount;
      if (added > 0) { state.batch = null; showToast(`已添加 ${added} 个音乐文件。`); }
    } catch (error) { showToast(errorText(error)); }
    finally { state.busy = false; renderSummary(); }
  }

  async function startBatch() {
    if (!api || state.running || state.busy || !state.outputDir) return;
    const counts = queueCounts();
    if (!counts.ready) return;
    state.running = true;
    state.cancelling = false;
    state.batch = { running: true, total: counts.ready, completed: 0, success: 0, failed: 0, cancelled: 0 };
    renderSummary();
    try { await api.start({ outputDir: state.outputDir, bitrate: Number(elements.bitrate.value) }); }
    catch (error) { state.running = false; state.batch = null; showToast(errorText(error)); renderSummary(); }
  }

  function onEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'queue') updateQueue(event.items);
    else if (event.type === 'item' && event.item) {
      const index = state.items.findIndex((item) => item.id === event.item.id);
      if (index === -1) state.items.push(event.item);
      else state.items[index] = event.item;
      updateRow(event.item);
      renderSummary();
    } else if (event.type === 'batch') {
      const wasRunning = state.running;
      state.batch = event;
      state.running = Boolean(event.running);
      if (!state.running) {
        state.cancelling = false;
        if (wasRunning && event.success > 0 && !event.failed && !event.cancelled) showToast(`转换完成，${event.success} 个 MP3 已保存。`);
      }
      renderSummary();
    } else if (event.type === 'notice') showToast(event.message);
  }

  elements['add-files'].addEventListener('click', () => addFiles('files'));
  elements['empty-add-files'].addEventListener('click', () => addFiles('files'));
  elements['add-folder'].addEventListener('click', () => addFiles('folder'));
  elements.start.addEventListener('click', startBatch);
  elements.cancel.addEventListener('click', async () => {
    if (!api || state.cancelling || !state.running) return;
    state.cancelling = true;
    renderSummary();
    try { await api.cancel(); }
    catch (error) { state.cancelling = false; showToast(errorText(error)); renderSummary(); }
  });
  elements['choose-output'].addEventListener('click', async () => {
    if (!api || state.running || state.busy) return;
    state.busy = true;
    renderSummary();
    try { const directory = await api.chooseOutput(); if (directory) state.outputDir = directory; }
    catch (error) { showToast(errorText(error)); }
    finally { state.busy = false; renderSummary(); }
  });
  elements['open-output'].addEventListener('click', async () => {
    if (!api || !state.outputDir) return;
    try { await api.openOutput(state.outputDir); }
    catch (error) { showToast(errorText(error)); }
  });
  elements['clear-queue'].addEventListener('click', async () => {
    if (!api || state.running || state.busy) return;
    state.busy = true;
    renderSummary();
    try { updateQueue(await api.clearQueue()); state.batch = null; }
    catch (error) { showToast(errorText(error)); }
    finally { state.busy = false; renderSummary(); }
  });
  elements['toast-close'].addEventListener('click', () => { clearTimeout(toastTimer); elements.toast.hidden = true; });
  elements.bitrate.addEventListener('change', () => { if (state.running) renderSummary(); });
  elements['key-form'].addEventListener('submit', event => { event.preventDefault(); saveSongKey(); });
  elements['key-clear'].addEventListener('click', () => saveSongKey(true));
  elements['key-cancel'].addEventListener('click', () => closeKeyDialog());
  elements['key-close'].addEventListener('click', () => closeKeyDialog());
  elements['key-dialog'].addEventListener('cancel', event => {
    event.preventDefault();
    if (!state.busy) closeKeyDialog();
  });
  elements['key-dialog'].addEventListener('close', clearKeyInput);

  document.addEventListener('dragover', (event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = state.running || state.busy ? 'none' : 'copy'; });
  document.addEventListener('drop', (event) => event.preventDefault());
  elements['drop-area'].addEventListener('dragenter', (event) => {
    event.preventDefault();
    if (state.running || state.busy || !event.dataTransfer?.types.includes('Files')) return;
    dragDepth++;
    elements['drop-overlay'].hidden = false;
  });
  elements['drop-area'].addEventListener('dragleave', (event) => {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) elements['drop-overlay'].hidden = true;
  });
  elements['drop-area'].addEventListener('drop', async (event) => {
    event.preventDefault();
    dragDepth = 0;
    elements['drop-overlay'].hidden = true;
    if (!api || state.running || state.busy) return;
    try {
      const paths = api.getDropPaths(Array.from(event.dataTransfer?.files || []));
      if (paths.length) await addFiles('paths', paths);
      else showToast('请拖入本机的 QQ 音乐、FLAC 文件或文件夹。');
    } catch (error) { showToast(errorText(error)); }
  });
  window.addEventListener('blur', () => { dragDepth = 0; elements['drop-overlay'].hidden = true; });

  async function initialize() {
    if (!api) { renderSummary(); showToast('请在 QQ音乐转MP3 应用中打开此界面。', 10000); return; }
    const unsubscribe = api.onEvent(onEvent);
    window.addEventListener('beforeunload', unsubscribe, { once: true });
    state.busy = true;
    renderSummary();
    try {
      const settings = await api.getSettings();
      state.outputDir = settings.outputDir || '';
      if ([320, 256, 192].includes(Number(settings.bitrate))) elements.bitrate.value = String(settings.bitrate);
    } catch (error) { showToast(errorText(error)); }
    finally { state.busy = false; renderSummary(); }
  }

  initialize();
})();
