'use strict';

const elements = {
  liveStatus: document.getElementById('liveStatus'),
  liveText: document.getElementById('liveText'),
  dropzone: document.getElementById('dropzone'),
  sendButton: document.getElementById('sendButton'),
  fileInput: document.getElementById('fileInput'),
  limitText: document.getElementById('limitText'),
  uploadPanel: document.getElementById('uploadPanel'),
  uploadName: document.getElementById('uploadName'),
  uploadQueue: document.getElementById('uploadQueue'),
  cancelUpload: document.getElementById('cancelUpload'),
  progressTrack: document.getElementById('progressTrack'),
  progressFill: document.getElementById('progressFill'),
  uploadStatus: document.getElementById('uploadStatus'),
  uploadPercent: document.getElementById('uploadPercent'),
  connectCard: document.getElementById('connectCard'),
  qrCode: document.getElementById('qrCode'),
  copyAddress: document.getElementById('copyAddress'),
  addressText: document.getElementById('addressText'),
  addressList: document.getElementById('addressList'),
  filesMeta: document.getElementById('filesMeta'),
  clearAll: document.getElementById('clearAll'),
  fileList: document.getElementById('fileList'),
  footerBadge: document.getElementById('footerBadge'),
  toast: document.getElementById('toast'),
};

const state = {
  files: [],
  totalBytes: 0,
  maxFileBytes: 5 * 1024 * 1024 * 1024,
  loaded: false,
  signature: '',
  selectedUrl: '',
  networkSignature: '',
  liveFailures: 0,
};

const upload = {
  queue: [],
  active: false,
  xhr: null,
  session: 0,
};

const downloadIcon = `
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 4v11m0 0 4-4m-4 4-4-4M5 20h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
`;

const trashIcon = `
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M5 7h14M9 7V5h6v2m-8 0 1 13h8l1-13M10 11v5m4-5v5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
`;

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** index;

  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

function relativeTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  const seconds = (Date.now() - date.getTime()) / 1000;

  if (!Number.isFinite(seconds) || seconds < 45) return 'Just now';
  if (seconds < 3600) {
    return `${Math.max(1, Math.floor(seconds / 60))}m ago`;
  }
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

function extensionLabel(name) {
  const match = /\.([a-z0-9]{1,5})$/i.exec(name);
  return match ? match[1].toUpperCase() : 'FILE';
}

function showToast(message, type = 'info') {
  window.clearTimeout(showToast.timer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle('is-error', type === 'error');
  elements.toast.classList.add('is-visible');

  showToast.timer = window.setTimeout(() => {
    elements.toast.classList.remove('is-visible');
  }, type === 'error' ? 4200 : 2600);
}

function setLive(online) {
  elements.liveStatus.classList.toggle('is-offline', !online);
  elements.liveText.textContent = online ? 'Connected' : 'Reconnecting...';
}

async function refreshState(quiet = true) {
  try {
    const response = await fetch('/api/state', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Server returned ${response.status}`);

    const data = await response.json();
    state.liveFailures = 0;
    setLive(true);
    applyState(data);
  } catch {
    state.liveFailures += 1;

    if (!state.loaded || state.liveFailures >= 2) {
      setLive(false);
    }

    if (!quiet) {
      showToast('Cannot reach Easy Drop. Is the app still running?', 'error');
    }
  }
}

function applyState(data) {
  const wasLoaded = state.loaded;
  state.loaded = true;
  state.files = Array.isArray(data.files) ? data.files : [];
  state.totalBytes = Number(data.totalBytes) || 0;
  state.maxFileBytes = Number(data.maxFileBytes) || state.maxFileBytes;

  if (!wasLoaded) {
    elements.limitText.textContent = `Up to ${formatBytes(state.maxFileBytes)} per file`;
  }

  const network = data.network || {};
  const addresses = Array.isArray(network.addresses) ? network.addresses : [];
  const networkSignature = `${network.preferredUrl || ''}|${addresses
    .map((entry) => entry.url)
    .join('|')}`;

  if (networkSignature !== state.networkSignature) {
    state.networkSignature = networkSignature;
    setupNetwork(network);
  }

  applyFiles();
}

function setupNetwork(network) {
  const addresses = Array.isArray(network.addresses)
    ? network.addresses
    : [];

  const hasPublicLink = addresses.some(
    (entry) => entry.name === 'Public link',
  );

  if (elements.footerBadge) {
    elements.footerBadge.textContent = hasPublicLink
      ? 'LAN + public link'
      : 'Local network only';
  }

  if (addresses.length === 0) {
    elements.connectCard.hidden = true;
    return;
  }

  elements.connectCard.hidden = false;

  const availableUrls = new Set(addresses.map((entry) => entry.url));
  const chosenUrl = availableUrls.has(state.selectedUrl)
    ? state.selectedUrl
    : network.preferredUrl || addresses[0].url;

  renderAddressChips(addresses);
  selectAddress(chosenUrl);
}

function renderAddressChips(addresses) {
  elements.addressList.replaceChildren();

  if (addresses.length <= 1) {
    elements.addressList.hidden = true;
    return;
  }

  elements.addressList.hidden = false;

  for (const entry of addresses) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'address-chip';
    chip.textContent = entry.name || entry.address;
    chip.title = `${entry.name || 'Network'} - ${entry.url}`;
    chip.dataset.url = entry.url;
    chip.addEventListener('click', () => selectAddress(entry.url));
    elements.addressList.append(chip);
  }
}

function selectAddress(url) {
  if (!url) return;

  state.selectedUrl = url;
  elements.addressText.textContent = url.replace(/^https?:\/\//, '');
  elements.copyAddress.title = `Copy ${url}`;
  elements.copyAddress.setAttribute('aria-label', `Copy address ${url}`);
  renderQr(url);

  for (const chip of elements.addressList.querySelectorAll('.address-chip')) {
    const isActive = chip.dataset.url === url;
    chip.classList.toggle('is-active', isActive);
    chip.setAttribute('aria-pressed', String(isActive));
  }
}

function renderQr(url) {
  elements.qrCode.replaceChildren();

  try {
    if (typeof window.qrcode !== 'function') {
      throw new Error('QR renderer unavailable');
    }

    const qr = window.qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    elements.qrCode.innerHTML = qr.createImgTag(5, 2);

    const image = elements.qrCode.querySelector('img');
    if (image) image.alt = `QR code for ${url}`;
  } catch {
    const fallback = document.createElement('span');
    fallback.textContent = 'QR unavailable';
    elements.qrCode.append(fallback);
  }
}

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.append(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  const copied = document.execCommand('copy');
  textarea.remove();

  if (!copied) throw new Error('Copy failed');
}

function applyFiles() {
  const count = state.files.length;
  elements.filesMeta.textContent = `${count} ${count === 1 ? 'file' : 'files'} · ${formatBytes(state.totalBytes)}`;
  elements.clearAll.disabled = count === 0;

  const signature = state.files
    .map((file) => `${file.id}:${file.name}:${file.size}`)
    .join('|');

  if (signature === state.signature) {
    updateRelativeTimes();
    return;
  }

  state.signature = signature;
  renderFileList();
}

function renderFileList() {
  elements.fileList.replaceChildren();

  if (state.files.length === 0) {
    elements.fileList.append(createEmptyState());
    return;
  }

  for (const file of state.files) {
    elements.fileList.append(createFileRow(file));
  }

  updateRelativeTimes();
}

function createEmptyState() {
  const empty = document.createElement('div');
  empty.className = 'empty-state';
  empty.innerHTML = `
    <span class="empty-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none">
        <path d="M7 3h6l4 4v14H7V3Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
        <path d="M13 3v4h4" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
      </svg>
    </span>
    <p>No files yet</p>
    <span>Files sent from any device will appear here.</span>
  `;
  return empty;
}

function createFileRow(file) {
  const row = document.createElement('div');
  row.className = 'file-row';
  row.dataset.id = file.id;

  const badge = document.createElement('span');
  badge.className = 'file-badge';
  badge.textContent = extensionLabel(file.name);

  const info = document.createElement('div');
  info.className = 'file-info';

  const downloadUrl = `/download/${encodeURIComponent(file.id)}`;
  const name = document.createElement('a');
  name.className = 'file-name';
  name.href = downloadUrl;
  name.download = file.name;
  name.textContent = file.name;
  name.title = file.name;

  const meta = document.createElement('div');
  meta.className = 'file-meta';

  const size = document.createElement('span');
  size.textContent = formatBytes(file.size);

  const separator = document.createElement('span');
  separator.className = 'separator';
  separator.setAttribute('aria-hidden', 'true');

  const time = document.createElement('span');
  time.dataset.created = file.createdAt;
  time.textContent = relativeTime(file.createdAt);
  time.title = new Date(file.createdAt).toLocaleString();

  meta.append(size, separator, time);
  info.append(name, meta);

  const actions = document.createElement('div');
  actions.className = 'file-actions';

  const download = document.createElement('a');
  download.className = 'download-button';
  download.href = downloadUrl;
  download.download = file.name;
  download.setAttribute('aria-label', `Download ${file.name}`);
  download.innerHTML = `${downloadIcon}<span class="download-label">Download</span>`;

  const remove = document.createElement('button');
  remove.className = 'delete-button';
  remove.type = 'button';
  remove.dataset.delete = file.id;
  remove.setAttribute('aria-label', `Delete ${file.name}`);
  remove.title = 'Delete file';
  remove.innerHTML = trashIcon;

  actions.append(download, remove);
  row.append(badge, info, actions);

  return row;
}

function updateRelativeTimes() {
  for (const element of elements.fileList.querySelectorAll('[data-created]')) {
    element.textContent = relativeTime(element.dataset.created);
  }
}

function openFilePicker() {
  elements.fileInput.click();
}

function queueFiles(fileList) {
  const incoming = Array.from(fileList || []);
  if (incoming.length === 0) return;

  const accepted = [];

  for (const file of incoming) {
    if (file.size > state.maxFileBytes) {
      showToast(
        `${file.name} is too large. The limit is ${formatBytes(state.maxFileBytes)}.`,
        'error',
      );
      continue;
    }
    accepted.push(file);
  }

  if (accepted.length === 0) return;

  upload.queue.push(...accepted);
  startQueue();
}

function showUploadFile(file) {
  elements.uploadPanel.hidden = false;
  elements.uploadPanel.classList.remove('is-complete', 'is-error');
  elements.uploadName.textContent = file.name;
  elements.uploadQueue.textContent = upload.queue.length
    ? `${upload.queue.length} more waiting`
    : '';
  elements.uploadStatus.textContent = 'Uploading';
  elements.uploadPercent.textContent = '0%';
  elements.progressFill.style.width = '0%';
  elements.progressTrack.setAttribute('aria-valuenow', '0');
}

function setProgress(value) {
  if (value === null) {
    elements.progressFill.style.width = '35%';
    elements.uploadPercent.textContent = '...';
    elements.uploadStatus.textContent = 'Uploading';
    return;
  }

  const percent = Math.max(0, Math.min(100, Math.round(value)));
  elements.progressFill.style.width = `${percent}%`;
  elements.progressTrack.setAttribute('aria-valuenow', String(percent));
  elements.uploadPercent.textContent = `${percent}%`;
  elements.uploadStatus.textContent =
    percent >= 100 ? 'Saving...' : 'Uploading';
}

function uploadFile(file, session) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    upload.xhr = xhr;
    let finished = false;

    const finish = (result) => {
      if (finished) return;
      finished = true;
      if (upload.xhr === xhr) upload.xhr = null;
      resolve(result);
    };

    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('X-Easy-Drop', '1');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.setRequestHeader(
      'X-File-Type',
      file.type || 'application/octet-stream',
    );
    xhr.setRequestHeader(
      'Content-Type',
      file.type || 'application/octet-stream',
    );

    xhr.upload.onprogress = (event) => {
      if (session !== upload.session) return;
      if (event.lengthComputable) {
        setProgress((event.loaded / event.total) * 100);
      } else {
        setProgress(null);
      }
    };

    xhr.onload = () => {
      if (session !== upload.session) {
        finish({ aborted: true });
        return;
      }

      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // The status code is enough when the response is not JSON.
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        finish({ ok: true });
      } else {
        finish({
          error:
            data?.error || `Upload failed with status ${xhr.status}.`,
        });
      }
    };

    xhr.onerror = () =>
      finish({ error: 'Connection lost while uploading.' });
    xhr.onabort = () => finish({ aborted: true });
    xhr.ontimeout = () =>
      finish({ error: 'The upload timed out. Please try again.' });

    xhr.send(file);
  });
}

async function startQueue() {
  if (upload.active || upload.queue.length === 0) return;

  upload.active = true;
  const session = ++upload.session;
  let sent = 0;
  let failed = 0;

  while (session === upload.session) {
    const file = upload.queue.shift();
    if (!file) break;

    showUploadFile(file);
    const result = await uploadFile(file, session);

    if (session !== upload.session) return;
    if (result.aborted) return;

    if (result.ok) {
      sent += 1;
      await refreshState(true);
    } else {
      failed += 1;
      showToast(result.error || `Could not send ${file.name}.`, 'error');
    }
  }

  if (session !== upload.session) return;

  upload.active = false;

  const complete = failed === 0;
  elements.uploadPanel.classList.toggle('is-complete', complete);
  elements.uploadPanel.classList.toggle('is-error', !complete && sent === 0);
  elements.uploadName.textContent =
    sent > 0
      ? `${sent} ${sent === 1 ? 'file' : 'files'} sent`
      : 'Upload failed';
  elements.uploadQueue.textContent = '';
  elements.uploadStatus.textContent = complete
    ? 'Complete'
    : sent > 0
      ? 'Finished with errors'
      : 'Could not upload';
  elements.uploadPercent.textContent = complete ? '100%' : '';
  elements.progressFill.style.width = complete ? '100%' : '0%';
  elements.progressTrack.setAttribute(
    'aria-valuenow',
    complete ? '100' : '0',
  );

  window.setTimeout(
    () => {
      if (
        upload.session === session &&
        !upload.active &&
        upload.queue.length === 0
      ) {
        hideUploadPanel();
      }
    },
    complete ? 1400 : 2800,
  );
}

function hideUploadPanel() {
  elements.uploadPanel.hidden = true;
  elements.uploadPanel.classList.remove('is-complete', 'is-error');
  elements.progressFill.style.width = '0%';
  elements.progressTrack.setAttribute('aria-valuenow', '0');
}

function cancelUpload() {
  if (!upload.active) {
    hideUploadPanel();
    return;
  }

  upload.session += 1;
  upload.queue.length = 0;
  upload.active = false;

  if (upload.xhr) {
    upload.xhr.abort();
    upload.xhr = null;
  }

  hideUploadPanel();
  showToast('Upload cancelled');
  refreshState(true);
}

async function deleteFile(id, button) {
  const file = state.files.find((entry) => entry.id === id);
  if (!file) return;
  if (!window.confirm(`Delete "${file.name}" from the drop?`)) return;

  button.disabled = true;

  try {
    const response = await fetch(
      `/api/files/${encodeURIComponent(id)}`,
      {
        method: 'DELETE',
        headers: { 'X-Easy-Drop': '1' },
      },
    );

    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw new Error(data?.error || 'Could not delete the file.');
    }

    showToast('File deleted');
    await refreshState(true);
  } catch (error) {
    button.disabled = false;
    showToast(error.message || 'Could not delete the file.', 'error');
  }
}

async function clearAllFiles() {
  if (state.files.length === 0) return;

  const message =
    state.files.length === 1
      ? 'Delete this file from the drop?'
      : `Delete all ${state.files.length} files from the drop?`;

  if (!window.confirm(message)) return;

  elements.clearAll.disabled = true;

  try {
    const response = await fetch('/api/files', {
      method: 'DELETE',
      headers: { 'X-Easy-Drop': '1' },
    });

    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw new Error(data?.error || 'Could not clear the files.');
    }

    showToast('All files deleted');
    await refreshState(true);
  } catch (error) {
    showToast(error.message || 'Could not clear the files.', 'error');
  } finally {
    elements.clearAll.disabled = state.files.length === 0;
  }
}

function bindEvents() {
  elements.sendButton.addEventListener('click', (event) => {
    event.stopPropagation();
    openFilePicker();
  });

  elements.dropzone.addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    openFilePicker();
  });

  elements.fileInput.addEventListener('change', () => {
    queueFiles(elements.fileInput.files);
    elements.fileInput.value = '';
  });

  for (const type of ['dragenter', 'dragover']) {
    elements.dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      elements.dropzone.classList.add('is-dragging');
    });
  }

  elements.dropzone.addEventListener('dragleave', (event) => {
    if (!elements.dropzone.contains(event.relatedTarget)) {
      elements.dropzone.classList.remove('is-dragging');
    }
  });

  elements.dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    elements.dropzone.classList.remove('is-dragging');
    queueFiles(event.dataTransfer?.files);
  });

  document.addEventListener('dragover', (event) => {
    event.preventDefault();
  });

  document.addEventListener('drop', (event) => {
    if (!elements.dropzone.contains(event.target)) {
      event.preventDefault();
      elements.dropzone.classList.remove('is-dragging');
    }
  });

  elements.cancelUpload.addEventListener('click', cancelUpload);
  elements.copyAddress.addEventListener('click', async () => {
    if (!state.selectedUrl) return;

    try {
      await copyText(state.selectedUrl);
      showToast('Address copied');
    } catch {
      showToast('Could not copy. Type the address manually.', 'error');
    }
  });

  elements.fileList.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-delete]');
    if (!button) return;
    event.preventDefault();
    deleteFile(button.dataset.delete, button);
  });

  elements.clearAll.addEventListener('click', clearAllFiles);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshState(true);
  });
}

function init() {
  bindEvents();
  refreshState(false);

  window.setInterval(() => {
    if (!document.hidden) refreshState(true);
  }, 3000);
}

init();
