'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { spawn, spawnSync, exec } = require('node:child_process');

const APP_DIR = __dirname;
const APP_NAME = 'Easy Drop';
const MODE = String(process.env.TUNNEL || 'auto').trim().toLowerCase();
const OPEN_BROWSER =
  process.env.NO_OPEN !== '1' && !process.argv.includes('--no-open');
const TOOLS_DIR = path.join(APP_DIR, '.tools');
const CLOUDFLARED_PATH = path.join(TOOLS_DIR, 'cloudflared.exe');
const DOWNLOAD_URLS = {
  x64: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
  arm64:
    'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-arm64.exe',
  ia32: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-386.exe',
};

process.env.NO_OPEN = '1';
process.env.LAN_DROP_EMBEDDED = '1';

const lanDrop = require('./server.js');

const children = new Set();
let stopping = false;
let publicUrl = '';

function track(child) {
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

function stopChildren() {
  for (const child of children) {
    try {
      if (process.platform === 'win32' && child.pid) {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } else {
        child.kill('SIGTERM');
      }
    } catch {
      // The process is already gone.
    }
  }

  children.clear();
}

async function shutdownServer(signal) {
  if (stopping) return;
  stopping = true;

  if (publicUrl) console.log('  Closing the public link...');
  stopChildren();

  await lanDrop.shutdown(signal);
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

function findInstalledCloudflared() {
  if (process.env.CLOUDFLARED_PATH) {
    return fs.existsSync(process.env.CLOUDFLARED_PATH)
      ? process.env.CLOUDFLARED_PATH
      : '';
  }

  if (fs.existsSync(CLOUDFLARED_PATH)) return CLOUDFLARED_PATH;

  const result = spawnSync(
    process.platform === 'win32' ? 'where' : 'which',
    ['cloudflared'],
    { encoding: 'utf8', windowsHide: true },
  );

  if (result.status === 0) {
    const line = String(result.stdout || '')
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find((entry) => entry && fs.existsSync(entry));

    if (line) return line;
  }

  return '';
}

function download(url, destination, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) {
      reject(new Error('Too many redirects while downloading cloudflared.'));
      return;
    }

    const target = new URL(url);
    const client = target.protocol === 'http:' ? http : https;

    const request = client.get(
      target,
      { headers: { 'User-Agent': 'easy-drop' } },
      (response) => {
        const { statusCode = 0, headers } = response;

        if (
          statusCode >= 300 &&
          statusCode < 400 &&
          headers.location
        ) {
          response.resume();
          const next = new URL(headers.location, target).toString();
          resolve(download(next, destination, redirects + 1));
          return;
        }

        if (statusCode !== 200) {
          response.resume();
          reject(
            new Error(`Download failed with HTTP ${statusCode}.`),
          );
          return;
        }

        const total = Number(headers['content-length']) || 0;
        let received = 0;
        let lastShown = -10;

        const output = fs.createWriteStream(destination);

        response.on('data', (chunk) => {
          received += chunk.length;

          if (!total) return;

          const percent = Math.floor((received / total) * 100);
          if (percent >= lastShown + 10) {
            lastShown = percent;
            process.stdout.write(
              `\r  Downloading cloudflared... ${percent}%`,
            );
          }
        });

        response.on('error', reject);
        output.on('error', reject);
        output.on('finish', () => {
          if (total) process.stdout.write('\n');
          resolve();
        });

        response.pipe(output);
      },
    );

    request.on('error', reject);
    request.setTimeout(120000, () => {
      request.destroy(new Error('The cloudflared download timed out.'));
    });
  });
}

async function ensureCloudflared() {
  const installed = findInstalledCloudflared();
  if (installed) return installed;

  const downloadUrl = DOWNLOAD_URLS[process.arch];
  if (process.platform !== 'win32' || !downloadUrl) {
    throw new Error(
      'cloudflared is not installed. Install it from ' +
        'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
    );
  }

  fs.mkdirSync(TOOLS_DIR, { recursive: true });

  const partialPath = `${CLOUDFLARED_PATH}.download`;
  console.log('');
  console.log(
    '  cloudflared is missing. Downloading it once (about 60 MB)...',
  );

  try {
    await download(downloadUrl, partialPath);
    fs.rmSync(CLOUDFLARED_PATH, { force: true });
    fs.renameSync(partialPath, CLOUDFLARED_PATH);
    return CLOUDFLARED_PATH;
  } catch (error) {
    fs.rmSync(partialPath, { force: true });
    throw error;
  }
}

function lastMeaningfulLine(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\u001b\[[0-9;]*m/g, '').trim())
    .filter(Boolean)
    .pop();
}

function watchForUrl(child, pattern, label, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;

    const finish = (error, url) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (error) reject(error);
      else resolve(url);
    };

    const onData = (chunk) => {
      buffer += chunk.toString();

      if (process.env.DEBUG_TUNNEL === '1') process.stdout.write(chunk);

      const match = buffer.match(pattern);
      if (match) finish(null, match[0]);
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.once('error', (error) => {
      finish(new Error(`Could not start ${label}: ${error.message}`));
    });

    child.once('exit', (code) => {
      const detail = lastMeaningfulLine(buffer);
      finish(
        new Error(
          `${label} stopped before creating a link (exit code ${code ?? 'unknown'})` +
            (detail ? `: ${detail}` : '.'),
        ),
      );
    });

    const timer = setTimeout(() => {
      finish(new Error(`Timed out waiting for the ${label} link.`));
    }, timeoutMs);
    timer.unref();
  });
}

function warnOnUnexpectedExit(child, label) {
  child.once('exit', (code) => {
    if (stopping) return;

    console.error(
      `\n  The public link closed unexpectedly (${label} exit code ${code ?? 'unknown'}).`,
    );
    console.error('  Easy Drop is still available on the local network.\n');
  });
}

function startCloudflared(binary) {
  const port = lanDrop.getPort();
  const child = track(
    spawn(
      binary,
      [
        'tunnel',
        '--url',
        `http://localhost:${port}`,
        '--no-autoupdate',
        '--loglevel',
        'info',
      ],
      {
        cwd: APP_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    ),
  );

  warnOnUnexpectedExit(child, 'cloudflared');

  return watchForUrl(
    child,
    /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i,
    'cloudflared',
    45000,
  ).then((url) => ({ url, provider: 'cloudflared' }));
}

function startLocaltunnel() {
  const port = lanDrop.getPort();
  const command = [
    'npx',
    '--yes',
    'localtunnel',
    '--port',
    String(port),
  ];

  const child = track(
    process.platform === 'win32'
      ? spawn(command.join(' '), {
          cwd: APP_DIR,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          shell: true,
        })
      : spawn(command[0], command.slice(1), {
          cwd: APP_DIR,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
  );

  warnOnUnexpectedExit(child, 'localtunnel');

  return watchForUrl(
    child,
    /https:\/\/[a-z0-9-]+\.loca\.lt/i,
    'localtunnel',
    90000,
  ).then((url) => ({ url, provider: 'localtunnel' }));
}

async function createTunnel() {
  if (MODE === 'off' || MODE === 'none' || MODE === 'lan') {
    console.log('  Public link is off (TUNNEL=off).');
    return { url: '', provider: '' };
  }

  if (MODE === 'localtunnel') {
    console.log('  Starting a localtunnel link...');
    return startLocaltunnel();
  }

  if (MODE !== 'auto' && MODE !== 'cloudflared') {
    throw new Error(
      `Unknown TUNNEL value "${MODE}". Use auto, cloudflared, localtunnel, or off.`,
    );
  }

  try {
    const binary = await ensureCloudflared();
    console.log('  Starting a Cloudflare quick tunnel...');
    return await startCloudflared(binary);
  } catch (error) {
    console.error(`\n  cloudflared failed: ${error.message}`);

    if (MODE === 'cloudflared') throw error;

    console.log('  Falling back to localtunnel...');
    return startLocaltunnel();
  }
}

function printPublicBanner(url, provider) {
  if (!url) {
    console.log('  Other devices can still use the LAN addresses above.');
    console.log('');
    return;
  }

  console.log('');
  console.log('  --------------------------------------------------');
  console.log(`  Public link  ${url}`);
  console.log('  --------------------------------------------------');
  console.log('');
  console.log('  Anyone with this link can open Easy Drop from anywhere.');
  console.log('  The link is temporary and works only while this app runs.');
  console.log('  It can take a few seconds before the link starts working.');

  if (provider === 'cloudflared') {
    console.log(
      '  Cloudflare limits each upload to about 100 MB over this link;',
    );
    console.log('  use the LAN address above for bigger files.');
  } else if (provider === 'localtunnel') {
    console.log(
      '  localtunnel may ask visitors for a password: open',
    );
    console.log('  https://loca.lt/mytunnelpassword on this device to see it.');
  }

  console.log('');
}

async function main() {
  await lanDrop.start();

  console.log('  Preparing the public link...');

  let tunnel = { url: '', provider: '' };

  try {
    tunnel = await createTunnel();
  } catch (error) {
    console.error(`\n  Could not create a public link: ${error.message}`);
    console.log(
      '  Easy Drop is still running for devices on this network.\n',
    );
  }

  publicUrl = tunnel.url;

  if (publicUrl) {
    process.env.LAN_DROP_PUBLIC_URL = publicUrl;
    printPublicBanner(publicUrl, tunnel.provider);

    if (OPEN_BROWSER) {
      openBrowser(publicUrl);
    }
  } else {
    printPublicBanner('', '');
    if (OPEN_BROWSER) openBrowser(`http://localhost:${lanDrop.getPort()}`);
  }

  console.log('  Press Ctrl+C to stop.');
  console.log('');
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    shutdownServer(signal).catch(() => process.exit(1));
  });
}

process.on('exit', lanDrop.removeSessionDir);

main().catch((error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(
      '\nPort is already in use. Close the other app or set PORT first, ' +
        'for example:\n  set PORT=3001 && start.bat\n',
    );
  } else {
    console.error(`\nCould not start ${APP_NAME}:`, error.message);
  }

  lanDrop.removeSessionDir();
  process.exit(1);
});
