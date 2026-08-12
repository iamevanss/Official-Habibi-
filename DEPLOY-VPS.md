# Deploying Habibi to a VPS

No dashboard auto-deploy here — this is a real server. Longer process than Railway/Render, but one-time setup. Works on any Linux VPS provider (Oracle Cloud, DigitalOcean, Hetzner, Vultr, Linode, etc.) — provider-specific notes are called out where they matter. Do this in order; each phase depends on the last one working.

## Phase 1: Provision the VM

1. Create an Ubuntu VM (22.04 or 24.04) with your provider of choice.
   - **Oracle Cloud (Always Free):** try the **Ampere A1** shape first (ARM, up to 4 OCPU/24GB free) — but capacity is frequently unavailable in busy regions. Fall back to **E2.1.Micro** (AMD, 1 OCPU/1GB, reliably available) if A1 won't provision. Try different Availability Domains and times of day if you want to keep attempting A1.
   - **Any paid provider (DigitalOcean/Hetzner/Vultr/Linode):** 2GB RAM / 1-2 vCPU is a comfortable minimum for an active group — noticeably more consistent than a contested free-tier shape, since you're not competing for burst capacity.
2. Save the SSH key/credentials the provider gives you — you'll need them for the next step.
3. Note the VM's **public IP** — needed for every step below.

## Phase 2: SSH access from your phone

1. Install **Termux** — get it from F-Droid, not the Play Store (Play Store version is outdated and no longer maintained).
2. Open Termux, run:
```
pkg update && pkg upgrade -y
pkg install openssh -y
termux-setup-storage
```
Allow the storage permission prompt that pops up.

3. If your provider gave you a downloadable private key file, move it into Termux (replace with your actual filename):
```
ls ~/storage/downloads/
cp ~/storage/downloads/YOUR-KEY-FILENAME.key ~/vps_key.key
chmod 600 ~/vps_key.key
```
Some providers (DigitalOcean, Hetzner, etc.) instead let you paste your own public key during creation and give you a root password/passphrase directly — skip the key copy step in that case.

4. Connect (replace `YOUR_PUBLIC_IP` and the username — `ubuntu` on Oracle, often `root` elsewhere):
```
ssh -i ~/vps_key.key ubuntu@YOUR_PUBLIC_IP
```
First connection asks to confirm the host — type `yes`.

You're now inside the server.

## Phase 3: Prepare the server

```
sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git
```

Confirm it worked:
```
node --version
npm --version
```

### Add swap (do this regardless of RAM size)

A busy group can push memory harder than expected. A swap file turns a potential crash/OOM-kill into a slowdown instead — cheap insurance:
```
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h   # confirm swap shows as active
```
On a 1GB-RAM free-tier box, sized-up swap (4-8G+) is reasonable. Note swap is disk-speed, not RAM-speed — it prevents crashes, it doesn't make a genuinely undersized VM fast. If `free -h` shows swap usage climbing heavily during normal activity, that's a sign to upgrade the VM rather than lean on swap indefinitely.

## Phase 4: Deploy Habibi

```
git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git habibi
cd habibi
npm install
```

Create your `.env` file directly on the server:
```
nano .env
```
Paste in (fill in your real values):
```
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
TELEGRAM_BOT_TOKEN=
TELEGRAM_OWNER_ID=
GROQ_API_KEY=
ADMIN_SECRET=choose-a-long-random-value-here
ALLOWED_ORIGIN=https://your-panel.vercel.app
PORT=3000
```
Save with `Ctrl+O`, `Enter`, then exit with `Ctrl+X`. Lock down the file:
```
chmod 600 .env
```

Test it runs:
```
node index.js
```
Watch for `Habibi connected successfully` and the connection attempts. `Ctrl+C` to stop once confirmed — this was just a test run.

## Phase 5: Keep it running permanently

```
sudo npm install -g pm2
pm2 start index.js --name habibi
pm2 save
pm2 startup
```
`pm2 startup` prints a command starting with `sudo env PATH=...` — copy that exact line and run it too, then:
```
pm2 save
```
Now Habibi survives reboots and restarts automatically if it ever crashes.

**Useful pm2 commands going forward:**
```
pm2 logs habibi        # live logs
pm2 restart habibi     # restart after you push code changes
pm2 status              # check it's online
```

## Phase 6: HTTPS for the admin panel — Cloudflare Tunnel (no domain required)

The admin panel (deployed separately to Vercel) needs an HTTPS endpoint to talk to the bot's API. Cloudflare Tunnel gives you that for free, with no domain purchase needed.

1. Install cloudflared:
```
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
```

2. Set it up as a permanent background service (a "Quick Tunnel" — gives you a random `*.trycloudflare.com` URL, no Cloudflare account needed):
```
sudo tee /etc/systemd/system/cloudflared-habibi.service << 'EOF'
[Unit]
Description=Cloudflare Tunnel for Habibi
After=network.target

[Service]
ExecStart=/usr/bin/cloudflared tunnel --url http://localhost:3000
Restart=always
User=ubuntu

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable cloudflared-habibi
sudo systemctl start cloudflared-habibi
```

3. Grab your tunnel URL from the logs:
```
sudo journalctl -u cloudflared-habibi | grep trycloudflare
```
Look for a line like `https://random-two-words-1234.trycloudflare.com` — that's your bot's HTTPS API endpoint. Use it as the **Server URL** when signing into the admin panel.

4. No firewall changes needed — the tunnel makes an outbound connection to Cloudflare, so there's nothing inbound to open in your provider's security rules/firewall.

**One tradeoff:** this random URL changes if the service restarts (VM reboot, crash, redeploy of the tunnel service). If the panel stops connecting, re-run the `journalctl` command above to get the new URL, update `ALLOWED_ORIGIN` in `.env` if needed, and re-enter the new Server URL in the panel.

**Want a stable URL that never changes?** Use a Cloudflare **named tunnel** instead — requires a free Cloudflare account and (for the cleanest setup) a domain pointed at Cloudflare's nameservers. Ask if you want that walkthrough; it's a bit more setup but the URL never rotates.

## Updating code later

No auto-deploy from GitHub here — you pull manually:
```
cd ~/habibi
git pull
npm install
pm2 restart habibi
```

If you use the admin panel's Changelog field (Settings tab), fill it in with the new version + a short summary right when you deploy — the bot broadcasts it to every group automatically on this restart, but only if the version is actually new.
