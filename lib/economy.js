import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY

if (!supabaseUrl || !supabaseKey) {
    console.error('❌ Supabase environment variables are missing! Check your .env file.')
}

export const supabase = createClient(supabaseUrl, supabaseKey)

const STARTING_BALANCE = 1000
const LEVEL_UP_MESSAGE_INTERVAL = 50
const LEVEL_UP_REWARD = 100000
const DAILY_REWARD = 25000
const DAILY_COOLDOWN_MS = 24 * 60 * 60 * 1000
const STEAL_WINDOW_MS = 30 * 60 * 1000
const STEAL_MAX_ATTEMPTS = 2
const STEAL_SUCCESS_CHANCE = 0.3
const STEAL_FAIL_LOSS_RATE = 0.9
const GIVE_FEE_RATE = 0.05
const IMMUNITY_COST_PER_HOUR = 2000

// ---------- LOAN ----------
const LOAN_MAX = 100000
const LOAN_COOLDOWN_MS = 24 * 60 * 60 * 1000

// ---------- STRIP ----------
const STRIP_SUCCESS_CHANCE = 0.75
const STRIP_TARGET_WINDOW_MS = 60 * 60 * 1000
const STRIP_TARGET_MAX_HITS = 5

// ---------- SPY ----------
const SPY_COST = 5000

// ---------- SHOP ----------
// Three catalogs now:
//  - WEAPONS: stockpile-able consumables (same user_inventory mechanism the old
//    flat "ammo" item used) — one unit consumed per .rob/.steal, grade sets the
//    success-rate bonus on a flat +5%/grade ladder.
//  - VEHICLES / HOUSES: graded, one owned at a time (buying a new grade trades
//    in whatever you currently hold at the standard SELL_RATE). Their catalogs
//    live in the DB (vehicle_grades / house_grades tables) rather than here, so
//    the hourly house-income pg_cron job reads the exact same numbers this file
//    does — no drift between the two.
const WEAPON_ITEMS = {
    knife: { key: 'knife', grade: 1, name: 'Knife', emoji: '🔪', price: 100000, bonus: 0.05, consumable: true },
    bat: { key: 'bat', grade: 2, name: 'Bat', emoji: '🏏', price: 200000, bonus: 0.10, consumable: true },
    pistol: { key: 'pistol', grade: 3, name: 'Pistol', emoji: '🔫', price: 400000, bonus: 0.15, consumable: true },
    shotgun: { key: 'shotgun', grade: 4, name: 'Shotgun', emoji: '💥', price: 700000, bonus: 0.20, consumable: true },
    smg: { key: 'smg', grade: 5, name: 'SMG', emoji: '🔫', price: 1100000, bonus: 0.25, consumable: true },
    rifle: { key: 'rifle', grade: 6, name: 'Rifle', emoji: '🎯', price: 1600000, bonus: 0.30, consumable: true },
    grenade: { key: 'grenade', grade: 7, name: 'Grenade', emoji: '💣', price: 2200000, bonus: 0.35, consumable: true }
}
const WEAPON_LIST = Object.values(WEAPON_ITEMS).sort((a, b) => a.grade - b.grade).map((w) => ({
    ...w,
    description: `Consumable — +${Math.round(w.bonus * 100)}% success on your next .rob or .steal. One use per unit.`
}))

// Vehicle/house catalogs are small and near-static, so they're cached in memory
// rather than round-tripping to Supabase on every .shop/.buy/.rob call.
const GRADE_CACHE_TTL_MS = 5 * 60 * 1000
let vehicleGradesCache = null
let vehicleGradesCacheTime = 0
let houseGradesCache = null
let houseGradesCacheTime = 0

export async function getVehicleGrades() {
    if (vehicleGradesCache && Date.now() - vehicleGradesCacheTime < GRADE_CACHE_TTL_MS) return vehicleGradesCache
    const { data, error } = await supabase.from('vehicle_grades').select('*').order('grade', { ascending: true })
    if (error) {
        console.error('Error fetching vehicle grades:', error.message)
        return vehicleGradesCache || []
    }
    vehicleGradesCache = data || []
    vehicleGradesCacheTime = Date.now()
    return vehicleGradesCache
}

export async function getHouseGrades() {
    if (houseGradesCache && Date.now() - houseGradesCacheTime < GRADE_CACHE_TTL_MS) return houseGradesCache
    const { data, error } = await supabase.from('house_grades').select('*').order('grade', { ascending: true })
    if (error) {
        console.error('Error fetching house grades:', error.message)
        return houseGradesCache || []
    }
    houseGradesCache = data || []
    houseGradesCacheTime = Date.now()
    return houseGradesCache
}

// Normalizes user-typed item names for matching against a stored `key` or
// `name` — strips everything but letters/digits so "Private Island",
// "private_island", and "PRIVATE-ISLAND" all collapse to the same string.
function normalizeItemInput(text) {
    return String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function matchesItem(item, normalizedInput) {
    if (!normalizedInput) return false
    if (normalizeItemInput(item.key) === normalizedInput) return true
    if (item.name && normalizeItemInput(item.name) === normalizedInput) return true
    return false
}

async function findVehicleGrade(matcher) {
    const grades = await getVehicleGrades()
    return grades.find(matcher) || null
}

async function findHouseGrade(matcher) {
    const grades = await getHouseGrades()
    return grades.find(matcher) || null
}

// Crew cap for a .rob heist — 0 means "no vehicle, can't lead a heist".
export async function getCrewCap(memberId) {
    const user = await getOrCreateUser(memberId)
    if (!user.car_grade) return 0
    const grade = await findVehicleGrade((v) => v.grade === user.car_grade)
    return grade?.crew_size || 0
}

// Finds and consumes whichever owned weapon has the highest success bonus —
// players always get the best value out of their stockpile automatically.
export async function consumeBestWeapon(memberId) {
    const { data, error } = await supabase
        .from('user_inventory')
        .select('item_key, quantity')
        .eq('member_id', memberId)
        .gt('quantity', 0)

    if (error || !data || !data.length) return { bonus: 0, weapon: null }

    let best = null
    for (const row of data) {
        const w = WEAPON_ITEMS[row.item_key]
        if (w && (!best || w.bonus > best.bonus)) best = w
    }
    if (!best) return { bonus: 0, weapon: null }

    await consumeItem(memberId, best.key)
    return { bonus: best.bonus, weapon: best }
}

// ---------- USER CORE ----------

export async function getOrCreateUser(memberId, pushName = 'User') {
    const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('member_id', memberId)
        .maybeSingle()

    if (error) {
        console.error('Error fetching user:', error.message)
    }

    if (data) return data

    const newUser = {
        member_id: memberId,
        push_name: pushName,
        balance: STARTING_BALANCE,
        text_count: 0,
        level: 1,
        steal_wins: 0,
        steal_losses: 0,
        vault_balance: 0
    }

    const { data: created, error: createError } = await supabase
        .from('users')
        .insert([newUser])
        .select()
        .maybeSingle()

    if (createError) {
        // Handle race condition: user got created between our select and insert
        const { data: existing } = await supabase
            .from('users')
            .select('*')
            .eq('member_id', memberId)
            .maybeSingle()
        if (existing) return existing
        console.error('Error creating user:', createError.message)
        return newUser
    }

    return created
}

export async function updateUser(memberId, updates) {
    const { data, error } = await supabase
        .from('users')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('member_id', memberId)
        .select()
        .maybeSingle()

    if (error) {
        console.error('Error updating user:', error.message)
    }
    return data
}

// Called on every group message. One atomic round trip (via the increment_text_count
// Postgres function) instead of ~5-6 sequential calls — this is the hot path that runs
// on every single message, so it matters a lot under load.
export async function incrementTextCount(memberId, groupId, pushName, groupName) {
    const { data, error } = await supabase.rpc('increment_text_count', {
        p_member_id: memberId,
        p_group_id: groupId,
        p_push_name: pushName,
        p_group_name: groupName || null
    })

    if (error) {
        console.error('Error incrementing text count:', error.message)
        return { leveledUp: false, newLevel: 1, textCount: 0 }
    }

    const row = Array.isArray(data) ? data[0] : data
    return {
        leveledUp: Boolean(row?.leveled_up),
        newLevel: row?.new_level ?? 1,
        textCount: row?.new_text_count ?? 0
    }
}

export async function getTopN(n = 20) {
    const { data, error } = await supabase
        .from('users')
        .select('member_id, push_name, balance, level')
        .order('balance', { ascending: false })
        .limit(n)

    if (error) {
        console.error('Error fetching leaderboard:', error.message)
        return []
    }
    return data || []
}

export async function getProfile(memberId) {
    const user = await getOrCreateUser(memberId)

    const { count: rankCount } = await supabase
        .from('users')
        .select('member_id', { count: 'exact', head: true })
        .gt('balance', user.balance || 0)

    const marriage = await getActiveMarriage(memberId)
    const spouseId = marriage ? (marriage.partner1_id === memberId ? marriage.partner2_id : marriage.partner1_id) : null

    return {
        balance: Number(user.balance || 0),
        rank: (rankCount || 0) + 1,
        level: user.level || 1,
        text_count: user.text_count || 0,
        stealWins: user.steal_wins || 0,
        stealLosses: user.steal_losses || 0,
        vaultBalance: marriage ? Number(marriage.vault_balance || 0) : 0,
        spouseId
    }
}

// ---------- DAILY ----------

export async function claimDaily(memberId, pushName) {
    const user = await getOrCreateUser(memberId, pushName)

    if (user.last_airdrop) {
        const elapsed = Date.now() - new Date(user.last_airdrop).getTime()
        if (elapsed < DAILY_COOLDOWN_MS) {
            const remainingMs = DAILY_COOLDOWN_MS - elapsed
            const hours = Math.floor(remainingMs / (60 * 60 * 1000))
            const minutes = Math.floor((remainingMs % (60 * 60 * 1000)) / (60 * 1000))
            return { error: `Already claimed. Come back in ${hours}h ${minutes}m.` }
        }
    }

    let houseBonus = 0
    if (user.house_grade) {
        const grade = await findHouseGrade((h) => h.grade === user.house_grade)
        houseBonus = grade?.daily_bonus || 0
    }
    const grossReward = DAILY_REWARD + houseBonus

    const { repaid, credited, loanBalanceRemaining } = applyLoanRepayment(user, grossReward)

    await updateUser(memberId, {
        balance: Number(user.balance || 0) + credited,
        loan_balance: loanBalanceRemaining,
        last_airdrop: new Date().toISOString()
    })

    return { amount: grossReward, repaid, credited, houseBonus }
}

// ---------- LOAN ----------

// Pure helper (no DB call) — given a user row and a gross amount they just earned,
// figures out how much goes to paying off any outstanding loan_balance first and
// how much actually lands in their balance. Callers are responsible for persisting
// the returned values.
function applyLoanRepayment(user, grossAmount) {
    const owed = Number(user.loan_balance || 0)
    if (owed <= 0) return { repaid: 0, credited: grossAmount, loanBalanceRemaining: 0 }

    const repaid = Math.min(owed, grossAmount)
    return {
        repaid,
        credited: grossAmount - repaid,
        loanBalanceRemaining: owed - repaid
    }
}

// Called from messageHandler right after a level-up payout has already landed
// (the +100,000 is credited inside the increment_text_count RPC itself, since
// that's the hot path). This claws back whatever's owed against that fresh
// credit rather than re-deriving the payout — same net effect as if the loan
// had been deducted before the money ever arrived.
export async function repayLoanFromLevelUp(memberId, grossAmount) {
    const user = await getOrCreateUser(memberId)
    const owed = Number(user.loan_balance || 0)
    if (owed <= 0) return { repaid: 0 }

    const repaid = Math.min(owed, grossAmount)
    await updateUser(memberId, {
        balance: Number(user.balance || 0) - repaid,
        loan_balance: owed - repaid
    })
    return { repaid, loanBalanceRemaining: owed - repaid }
}

export async function takeLoan(memberId, amount, pushName) {
    if (!Number.isInteger(amount) || amount <= 0) return { error: 'Enter a valid amount.' }
    if (amount > LOAN_MAX) return { error: `Max loan is ${LOAN_MAX.toLocaleString()} habz.` }

    const user = await getOrCreateUser(memberId, pushName)

    if (user.last_loan_at) {
        const elapsed = Date.now() - new Date(user.last_loan_at).getTime()
        if (elapsed < LOAN_COOLDOWN_MS) {
            const remainingMs = LOAN_COOLDOWN_MS - elapsed
            const hours = Math.floor(remainingMs / (60 * 60 * 1000))
            const minutes = Math.floor((remainingMs % (60 * 60 * 1000)) / (60 * 1000))
            return { error: `Already took a loan. Come back in ${hours}h ${minutes}m.` }
        }
    }

    const newLoanBalance = Number(user.loan_balance || 0) + amount

    await updateUser(memberId, {
        balance: Number(user.balance || 0) + amount,
        loan_balance: newLoanBalance,
        last_loan_at: new Date().toISOString()
    })

    await supabase.from('transactions').insert({
        sender_id: null,
        receiver_id: memberId,
        amount,
        tx_type: 'loan',
        description: `Total owed: ${newLoanBalance}`
    })

    return { amount, totalOwed: newLoanBalance }
}

// ---------- ADMIN: GIVE-ALL & ONE-TIME TAX ----------

export async function giveAllMembers(groupId, amount) {
    if (!groupId) return { error: 'No group to drop this in.' }
    if (!Number.isInteger(amount) || amount <= 0) return { error: 'Enter a valid amount.' }

    const { data, error } = await supabase.rpc('give_all_members', {
        p_group_id: groupId,
        p_amount: amount
    })

    if (error) {
        console.error('Error running give-all:', error.message)
        return { error: 'Something broke handing out money.' }
    }

    return { affectedCount: data ?? 0, amount }
}

export async function grantBonus(targetId, amount) {
    if (!Number.isInteger(amount) || amount <= 0) return { error: 'Enter a valid amount.' }

    const user = await getOrCreateUser(targetId)
    await updateUser(targetId, { balance: Number(user.balance || 0) + amount })

    await supabase.from('transactions').insert({
        sender_id: null,
        receiver_id: targetId,
        amount,
        tx_type: 'bonus',
        description: 'admin-granted bonus'
    })

    return { amount }
}

export async function taxAllMembers(groupId, percent) {
    if (!groupId) return { error: 'No group to tax.' }
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100) return { error: 'Enter a percent between 1 and 100.' }

    const { data, error } = await supabase.rpc('tax_all_members', {
        p_group_id: groupId,
        p_percent: percent
    })

    if (error) {
        console.error('Error running tax:', error.message)
        return { error: 'Something broke collecting that tax.' }
    }

    const row = Array.isArray(data) ? data[0] : data
    return { affectedCount: row?.affected_count ?? 0, totalCollected: Number(row?.total_collected ?? 0), percent }
}

// ---------- GROUP AIRDROP (admin-triggered, first .claim wins) ----------

const AIRDROP_MIN = 50000
const AIRDROP_MAX = 150000

export async function createGroupAirdrop(groupId) {
    if (!groupId) return { error: 'No group to drop this in.' }

    // Rounded to the nearest 1,000 for a cleaner-looking announcement.
    const amount = Math.round((Math.random() * (AIRDROP_MAX - AIRDROP_MIN) + AIRDROP_MIN) / 1000) * 1000

    const { error } = await supabase.from('airdrops').insert({
        group_id: groupId,
        amount,
        is_claimed: false,
        dropped_at: new Date().toISOString()
    })

    if (error) {
        console.error('Error creating airdrop:', error.message)
        return { error: 'Something broke dropping that airdrop.' }
    }

    return { amount }
}

export async function claimGroupAirdrop(memberId, groupId, pushName) {
    if (!groupId) return { error: 'No airdrop to claim here.' }

    const { data: airdrop, error } = await supabase
        .from('airdrops')
        .select('*')
        .eq('group_id', groupId)
        .eq('is_claimed', false)
        .order('dropped_at', { ascending: false })
        .limit(1)
        .maybeSingle()

    if (error) {
        console.error('Error fetching airdrop:', error.message)
        return { error: 'Something broke checking the airdrop.' }
    }
    if (!airdrop) return { error: 'No active airdrop in this group right now.' }

    const { data: claimed, error: claimError } = await supabase
        .from('airdrops')
        .update({ is_claimed: true, claimed_by: memberId, claimed_at: new Date().toISOString() })
        .eq('id', airdrop.id)
        .eq('is_claimed', false)
        .select()
        .maybeSingle()

    if (claimError || !claimed) {
        return { error: 'Someone already beat you to it.' }
    }

    const user = await getOrCreateUser(memberId, pushName)
    await updateUser(memberId, { balance: Number(user.balance || 0) + Number(claimed.amount) })

    return { amount: Number(claimed.amount) }
}

// ---------- STEAL ----------

export async function attemptSteal(stealerId, targetId, groupId, pushName) {
    if (stealerId === targetId) return { error: "You can't steal from yourself." }

    const stealer = await getOrCreateUser(stealerId, pushName)
    const target = await getOrCreateUser(targetId)

    if (isKilled(target)) return { error: "They're dead. Nothing left to steal from a corpse." }

    if (target.immunity_until && new Date(target.immunity_until).getTime() > Date.now()) {
        return { error: 'Target has immunity right now. Try someone else.' }
    }

    let attemptsUsed = stealer.steal_count_24h || 0
    if (!stealer.last_steal_time || Date.now() - new Date(stealer.last_steal_time).getTime() > STEAL_WINDOW_MS) {
        attemptsUsed = 0
    }

    if (attemptsUsed >= STEAL_MAX_ATTEMPTS) {
        const elapsed = Date.now() - new Date(stealer.last_steal_time).getTime()
        const remainingMs = STEAL_WINDOW_MS - elapsed
        const minutes = Math.max(1, Math.ceil(remainingMs / (60 * 1000)))
        return { error: `You're out of steal attempts. Try again in ${minutes}m.` }
    }

    // Weapon is only spent once every other condition above has passed —
    // no point burning stock on an attempt that was never going to happen.
    const { bonus: weaponBonus, weapon } = await consumeBestWeapon(stealerId)

    const success = Math.random() < (STEAL_SUCCESS_CHANCE + weaponBonus)
    let movedAmount = 0

    if (success) {
        movedAmount = Number(target.balance || 0)
        await updateUser(targetId, { balance: 0 })
        await updateUser(stealerId, {
            balance: Number(stealer.balance || 0) + movedAmount,
            steal_wins: (stealer.steal_wins || 0) + 1,
            steal_count_24h: attemptsUsed + 1,
            last_steal_time: new Date().toISOString()
        })
    } else {
        movedAmount = Math.floor(Number(stealer.balance || 0) * STEAL_FAIL_LOSS_RATE)
        await updateUser(stealerId, {
            balance: Number(stealer.balance || 0) - movedAmount,
            steal_losses: (stealer.steal_losses || 0) + 1,
            steal_count_24h: attemptsUsed + 1,
            last_steal_time: new Date().toISOString()
        })
        await updateUser(targetId, { balance: Number(target.balance || 0) + movedAmount })
    }

    await supabase.from('steal_attempts').insert({
        stealer_id: stealerId,
        target_id: targetId,
        group_id: groupId,
        amount: movedAmount,
        success
    })

    return { success, movedAmount, weapon }
}

// ---------- HEIST (.rob) ----------
// Note: the identity of who's on the crew and the 10-second recruiting window
// itself is tracked in-memory in messageHandler.js (it's real-time/transient).
// This file only handles the cooldown check and the atomic payout once a heist
// resolves.

const ROB_SUCCESS_CHANCE = 0.5
const ROB_TARGET_WINDOW_MS = 60 * 60 * 1000
const ROB_TARGET_MAX_HITS = 5

export async function checkRobCooldown(targetId) {
    const windowStart = new Date(Date.now() - ROB_TARGET_WINDOW_MS).toISOString()

    const { data, error } = await supabase
        .from('heists')
        .select('resolved_at')
        .eq('target_id', targetId)
        .gte('resolved_at', windowStart)
        .order('resolved_at', { ascending: true })

    if (error) {
        console.error('Error checking rob cooldown:', error.message)
        return { onCooldown: false }
    }

    const hits = data || []
    if (hits.length < ROB_TARGET_MAX_HITS) return { onCooldown: false }

    // Once the oldest of the last 5 hits ages out of the window, a new slot opens up.
    const oldest = new Date(hits[0].resolved_at).getTime()
    const remainingMs = ROB_TARGET_WINDOW_MS - (Date.now() - oldest)
    const minutes = Math.max(1, Math.ceil(remainingMs / (60 * 1000)))
    return { onCooldown: true, minutes }
}

export async function resolveHeist(groupId, targetId, initiatorId, crewIds, weaponBonus = 0) {
    const success = Math.random() < (ROB_SUCCESS_CHANCE + weaponBonus)

    const { data, error } = await supabase.rpc('resolve_heist', {
        p_target_id: targetId,
        p_crew_ids: crewIds,
        p_success: success
    })

    if (error) {
        console.error('Error resolving heist:', error.message)
        return { error: 'Something broke resolving the heist.' }
    }

    const row = Array.isArray(data) ? data[0] : data
    const totalMoved = Number(row?.total_moved ?? 0)
    const perMemberShare = Number(row?.per_member_share ?? 0)

    await supabase.from('heists').insert({
        group_id: groupId,
        target_id: targetId,
        initiator_id: initiatorId,
        crew_ids: crewIds,
        success,
        amount_moved: totalMoved,
        resolved_at: new Date().toISOString()
    })

    return { success, totalMoved, perMemberShare, crewSize: crewIds.length }
}

// ---------- GIVE ----------

export async function giveMoney(senderId, targetId, amount, groupId, pushName) {
    if (senderId === targetId) return { error: "You can't send money to yourself." }
    if (!Number.isInteger(amount) || amount <= 0) return { error: 'Enter a valid amount.' }

    const sender = await getOrCreateUser(senderId, pushName)
    if (Number(sender.balance || 0) < amount) return { error: "You don't have that much." }

    const fee = Math.floor(amount * GIVE_FEE_RATE)
    const amountReceived = amount - fee

    const target = await getOrCreateUser(targetId)

    await updateUser(senderId, { balance: Number(sender.balance || 0) - amount })
    await updateUser(targetId, { balance: Number(target.balance || 0) + amountReceived })

    await supabase.from('transactions').insert({
        sender_id: senderId,
        receiver_id: targetId,
        group_id: groupId,
        amount,
        tx_type: 'give',
        description: `Fee: ${fee}`
    })

    return { amountReceived, fee }
}

// ---------- IMMUNITY ----------

export async function buyImmunity(memberId, hours, groupId, pushName) {
    if (!Number.isInteger(hours) || hours <= 0) return { error: 'Enter a valid number of hours.' }

    const user = await getOrCreateUser(memberId, pushName)
    const cost = hours * IMMUNITY_COST_PER_HOUR

    if (Number(user.balance || 0) < cost) return { error: `You need ${cost.toLocaleString()} habz for that.` }

    const currentImmunity = user.immunity_until && new Date(user.immunity_until).getTime() > Date.now()
        ? new Date(user.immunity_until).getTime()
        : Date.now()

    const newImmunityUntil = new Date(currentImmunity + hours * 60 * 60 * 1000).toISOString()

    await updateUser(memberId, {
        balance: Number(user.balance || 0) - cost,
        immunity_until: newImmunityUntil
    })

    return { hours, cost }
}

// ---------- COINFLIP ----------

export async function coinflip(memberId, amount, groupId, pushName) {
    if (!Number.isInteger(amount) || amount <= 0) return { error: 'Enter a valid amount.' }

    const user = await getOrCreateUser(memberId, pushName)
    if (Number(user.balance || 0) < amount) return { error: "You don't have that much to bet." }

    const won = Math.random() < 0.5
    const newBalance = won ? Number(user.balance || 0) + amount : Number(user.balance || 0) - amount

    await updateUser(memberId, { balance: newBalance })

    await supabase.from('transactions').insert({
        sender_id: memberId,
        receiver_id: null,
        group_id: groupId,
        amount,
        tx_type: 'coinflip',
        description: won ? 'win' : 'loss'
    })

    return { won, amount }
}

// ---------- MARRIAGE ----------

async function getActiveMarriage(memberId) {
    const { data, error } = await supabase
        .from('marriages')
        .select('*')
        .or(`partner1_id.eq.${memberId},partner2_id.eq.${memberId}`)
        .eq('status', 'married')
        .maybeSingle()

    if (error) {
        console.error('Error fetching marriage:', error.message)
        return null
    }
    return data
}

async function getAnyActiveOrPendingMarriage(memberId) {
    const { data, error } = await supabase
        .from('marriages')
        .select('*')
        .or(`partner1_id.eq.${memberId},partner2_id.eq.${memberId}`)
        .in('status', ['pending', 'married'])
        .maybeSingle()

    if (error) {
        console.error('Error fetching marriage:', error.message)
        return null
    }
    return data
}

export async function getAllCouples() {
    const { data, error } = await supabase
        .from('marriages')
        .select('partner1_id, partner2_id, vault_balance, married_at')
        .eq('status', 'married')
        .order('married_at', { ascending: true })

    if (error) {
        console.error('Error fetching couples:', error.message)
        return []
    }
    if (!data || !data.length) return []

    const ids = [...new Set(data.flatMap((m) => [m.partner1_id, m.partner2_id]))]
    const { data: users } = await supabase
        .from('users')
        .select('member_id, push_name')
        .in('member_id', ids)

    const nameById = new Map((users || []).map((u) => [u.member_id, u.push_name]))

    return data.map((m) => ({
        partner1Id: m.partner1_id,
        partner2Id: m.partner2_id,
        partner1Name: nameById.get(m.partner1_id) || 'Someone',
        partner2Name: nameById.get(m.partner2_id) || 'Someone',
        vaultBalance: Number(m.vault_balance || 0),
        marriedAt: m.married_at
    }))
}

export async function proposeMarriage(proposerId, targetId, pushName) {
    if (proposerId === targetId) return { error: "You can't marry yourself." }

    await getOrCreateUser(proposerId, pushName)
    await getOrCreateUser(targetId)

    const proposerExisting = await getAnyActiveOrPendingMarriage(proposerId)
    if (proposerExisting) {
        return { error: proposerExisting.status === 'married' ? "You're already married." : 'You already have a pending proposal.' }
    }

    const targetExisting = await getAnyActiveOrPendingMarriage(targetId)
    if (targetExisting) {
        return { error: "They're already taken or have a pending proposal." }
    }

    const { error } = await supabase.from('marriages').insert({
        partner1_id: proposerId,
        partner2_id: targetId,
        status: 'pending',
        proposed_by: proposerId
    })

    if (error) {
        console.error('Error creating proposal:', error.message)
        return { error: 'Something broke sending that proposal.' }
    }

    return { success: true }
}

export async function acceptMarriage(accepterId) {
    const { data: proposal, error } = await supabase
        .from('marriages')
        .select('*')
        .eq('partner2_id', accepterId)
        .eq('status', 'pending')
        .order('proposed_at', { ascending: false })
        .limit(1)
        .maybeSingle()

    if (error) {
        console.error('Error fetching proposal:', error.message)
        return { error: 'Something broke checking your proposals.' }
    }
    if (!proposal) return { error: "You don't have a pending proposal." }

    const { error: updateError } = await supabase
        .from('marriages')
        .update({ status: 'married', married_at: new Date().toISOString() })
        .eq('id', proposal.id)

    if (updateError) {
        console.error('Error accepting marriage:', updateError.message)
        return { error: 'Something broke accepting that proposal.' }
    }

    return { spouseId: proposal.partner1_id }
}

export async function cancelProposal(memberId) {
    const { data: proposal, error } = await supabase
        .from('marriages')
        .select('*')
        .or(`partner1_id.eq.${memberId},partner2_id.eq.${memberId}`)
        .eq('status', 'pending')
        .order('proposed_at', { ascending: false })
        .limit(1)
        .maybeSingle()

    if (error) {
        console.error('Error fetching proposal to cancel:', error.message)
        return { error: 'Something broke checking your proposals.' }
    }
    if (!proposal) return { error: "You don't have a pending proposal." }

    const { error: updateError } = await supabase
        .from('marriages')
        .update({ status: 'cancelled' })
        .eq('id', proposal.id)

    if (updateError) {
        console.error('Error cancelling proposal:', updateError.message)
        return { error: 'Something broke cancelling that proposal.' }
    }

    const otherId = proposal.partner1_id === memberId ? proposal.partner2_id : proposal.partner1_id
    return { otherId }
}

export async function divorce(memberId) {
    const marriage = await getActiveMarriage(memberId)
    if (!marriage) return { error: "You're not married." }

    const splitAmount = Math.floor(Number(marriage.vault_balance || 0) / 2)

    if (splitAmount > 0) {
        const partner1 = await getOrCreateUser(marriage.partner1_id)
        const partner2 = await getOrCreateUser(marriage.partner2_id)
        await updateUser(marriage.partner1_id, { balance: Number(partner1.balance || 0) + splitAmount })
        await updateUser(marriage.partner2_id, { balance: Number(partner2.balance || 0) + splitAmount })
    }

    const { error } = await supabase
        .from('marriages')
        .update({ status: 'divorced', divorced_at: new Date().toISOString(), vault_balance: 0 })
        .eq('id', marriage.id)

    if (error) {
        console.error('Error divorcing:', error.message)
        return { error: 'Something broke ending that marriage.' }
    }

    return { splitAmount }
}

export async function getVault(memberId) {
    const marriage = await getActiveMarriage(memberId)
    if (!marriage) return { error: "You're not married." }
    return { vaultBalance: Number(marriage.vault_balance || 0) }
}

export async function depositToVault(memberId, amount) {
    if (!Number.isInteger(amount) || amount <= 0) return { error: 'Enter a valid amount.' }

    const marriage = await getActiveMarriage(memberId)
    if (!marriage) return { error: "You're not married." }

    const user = await getOrCreateUser(memberId)
    if (Number(user.balance || 0) < amount) return { error: "You don't have that much." }

    await updateUser(memberId, { balance: Number(user.balance || 0) - amount })

    const { error } = await supabase
        .from('marriages')
        .update({ vault_balance: Number(marriage.vault_balance || 0) + amount })
        .eq('id', marriage.id)

    if (error) {
        console.error('Error depositing to vault:', error.message)
        return { error: 'Something broke depositing that.' }
    }

    return { success: true }
}

export async function withdrawFromVault(memberId, amount) {
    if (!Number.isInteger(amount) || amount <= 0) return { error: 'Enter a valid amount.' }

    const marriage = await getActiveMarriage(memberId)
    if (!marriage) return { error: "You're not married." }
    if (Number(marriage.vault_balance || 0) < amount) return { error: "The vault doesn't have that much." }

    const user = await getOrCreateUser(memberId)

    const { error } = await supabase
        .from('marriages')
        .update({ vault_balance: Number(marriage.vault_balance || 0) - amount })
        .eq('id', marriage.id)

    if (error) {
        console.error('Error withdrawing from vault:', error.message)
        return { error: 'Something broke withdrawing that.' }
    }

    await updateUser(memberId, { balance: Number(user.balance || 0) + amount })

    return { success: true }
}

// Kept for the admin dashboard's leaderboard formatting endpoint
export async function getLeaderboardFormatted() {
    const data = await getTopN(20)

    if (!data || data.length === 0) {
        return '🏆 *HABIBI TOP BALANCES* 🏆\n\nNo records found yet!'
    }

    let text = '🏆 *Top 20 Flexers* 🏆\n\n'
    data.forEach((user, index) => {
        const name = user.push_name || 'Anonymous'
        const bal = Number(user.balance || 0).toLocaleString()
        text += `${index + 1}. *${name}* :\n     *BALANCE* - _₻${bal}_\n\n`
    })

    return text.trim()
}

// ---------- STRIP ----------
// 75% chance, costs a flat fee regardless of outcome — a successful hit just
// cancels the target's active steal immunity, no money moves between actor and
// target either way. Rate-limited per target (not per actor): once a target's
// been hit 5 times in an hour by anyone, they're safe for the rest of that window.
const STRIP_COST = 7500

export async function attemptStrip(actorId, targetId, groupId, pushName) {
    if (actorId === targetId) return { error: "You can't strip your own immunity." }

    const windowStart = new Date(Date.now() - STRIP_TARGET_WINDOW_MS).toISOString()
    const { data: recentHits, error: countError } = await supabase
        .from('strip_attempts')
        .select('attempted_at')
        .eq('target_id', targetId)
        .gte('attempted_at', windowStart)
        .order('attempted_at', { ascending: true })

    if (countError) {
        console.error('Error checking strip rate limit:', countError.message)
        return { error: 'Something broke checking that.' }
    }

    if ((recentHits || []).length >= STRIP_TARGET_MAX_HITS) {
        const oldest = new Date(recentHits[0].attempted_at).getTime()
        const remainingMs = STRIP_TARGET_WINDOW_MS - (Date.now() - oldest)
        const minutes = Math.max(1, Math.ceil(remainingMs / (60 * 1000)))
        return { error: `They've been stripped enough this hour. Try again in ${minutes}m.` }
    }

    const target = await getOrCreateUser(targetId, undefined)
    const actor = await getOrCreateUser(actorId, pushName)

    if (isKilled(target)) return { error: "They're dead. Nothing to strip off a corpse." }

    if (Number(actor.balance || 0) < STRIP_COST) {
        return { error: `You need ${STRIP_COST.toLocaleString()} habz to try that.` }
    }

    const success = Math.random() < STRIP_SUCCESS_CHANCE
    const hadImmunity = Boolean(target.immunity_until && new Date(target.immunity_until).getTime() > Date.now())

    await updateUser(actorId, { balance: Number(actor.balance || 0) - STRIP_COST })

    if (success && hadImmunity) {
        await updateUser(targetId, { immunity_until: null })
    }

    await supabase.from('strip_attempts').insert({
        actor_id: actorId,
        target_id: targetId,
        group_id: groupId,
        success
    })

    await supabase.from('transactions').insert({
        sender_id: actorId,
        receiver_id: null,
        amount: STRIP_COST,
        tx_type: 'strip',
        description: `Strip attempt on ${targetId}`
    })

    return { success, hadImmunity, removedImmunity: success && hadImmunity, cost: STRIP_COST }
}

// ---------- SPY ----------

export async function spyOnUser(actorId, targetId, pushName) {
    if (actorId === targetId) return { error: 'Just check `.profile`.' }

    const actor = await getOrCreateUser(actorId, pushName)
    if (Number(actor.balance || 0) < SPY_COST) return { error: `You need ${SPY_COST.toLocaleString()} habz for that.` }

    const target = await getOrCreateUser(targetId)
    const profile = await getProfile(targetId)
    const inventory = await getInventory(targetId)

    await updateUser(actorId, { balance: Number(actor.balance || 0) - SPY_COST })

    const immunityActive = Boolean(target.immunity_until && new Date(target.immunity_until).getTime() > Date.now())
    const immunityMinutesLeft = immunityActive
        ? Math.ceil((new Date(target.immunity_until).getTime() - Date.now()) / (60 * 1000))
        : 0

    let spouseName = null
    if (profile.spouseId) {
        const spouse = await getOrCreateUser(profile.spouseId)
        spouseName = spouse?.push_name || 'Someone'
    }

    return {
        cost: SPY_COST,
        balance: profile.balance,
        level: profile.level,
        rank: profile.rank,
        stealWins: profile.stealWins,
        stealLosses: profile.stealLosses,
        loanBalance: Number(target.loan_balance || 0),
        immunityActive,
        immunityMinutesLeft,
        spouseName,
        inventory
    }
}

// ---------- SHOP / INVENTORY ----------

export async function getShopListing() {
    const [vehicles, houses] = await Promise.all([getVehicleGrades(), getHouseGrades()])
    return { weapons: WEAPON_LIST, vehicles, houses }
}

export async function getInventory(memberId) {
    const user = await getOrCreateUser(memberId)

    const { data, error } = await supabase
        .from('user_inventory')
        .select('item_key, quantity')
        .eq('member_id', memberId)
        .gt('quantity', 0)

    if (error) {
        console.error('Error fetching inventory:', error.message)
    }

    const weapons = (data || [])
        .map((row) => ({ ...WEAPON_ITEMS[row.item_key], quantity: row.quantity }))
        .filter((item) => item.key)

    const vehicle = user.car_grade ? await findVehicleGrade((v) => v.grade === user.car_grade) : null
    const house = user.house_grade ? await findHouseGrade((h) => h.grade === user.house_grade) : null

    return { weapons, vehicle, house }
}

export async function hasItem(memberId, itemKey) {
    const { data, error } = await supabase
        .from('user_inventory')
        .select('quantity')
        .eq('member_id', memberId)
        .eq('item_key', itemKey)
        .maybeSingle()

    if (error) {
        console.error('Error checking inventory item:', error.message)
        return false
    }
    return Boolean(data && data.quantity > 0)
}

// Consumes one unit of a consumable item (currently just ammo). Returns
// whether a unit was actually available and got used.
export async function consumeItem(memberId, itemKey) {
    const { data, error } = await supabase
        .from('user_inventory')
        .select('quantity')
        .eq('member_id', memberId)
        .eq('item_key', itemKey)
        .maybeSingle()

    if (error || !data || data.quantity <= 0) return false

    await supabase
        .from('user_inventory')
        .update({ quantity: data.quantity - 1, updated_at: new Date().toISOString() })
        .eq('member_id', memberId)
        .eq('item_key', itemKey)

    return true
}

// Sell back at a 25% loss — you get 75% of the original price. Also what a
// vehicle/house trade-in refunds when upgrading to a new grade.
const SELL_RATE = 0.75

async function buyWeapon(memberId, item, pushName) {
    const user = await getOrCreateUser(memberId, pushName)
    if (Number(user.balance || 0) < item.price) {
        return { error: `You need ${item.price.toLocaleString()} habz for a ${item.name.toLowerCase()}. You're nowhere close.` }
    }

    await updateUser(memberId, { balance: Number(user.balance || 0) - item.price })

    const { data: existing } = await supabase
        .from('user_inventory')
        .select('quantity')
        .eq('member_id', memberId)
        .eq('item_key', item.key)
        .maybeSingle()

    if (existing) {
        await supabase
            .from('user_inventory')
            .update({ quantity: existing.quantity + 1, updated_at: new Date().toISOString() })
            .eq('member_id', memberId)
            .eq('item_key', item.key)
    } else {
        await supabase
            .from('user_inventory')
            .insert({ member_id: memberId, item_key: item.key, quantity: 1 })
    }

    await supabase.from('transactions').insert({
        sender_id: memberId,
        receiver_id: null,
        amount: item.price,
        tx_type: 'shop',
        description: `Bought: ${item.name}`
    })

    return { item: { emoji: item.emoji, name: item.name, price: item.price } }
}

async function sellWeapon(memberId, item) {
    const { data: existing, error } = await supabase
        .from('user_inventory')
        .select('quantity')
        .eq('member_id', memberId)
        .eq('item_key', item.key)
        .maybeSingle()

    if (error) {
        console.error('Error checking inventory before sell:', error.message)
        return { error: 'Something broke checking your inventory.' }
    }
    if (!existing || existing.quantity <= 0) {
        return { error: `You don't own a ${item.name.toLowerCase()}.` }
    }

    const sellPrice = Math.floor(item.price * SELL_RATE)

    await supabase
        .from('user_inventory')
        .update({ quantity: existing.quantity - 1, updated_at: new Date().toISOString() })
        .eq('member_id', memberId)
        .eq('item_key', item.key)

    const user = await getOrCreateUser(memberId)
    await updateUser(memberId, { balance: Number(user.balance || 0) + sellPrice })

    await supabase.from('transactions').insert({
        sender_id: null,
        receiver_id: memberId,
        amount: sellPrice,
        tx_type: 'shop_sell',
        description: `Sold: ${item.name}`
    })

    return { item: { emoji: item.emoji, name: item.name, price: item.price }, sellPrice, lostAmount: item.price - sellPrice }
}

// Shared trade-in logic for vehicles/houses: buying a new grade automatically
// sells whatever grade is currently owned (at SELL_RATE) and applies that as
// credit toward the new purchase, rather than requiring a separate .sell first.
async function buyGradedAsset({ memberId, pushName, targetGrade, currentGradeNum, gradeColumn, findGrade }) {
    if (currentGradeNum === targetGrade.grade) {
        return { error: `You already own the ${targetGrade.name}.` }
    }

    const user = await getOrCreateUser(memberId, pushName)
    let refund = 0
    let upgradedFrom = null
    if (currentGradeNum) {
        const current = await findGrade((g) => g.grade === currentGradeNum)
        if (current) {
            refund = Math.floor(current.price * SELL_RATE)
            upgradedFrom = current
        }
    }

    const netCost = targetGrade.price - refund
    if (Number(user.balance || 0) < netCost) {
        return { error: `You need ${netCost.toLocaleString()} habz for the ${targetGrade.name.toLowerCase()}${refund ? ` (after trading in your ${upgradedFrom.name.toLowerCase()})` : ''}. You're nowhere close.` }
    }

    await updateUser(memberId, {
        balance: Number(user.balance || 0) - netCost,
        [gradeColumn]: targetGrade.grade
    })

    await supabase.from('transactions').insert({
        sender_id: memberId,
        receiver_id: null,
        amount: netCost,
        tx_type: 'shop',
        description: upgradedFrom ? `Traded ${upgradedFrom.name} for ${targetGrade.name}` : `Bought: ${targetGrade.name}`
    })

    return { item: targetGrade, netCost, refund, upgradedFrom }
}

async function sellGradedAsset({ memberId, currentGradeNum, gradeColumn, findGrade, emptyErrorLabel }) {
    if (!currentGradeNum) return { error: `You don't own a ${emptyErrorLabel}.` }

    const current = await findGrade((g) => g.grade === currentGradeNum)
    if (!current) return { error: `You don't own a ${emptyErrorLabel}.` }

    const sellPrice = Math.floor(current.price * SELL_RATE)
    const user = await getOrCreateUser(memberId)

    await updateUser(memberId, {
        balance: Number(user.balance || 0) + sellPrice,
        [gradeColumn]: 0
    })

    await supabase.from('transactions').insert({
        sender_id: null,
        receiver_id: memberId,
        amount: sellPrice,
        tx_type: 'shop_sell',
        description: `Sold: ${current.name}`
    })

    return { item: current, sellPrice, lostAmount: current.price - sellPrice }
}

// Router: figures out whether the given text is a weapon, vehicle, or house and
// dispatches to the right purchase flow. Matches against each item's short
// `key` (e.g. "submarine") OR its display `name` (e.g. "Private Island"),
// case/spacing/punctuation-insensitive, since `.shop` only ever shows names.
export async function buyShopItem(memberId, rawInput, pushName) {
    const normalizedInput = normalizeItemInput(rawInput)

    const weapon = Object.values(WEAPON_ITEMS).find((w) => matchesItem(w, normalizedInput))
    if (weapon) return buyWeapon(memberId, weapon, pushName)

    const vehicleGrade = await findVehicleGrade((v) => matchesItem(v, normalizedInput))
    if (vehicleGrade) {
        const user = await getOrCreateUser(memberId, pushName)
        return buyGradedAsset({
            memberId, pushName,
            targetGrade: vehicleGrade,
            currentGradeNum: user.car_grade,
            gradeColumn: 'car_grade',
            findGrade: findVehicleGrade
        })
    }

    const houseGrade = await findHouseGrade((h) => matchesItem(h, normalizedInput))
    if (houseGrade) {
        const user = await getOrCreateUser(memberId, pushName)
        return buyGradedAsset({
            memberId, pushName,
            targetGrade: houseGrade,
            currentGradeNum: user.house_grade,
            gradeColumn: 'house_grade',
            findGrade: findHouseGrade
        })
    }

    return { error: `No such item. Try \`.shop\` to see what's on sale.` }
}

// Router for .sell — also accepts the generic "car"/"house" aliases so players
// don't need to remember exactly which grade they currently own.
export async function sellShopItem(memberId, rawInput) {
    const normalizedInput = normalizeItemInput(rawInput)

    const weapon = Object.values(WEAPON_ITEMS).find((w) => matchesItem(w, normalizedInput))
    if (weapon) return sellWeapon(memberId, weapon)

    if (normalizedInput === 'car' || (await findVehicleGrade((v) => matchesItem(v, normalizedInput)))) {
        const user = await getOrCreateUser(memberId)
        return sellGradedAsset({
            memberId,
            currentGradeNum: user.car_grade,
            gradeColumn: 'car_grade',
            findGrade: findVehicleGrade,
            emptyErrorLabel: 'vehicle'
        })
    }

    if (normalizedInput === 'house' || (await findHouseGrade((h) => matchesItem(h, normalizedInput)))) {
        const user = await getOrCreateUser(memberId)
        return sellGradedAsset({
            memberId,
            currentGradeNum: user.house_grade,
            gradeColumn: 'house_grade',
            findGrade: findHouseGrade,
            emptyErrorLabel: 'house'
        })
    }

    return { error: `No such item. Try \`.inventory\` to see what you own.` }
}

// ---------- KILL / REVIVE / BULLETPROOF ----------
// .kill has no random component — the cost IS the success chance, so it
// always lands unless the target is bulletproof. It wipes the target's
// balance and inventory only — their vehicle, house, and marriage vault are
// left untouched — and locks them out of every command for 25 minutes via
// killed_until. .revive just lifts that lockout — it deliberately does NOT
// restore anything, since "start a new life" is the whole point.
const KILL_COST = 1000000
const KILL_LOCKOUT_MS = 25 * 60 * 1000
const REVIVE_COST = 5000
const STRIP_BULLETPROOF_COST = 10000000

const DURATION_UNIT_MS = {
    sec: 1000, secs: 1000, second: 1000, seconds: 1000,
    min: 60 * 1000, mins: 60 * 1000, minute: 60 * 1000, minutes: 60 * 1000,
    hr: 60 * 60 * 1000, hrs: 60 * 60 * 1000, hour: 60 * 60 * 1000, hours: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000, days: 24 * 60 * 60 * 1000
}

export function parseBulletproofDuration(amountRaw, unitRaw) {
    const amount = parseInt(amountRaw, 10)
    const unit = (unitRaw || '').toLowerCase()
    if (!Number.isInteger(amount) || amount <= 0) return null
    const unitMs = DURATION_UNIT_MS[unit]
    if (!unitMs) return null
    return amount * unitMs
}

export function isKilled(user) {
    return Boolean(user?.killed_until && new Date(user.killed_until).getTime() > Date.now())
}

export function isBulletproof(user) {
    return Boolean(user?.bulletproof_until && new Date(user.bulletproof_until).getTime() > Date.now())
}

// Dissolves a marriage without splitting the vault — the vault gets wiped
// entirely, since .kill is a robbery, not a divorce. Exported so the admin
// panel's kill/wipe-vault actions can reuse the exact same logic as the
// in-chat .kill command, instead of drifting out of sync with it.
export async function forfeitMarriage(memberId) {
    const marriage = await getActiveMarriage(memberId)
    if (!marriage) return
    const { error } = await supabase
        .from('marriages')
        .update({ status: 'divorced', divorced_at: new Date().toISOString(), vault_balance: 0 })
        .eq('id', marriage.id)
    if (error) {
        console.error(`Error forfeiting marriage ${marriage.id} for ${memberId}:`, error.message)
    }
}

async function wipeInventory(memberId) {
    const { error } = await supabase.from('user_inventory').delete().eq('member_id', memberId)
    if (error) {
        console.error(`Error wiping inventory for ${memberId}:`, error.message)
    }
}

export async function killUser(actorId, targetId, groupId, pushName) {
    if (actorId === targetId) return { error: "You can't kill yourself, dramatic." }

    const actor = await getOrCreateUser(actorId, pushName)
    const target = await getOrCreateUser(targetId)

    if (isKilled(target)) return { error: 'Already dead. Someone beat you to it.' }
    if (isBulletproof(target)) return { error: "They're bulletproof right now. Can't touch them." }
    if (Number(actor.balance || 0) < KILL_COST) return { error: `You need ${KILL_COST.toLocaleString()} habz for that.` }

    await updateUser(actorId, { balance: Number(actor.balance || 0) - KILL_COST })

    await wipeInventory(targetId)

    // updateUser already logs internally if this fails
    // Only balance + inventory are wiped — vehicle, house, and marriage
    // vault are deliberately left alone.
    await updateUser(targetId, {
        balance: 0,
        killed_until: new Date(Date.now() + KILL_LOCKOUT_MS).toISOString()
    })

    await supabase.from('transactions').insert({
        sender_id: actorId,
        receiver_id: null,
        group_id: groupId,
        amount: KILL_COST,
        tx_type: 'kill',
        description: `Killed ${targetId}`
    })

    return { cost: KILL_COST }
}

export async function reviveUser(actorId, targetId, pushName) {
    if (actorId === targetId) return { error: "You're dead. Someone else has to revive you." }

    const target = await getOrCreateUser(targetId)
    if (!isKilled(target)) return { error: "They're not dead." }

    const actor = await getOrCreateUser(actorId, pushName)
    if (Number(actor.balance || 0) < REVIVE_COST) return { error: `You need ${REVIVE_COST.toLocaleString()} habz for that.` }

    await updateUser(actorId, { balance: Number(actor.balance || 0) - REVIVE_COST })
    await updateUser(targetId, { killed_until: null })

    await supabase.from('transactions').insert({
        sender_id: actorId,
        receiver_id: targetId,
        amount: REVIVE_COST,
        tx_type: 'revive',
        description: `Revived ${targetId}`
    })

    return { cost: REVIVE_COST }
}

// Admin-only grant — stacks onto any bulletproof window the target already has,
// same pattern as buyImmunity.
export async function grantBulletproof(targetId, amountRaw, unitRaw, pushName) {
    const durationMs = parseBulletproofDuration(amountRaw, unitRaw)
    if (!durationMs) return { error: 'Usage: `.gbulprof <amount> <sec|min|hr|day>`' }

    const target = await getOrCreateUser(targetId, pushName)
    const currentUntil = isBulletproof(target) ? new Date(target.bulletproof_until).getTime() : Date.now()
    const newUntil = new Date(currentUntil + durationMs).toISOString()

    await updateUser(targetId, { bulletproof_until: newUntil })

    return { durationMs }
}

export async function stripBulletproof(actorId, targetId, pushName) {
    if (actorId === targetId) return { error: "Can't strip your own bulletproof, genius." }

    const target = await getOrCreateUser(targetId)
    if (!isBulletproof(target)) return { error: "They're not bulletproof." }

    const actor = await getOrCreateUser(actorId, pushName)
    if (Number(actor.balance || 0) < STRIP_BULLETPROOF_COST) return { error: `You need ${STRIP_BULLETPROOF_COST.toLocaleString()} habz for that.` }

    await updateUser(actorId, { balance: Number(actor.balance || 0) - STRIP_BULLETPROOF_COST })
    await updateUser(targetId, { bulletproof_until: null })

    await supabase.from('transactions').insert({
        sender_id: actorId,
        receiver_id: null,
        amount: STRIP_BULLETPROOF_COST,
        tx_type: 'strip_bulletproof',
        description: `Stripped bulletproof from ${targetId}`
    })

    return { cost: STRIP_BULLETPROOF_COST }
}

// ---------- MODERATORS ----------
// Second permission tier below the hardcoded ADMIN_JID owner. Cached briefly
// in-process since isModerator gets checked on every gated command, same
// reasoning as the AI toggle cache above — but kept short (unlike that one)
// so an add/remove takes effect almost immediately instead of surviving a
// stale cache for the life of the process.
const MOD_CACHE_TTL_MS = 30 * 1000
let moderatorSetCache = null
let moderatorSetCacheTime = 0

async function getModeratorSet() {
    if (moderatorSetCache && Date.now() - moderatorSetCacheTime < MOD_CACHE_TTL_MS) return moderatorSetCache

    const { data, error } = await supabase.from('moderators').select('member_id')
    if (error) {
        console.error('Error fetching moderators:', error.message)
        return moderatorSetCache || new Set()
    }

    moderatorSetCache = new Set((data || []).map((r) => r.member_id))
    moderatorSetCacheTime = Date.now()
    return moderatorSetCache
}

export async function isModerator(memberId) {
    const set = await getModeratorSet()
    return set.has(memberId)
}

export async function addModerator(memberId, addedBy) {
    const { error } = await supabase
        .from('moderators')
        .upsert({ member_id: memberId, added_by: addedBy, added_at: new Date().toISOString() })

    if (error) {
        console.error('Error adding moderator:', error.message)
        return { error: 'Something broke adding that moderator.' }
    }
    moderatorSetCache = null
    return { success: true }
}

export async function removeModerator(memberId) {
    const { error } = await supabase.from('moderators').delete().eq('member_id', memberId)
    if (error) {
        console.error('Error removing moderator:', error.message)
        return { error: 'Something broke removing that moderator.' }
    }
    moderatorSetCache = null
    return { success: true }
}

export async function listModerators() {
    const { data, error } = await supabase
        .from('moderators')
        .select('member_id, added_at')
        .order('added_at', { ascending: true })

    if (error) {
        console.error('Error listing moderators:', error.message)
        return []
    }
    return data || []
}

// ---------- AUTO AIRDROPS ----------

export async function getActiveGroupIds() {
    const { data, error } = await supabase.from('groups').select('group_id').eq('is_active', true)
    if (error) {
        console.error('Error fetching active groups:', error.message)
        return []
    }
    return (data || []).map((g) => g.group_id)
}

export async function hasUnclaimedAirdrop(groupId) {
    const { data, error } = await supabase
        .from('airdrops')
        .select('id')
        .eq('group_id', groupId)
        .eq('is_claimed', false)
        .limit(1)
        .maybeSingle()

    if (error) {
        console.error('Error checking unclaimed airdrop:', error.message)
        return true // fail safe — skip dropping a new one if we can't tell
    }
    return Boolean(data)
}

// ---------- AI TOGGLE ----------
// Single-row settings table so the .ai on/off switch survives restarts and
// redeploys instead of silently resetting to "on" — same reasoning as
// everything else living in Supabase rather than in-process memory.
// Cached in-process so the conversational-trigger check on every message
// doesn't cost a DB round trip; the cache is refreshed on every write, and
// on the first read after a restart.
let aiEnabledCache = null

export async function isAiEnabled() {
    if (aiEnabledCache !== null) return aiEnabledCache

    const { data, error } = await supabase
        .from('bot_settings')
        .select('ai_enabled')
        .eq('id', 1)
        .maybeSingle()

    if (error) {
        console.error('Error fetching AI toggle, defaulting to enabled:', error.message)
        return true
    }

    aiEnabledCache = data?.ai_enabled ?? true
    return aiEnabledCache
}

export async function setAiEnabled(enabled) {
    const { error } = await supabase
        .from('bot_settings')
        .update({ ai_enabled: enabled })
        .eq('id', 1)

    if (error) {
        console.error('Error updating AI toggle:', error.message)
        return { error: 'Something broke flipping that switch.' }
    }

    aiEnabledCache = enabled
    return { success: true }
}
