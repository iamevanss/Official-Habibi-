import 'dotenv/config'
import express from 'express'
import http from 'http'
import TelegramBot from 'node-telegram-bot-api'
import makeWASocket, {
    DisconnectReason,
    fetchLatestWaWebVersion,
    Browsers,
    makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys'
import pino from 'pino'
import { useSupabaseAuthState } from './lib/supabaseAuthState.js'
import { handleIncomingMessage, handleGroupParticipantsUpdate } from './lib/messageHandler.js'
import { adminRouter } from './lib/adminApi.js'
import { initWebSocket } from './lib/websocket.js'
import { createGroupAirdrop, getActiveGroupIds, hasUnclaimedAirdrop } from './lib/economy.js'
import { startBroadcastScheduler } from './lib/scheduler.js'

// Baileys calls groupMetadata() internally on every single outgoy group message
// (to resolve the participant list for encryption) unless a cache is provided.
// In a large, active group this floods WhatsApp with metadata queries and can
// get rate-limited/rejected ("forbidden"), which then blocks every reply. This
// cache is the library's own documented fix for that. Persists across
// reconnects since it's declared at module scope, not inside connectToWhatsApp.
const GROUP_METADATA_TTL_MS = 5 * 60 * 1000
const groupMetadataCache = new Map()

function getCachedGroupMetadata(jid) {
    const entry = groupMetadataCache.get(jid)
    if (!entry) return undefined
    if (Date.now() - entry.time > GROUP_METADATA_TTL_MS) {
        groupMetadataCache.delete(jid)
        return undefined
    }
    return entry.data
}

function setCachedGroupMetadata(jid, data) {
    groupMetadataCache.set(jid, { data, time: Date.now() })
}

// Entries expire lazily (on next read) via getCachedGroupMetadata, but a group
// that goes quiet — bot removed, group archived, etc. — would otherwise sit in
// memory forever since nothing ever reads it again to trigger the delete. This
// sweep guarantees stale entries are actually freed, which matters once the bot
// is in more than a couple of large groups.
setInterval(() => {
    const now = Date.now()
    for (const [jid, entry] of groupMetadataCache) {
        if (now - entry.time > GROUP_METADATA_TTL_MS) {
            groupMetadataCache.delete(jid)
        }
    }
}, GROUP_METADATA_TTL_MS)

async function refreshGroupMetadataCache(sockInstance, jid) {
    try {
        const metadata = await sockInstance.groupMetadata(jid)
        setCachedGroupMetadata(jid, metadata)
    } catch (err) {
        console.error(`Failed to refresh group metadata cache for ${jid}:`, err.message)
    }
}

// Baileys' own docs recommend keeping this outside the socket instance so it
// survives reconnects — otherwise every reconnect resets retry tracking to
// zero, which can contribute to repeated decrypt/retry loops.
const retryCounters = new Map()
const msgRetryCounterCache = {
    get: (key) => retryCounters.get(key),
    set: (key, value) => retryCounters.set(key, value),
    del: (key) => retryCounters.delete(key),
    flushAll: () => retryCounters.clear()
}

// Auto-airdrops — one drop per active group on a fixed interval, skipped for
// any group that still has an unclaimed one sitting there (no point stacking
// drops nobody's grabbed yet). Started once on the first successful
// connection, not on every reconnect, so restarts don't stack intervals.
const AUTO_AIRDROP_INTERVAL_MS = 4 * 60 * 60 * 1000 // every 4 hours — tune as needed
let autoAirdropStarted = false

function formatHabz(amount) {
    return `₻${Number(amount || 0).toLocaleString()}`
}

async function runAutoAirdrops() {
    try {
        const groupIds = await getActiveGroupIds()
        for (const groupId of groupIds) {
            if (!sock) continue
            const alreadyPending = await hasUnclaimedAirdrop(groupId)
            if (alreadyPending) continue

            const result = await createGroupAirdrop(groupId)
            if (result.error) continue

            await sock.sendPresenceUpdate('composing', groupId)
            await sock.sendMessage(groupId, {
                text: `🪂 *AIRDROP INCOMING* 🪂\n\n${formatHabz(result.amount)} is up for grabs. First to type \`.claim\` takes it all.`
            })
        }
    } catch (err) {
        console.error('Auto-airdrop run failed:', err.message)
    }
}

function startAutoAirdropScheduler() {
    if (autoAirdropStarted) return
    autoAirdropStarted = true
    setInterval(runAutoAirdrops, AUTO_AIRDROP_INTERVAL_MS)
}

const app = express()
const server = http.createServer(app)

// Both are read by adminApi.js (GET /status) but were never being written
// anywhere — connectionState always fell back to its 'unknown' default and
// startTime always fell back to "right now" at request time, making uptime
// permanently read ~0m regardless of how long the bot had actually been up.
app.set('startTime', Date.now())
app.set('connectionState', 'connecting')

app.use('/api', adminRouter)

// A single uncaught error anywhere (Baileys internals, Telegram polling, a stray
// promise) would otherwise kill the whole process — WhatsApp connection, admin
// dashboard, and websocket all together. Log and stay alive instead.
process.on('uncaughtException', (err) => {
    console.error('Uncaught exception (process kept alive):', err)
    notifyOwnerThrottled(`⚠️ Habibi hit an uncaught error but stayed alive: ${err.message}`, 120000)
})

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection (process kept alive):', reason)
    notifyOwnerThrottled(`⚠️ Habibi hit an unhandled rejection but stayed alive: ${reason?.message || reason}`, 120000)
})

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_OWNER_ID = process.env.TELEGRAM_OWNER_ID

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true })

let sock = null
let isReadyForPairing = false
let reconnectAttempts = 0
let lastFailureNotifyTime = 0
let autoRetryStopped = false

const MAX_AUTO_RETRIES = 10

function sanitizePhoneNumber(phone) {
    return phone.replace(/\D/g, '')
}

function isOwner(msg) {
    const match = String(msg.chat.id) === String(TELEGRAM_OWNER_ID)
    if (!match) {
        console.log(`Ignored command from chat ID ${msg.chat.id} — TELEGRAM_OWNER_ID is set to ${TELEGRAM_OWNER_ID}`)
    }
    return match
}

function notifyOwner(text) {
    if (TELEGRAM_OWNER_ID) {
        bot.sendMessage(TELEGRAM_OWNER_ID, text)
    }
}

function notifyOwnerThrottled(text, minIntervalMs = 60000) {
    const now = Date.now()
    if (now - lastFailureNotifyTime > minIntervalMs) {
        lastFailureNotifyTime = now
        notifyOwner(text)
    }
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useSupabaseAuthState()
    
    let version
    try {
        const waVersion = await fetchLatestWaWebVersion()
        version = waVersion.version
    } catch (err) {
        console.warn('Failed to fetch WA Web version, defaulting to fallback version.')
    }

    sock = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }))
        },
        ...(version ? { version } : {}),
        logger: pino({ level: process.env.BAILEYS_LOG_LEVEL || 'warn' }),
        browser: Browsers.macOS('Chrome'),
        printQRInTerminal: false,
        syncFullHistory: false,
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: false,
        defaultQueryTimeoutMs: 60000,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        retryRequestDelayMs: 500,
        maxMsgRetryCount: 5,
        msgRetryCounterCache,
        emitOwnEvents: false,
        fireInitQueries: true,
        aiLabel: false,
        getMessage: async () => ({ conversation: '' }),
        cachedGroupMetadata: async (jid) => getCachedGroupMetadata(jid),
        // Habibi only cares about group messages — Status broadcasts from every
        // contact were a huge share of the CPU-heavy decrypt-failure noise for
        // content she never uses. Skipping decryption for them entirely is a
        // documented Baileys option, not a workaround.
        shouldIgnoreJid: (jid) => jid === 'status@broadcast'
    })

    app.set('sock', sock)

    if (sock.keepAliveTimer) clearInterval(sock.keepAliveTimer)
    sock.keepAliveTimer = setInterval(async () => {
        try {
            if (sock?.ws?.readyState === 1) {
                await sock.sendPresenceUpdate('available')
            }
        } catch (error) {
            console.error('Keep-alive failed:', error.message)
        }
    }, 25000)

    let groupCacheWarmPromise = Promise.resolve()

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr && !sock.authState.creds.registered && !isReadyForPairing) {
            isReadyForPairing = true
            notifyOwner('Habibi is ready to pair. Send /pair <phone number> (country code, no +).')
        }

        if (connection === 'connecting') {
            app.set('connectionState', 'connecting')
        }

        if (connection === 'close') {
            app.set('connectionState', 'close')
            const shouldReconnect =
                lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut

            console.log('Connection closed:', lastDisconnect?.error?.message)
            isReadyForPairing = false
            reconnectAttempts++

            if (reconnectAttempts > MAX_AUTO_RETRIES) {
                autoRetryStopped = true
                console.log(`Stopped after ${reconnectAttempts} failed attempts. Waiting for /retry.`)
                notifyOwnerThrottled(
                    `Habibi couldn't connect after ${MAX_AUTO_RETRIES} tries and has stopped retrying automatically — send /retry when you want to try again.`,
                    300000
                )
                return
            }

            const delay = Math.min(reconnectAttempts * 5000, 60000)

            if (shouldReconnect) {
                console.log(`Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})...`)
                setTimeout(connectToWhatsApp, delay)
            } else {
                console.log(`Logged out. Retrying in ${delay / 1000}s (attempt ${reconnectAttempts})...`)
                notifyOwnerThrottled(
                    'Habibi keeps getting logged out and is retrying automatically. Watch for the ready-to-pair message.'
                )
                setTimeout(connectToWhatsApp, delay)
            }
        } else if (connection === 'open') {
            console.log('Habibi connected successfully')
            app.set('connectionState', 'open')
            app.set('startTime', Date.now()) // uptime tracks the current live connection, not raw process age
            isReadyForPairing = false
            reconnectAttempts = 0
            autoRetryStopped = false
            notifyOwner('Habibi connected successfully.')
            startAutoAirdropScheduler()
            // Getter, not `sock` directly — see scheduler.js for why: this
            // module-level `sock` gets reassigned on every reconnect, and the
            // scheduler needs to always read the live one.
            startBroadcastScheduler(() => sock)

            // Warm the group metadata cache immediately so the very first
            // message sent doesn't have to hit a live groupMetadata query.
            // Stored so messages.upsert can await it below — without that,
            // messages arriving in the gap before this resolves would still
            // miss the cache and trigger live queries, defeating the point.
            groupCacheWarmPromise = sock.groupFetchAllParticipating()
                .then((groups) => {
                    for (const jid of Object.keys(groups)) {
                        setCachedGroupMetadata(jid, groups[jid])
                    }
                })
                .catch((err) => console.error('Failed to prefetch group metadata:', err.message))
        }
    })

    sock.ev.on('messages.upsert', async ({ messages }) => {
        // Never block on this longer than a few seconds — if the prefetch is
        // slow or fails, fall back to per-send live lookups rather than
        // stalling every incoming message indefinitely.
        await Promise.race([groupCacheWarmPromise, new Promise((resolve) => setTimeout(resolve, 5000))])

        await Promise.all(
            messages.map((msg) =>
                handleIncomingMessage(sock, msg).catch((error) => {
                    console.error('Error handling message:', error)
                })
            )
        )
    })

    sock.ev.on('group-participants.update', async (update) => {
        try {
            await handleGroupParticipantsUpdate(sock, update)
        } catch (error) {
            console.error('Error handling group participants update:', error)
        }
        if (update?.id) refreshGroupMetadataCache(sock, update.id)
    })

    sock.ev.on('groups.update', (updates) => {
        for (const update of updates) {
            if (update?.id) refreshGroupMetadataCache(sock, update.id)
        }
    })

    sock.ev.on('creds.update', saveCreds)
}

bot.onText(/\/pair (.+)/, async (msg, match) => {
    if (!isOwner(msg)) return

    if (!sock || !isReadyForPairing || sock.authState.creds.registered) {
        return bot.sendMessage(msg.chat.id, 'Not ready yet, or already paired.')
    }

    const sanitized = sanitizePhoneNumber(match[1])
    if (!sanitized) {
        return bot.sendMessage(msg.chat.id, 'Invalid phone number.')
    }

    try {
        await new Promise((resolve) => setTimeout(resolve, 2000))
        const code = await sock.requestPairingCode(sanitized)
        bot.sendMessage(
            msg.chat.id,
            `Pairing code: ${code}\n\nWhatsApp > Linked Devices > Link a Device > Enter this code.`
        )
    } catch (error) {
        console.error('Failed to request pairing code:', error)
        bot.sendMessage(msg.chat.id, 'Failed to generate pairing code. Try again.')
    }
})

bot.onText(/\/start/, (msg) => {
    if (!isOwner(msg)) return
    bot.sendMessage(msg.chat.id, 'Habibi pairing control online. Use /pair <phone number> once she says she is ready.')
})

bot.onText(/\/retry/, (msg) => {
    if (!isOwner(msg)) return

    if (!autoRetryStopped) {
        return bot.sendMessage(msg.chat.id, 'Already running — no need to retry manually right now.')
    }

    reconnectAttempts = 0
    autoRetryStopped = false
    bot.sendMessage(msg.chat.id, 'Trying again...')
    connectToWhatsApp()
})

app.get('/', (req, res) => {
    res.send('Habibi is running')
})

server.listen(process.env.PORT || 3000, () => {
    console.log('Health check server running')
    initWebSocket(server)
    connectToWhatsApp()
})
