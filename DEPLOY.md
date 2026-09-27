# 🌍 Deploy the portal publicly — Oracle Cloud Always Free (24/7, $0)

This guide publishes the portal at a real public URL using Oracle Cloud's
**Always Free** tier. Free for the life of your account — no trial expiry.

**What you get free (2026):**
- 2 × AMD micro VMs (1 GB RAM each) **or** up to 2 ARM cores + 12 GB RAM
- 200 GB storage, 10 TB/month outbound traffic
- A public IP + your own firewall rules

> A credit card is required at signup (identity verification). You are **not
> charged** as long as you stay inside Always Free limits — do **not** click
> "Upgrade to Pay As You Go".

---

## Step 1 — Create the account (≈10 min)

1. Go to <https://www.oracle.com/cloud/free> → **Start for free**.
2. Fill the form, verify email + phone + payment card (verification only).
3. Choose a **home region close to you** (you can't easily change it later).
   If ARM instances show "out of capacity" in your region, pick another region
   when creating the account (e.g. US Midwest / Phoenix / San Jose).

## Step 2 — Create the virtual machine (≈10 min)

1. Oracle home menu → **Compute → Instances → Create instance**.
2. **Image:** Canonical Ubuntu 24.04 (or 22.04) — pick from "Operating system".
3. **Shape:**
   - Best: `VM.Standard.A1.Flex` (ARM) → set **1 OCPU / 6 GB RAM** (plenty).
   - Alternative: `VM.Standard.E2.1.Micro` (AMD, 1 GB RAM) — also free.
   - If the shape shows "Out of capacity", try a different availability domain
     or region — this is the most common free-tier hiccup.
4. **SSH key:** select **"Generate a key pair"**, download the `.pem` private
   key, and **paste the public key** shown (keep the `.pem` — you need it in
   Step 4).
5. Leave boot volume at default (47 GB, free) → **Create**.
6. Wait for the instance state = **Running**, note its **public IP**.

### Open the firewall port

In the instance page → **Virtual cloud network** link → **Default security
list** → **Add ingress rules**:

| Field | Value |
|---|---|
| Source CIDR | `0.0.0.0/0` |
| Destination port | `3000` |

(Skip 80/443 unless you add a reverse proxy later.)

## Step 3 — Upload the portal (≈5 min, from your Windows PC)

Compress the finished portal (everything, including `node_modules`, `data/`
and the agent ZIP — it runs on Linux as-is):

```powershell
cd "C:\Users\Administrator\Documents\anti cheat exe"
Compress-Archive -Path portal -DestinationPath portal-server.zip -Force
```

Copy it to the server (use the public IP and the `.pem` key from Step 2):

```powershell
scp -i $env:USERPROFILE\Downloads\oracle_key.pem portal-server.zip ubuntu@<PUBLIC_IP>:~/
```

## Step 4 — Install Node and start it (≈5 min, on the server)

Connect to the server:

```powershell
ssh -i $env:USERPROFILE\Downloads\oracle_key.pem ubuntu@<PUBLIC_IP>
```

Then inside the SSH session:

```bash
# Node.js 24 LTS (required — the portal uses the built-in node:sqlite)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs unzip

# unpack the portal
unzip -o portal-server.zip -d ~/
cd ~/portal
node -v                 # must print v24.x (or v22.5+)
```

Smoke test it:

```bash
HOST=0.0.0.0 PORT=3000 ADMIN_PASSWORD='ChangeMe_123' node server.js
# → http://0.0.0.0:3000
```

Open `http://<PUBLIC_IP>:3000` in your browser — you should land on the
**login page** (`/login.html`). Sign in with username `admin` and the
`ADMIN_PASSWORD` you set, then you get the dashboard. Ctrl+C stops the smoke test.

## Step 5 — Make it run 24/7 (systemd, auto-restart)

Still on the server:

```bash
sudo tee /etc/systemd/system/anticheat.service > /dev/null <<'EOF'
[Unit]
Description=Anti-cheat Portal
After=network.target

[Service]
WorkingDirectory=/home/ubuntu/portal
Environment=HOST=0.0.0.0
Environment=PORT=3000
Environment=ADMIN_PASSWORD=ChangeMe_123
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
User=ubuntu

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now anticheat
systemctl status anticheat --no-pager | head -5    # should say active (running)
```

It now starts on boot and restarts if it ever crashes. Replace
`ChangeMe_123` with a strong password **before** you finish.

Useful commands:

```bash
sudo systemctl restart anticheat     # restart after updates
sudo journalctl -u anticheat -f      # live logs
```

## Step 6 — Use it

| What | How |
|---|---|
| Dashboard | `http://<PUBLIC_IP>:3000` → redirects to the login page. Username `admin` (or `admin@anything`), password = `ADMIN_PASSWORD` |
| Social sign-in | "Continue with Google / Discord" on the login page — register the redirect URIs first (next section) |
| Share a pin | Create Pin in the dashboard → give players the PIN + the **Download** page link |
| Players run the agent | `AntiCheatAgent.exe --portal http://<PUBLIC_IP>:3000` or edit `agent.config.json` |
| Unattended scan | add `--pin XXXX-XXXX --player "Name" --auto` |

## Step 6b — Google / Discord sign-in (optional but recommended)

The login page also offers **Continue with Google** and **Continue with Discord**.
The OAuth client IDs are already wired into `server.js` (override with
`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `DISCORD_CLIENT_ID` /
`DISCORD_CLIENT_SECRET` env vars). For the sign-in buttons to work against your
public URL, register the redirect URIs with each provider:

| Provider | Where to add the URI |
|---|---|
| Google | [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → your OAuth client → *Authorized redirect URIs* |
| Discord | [Discord Developer Portal](https://discord.com/developers/applications) → your app → OAuth2 → *Redirects* |

Add **both** of these (replace `<PUBLIC_IP>` with your server address, keep
port 3000 unless you put Caddy in front — then use the HTTPS URL):

```
http://<PUBLIC_IP>:3000/auth/google/callback
http://<PUBLIC_IP>:3000/auth/discord/callback
```

While testing locally also add the loopback variants
(`http://127.0.0.1:3000/auth/.../callback` and `http://localhost:3000/auth/.../callback`).
Until the URIs are registered the buttons still open the provider, which will
show a *redirect URI mismatch* error — password login always works regardless.

---

## 🔒 Security notes (read these)

- **The login page (`ADMIN_PASSWORD`) is the only thing standing between the
  internet and your portal.** Pick something long — without it the password
  login falls back to `admin/admin123` and a warning is printed at startup.
- Sign-ins become **30-day session cookies** (stored in the portal database);
  sign out from the user chip in the sidebar. Password attempts are rate-limited
  (10/minute per IP).
- The agent API (`/api/agent/validate|report`) intentionally stays open — it is
  gated by session PINs (the agent cannot answer a browser login prompt).
- Plain HTTP means the password and reports travel unencrypted. Acceptable for
  testing; for real tournaments add **HTTPS** (next section).
- Oracle enforces an **idle-reclaim policy** on Always Free instances — an
  instance that receives zero traffic for a long time may be reclaimed. Keeping
  the dashboard open / occasional scans is normally enough.
- Never mine crypto or proxy traffic on the free tier — that gets accounts
  terminated.

## 🔐 Optional: HTTPS + a domain (free/cheap)

Plain `http://IP:3000` works but is unencrypted. With a domain (any registrar,
~$10/yr) **Caddy** gives automatic HTTPS in ~5 lines:

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/deb.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list > /dev/null
sudo apt-get update && sudo apt-get install -y caddy

sudo tee /etc/caddy/Caddyfile > /dev/null <<'EOF'
scan.yourdomain.com {
    reverse_proxy localhost:3000
}
EOF

sudo systemctl restart caddy
```

Point your domain's DNS **A record** at `<PUBLIC_IP>` first. Then browse
`https://scan.yourdomain.com` and run the agent with
`--portal https://scan.yourdomain.com`.

## 🔄 Updating later

```powershell
# from Windows — rebuild the portal package and re-upload
Compress-Archive -Path portal -DestinationPath portal-server.zip -Force
scp -i oracle_key.pem portal-server.zip ubuntu@<PUBLIC_IP>:~/
```

On the server: `unzip -o ~/portal-server.zip -d ~/ && sudo systemctl restart anticheat`

When you change the agent, republish the ZIP:

```powershell
dotnet publish agent\AntiCheatAgent\AntiCheatAgent.csproj -c Release -r win-x64 `
  --self-contained true -p:PublishSingleFile=true -o agent\publish
# re-zip agent\publish (exclude *.pdb / *.xml) over portal\agent\TournamentAntiCheat-Agent.zip
```

## 🧪 Local vs public behaviour

| | Local (default) | Public server |
|---|---|---|
| Bind address | default `0.0.0.0` — set `HOST=127.0.0.1` to stay LAN-invisible | `HOST=0.0.0.0` |
| Login | login page: `admin` + `ADMIN_PASSWORD` (local default `admin123` + dev hint) | same — set a strong `ADMIN_PASSWORD` |
| Sign-in options | Google / Discord buttons need redirect URIs registered (Step 6b) | same, with the public URL's callback URIs |
| Download page | serves the ZIP build | same |
| Agent portal | `agent.config.json` or `--portal http://127.0.0.1:3000` | `--portal http://<IP>:3000` |

---

### Why Oracle? (other free options checked Sep 2026)

| Platform | Verdict for this app |
|---|---|
| **Oracle Always Free** | ✅ truly 24/7, SQLite persists, real server — **this guide** |
| Northflank free tier | ✅ good (Git deploy, persistent volume, no cold starts) but 1 GB RAM / 0.5 GB disk limits |
| Render free | ⚠️ sleeps after ~15 min idle **and has no persistent disk** → SQLite data lost on restart |
| Fly.io / Railway | ❌ free tier gone (Fly) / only ~$1 credit (Railway) |
| Vercel / Netlify / Cloudflare Pages | ❌ serverless only — long-running Node + SQLite can't run |
| Tunnel from your own PC | ✅ instant + free, but only while your PC is on |
