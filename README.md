# Easy Drop

A temporary file and text drop you can open from any phone, tablet, or
computer. Run it on one machine, share the address or public link, and every
device sees the same drop: send files on one device, then download them on
another. You can also keep shared text notes that sync to every device.

- Works on your local network without an internet connection.
- Creates a temporary public link through a Cloudflare tunnel, so devices on
  other networks can join too.
- Shared text notes save automatically and appear on every device.
- No accounts, no build step, and no npm dependencies.
- Files and notes are temporary and deleted when the app stops.

## Requirements

- [Node.js](https://nodejs.org) 18 or newer (Windows, macOS, or Linux).
- Internet access only if you want the public link.

## Quick start

On Windows, double-click **`start.bat`**. If Windows Firewall asks, allow
Node.js on **Private networks**.

From a terminal:

```powershell
npm start        # Easy Drop plus a public link
npm run lan      # LAN only, no tunnel
```

The terminal prints the local addresses and the public link, and the browser
opens automatically. Keep the window open while transferring. Press **Ctrl+C**
to stop; the temporary files are removed.

## Public link

`start.bat` runs Easy Drop and a Cloudflare quick tunnel.

- The first run downloads `cloudflared` once (about 60 MB) into `.tools/`.
  Later runs reuse it.
- The link looks like `https://something-random.trycloudflare.com`. It is
  random, temporary, and only works while this app is running.
- Anyone with the link can open the page, upload, and download. Share it only
  with people you trust.
- Cloudflare limits each upload to about **100 MB** over the public link. For
  larger files, use the LAN address printed in the terminal.
- The page shows the public link and its QR code to visitors coming through the
  tunnel, and the LAN address to devices on the same network.

Choose the tunnel mode with the `TUNNEL` variable:

| Value         | Behaviour                                              |
| ------------- | ------------------------------------------------------ |
| `auto`        | Cloudflare tunnel, falls back to localtunnel (default) |
| `cloudflared` | Cloudflare tunnel only                                 |
| `localtunnel` | localtunnel only (no download, may ask for a password) |
| `off`         | LAN only, no public link                               |

```powershell
set TUNNEL=off && start.bat
```

When using localtunnel, visitors may be asked for a password. Open
<https://loca.lt/mytunnelpassword> on the machine running Easy Drop to see it.

## How to use

- Click **Send files** (or drop files) on any device.
- Files appear in the shared **Files** list for every connected device.
- Tap **Download** next to a file to save it.
- **Clear all** removes the current drop immediately.

### Shared text

- Click **New** in the **Shared text** card to add a note.
- Paste or type; the note saves automatically about a second after you stop
  typing, and other devices see it within a few seconds.
- **Copy** puts a note on your clipboard; the trash button deletes it for
  everyone.
- You can keep up to 50 notes, with 20,000 characters per note.
- Notes are temporary and live only while Easy Drop is running.

Files are stored in a temporary folder and deleted when Easy Drop stops. Any
leftover temporary folder is also removed the next time it starts.

## Configuration

| Variable          | Default | Purpose                                          |
| ----------------- | ------- | ------------------------------------------------ |
| `PORT`            | `3000`  | HTTP port                                        |
| `HOST`            | `0.0.0.0` | Network interface to bind                      |
| `MAX_FILE_MB`     | `5120`  | Per-file upload limit in MB                      |
| `TUNNEL`          | `auto`  | `auto`, `cloudflared`, `localtunnel`, or `off`   |
| `NO_OPEN`         | unset   | Set to `1` to stop the browser from opening      |
| `CLOUDFLARED_PATH`| unset   | Use a specific `cloudflared` binary              |
| `DEBUG_TUNNEL`    | unset   | Set to `1` to show raw tunnel logs               |

```powershell
$env:PORT = "3001"
$env:MAX_FILE_MB = "10240"
npm start
```

## Project structure

```
easy-drop/
  server.js     HTTP server, upload/download API, temporary storage
  tunnel.js     Starts the server and the public tunnel
  start.bat     Windows launcher
  public/       Web interface (HTML, CSS, JavaScript, QR renderer)
  .tools/       Downloaded cloudflared binary (created at runtime)
```

## Security and privacy

- There is no login. Anyone who can reach the address or public link can upload
  and download while the app is running.
- Over the LAN, traffic goes directly between devices. With the public link,
  traffic passes through the Cloudflare tunnel. Files still live only in a
  temporary folder on the machine running Easy Drop.
- Do not run it on a network you do not trust.

## Troubleshooting

- **Port already in use:** start with another port, for example
  `$env:PORT = "3001"; .\start.bat` in PowerShell.
- **Public link shows an error right after starting:** wait a few seconds; the
  tunnel can take a moment to become reachable.
- **Large upload fails over the public link:** the Cloudflare tunnel caps each
  upload at about 100 MB. Use the LAN address for bigger files.
- **Phones cannot reach the LAN address:** allow Node.js on private networks in
  Windows Firewall, and avoid guest Wi-Fi networks that isolate clients.
