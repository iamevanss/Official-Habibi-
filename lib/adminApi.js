import express from 'express'
import cors from 'cors'
import { createClient } from '@supabase/supabase-js'
import {
    getOrCreateUser, getTopN, getProfile, getInventory,
    getVehicleGrades, getHouseGrades, getShopListing,
    listModerators, addModerator, removeModerator,
    isAiEnabled, setAiEnabled,
    getVault, getAllCouples, forfeitMarriage
} from './economy.js'
import { broadcastUpdate } from './websocket.js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

export const adminRouter = express.Router()

// Origins allowed to call this API from a browser (the Vercel panel, plus
// localhost while building it). Comma-separated in .env — no wildcard, since
// every route here can move money or send WhatsApp messages.
const allowedOrigins = (process.env.ALLOWED_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

adminRouter.use(cors({
    origin(origin, callback) {
        // Allow non-browser tools (curl, server-to-server) which send no Origin header.
        if (!origin || allowedOrigins.includes(origin)) return callback(null, true)
        callback(new Error('Not allowed by CORS'))
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'x-admin-secret']
}))

function requireAdmin(req, res, next) {
    const secret = req.headers['x-admin-secret']
    if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' })
    }
    next()
}

adminRouter.use(express.json())
adminRouter.use(requireAdmin)

// ---------- AUTH / HEALTH ----------

// The panel calls this once on login to confirm the secret the user typed in
// is actually correct, before storing it and moving on to the dashboard.
adminRouter.get('/ping', (req, res) => {
    res.json({ ok: true })
})

adminRouter.get('/status', (req, res) => {
    const sock = req.app.get('sock')
    const connectionState = req.app.get('connectionState') || 'unknown'
    const startTime = req.app.get('startTime') || Date.now()
    res.json({
        connectionState, // 'open' | 'connecting' | 'close' | 'unknown'
        connected: connectionState === 'open',
        hasSocket: Boolean(sock),
        uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
        botName: sock?.user?.name || sock?.user?.verifiedName || null,
        botNumber: sock?.user?.id?.split(':')[0] || null
    })
})

// ---------- DASHBOARD STATS ----------

adminRouter.get('/stats', async (req, res) => {
    const [usersCount, groupsCount, balanceAgg, tx24h] = await Promise.all([
        supabase.from('users').select('member_id', { count: 'exact', head: true }),
        supabase.from('groups').select('group_id', { count: 'exact', head: true }).eq('is_active', true),
        supabase.from('users').select('balance'),
        supabase
            .from('transactions')
            .select('amount, tx_type')
            .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    ])

    const totalHabz = (balanceAgg.data || []).reduce((sum, r) => sum + Number(r.balance || 0), 0)
    const volume24h = (tx24h.data || []).reduce((sum, r) => sum + Number(r.amount || 0), 0)

    res.json({
        totalUsers: usersCount.count || 0,
        totalGroups: groupsCount.count || 0,
        totalHabz,
        transactions24h: (tx24h.data || []).length,
        volume24h
    })
})

adminRouter.get('/transactions/recent', async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 30, 100)
    const { data, error } = await supabase
        .from('transactions')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit)

    if (error) return res.status(500).json({ error: error.message })
    res.json({ transactions: data })
})

adminRouter.get('/leaderboard/global', async (req, res) => {
    const top = await getTopN(20)
    res.json({ leaderboard: top })
})

adminRouter.get('/leaderboard/:groupId', async (req, res) => {
    const { groupId } = req.params

    const { data: members, error } = await supabase
        .from('group_members')
        .select('member_id, users(member_id, push_name, balance, level)')
        .eq('group_id', groupId)

    if (error) return res.status(500).json({ error: error.message })

    const sorted = (members || [])
        .map((m) => m.users)
        .filter(Boolean)
        .sort((a, b) => b.balance - a.balance)
        .slice(0, 20)

    res.json({ leaderboard: sorted })
})

// ---------- USERS ----------

adminRouter.get('/users', async (req, res) => {
    const q = (req.query.q || '').trim()
    let query = supabase.from('users').select('member_id, push_name, balance, level, killed_until').limit(20)
    if (q) query = query.or(`member_id.ilike.%${q}%,push_name.ilike.%${q}%`)
    else query = query.order('balance', { ascending: false })

    const { data, error } = await query
    if (error) return res.status(500).json({ error: error.message })
    res.json({ users: data })
})

// Everyone currently in a killed_until lockout — lets the panel offer a
// one-tap revive list instead of requiring a search per name.
adminRouter.get('/users/dead', async (req, res) => {
    const { data, error } = await supabase
        .from('users')
        .select('member_id, push_name, killed_until')
        .gt('killed_until', new Date().toISOString())
        .order('killed_until', { ascending: true })

    if (error) return res.status(500).json({ error: error.message })
    res.json({ users: data })
})

adminRouter.get('/user/:memberId', async (req, res) => {
    const profile = await getProfile(req.params.memberId)
    const inventory = await getInventory(req.params.memberId)
    res.json({ profile, inventory })
})

adminRouter.get('/transactions/:memberId', async (req, res) => {
    const { data, error } = await supabase
        .from('transactions')
        .select('*')
        .or(`sender_id.eq.${req.params.memberId},receiver_id.eq.${req.params.memberId}`)
        .order('created_at', { ascending: false })
        .limit(50)

    if (error) return res.status(500).json({ error: error.message })
    res.json({ transactions: data })
})

adminRouter.post('/adjust-balance', async (req, res) => {
    const { memberId, amount, reason } = req.body

    if (!memberId || amount === undefined || amount === null) {
        return res.status(400).json({ error: 'memberId and amount are required' })
    }

    const user = await getOrCreateUser(memberId)
    const newBalance = Number(user.balance || 0) + Number(amount)

    await supabase
        .from('users')
        .update({ balance: newBalance, updated_at: new Date().toISOString() })
        .eq('member_id', memberId)

    await supabase.from('transactions').insert({
        sender_id: null,
        receiver_id: memberId,
        amount,
        tx_type: 'admin_adjustment',
        description: reason || 'Manual admin adjustment'
    })

    broadcastUpdate('balance_adjusted', { memberId, newBalance })
    res.json({ success: true, newBalance })
})

adminRouter.post('/reset-steals', async (req, res) => {
    const { memberId } = req.body
    if (!memberId) return res.status(400).json({ error: 'memberId is required' })

    await supabase
        .from('users')
        .update({ steal_targets_24h: [], steal_count_24h: 0, last_steal_time: null, updated_at: new Date().toISOString() })
        .eq('member_id', memberId)

    res.json({ success: true })
})

// Admin kill/revive — unlike the in-chat .kill command, these don't charge the
// admin anything and don't require the target to currently be alive/dead in a
// particular state beyond what's checked below. Matches the in-chat .kill:
// wipes balance + inventory only, leaves vehicle/house/marriage vault alone.
// Admins can still pick a custom lockout length (defaults to the same 25
// minutes as in-chat .kill).
adminRouter.post('/user/:memberId/kill', async (req, res) => {
    const { memberId } = req.params
    const minutes = Number(req.body?.minutes) || Number(req.body?.hours) * 60 || 25

    await supabase.from('user_inventory').delete().eq('member_id', memberId)
    const { error } = await supabase
        .from('users')
        .update({
            balance: 0,
            killed_until: new Date(Date.now() + minutes * 60 * 1000).toISOString(),
            updated_at: new Date().toISOString()
        })
        .eq('member_id', memberId)

    if (error) return res.status(500).json({ error: error.message })

    await supabase.from('transactions').insert({
        sender_id: null,
        receiver_id: null,
        amount: 0,
        tx_type: 'admin_kill',
        description: `Admin killed ${memberId}`
    })

    broadcastUpdate('user_killed', { memberId })
    res.json({ success: true })
})

adminRouter.post('/user/:memberId/revive', async (req, res) => {
    const { memberId } = req.params
    const { error } = await supabase
        .from('users')
        .update({ killed_until: null, updated_at: new Date().toISOString() })
        .eq('member_id', memberId)

    if (error) return res.status(500).json({ error: error.message })

    await supabase.from('transactions').insert({
        sender_id: null,
        receiver_id: memberId,
        amount: 0,
        tx_type: 'admin_revive',
        description: `Admin revived ${memberId}`
    })

    broadcastUpdate('user_revived', { memberId })
    res.json({ success: true })
})

// ---------- GROUPS / BROADCAST ----------

adminRouter.get('/groups', async (req, res) => {
    const { data, error } = await supabase.from('groups').select('*').order('registered_at', { ascending: false })
    if (error) return res.status(500).json({ error: error.message })

    const { data: counts } = await supabase.from('group_members').select('group_id')
    const countMap = {}
    for (const row of counts || []) countMap[row.group_id] = (countMap[row.group_id] || 0) + 1

    res.json({ groups: (data || []).map((g) => ({ ...g, memberCount: countMap[g.group_id] || 0 })) })
})

adminRouter.get('/groups/:groupId/members', async (req, res) => {
    const { data, error } = await supabase
        .from('group_members')
        .select('member_id, joined_at, users(push_name, balance, level)')
        .eq('group_id', req.params.groupId)
        .order('joined_at', { ascending: false })

    if (error) return res.status(500).json({ error: error.message })
    res.json({ members: data })
})

adminRouter.post('/broadcast/airdrop', async (req, res) => {
    const { groupId, amount } = req.body
    if (!groupId || !amount || amount <= 0) {
        return res.status(400).json({ error: 'groupId and a positive amount are required' })
    }

    const { data: airdrop, error } = await supabase
        .from('airdrops')
        .insert({ group_id: groupId, amount })
        .select()
        .maybeSingle()

    if (error) return res.status(500).json({ error: error.message })

    const sock = req.app.get('sock')
    if (sock) {
        await sock.sendMessage(groupId, {
            text: `🦩 AirDrop incoming, first to send .claim gets ₻${amount.toLocaleString()} added to their balance`
        })
    }

    broadcastUpdate('airdrop_sent', { groupId, amount })
    res.json({ success: true, airdrop })
})

adminRouter.post('/broadcast/message', async (req, res) => {
    const { groupId, text } = req.body
    if (!groupId || !text) return res.status(400).json({ error: 'groupId and text are required' })

    const sock = req.app.get('sock')
    if (!sock) return res.status(503).json({ error: 'WhatsApp connection not ready' })

    await sock.sendMessage(groupId, { text })
    broadcastUpdate('message_sent', { groupId })
    res.json({ success: true })
})

// ---------- SHOP CONFIG ----------

adminRouter.get('/shop', async (req, res) => {
    const { weapons, vehicles, houses } = await getShopListing()
    res.json({ weapons, vehicles, houses })
})

adminRouter.put('/shop/vehicle/:grade', async (req, res) => {
    const { price, crew_size, name } = req.body
    const update = {}
    if (price !== undefined) update.price = price
    if (crew_size !== undefined) update.crew_size = crew_size
    if (name !== undefined) update.name = name

    const { error } = await supabase.from('vehicle_grades').update(update).eq('grade', req.params.grade)
    if (error) return res.status(500).json({ error: error.message })
    broadcastUpdate('shop_updated', { catalog: 'vehicle', grade: req.params.grade })
    res.json({ success: true })
})

adminRouter.put('/shop/house/:grade', async (req, res) => {
    const { price, hourly_rate, daily_bonus, name } = req.body
    const update = {}
    if (price !== undefined) update.price = price
    if (hourly_rate !== undefined) update.hourly_rate = hourly_rate
    if (daily_bonus !== undefined) update.daily_bonus = daily_bonus
    if (name !== undefined) update.name = name

    const { error } = await supabase.from('house_grades').update(update).eq('grade', req.params.grade)
    if (error) return res.status(500).json({ error: error.message })
    broadcastUpdate('shop_updated', { catalog: 'house', grade: req.params.grade })
    res.json({ success: true })
})

// ---------- VAULTS (marriage) ----------

// List every active marriage with its vault balance — mirrors the in-chat
// .marriages listing, so the panel doesn't need a separate DB query.
adminRouter.get('/vaults', async (req, res) => {
    const couples = await getAllCouples()
    res.json({ vaults: couples })
})

adminRouter.get('/vault/:memberId', async (req, res) => {
    const result = await getVault(req.params.memberId)
    res.json(result)
})

// Force-empties a member's marriage vault and dissolves the marriage without
// touching balance/vehicle/house/inventory — for when you just need to clear
// a vault, not do a full kill.
adminRouter.post('/vault/:memberId/wipe', async (req, res) => {
    await forfeitMarriage(req.params.memberId)
    broadcastUpdate('vault_wiped', { memberId: req.params.memberId })
    res.json({ success: true })
})

// ---------- MODERATORS ----------

// The bot checks moderator status against a bare-digit member_id (stripped of
// "@s.whatsapp.net", ":device suffixes, "+", spaces, dashes — see
// normalizeJid in messageHandler.js). If an admin types a number into the
// panel with any of those still attached, it gets stored differently than
// what the bot compares against on a real message, and the moderator status
// silently never matches. Normalizing here keeps the two in sync.
function normalizeMemberId(raw) {
    return String(raw || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '')
}

adminRouter.get('/moderators', async (req, res) => {
    res.json({ moderators: await listModerators() })
})

adminRouter.post('/moderators', async (req, res) => {
    const memberId = normalizeMemberId(req.body?.memberId)
    if (!memberId) return res.status(400).json({ error: 'memberId is required' })
    const result = await addModerator(memberId, req.body?.addedBy || 'admin-panel')
    if (result.error) return res.status(500).json(result)
    res.json({ success: true })
})

adminRouter.delete('/moderators/:memberId', async (req, res) => {
    const result = await removeModerator(normalizeMemberId(req.params.memberId))
    if (result.error) return res.status(500).json(result)
    res.json({ success: true })
})

// ---------- SETTINGS ----------

adminRouter.get('/settings', async (req, res) => {
    res.json({ aiEnabled: await isAiEnabled() })
})

adminRouter.post('/settings', async (req, res) => {
    const { aiEnabled } = req.body
    if (typeof aiEnabled !== 'boolean') return res.status(400).json({ error: 'aiEnabled must be true/false' })
    const result = await setAiEnabled(aiEnabled)
    if (result.error) return res.status(500).json(result)
    broadcastUpdate('settings_updated', { aiEnabled })
    res.json({ success: true })
})
