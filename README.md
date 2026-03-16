# GO Shelf

A self-hosted web app for browsing your GOG library and downloading Windows installers, DLC, and extras directly to your home server or NAS.

**Features**

- Browse your full GOG library in a card or list view
- Sort by name, release year, or installer size
- Filter by category or toggle "not downloaded" to see what's missing
- Download installers, DLC, and extras with a live progress queue
- Batch-queue all installers for a game in one click
- Scan your collection to see total size and per-game installer sizes
- Check for game updates — detects new installer versions and highlights changed games
- MD5 checksum verification of downloaded files
- Dark theme, keyboard-friendly

---

## Quick start (Docker — recommended)

Docker handles all native dependencies automatically.

```bash
git clone https://github.com/your-username/go-shelf.git
cd go-shelf
cp .env.example .env
# Edit .env — at minimum set DOWNLOAD_DIR to where you want files saved
docker compose up -d
```

Then open [http://localhost:3000](http://localhost:3000) and sign in with your GOG account.

### docker-compose volumes

| Volume | Purpose |
|--------|---------|
| `./data` | SQLite database and auth tokens — keep this persistent |
| `DOWNLOAD_DIR` (left side) | Where installers are saved — point this at your NAS or drive |

---

## Manual install

### Prerequisites

- **Node.js 18+**
- **Python 3** and **C++ build tools** — required to compile `better-sqlite3`

**Debian/Ubuntu:**
```bash
sudo apt-get install python3 make g++
```

**macOS:**
```bash
xcode-select --install
```

**Windows:** Install [Python 3](https://python.org) and the "Desktop development with C++" workload from Visual Studio.

### Install

```bash
git clone https://github.com/your-username/go-shelf.git
cd go-shelf
npm install
cp .env.example .env
# Edit .env to configure your download directory and server address
npm start
```

Open [http://localhost:3000](http://localhost:3000).

---

## Configuration

All configuration is via environment variables (or a `.env` file).

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Port the web server listens on |
| `HOST` | `http://localhost:3000` | Public URL of your server — shown after login, used in logs |
| `DOWNLOAD_DIR` | `./data/downloads` | Where installers are saved |
| `DB_PATH` | `./data/go-shelf.db` | SQLite database path |
| `BASIC_AUTH` | *(none)* | Optional HTTP basic auth — set to `username:password` to protect the UI |

> **Security note:** GO Shelf has no built-in authentication beyond GOG's OAuth flow. If you expose it beyond localhost (e.g. on a home network or via a reverse proxy), set `BASIC_AUTH` to prevent unauthorized access to the download queue and stored tokens.

---

## Signing in to GOG

GO Shelf uses GOG's Galaxy client credentials, which require a manual auth flow:

1. Click **Sign in with GOG** — this opens GOG's login page in a new tab
2. Log in to your GOG account
3. After login, GOG redirects you to a page that may appear blank or show an error — **copy the full URL from your browser's address bar**
4. Paste it into the field on the GO Shelf login screen and click **Connect**

You only need to do this once. The app stores and auto-refreshes your tokens.

---

## Running as a systemd service (Linux)

```bash
# Copy the app to /opt
sudo cp -r . /opt/go-shelf

# Create a dedicated user
sudo useradd -r -s /bin/false go-shelf
sudo chown -R go-shelf:go-shelf /opt/go-shelf

# Copy the service file
sudo cp contrib/go-shelf.service /etc/systemd/system/

# Configure environment
sudo cp /opt/go-shelf/.env.example /opt/go-shelf/.env
sudo nano /opt/go-shelf/.env

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable --now go-shelf
sudo journalctl -u go-shelf -f
```

---

## CLI

GO Shelf includes a basic CLI for scripting and headless use.

```bash
node cli/index.js --help

# Commands
node cli/index.js login          # Authenticate (opens browser)
node cli/index.js list           # List your library
node cli/index.js info <id>      # Show game details and download links
node cli/index.js download <id>  # Queue a game for download
node cli/index.js queue          # Show download queue
```

---

## Notes

- GO Shelf uses the same community client credentials as [lgogdownloader](https://github.com/Sude-/lgogdownloader) and [Heroic Games Launcher](https://github.com/Heroic-Games-Launcher/HeroicGamesLauncher). These are well-known and widely used.
- All downloads go through GOG's official CDN using your authenticated session.
- No data is sent anywhere other than GOG's servers.

---

## License

MIT — see [LICENSE](LICENSE).
