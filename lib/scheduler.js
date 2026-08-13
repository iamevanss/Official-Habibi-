// ============================================================
// Habibi — scheduled broadcasts
// 1. Motivational quotes at 6:00 AM and 11:00 PM Africa/Lagos (WAT) time,
//    sent to every active group.
// 2. A one-time changelog broadcast on startup, but only when the stored
//    version actually differs from the last one broadcast — so routine
//    reconnects/crashes never spam every group with "what's new".
// 3. A weekly leaderboard recap + reset — Monday 00:00 WAT.
// 4. Auto-ending a .event once its timer runs out, with an announcement.
//
// Started once from index.js on the first successful WhatsApp connection,
// same pattern as the existing auto-airdrop scheduler.
// ============================================================

import { generateMotivationalQuote } from './ai.js'
import {
    getActiveGroupIds,
    getChangelogState,
    getLastBroadcastVersion,
    markChangelogBroadcast,
    getWeeklyLeaderboard,
    resetWeeklyBalances,
    getActiveEvent,
    stopEvent,
    EVENT_TYPES,
    resolveExpiredWars
} from './economy.js'

const CHECK_INTERVAL_MS = 60 * 1000 // check the clock once a minute
const TIMEZONE = 'Africa/Lagos'

// Guards against firing twice within the same minute, and against firing
// again later the same day/week if the process restarts mid-window.
let lastFiredKey = null
let lastWeeklyFiredKey = null

function getWatParts(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: TIMEZONE,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23'
    }).formatToParts(now)

    const get = (type) => parts.find((p) => p.type === type)?.value
    return {
        dateKey: `${get('year')}-${get('month')}-${get('day')}`,
        hour: Number(get('hour')),
        minute: Number(get('minute')),
        weekday: get('weekday') // 'Mon', 'Tue', etc.
    }
}

async function broadcastToAllGroups(getSock, text) {
    const sock = getSock()
    if (!sock) return
    const groupIds = await getActiveGroupIds()
    for (const groupId of groupIds) {
        try {
            await sock.sendMessage(groupId, { text })
        } catch (err) {
            console.error(`Failed to broadcast to ${groupId}:`, err.message)
        }
    }
}

async function runQuoteCheck(getSock) {
    const { dateKey, hour, minute } = getWatParts()
    // A small window (not an exact-minute match) so a slow tick or a restart
    // right around the target minute doesn't just skip the day entirely.
    const isMorningWindow = hour === 6 && minute < 5
    const isNightWindow = hour === 23 && minute < 5
    if (!isMorningWindow && !isNightWindow) return

    const type = isMorningWindow ? 'morning' : 'night'
    const key = `${dateKey}-${type}`
    if (lastFiredKey === key) return
    lastFiredKey = key

    try {
        const quote = await generateMotivationalQuote(type)
        const emoji = type === 'morning' ? '🌅' : '🌙'
        await broadcastToAllGroups(getSock, `${emoji} ${quote}`)
    } catch (err) {
        console.error('Quote broadcast failed:', err.message)
    }
}

async function runChangelogCheck(getSock) {
    try {
        const { version, text } = await getChangelogState()
        if (!version || !text) return // nothing configured in the admin panel yet

        const lastBroadcast = await getLastBroadcastVersion()
        if (lastBroadcast === version) return // already sent this version

        await broadcastToAllGroups(
            getSock,
            `🔧 *Habibi update — ${version}*\n\n${text}\n\nType \`.help\` to see the full command list.`
        )
        await markChangelogBroadcast(version)
    } catch (err) {
        console.error('Changelog broadcast failed:', err.message)
    }
}

// Monday 00:00-00:05 WAT — recap THEN reset, in that order, since resetting
// first would wipe the very numbers the recap needs to show.
async function runWeeklyLeaderboardCheck(getSock) {
    const { dateKey, hour, minute, weekday } = getWatParts()
    const isResetWindow = weekday === 'Mon' && hour === 0 && minute < 5
    if (!isResetWindow) return

    const key = `weekly-${dateKey}`
    if (lastWeeklyFiredKey === key) return
    lastWeeklyFiredKey = key

    try {
        const top = await getWeeklyLeaderboard(5)
        if (top.length) {
            const lines = top.map((u, i) => `${i + 1}. *${u.push_name || 'Anonymous'}* — ${u.weeklyEarnings.toLocaleString()} habz earned`)
            await broadcastToAllGroups(getSock, `📅 *Weekly Recap*\n\nThis week's top earners:\n\n${lines.join('\n')}\n\nFresh week starts now — good luck. 🍀`)
        }
        await resetWeeklyBalances()
    } catch (err) {
        console.error('Weekly leaderboard recap/reset failed:', err.message)
    }
}

async function runEventExpiryCheck(getSock) {
    try {
        const active = await getActiveEvent()
        if (!active) return // nothing running, or it already expired and was cleared

        if (new Date(active.expiresAt).getTime() > Date.now()) return // still running

        const result = await stopEvent()
        if (result.error) return
        const config = EVENT_TYPES[result.type]
        await broadcastToAllGroups(getSock, `${config.emoji} The *${config.label}* event has ended. Back to normal.`)
    } catch (err) {
        console.error('Event expiry check failed:', err.message)
    }
}

// Gang wars aren't tied to a single group (members can be spread across
// several), so results broadcast bot-wide same as quotes/changelog, rather
// than trying to guess which group "belongs" to a gang.
async function runGangWarCheck(getSock) {
    try {
        const results = await resolveExpiredWars()
        for (const result of results) {
            if (result.type === 'challenge_expired') {
                await broadcastToAllGroups(
                    getSock,
                    `⌛ *${result.challengerGang?.name || 'A gang'}*'s war challenge went unanswered and has expired. Wager refunded.`
                )
            } else if (result.type === 'war_resolved') {
                const { challengerGang, rivalGang, winnerGangId, pot, war } = result
                if (winnerGangId) {
                    const winnerName = winnerGangId === war.challenger_gang_id ? challengerGang?.name : rivalGang?.name
                    await broadcastToAllGroups(
                        getSock,
                        `⚔️ *WAR OVER* — *${challengerGang?.name}* vs *${rivalGang?.name}*\n\n` +
                        `*${winnerName}* wins the pot of ${pot.toLocaleString()} habz!\n\n` +
                        `Final tally: ${challengerGang?.name} ${Number(war.challenger_tally).toLocaleString()} — ${Number(war.rival_tally).toLocaleString()} ${rivalGang?.name}`
                    )
                } else {
                    await broadcastToAllGroups(
                        getSock,
                        `⚔️ *WAR OVER* — *${challengerGang?.name}* vs *${rivalGang?.name}*\n\nIt's a tie. Both gangs get their wager back.`
                    )
                }
            }
        }
    } catch (err) {
        console.error('Gang war check failed:', err.message)
    }
}

let schedulerStarted = false

// Takes a getter, not the raw socket — WhatsApp reconnects fairly often (see
// index.js's own reconnect logic), and each reconnect creates a brand new
// sock instance. A getter always reads whatever index.js's module-level
// `sock` variable currently points to; a captured raw reference would go
// stale after the very first reconnect and silently stop sending anything.
export function startBroadcastScheduler(getSock) {
    if (schedulerStarted) return
    schedulerStarted = true

    // Changelog is checked once, shortly after connecting — no need to poll
    // for it every minute since it only ever changes via a manual deploy.
    setTimeout(() => runChangelogCheck(getSock), 10000)

    setInterval(() => {
        runQuoteCheck(getSock)
        runWeeklyLeaderboardCheck(getSock)
        runEventExpiryCheck(getSock)
        runGangWarCheck(getSock)
    }, CHECK_INTERVAL_MS)
}

