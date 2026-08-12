<div align="center">

<img src="./assets/habibi-coin-logo.svg" alt="Habibi — WhatsApp economy bot" width="320" />

**A WhatsApp group bot with a full in-chat economy — currency, gambling, marriage, heists, and a merciless AI personality.**

Built to keep groups *active*, not to moderate them.

[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Baileys](https://img.shields.io/badge/WhatsApp-Baileys-25D366?logo=whatsapp&logoColor=white)](https://github.com/WhiskeySockets/Baileys)
[![Database](https://img.shields.io/badge/database-Supabase-3ECF8E?logo=supabase&logoColor=white)](https://supabase.com)
[![AI](https://img.shields.io/badge/AI-Groq%20%2F%20Llama%203.3-F55036?logo=meta&logoColor=white)](https://console.groq.com)
[![Status](https://img.shields.io/badge/status-active%20beta-yellow)]()

[Features](#-features) • [Commands](#-commands) • [Architecture](#-architecture) • [Reliability](#-reliability--engineering) • [Getting Started](#-getting-started) • [Deployment](#-deployment) • [Roadmap](#-roadmap)

</div>

---

## 📖 Overview

Habibi lives in a WhatsApp group, tracks a running economy in **Habz (₻)**, and roasts everyone along the way. Every message earns currency, users level up, marry each other, run coordinated heists, and gamble it all away on a coinflip — while an AI personality (powered by Groq/Llama) jumps into conversation whenever it's tagged, mentioned by name, or replied to.

It's designed for one thing: giving a group a reason to keep talking.

## ✨ Features

| | |
|---|---|
| 🤖 **AI personality** | Replies when tagged, mentioned by name (`habibi`, `bibi`, `habs`), or replied to — powered by Groq, with per-user conversation memory and a locked-down anti-jailbreak identity |
| 💰 **Text-based economy** | Every message counts toward leveling; leveling up pays out |
| 📈 **Leveling system** | ₻100,000 awarded every 50 messages sent |
| 🪂 **Airdrops** | Admin-triggered drops, first to `.claim` takes it all |
| 🥷 **Stealing** | `.steal` a reply-target directly — 30% success, cooldown-limited |
| 🔫 **Heists** | `.rob` coordinates a 5-person crew via `.join` within a 10-second window — bypasses steal immunity entirely |
| 💍 **Marriage system** | Propose, accept, shared vault with deposits/withdrawals, 50/50 split on divorce |
| 🎲 **Gambling** | `.flip` — double or nothing |
| 🏆 **Global leaderboard** | Top 20 by balance, across all groups |
| ☀️ **Scheduled broadcasts** | AI-generated (Groq) motivational quotes at 6am/11pm WAT to every group, plus a one-time changelog announcement after real deploys |
| 👋 **Auto-welcomes** | New members get roasted on arrival (skipped for bulk adds) |
| 🔒 **Group-only** | Ignores DMs and status broadcasts entirely |
| 🌍 **Multi-group** | One global wallet per user, shared across every group the bot is in |
| 📡 **Live admin feed** | WebSocket + REST admin API broadcasts every economy event in real time |

## 🎮 Commands

| Command | Description |
|---|---|
| `.help` / `.menu` / `.start` | List all commands |
| `.ping` | Health check |
| `.top` / `.leaderboard` | Global top 20 |
| `.profile` / `.balance` / `.bal` | Your balance, level, rank, steal record, marriage status |
| `.daily` | Claim your daily ₻25,000 |
| `.claim` | Claim an active airdrop |
| `.steal` *(reply)* | Attempt to steal from the replied user — 30% success |
| `.rob @user` | Start a heist crew — 50% odds, ignores immunity |
| `.join` | Join an active heist within its 10s window |
| `.give` / `.pay @user <amount>` | Send Habz (5% fee) |
| `.flip` / `.coinflip <amount>` | Double or nothing |
| `.immunity <hours>` | Buy steal protection — ₻2,000/hour |
| `.marry` / `.propose @user` | Propose marriage |
| `.accept` | Accept a pending proposal |
| `.reject` | Turn down a proposal made to you |
| `.cancel` | Withdraw a proposal you sent |
| `.divorce` | End it, vault splits 50/50 |
| `.vault` | Check your marriage vault |
| `.deposit <amount>` | Add Habz to the vault |
| `.withdrawal <amount>` | Pull Habz from the vault |

> A handful of admin-only moderation commands exist for the bot owner and are intentionally left out of `.help`.

## 🏗 Architecture

```mermaid
flowchart LR
    WA["WhatsApp Group"] <-->|Baileys| Bot["index.js"]
    Bot --> MH["messageHandler.js"]
    MH --> ECO["economy.js"]
    MH --> AI["ai.js (Groq)"]
    Bot --> SCHED["scheduler.js"]
    SCHED --> ECO
    SCHED --> AI
    ECO <--> DB[("Supabase / Postgres")]
    AI <--> DB
    Bot <--> AUTH["supabaseAuthState.js"]
    AUTH <--> DB
    Bot --> API["adminApi.js"]
    Bot --> WS["websocket.js"]
    API <--> DB
    API --> DASH["Admin dashboard (Vercel)"]
    WS --> DASH
    TG["Telegram"] <-->|pairing control| Bot
```

Session credentials, economy state, and AI chat history all live in Supabase — the bot itself is stateless, so redeploys and server migrations don't require re-pairing WhatsApp.

## 🧱 Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node.js (ESM), [Baileys](https://github.com/WhiskeySockets/Baileys) for the WhatsApp Web protocol |
| Database | Supabase (PostgreSQL) — economy, sessions, chat history |
| AI | Groq — `llama-3.3-70b-versatile` |
| Pairing control | Telegram bot, owner-only |
| Process management | PM2 |
| Hosting | Any Linux VPS (currently Oracle Cloud, Ampere A1/E2 depending on capacity) via Cloudflare Tunnel for HTTPS — Railway/Render configs also included as alternatives |
| Live updates | `ws` — broadcasts economy events for a future admin dashboard |

## 🛡 Reliability & engineering

Habibi is built to survive a busy, unpredictable group chat, not just demo well:

| | |
|---|---|
| 🔄 **Self-healing connection** | Auto-reconnects on drops with exponential backoff, pings the owner on Telegram if it can't recover, and exposes a manual `/retry` — no SSH required for a normal disconnect |
| 🧱 **Crash-proof by design** | Uncaught exceptions and unhandled rejections are caught and logged instead of killing the process — WhatsApp, the admin API, and the WebSocket feed all keep running independently of each other |
| 🚦 **Anti-spam-aware sending** | A throttled outbound queue plus a TTL'd group-metadata cache, specifically built to keep the bot from tripping WhatsApp's spam detection in large, high-traffic groups |
| 🪪 **LID identity resolution** | Handles WhatsApp's newer "linked identifier" addressing — a change that silently fragments accounts in a lot of bots — with a sticky resolution cache so no one ends up split across duplicate wallets |
| 👥 **Bulk-join detection** | Recognizes mass-add events and suppresses the welcome-roast spam that would otherwise fire once per person, while still registering every new member in the economy |
| 💾 **Stateless, portable process** | Session credentials, economy data, and chat history all live in Supabase — the bot itself holds no local state, so it can be redeployed or migrated to a new server without re-pairing WhatsApp |

## 📁 Project structure

```
habibi-whatsapp/
├── index.js                  Entry point — WhatsApp connection, Telegram pairing, event wiring
├── package.json
├── Procfile                   Render/Railway process definition
├── render.yaml                 Render one-click deploy config
├── .env.example
├── lib/
│   ├── economy.js              Wallet, steal, heists, marriage, immunity, coinflip, levels
│   ├── messageHandler.js        Routes incoming messages: text counting, commands, AI triggers
│   ├── ai.js                     Groq personality, anti-jailbreak, per-user chat history, scheduled quotes
│   ├── scheduler.js               Daily quote broadcasts + version-gated changelog announcements
│   ├── supabaseAuthState.js        Baileys auth state backed by Supabase (survives redeploys)
│   ├── adminApi.js                  REST admin API (leaderboard, broadcasts, balance adjustments)
│   └── websocket.js                  Real-time event feed for the admin API
└── admin-panel/               Standalone dashboard, deployed separately (Vercel)
    ├── login.html               Sign-in page
    ├── panel.html                Dashboard shell
    ├── shared.js                  Session storage, API client, formatting — used by both pages
    ├── login.js                    Sign-in logic
    ├── panel.js                     Dashboard logic (users, groups, shop, vaults, dead, mods, settings)
    └── styles.css                   Shared styling
```

## 🚀 Getting started

**Requirements:** Node.js 18+, a [Supabase](https://supabase.com) project, a [Groq](https://console.groq.com) API key, and a Telegram bot token for pairing.

```bash
git clone https://github.com/iamevanss/Official-Habibi- habibi
cd habibi
npm install
cp .env.example .env   # fill in the values below
npm start
```

### Environment variables

| Variable | Purpose |
|---|---|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase **service_role** key (not the anon key) |
| `TELEGRAM_BOT_TOKEN` | Bot token from [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_OWNER_ID` | Your Telegram chat ID — only this ID can issue pairing/admin commands |
| `GROQ_API_KEY` | API key from console.groq.com |
| `ADMIN_SECRET` | Shared secret for the REST admin API + WebSocket feed |
| `ALLOWED_ORIGIN` | Your admin panel's URL (e.g. `https://your-panel.vercel.app`) — the only origin allowed to call the admin API from a browser |
| `PORT` | HTTP port (defaults to 3000; auto-set on Railway/Render) |

Once running, message your Telegram bot with `/start`, then `/pair <phone number>` (country code, no `+`) to link WhatsApp.

## ☁️ Deployment

Pick whichever fits your setup:

- **[DEPLOY-VPS.md](./DEPLOY-VPS.md)** — any VPS provider (current production setup, via Cloudflare Tunnel — no domain required)
- **[DEPLOY.md](./DEPLOY.md)** — Railway
- **[DEPLOY-RENDER.md](./DEPLOY-RENDER.md)** — Render

## 🗺 Roadmap

- [x] Core economy — balances, levels, leaderboard
- [x] Stealing, heists, marriage, gambling
- [x] AI personality with per-user memory
- [x] Supabase-backed auth (survives redeploys, no re-pairing on migration)
- [x] REST admin API + real-time WebSocket event feed
- [x] Admin dashboard frontend — separate login/panel pages, live event feed, users, groups, shop (weapons/vehicles/houses), marriage vaults + pending proposals, dead/revive, moderators, settings
- [x] Scheduler — auto-airdrops, daily motivational quote broadcasts (AI-generated with a curated fallback), version-gated changelog announcements on deploy
- [ ] Midnight steal-reset
- [ ] Weekly leaderboard reset + recap

## 🤝 Contributing

This is currently a single-maintainer project. Issues and PRs are welcome — open an issue first for anything beyond a small fix so it can be discussed before you sink time into it.

## 📄 License & usage

**© 2026 Stain. All rights reserved.**

This repository is source-available for reference and personal learning — it is **not** open source. Unless you have explicit written permission from Stain, you may not:

- Copy, fork, redistribute, or republish this codebase (in whole or in part)
- Deploy or run a modified or unmodified version of it as your own bot/product
- Strip, alter, or omit credit to Stain as the original creator

If you want to build on this, use it commercially, or feature parts of it elsewhere, reach out first — see the contact links below. Unauthorized use is a copyright violation and may result in a takedown request, GitHub repository/DMCA report, or further legal action.

## 🙌 Credits

Built by **Stain**.

[![WhatsApp](https://img.shields.io/badge/WhatsApp-25D366?logo=whatsapp&logoColor=white)](https://wa.me/2348132589873)
[![Telegram](https://img.shields.io/badge/Telegram-@heisstain-26A5E4?logo=telegram&logoColor=white)](https://t.me/heisstain)
[![Telegram](https://img.shields.io/badge/Telegram-@heisevanss-26A5E4?logo=telegram&logoColor=white)](https://t.me/heisevanss)
[![Instagram](https://img.shields.io/badge/Instagram-@heis__evanss-E4405F?logo=instagram&logoColor=white)](https://www.instagram.com/heis_evanss?igsh=Z3cxYmZsYTdrOGtv)

### Special thanks

Ted • Zed • Milo Dev
