# 🛡️ Tournament Anti-Cheat

A consent-based anti-cheat system for esports tournaments:

- **Agent EXE** (C# WPF + WebView2) — runs a ~60 second deep scan on the player's PC and uploads the report.
- **Portal** (Node.js + SQLite) — a localhost *Liquid Glass* dashboard for sessions, scan reports and system logs.

> **Scope:** this tool is an anti-cheat *scanner*, not surveillance software.
> It does **not** log keystrokes, screenshots, files, browsing history or USB devices.
> The player sees a consent screen listing exactly what is scanned before anything runs.

---

## ✨ What the agent scans

| Check | What it detects |
|---|---|
| **Processes** | Known cheat / debug tools running (Cheat Engine, x64dbg, Process Hacker, Frida, …) |
| **Debugger** | 6 primitives: `IsDebuggerPresent`, `CheckRemoteDebuggerPresent`, `ProcessDebugPort/Flags/ObjectHandle`, managed attach |
| **EXE / DLL files** | Deep scan of Downloads, temp folders, Program Files, AppData — flags known cheat binaries, temp droppers, unsigned executables (Authenticode via `WinVerifyTrust`) |
| **Game modules** | Loaded DLLs inside the game process — injected / third-party libraries, remote debugger attached to the game |
| **Antivirus** | WMI SecurityCenter2 AV products, real-time protection state, Defender policy keys, `WinDefend` service state — catches *disabled antivirus* |
| **Tooling** | Cheat tool folders in install locations, BYOVD-style cheat-abuse drivers (`winio64.sys`, `winring0.sys`, …) |
| **Integrity** | Game executable SHA-256 fingerprint for server-side comparison |

**PC forensic profile** (`PcProfileScanner`, shown as *PC Information* + *PC Activity* in the report):

| Check | Details |
|---|---|
| **Boot / BIOS** | Last boot time + uptime, BIOS vendor/version, board product/manufacturer, boot-manager entry (`bootmgfw.efi` / `bootmgr` / `winload.efi`) with SHA-256 prefix |
| **Windows** | Install date, build/release (registry), GPU + VRAM (WMI) |
| **Network** | VPN adapter keyword match (WMI), country + public IP (`ipapi.co`, 4s timeout) |
| **Files** | Recycle-bin age, executables written in Downloads/Temp/AppData in the last 72h (capped) |
| **Accounts** | Local accounts, Guest enabled?, current user admin? |
| **Recording** | OBS / Bandicam / Fraps / XSplit / Action! / Dxtory / Medal / RTSS / Afterburner running |
| **PowerShell** | Command history tail + Event-Log 4104 script-block log, strong/weak pattern tiers |
| **Focused window** | Foreground window title at scan time (z-order walk, own window skipped) |
| **AI opinion** | Deterministic narrative summarizing the weighted findings (weight 0, added after scoring) |

**Verdict scoring:** `critical=25 · high=12 · medium=5 · low=1`
→ `score ≥ 25 = detected`, `≥ 5 = suspicious`, otherwise `clean`.

## 📑 Report layout

Each uploaded report opens in the portal (Ocean-style sections):

- **Hero** — verdict badge, risk score, player / session / game
- **PC Information** — forensic metrics (boot time, VPN, recycle age, country, GPU, accounts, window text, …)
- **Logs rail** — `Overview` · `EXE files` · `DLL files` · `Processes` · `Engines` · `Other checks` · `AI Opinion`
- **PC Activity rail** — `Boot Sequence` (BIOS cells + boot entry hash) · `Files Activity` (recent executables) · `Accounts` · `Recording Software`

Every flagged file shows its full path, size, signature status and the reason it was flagged.

## 🌊 Portal (Ocean Anti-Cheat clone)

| Group | Pages |
|---|---|
| **Services** | Scanner → **Pins** (My Pins table + Ocean *Create New Pin* modal: game grid, Private toggle, RUIN/ÆGIR/RÁN engine tiers, validity) · **Detections** (client-side analyzer: String Extractor / Presence / Suspicious / Lua + Marketplace, files never leave the browser) · **Reports** |
| **Services ▸ Database** | Statistics · Query User — *DB Access required* paywall |
| **Services ▸ Anti-Cheat** | 👀 easter egg |
| **Support** | Tickets (statuses + priority) · Chat (*Portal Assistant*, rule-based bot, prompt chips) |
| **Others ▸ Resources** | Leaderboard (podium + per-player scan stats) · Documentation · Pricing · **Download** (serves the agent EXE) · ToS · Privacy · Legal · Changelogs |
| **Sidebar foot** | System Log (live event feed with level/source filters) |

---

## 🚀 Quick start

### 1. Start the portal (localhost)

```powershell
cd portal
npm install     # first time only
npm start       # → http://127.0.0.1:3000
```

### 2. Create a session

Open `http://127.0.0.1:3000` → **Create Pin** → pick a game (Free Fire, Valorant, PUBG Mobile, …),
optionally set the pin private → the portal generates a **PIN** like `K7F2-9QXA`.

### 3. Give the player the EXE + PIN

```powershell
agent\AntiCheatAgent\bin\Release\net8.0-windows\AntiCheatAgent.exe
```

The player enters the PIN → reviews the consent screen → watches the animated scan →
the report uploads and the app auto-closes.

### 4. Watch it land in the dashboard

**Scan Reports** shows the verdict; click a row to open the tabbed report.

---

## ⚙️ Agent options

```
--pin ABCD-1234      session PIN (skips the PIN screen)
--portal URL         portal address (default http://127.0.0.1:3000)
--player "Name"      player display name
--min-seconds N      minimum visible scan time (default 60)
--auto               unattended mode: launching with this flag counts as
                     operator consent and runs the scan without clicking
```

A config file `agent.config.json` next to the EXE also works:

```json
{
  "portalUrl": "http://127.0.0.1:3000",
  "pin": "",
  "playerName": "",
  "autoCloseSeconds": 4,
  "minScanSeconds": 60
}
```

Environment variable `ANTICHEAT_PORTAL` overrides the portal address.

---

## 📁 Project structure

```
anti cheat exe/
├── portal/                  # Node.js + Express + node:sqlite
│   ├── server.js            # API + static dashboard
│   ├── db.js                # schema, sessions, reports, events
│   ├── data/portal.db       # SQLite database (auto-created)
│   └── public/              # Liquid Glass dashboard (HTML/CSS/JS)
└── agent/                   # C# WPF (.NET 8) + WebView2
    └── AntiCheatAgent/
        ├── Services/        # scanners, AV checker, API client, orchestrator
        ├── Models/          # Finding model + severities
        └── wwwroot/         # animated loader UI (HTML/CSS/JS)
```

## 🔌 API (portal)

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/agent/validate` | agent checks a session PIN |
| POST | `/api/agent/report` | agent uploads a scan report |
| GET | `/api/stats` | dashboard overview counters |
| GET/POST | `/api/sessions` | list / create sessions (`visibility: public\|private`) |
| POST | `/api/sessions/:id/active` | pause / activate |
| POST | `/api/sessions/:id/visibility` | toggle Public / Private |
| DELETE | `/api/sessions/:id` | delete session + its reports |
| GET/DELETE | `/api/reports[/:id]` | list / fetch / delete reports |
| GET/POST | `/api/detections` | save / list detection analyzer results |
| DELETE | `/api/detections/:id` | delete a detection result |
| GET/POST | `/api/tickets` | list / create support tickets |
| POST | `/api/tickets/:id/status` | update ticket status |
| GET/POST/DELETE | `/api/chat` | chat history, message (+ assistant reply), clear |
| GET | `/api/events` | portal system log (`?excludeType=http`) |
| GET | `/download/agent` | serves `AntiCheatAgent.exe` to players |

---

## 📦 Distributing the agent to players

The Download page serves **`TournamentAntiCheat-Agent.zip`** — a self-contained
build (no .NET install needed). Players: extract the ZIP → run
`AntiCheatAgent.exe`. Only **WebView2 Runtime** is required (preinstalled with
Edge on Windows 11 and most Win10 machines; otherwise install "WebView2
Evergreen Runtime" from Microsoft).

1. **Unsigned EXE warnings** — Windows SmartScreen / Defender will warn on an unsigned
   binary that opens a network connection. Options:
   - Sign the EXE with a code-signing certificate (recommended for real tournaments), or
   - Have players click *More info → Run anyway*, or
   - Distribute through your tournament platform with instructions.
2. **Local use** — by default the portal binds to `127.0.0.1` only: it is not
   exposed to the network.

## 🌍 Public deployment (24/7, free)

See **[DEPLOY.md](DEPLOY.md)** — step-by-step guide for hosting the portal on
the **Oracle Cloud Always Free** tier (real server, SQLite data persists,
free for life).

Summary of the environment switches:

| Variable | Local (default) | Public server |
|---|---|---|
| `HOST` | `127.0.0.1` | `0.0.0.0` |
| `PORT` | `3000` | `3000` |
| `ADMIN_PASSWORD` | unset → no login | **required** → HTTP Basic auth on dashboard + API |
| `AGENT_FILE` | auto-detected | path to the agent ZIP, if stored elsewhere |

The agent API (`/api/agent/*`) stays open in both modes — it is gated by
session PINs.

## 🔒 Design commitments

- The agent never hides: it shows a window, a progress percentage and a result.
- The consent screen states exactly what is and is not collected.
- No keylogging, no file contents, no screenshots, no USB/file-deletion logging.
- All signatures used for detection are public, well-known tool names.

## 🧪 Testing

```powershell
# create a pin, then run unattended with a short window:
AntiCheatAgent.exe --pin XXXX-XXXX --portal http://127.0.0.1:3000 --auto --min-seconds 10
```

## 📦 Publishing the agent ZIP

The Download page serves a self-contained build (players need no .NET):

```powershell
dotnet publish agent\AntiCheatAgent\AntiCheatAgent.csproj -c Release -r win-x64 `
  --self-contained true -p:PublishSingleFile=true -o agent\publish
# zip the publish folder (skip *.pdb / *.xml) → portal\agent\TournamentAntiCheat-Agent.zip
```

## 🗺️ Roadmap ideas

- Player-side scan history and re-scan
- Code-signed agent builds + SHA pinning
- Live scanning while the game runs (tray mode)
- Webhook / Discord alerts on `detected` verdicts
