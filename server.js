'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { exec } = require('node:child_process');

const APP_NAME = 'Easy Drop';
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const OPEN_BROWSER =
  !process.argv.includes('--no-open') && process.env.NO_OPEN !== '1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_PREFIX = 'easy-drop-session-';
const LEGACY_SESSION_PREFIXES = ['lan-drop-session-'];

const requestedMaxMb = Number.parseFloat(process.env.MAX_FILE_MB);
const MAX_FILE_MB =
  Number.isFinite(requestedMaxMb) && requestedMaxMb > 0
    ? Math.min(requestedMaxMb, 102400)
    : 5120;
const MAX_FILE_BYTES = Math.floor(MAX_FILE_MB * 1024 * 1024);

const files = new Map();
const startedAt = Date.now();
let totalBytes = 0;
let sessionDir = '';
let server = null;
let shuttingDown = false;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; " +
    "script-src 'self'; connect-src 'self'; object-src 'none'; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

const STATIC_FILES = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  [
    '/qrcode.min.js',
    { file: 'qrcode.min.js', type: 'text/javascript; charset=utf-8' },
  ],
  ['/favicon.svg', { file: 'favicon.svg', type: 'image/svg+xml' }],
]);

function prepareStorage() {
  const tempRoot = os.tmpdir();

  for (const entry of fs.readdirSync(tempRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const isSessionDir =
      entry.name.startsWith(SESSION_PREFIX) ||
      LEGACY_SESSION_PREFIXES.some((prefix) =>
        entry.name.startsWith(prefix),
      );

    if (!isSessionDir) continue;

    try {
      fs.rmSync(path.join(tempRoot, entry.name), {
        recursive: true,
        force: true,
        maxRetries: 2,
        retryDelay: 50,
      });
    } catch {
      // A previous session may still be in use. This process uses its own dir.
    }
  }

  sessionDir = fs.mkdtempSync(path.join(tempRoot, SESSION_PREFIX));
}

function removeSessionDir() {
  if (!sessionDir) return;

  try {
    fs.rmSync(sessionDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  } catch {
    // Files still open by the OS are retried on exit and removed next launch.
  }
}

function formatLimit(bytes) {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${Number(gb.toFixed(gb >= 10 ? 0 : 1))} GB`;
  const mb = bytes / (1024 * 1024);
  return `${Number(mb.toFixed(mb >= 10 ? 0 : 1))} MB`;
}

function ipv4Score(address) {
  if (address.startsWith('192.168.')) return 0;
  if (address.startsWith('10.')) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 2;
  return 3;
}

function getLanAddresses() {
  const seen = new Set();
  const addresses = [];

  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (entry.address.startsWith('169.254.')) continue;
      if (seen.has(entry.address)) continue;

      seen.add(entry.address);
      addresses.push({ name, address: entry.address });
    }
  }

  addresses.sort((a, b) => {
    const score = ipv4Score(a.address) - ipv4Score(b.address);
    return score || a.address.localeCompare(b.address);
  });

  return addresses;
}

function requestProtocol(req) {
  const forwarded = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();

  if (forwarded === 'http' || forwarded === 'https') return forwarded;
  return req.socket && req.socket.encrypted ? 'https' : 'http';
}

function isPublicHostname(host) {
  if (!host || !/^[a-z0-9.-]+$/i.test(host)) return false;
  return host !== 'localhost' && !/^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function isLocalHostname(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function getPublicEntry(req, protocol, requestHost, hostHeader) {
  const configured = String(process.env.LAN_DROP_PUBLIC_URL || '').trim();

  if (configured) {
    try {
      return {
        name: 'Public link',
        address: new URL(configured).hostname,
        url: configured,
      };
    } catch {
      // Ignore an invalid public URL and fall back to the request host.
    }
  }

  if (isPublicHostname(requestHost)) {
    return {
      name: 'Public link',
      address: requestHost,
      url: `${protocol}://${hostHeader}`,
    };
  }

  return null;
}

function getNetworkState(req) {
  const port = server.address().port;
  const protocol = requestProtocol(req);
  const hostHeader = String(req.headers.host || '').trim();
  const requestHost = hostHeader.split(':')[0].toLowerCase();

  const addresses = getLanAddresses().map((entry) => ({
    ...entry,
    url: `http://${entry.address}:${port}`,
  }));

  const publicEntry = getPublicEntry(
    req,
    protocol,
    requestHost,
    hostHeader,
  );
  if (publicEntry) addresses.unshift(publicEntry);

  const lanAddresses = addresses.filter((entry) => entry !== publicEntry);
  const requestedAddress = addresses.find(
    (entry) => entry.address === requestHost,
  );

  let preferredUrl;
  if (requestedAddress) {
    preferredUrl = requestedAddress.url;
  } else if (!isLocalHostname(requestHost) && publicEntry) {
    preferredUrl = publicEntry.url;
  } else {
    preferredUrl =
      lanAddresses[0]?.url ||
      publicEntry?.url ||
      `http://localhost:${port}`;
  }

  return { addresses, preferredUrl };
}

function serializeFile(file) {
  return {
    id: file.id,
    name: file.name,
    size: file.size,
    type: file.type,
    createdAt: new Date(file.createdAt).toISOString(),
  };
}

function getAllFiles() {
  return [...files.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(serializeFile);
}

function sendJson(res, status, data, extraHeaders = {}) {
  if (res.writableEnded || res.destroyed) return;

  const body = JSON.stringify(data);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function sendText(res, status, message) {
  if (res.writableEnded || res.destroyed) return;

  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(message),
    'Cache-Control': 'no-store',
  });
  res.end(message);
}

function cleanFileName(rawName) {
  let name = typeof rawName === 'string' ? rawName : '';

  try {
    name = decodeURIComponent(name);
  } catch {
    // Keep the raw value if it is not valid percent-encoding.
  }

  name = name.replace(/\\/g, '/').split('/').pop() || '';
  name = name.replace(/[\u0000-\u001f\u007f]/g, '').trim();

  if (!name) name = 'file';

  if (name.length > 180) {
    const dot = name.lastIndexOf('.');
    const extension =
      dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
    name = name.slice(0, 180 - extension.length) + extension;
  }

  return name;
}

function cleanMimeType(rawType) {
  if (typeof rawType !== 'string') return 'application/octet-stream';

  const type = rawType.split(';')[0].trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(
    type,
  )
    ? type
    : 'application/octet-stream';
}

function contentDisposition(fileName) {
  const fallback =
    fileName
      .normalize('NFKD')
      .replace(/[^\x20-\x7e]/g, '_')
      .replace(/["\\]/g, '_') || 'download';

  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

async function handleUpload(req, res) {
  if (req.headers['x-easy-drop'] !== '1') {
    req.resume();
    sendJson(res, 403, { error: 'Missing Easy Drop request header.' });
    return;
  }

  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_FILE_BYTES) {
    req.resume();
    sendJson(res, 413, {
      error: `File is too large. The limit is ${formatLimit(MAX_FILE_BYTES)}.`,
    });
    return;
  }

  const id = crypto.randomUUID();
  const fileName = cleanFileName(req.headers['x-file-name']);
  const mimeType = cleanMimeType(req.headers['x-file-type']);
  const partPath = path.join(sessionDir, `${id}.part`);
  const finalPath = path.join(sessionDir, id);

  let writeStream;
  try {
    writeStream = fs.createWriteStream(partPath, { flags: 'wx' });
  } catch {
    req.resume();
    sendJson(res, 500, { error: 'Could not create the temporary file.' });
    return;
  }

  let settled = false;
  let size = 0;

  const removePart = () => {
    fsp.rm(partPath, { force: true }).catch(() => {});
  };

  const fail = (status, message) => {
    if (settled) return;
    settled = true;
    writeStream.destroy();
    writeStream.once('close', removePart);
    removePart();
    req.resume();

    if (!res.headersSent && !res.destroyed) {
      sendJson(res, status, { error: message });
    }
  };

  const abort = () => {
    if (settled) return;
    settled = true;
    writeStream.destroy();
    writeStream.once('close', removePart);
    removePart();
  };

  req.on('data', (chunk) => {
    if (settled) return;

    size += chunk.length;
    if (size > MAX_FILE_BYTES) {
      fail(
        413,
        `File is too large. The limit is ${formatLimit(MAX_FILE_BYTES)}.`,
      );
      return;
    }

    if (!writeStream.write(chunk)) {
      req.pause();
      writeStream.once('drain', () => {
        if (!settled) req.resume();
      });
    }
  });

  req.on('end', () => {
    if (settled) return;

    writeStream.end(async () => {
      if (settled) return;
      settled = true;

      try {
        const stat = await fsp.stat(partPath);
        await fsp.rename(partPath, finalPath);

        const file = {
          id,
          name: fileName,
          size: Number(stat.size),
          type: mimeType,
          createdAt: Date.now(),
          path: finalPath,
        };

        files.set(id, file);
        totalBytes += file.size;
        sendJson(res, 201, { file: serializeFile(file) });
      } catch {
        removePart();
        sendJson(res, 500, { error: 'Could not save the file.' });
      }
    });
  });

  req.on('aborted', abort);
  req.on('close', () => {
    if (!req.complete) abort();
  });
  req.on('error', abort);

  writeStream.on('error', () => {
    if (settled) return;
    settled = true;
    removePart();
    req.resume();
    sendJson(res, 500, { error: 'Could not save the file.' });
  });
}

async function handleDownload(req, res, id) {
  const file = files.get(id);
  if (!file) {
    sendJson(res, 404, { error: 'File not found. It may have been deleted.' });
    return;
  }

  let stat;
  try {
    stat = await fsp.stat(file.path);
  } catch {
    files.delete(id);
    totalBytes = Math.max(0, totalBytes - file.size);
    sendJson(res, 404, { error: 'File not found. It may have been deleted.' });
    return;
  }

  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': file.type,
    'Content-Length': stat.size,
    'Content-Disposition': contentDisposition(file.name),
    'Content-Security-Policy': 'sandbox',
    'Cache-Control': 'no-store',
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const readStream = fs.createReadStream(file.path);
  readStream.on('error', () => res.destroy());
  res.on('close', () => readStream.destroy());
  readStream.pipe(res);
}

async function handleDeleteOne(req, res, id) {
  if (req.headers['x-easy-drop'] !== '1') {
    sendJson(res, 403, { error: 'Missing Easy Drop request header.' });
    return;
  }

  const file = files.get(id);
  if (!file) {
    sendJson(res, 404, { error: 'File not found.' });
    return;
  }

  files.delete(id);
  totalBytes = Math.max(0, totalBytes - file.size);
  await fsp.rm(file.path, { force: true }).catch(() => {});
  sendJson(res, 200, { ok: true });
}

async function handleDeleteAll(req, res) {
  if (req.headers['x-easy-drop'] !== '1') {
    sendJson(res, 403, { error: 'Missing Easy Drop request header.' });
    return;
  }

  const deleted = files.size;
  const paths = [...files.values()].map((file) => file.path);
  files.clear();
  totalBytes = 0;

  await Promise.allSettled(
    paths.map((filePath) => fsp.rm(filePath, { force: true })),
  );

  sendJson(res, 200, { ok: true, deleted });
}

async function handleState(req, res) {
  sendJson(res, 200, {
    app: APP_NAME,
    hostname: os.hostname(),
    startedAt: new Date(startedAt).toISOString(),
    maxFileBytes: MAX_FILE_BYTES,
    totalBytes,
    files: getAllFiles(),
    network: getNetworkState(req),
  });
}

function handleStatic(req, res, entry) {
  const filePath = path.join(PUBLIC_DIR, entry.file);
  let stat;

  try {
    stat = fs.statSync(filePath);
  } catch {
    sendText(res, 404, 'Not found');
    return;
  }

  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': entry.type,
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const readStream = fs.createReadStream(filePath);
  readStream.on('error', () => res.destroy());
  readStream.pipe(res);
}

async function handleRequest(req, res) {
  const requestUrl = new URL(req.url || '/', 'http://easy-drop.local');
  const pathname = requestUrl.pathname;
  const parts = pathname.split('/').filter(Boolean);
  const method = req.method || 'GET';

  if (pathname === '/api/state') {
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, 405, { error: 'Method not allowed.' });
      return;
    }
    await handleState(req, res);
    return;
  }

  if (pathname === '/api/upload') {
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed.' });
      return;
    }
    await handleUpload(req, res);
    return;
  }

  if (parts[0] === 'download' && parts.length === 2) {
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, 405, { error: 'Method not allowed.' });
      return;
    }
    await handleDownload(req, res, parts[1]);
    return;
  }

  if (parts[0] === 'api' && parts[1] === 'files') {
    if (method !== 'DELETE') {
      sendJson(res, 405, { error: 'Method not allowed.' });
      return;
    }

    if (parts.length === 3) {
      await handleDeleteOne(req, res, parts[2]);
      return;
    }

    if (parts.length === 2) {
      await handleDeleteAll(req, res);
      return;
    }
  }

  if (method === 'GET' || method === 'HEAD') {
    const entry = STATIC_FILES.get(pathname);
    if (entry) {
      handleStatic(req, res, entry);
      return;
    }
  }

  if (pathname.startsWith('/api/')) {
    sendJson(res, 404, { error: 'Not found.' });
    return;
  }

  sendText(res, 404, 'Not found');
}

function openBrowser(url) {
  const command =
    process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;

  exec(command, { windowsHide: true }, () => {});
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\nStopping ${APP_NAME} (${signal})...`);
  console.log('Deleting temporary files...');

  const forceExit = setTimeout(() => {
    removeSessionDir();
    process.exit(1);
  }, 4000);
  forceExit.unref();

  const finish = () => {
    removeSessionDir();
    console.log('Temporary files deleted. Bye!');
    process.exit(0);
  };

  if (!server) {
    finish();
    return;
  }

  server.close(finish);
  if (typeof server.closeAllConnections === 'function') {
    server.closeAllConnections();
  }
}

function printBanner() {
  const port = server.address().port;
  const addresses = getLanAddresses();

  console.log('');
  console.log(`  ${APP_NAME} is running`);
  console.log('');
  console.log(`  This device     http://localhost:${port}`);

  if (addresses.length === 0) {
    console.log('  Other devices   No LAN address found. Check your Wi-Fi.');
  } else {
    for (const entry of addresses) {
      console.log(
        `  Other devices   http://${entry.address}:${port}  (${entry.name})`,
      );
    }
  }

  console.log('');
  console.log('  Scan the QR code on the page to open it on a phone or tablet.');
  console.log('  Files are temporary and deleted when you close this app.');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
}

async function start() {
  server = http.createServer((req, res) => {
    handleRequest(req, res).catch(() => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Server error.' });
      } else {
        res.destroy();
      }
    });
  });

  server.on('clientError', (error, socket) => {
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    }
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };

    const onListening = () => {
      server.off('error', onError);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(PORT, HOST);
  });

  prepareStorage();
  printBanner();

  if (OPEN_BROWSER) {
    openBrowser(`http://localhost:${server.address().port}`);
  }
}

if (require.main === module) {
  process.on('exit', removeSessionDir);

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      shutdown(signal);
    });
  }

  start().catch((error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(
        `\nPort ${PORT} is already in use. ` +
          'Close the other app or start with a different PORT, for example:\n' +
          '  set PORT=3001 && node server.js\n',
      );
    } else {
      console.error('\nCould not start Easy Drop:', error.message);
    }

    removeSessionDir();
    process.exit(1);
  });
} else {
  module.exports = {
    start,
    shutdown,
    removeSessionDir,
    getPort: () => (server ? server.address().port : PORT),
  };
}
