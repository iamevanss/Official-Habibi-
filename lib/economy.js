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

// ---------- GANGS ----------
const GANG_MAX_MEMBERS = 10
const GANG_CREATE_COST = 500000

async function getGangByMember(memberId) {
    const { data: membership, error } = await supabase
        .from('gang_members')
        .select('gang_id, rank')
        .eq('member_id', memberId)
        .maybeSingle()

    if (error) {
        console.error('Error fetching gang membership:', error.message)
        return null
    }
    if (!membership) return null

    const { data: gang, error: gangError } = await supabase
        .from('gangs')
        .select('*')
        .eq('id', membership.gang_id)
        .maybeSingle()

    if (gangError || !gang) return null
    return { ...gang, myRank: membership.rank }
}

async function getGangMembers(gangId) {
    const { data, error } = await supabase
        .from('gang_members')
        .select('member_id, rank, joined_at')
        .eq('gang_id', gangId)
        .order('joined_at', { ascending: true })

    if (error) {
        console.error('Error fetching gang members:', error.message)
        return []
    }
    return data || []
}

export async function createGang(leaderId, name, pushName) {
    const trimmedName = String(name || '').trim()
    if (!trimmedName || trimmedName.length > 30) return { error: 'Gang names are 1-30 characters.' }

    const existing = await getGangByMember(leaderId)
    if (existing) return { error: `You're already in *${existing.name}*. Leave it first.` }

    const user = await getOrCreateUser(leaderId, pushName)
    if (Number(user.balance || 0) < GANG_CREATE_COST) {
        return { error: `Starting a gang costs ${GANG_CREATE_COST.toLocaleString()} habz. You're short.` }
    }

    const { data: gang, error } = await supabase
        .from('gangs')
        .insert({ name: trimmedName, leader_id: leaderId })
        .select()
        .maybeSingle()

    if (error) {
        if (String(error.message).includes('duplicate')) return { error: `*${trimmedName}* is already taken. Pick another name.` }
        console.error('Error creating gang:', error.message)
        return { error: 'Something broke creating that gang.' }
    }

    const { error: memberError } = await supabase
        .from('gang_members')
        .insert({ member_id: leaderId, gang_id: gang.id, rank: 'leader' })

    if (memberError) {
        console.error('Error adding gang leader:', memberError.message)
        await supabase.from('gangs').delete().eq('id', gang.id)
        return { error: 'Something broke creating that gang.' }
    }

    await updateUser(leaderId, { balance: Number(user.balance || 0) - GANG_CREATE_COST })

    return { gang }
}

export async function inviteToGang(inviterId, inviteeId) {
    const inviterGang = await getGangByMember(inviterId)
    if (!inviterGang) return { error: "You're not in a gang." }
    if (inviterGang.myRank === 'member') return { error: 'Only leaders and officers can invite.' }

    const members = await getGangMembers(inviterGang.id)
    if (members.length >= GANG_MAX_MEMBERS) return { error: `*${inviterGang.name}* is full (${GANG_MAX_MEMBERS}/${GANG_MAX_MEMBERS}).` }

    const inviteeGang = await getGangByMember(inviteeId)
    if (inviteeGang) return { error: 'That person is already in a gang.' }

    const { data: pending } = await supabase
        .from('gang_invites')
        .select('id')
        .eq('invitee_id', inviteeId)
        .eq('status', 'pending')
        .maybeSingle()

    if (pending) return { error: 'That person already has a pending gang invite.' }

    const { error } = await supabase
        .from('gang_invites')
        .insert({ gang_id: inviterGang.id, inviter_id: inviterId, invitee_id: inviteeId })

    if (error) {
        console.error('Error creating gang invite:', error.message)
        return { error: 'Something broke sending that invite.' }
    }

    return { gang: inviterGang }
}

export async function acceptGangInvite(inviteeId) {
    const { data: invite, error } = await supabase
        .from('gang_invites')
        .select('*')
        .eq('invitee_id', inviteeId)
        .eq('status', 'pending')
        .order('invited_at', { ascending: false })
        .limit(1)
        .maybeSingle()

    if (error) {
        console.error('Error fetching gang invite:', error.message)
        return { error: 'Something broke checking your invites.' }
    }
    if (!invite) return { error: "You don't have a pending gang invite." }

    const alreadyInGang = await getGangByMember(inviteeId)
    if (alreadyInGang) {
        await supabase.from('gang_invites').update({ status: 'expired' }).eq('id', invite.id)
        return { error: "You're already in a gang." }
    }

    const members = await getGangMembers(invite.gang_id)
    if (members.length >= GANG_MAX_MEMBERS) {
        await supabase.from('gang_invites').update({ status: 'expired' }).eq('id', invite.id)
        return { error: 'That gang filled up before you could join.' }
    }

    const { data: gang } = await supabase.from('gangs').select('*').eq('id', invite.gang_id).maybeSingle()
    if (!gang) return { error: 'That gang no longer exists.' }

    const { error: memberError } = await supabase
        .from('gang_members')
        .insert({ member_id: inviteeId, gang_id: invite.gang_id, rank: 'member' })

    if (memberError) {
        console.error('Error joining gang:', memberError.message)
        return { error: 'Something broke joining that gang.' }
    }

    await supabase.from('gang_invites').update({ status: 'accepted' }).eq('id', invite.id)

    return { gang, inviterId: invite.inviter_id }
}

export async function rejectGangInvite(inviteeId) {
    const { data: invite, error } = await supabase
        .from('gang_invites')
        .select('*')
        .eq('invitee_id', inviteeId)
        .eq('status', 'pending')
        .order('invited_at', { ascending: false })
        .limit(1)
        .maybeSingle()

    if (error) {
        console.error('Error fetching gang invite:', error.message)
        return { error: 'Something broke checking your invites.' }
    }
    if (!invite) return { error: "You don't have a pending gang invite." }

    await supabase.from('gang_invites').update({ status: 'rejected' }).eq('id', invite.id)

    const { data: gang } = await supabase.from('gangs').select('name').eq('id', invite.gang_id).maybeSingle()
    return { gangName: gang?.name || 'the gang', inviterId: invite.inviter_id }
}

export async function kickFromGang(actorId, targetId) {
    const actorGang = await getGangByMember(actorId)
    if (!actorGang) return { error: "You're not in a gang." }
    if (actorGang.myRank === 'member') return { error: 'Only leaders and officers can kick.' }
    if (targetId === actorId) return { error: "Use `.gang leave` to leave your own gang." }

    const { data: targetMembership } = await supabase
        .from('gang_members')
        .select('rank, gang_id')
        .eq('member_id', targetId)
        .maybeSingle()

    if (!targetMembership || targetMembership.gang_id !== actorGang.id) {
        return { error: "That person isn't in your gang." }
    }
    if (targetMembership.rank === 'leader') return { error: "You can't kick the leader." }
    if (targetMembership.rank === 'officer' && actorGang.myRank !== 'leader') {
        return { error: 'Only the leader can kick an officer.' }
    }

    const { error } = await supabase.from('gang_members').delete().eq('member_id', targetId)
    if (error) {
        console.error('Error kicking gang member:', error.message)
        return { error: 'Something broke kicking that member.' }
    }

    return { gang: actorGang }
}

export async function leaveGang(memberId) {
    const gang = await getGangByMember(memberId)
    if (!gang) return { error: "You're not in a gang." }
    if (gang.myRank === 'leader') {
        return { error: 'Transfer leadership with `.gang transfer @user` or `.gang disband` first — a gang needs a leader.' }
    }

    const { error } = await supabase.from('gang_members').delete().eq('member_id', memberId)
    if (error) {
        console.error('Error leaving gang:', error.message)
        return { error: 'Something broke leaving that gang.' }
    }

    return { gang }
}

async function setGangRank(actorId, targetId, newRank) {
    const actorGang = await getGangByMember(actorId)
    if (!actorGang) return { error: "You're not in a gang." }
    if (actorGang.myRank !== 'leader') return { error: 'Only the leader can do that.' }
    if (targetId === actorId) return { error: "You're already the leader." }

    const { data: targetMembership } = await supabase
        .from('gang_members')
        .select('rank, gang_id')
        .eq('member_id', targetId)
        .maybeSingle()

    if (!targetMembership || targetMembership.gang_id !== actorGang.id) {
        return { error: "That person isn't in your gang." }
    }

    const { error } = await supabase.from('gang_members').update({ rank: newRank }).eq('member_id', targetId)
    if (error) {
        console.error('Error changing gang rank:', error.message)
        return { error: 'Something broke changing that rank.' }
    }

    return { gang: actorGang }
}

export const promoteInGang = (actorId, targetId) => setGangRank(actorId, targetId, 'officer')
export const demoteInGang = (actorId, targetId) => setGangRank(actorId, targetId, 'member')

export async function transferGangLeadership(actorId, targetId) {
    const actorGang = await getGangByMember(actorId)
    if (!actorGang) return { error: "You're not in a gang." }
    if (actorGang.myRank !== 'leader') return { error: 'Only the leader can transfer leadership.' }

    const { data: targetMembership } = await supabase
        .from('gang_members')
        .select('gang_id')
        .eq('member_id', targetId)
        .maybeSingle()

    if (!targetMembership || targetMembership.gang_id !== actorGang.id) {
        return { error: "That person isn't in your gang." }
    }

    await supabase.from('gang_members').update({ rank: 'leader' }).eq('member_id', targetId)
    await supabase.from('gang_members').update({ rank: 'officer' }).eq('member_id', actorId)
    await supabase.from('gangs').update({ leader_id: targetId }).eq('id', actorGang.id)

    return { gang: actorGang }
}

export async function depositToGangVault(memberId, amount, pushName) {
    if (!Number.isInteger(amount) || amount <= 0) return { error: 'Enter a valid amount.' }

    const gang = await getGangByMember(memberId)
    if (!gang) return { error: "You're not in a gang." }

    const user = await getOrCreateUser(memberId, pushName)
    if (Number(user.balance || 0) < amount) return { error: "You don't have that much." }

    await updateUser(memberId, { balance: Number(user.balance || 0) - amount })
    const { error } = await supabase
        .from('gangs')
        .update({ vault_balance: Number(gang.vault_balance || 0) + amount })
        .eq('id', gang.id)

    if (error) {
        console.error('Error depositing to gang vault:', error.message)
        return { error: 'Something broke depositing that.' }
    }

    return { gang, amount }
}

export async function withdrawFromGangVault(leaderId, amount) {
    if (!Number.isInteger(amount) || amount <= 0) return { error: 'Enter a valid amount.' }

    const gang = await getGangByMember(leaderId)
    if (!gang) return { error: "You're not in a gang." }
    if (gang.myRank !== 'leader') return { error: 'Only the leader can withdraw from the gang vault.' }
    if (Number(gang.vault_balance || 0) < amount) return { error: "The gang vault doesn't have that much." }

    const user = await getOrCreateUser(leaderId)
    await updateUser(leaderId, { balance: Number(user.balance || 0) + amount })
    const { error } = await supabase
        .from('gangs')
        .update({ vault_balance: Number(gang.vault_balance || 0) - amount })
        .eq('id', gang.id)

    if (error) {
        console.error('Error withdrawing from gang vault:', error.message)
        return { error: 'Something broke withdrawing that.' }
    }

    return { gang, amount }
}

export async function disbandGang(leaderId) {
    const gang = await getGangByMember(leaderId)
    if (!gang) return { error: "You're not in a gang." }
    if (gang.myRank !== 'leader') return { error: 'Only the leader can disband the gang.' }

    const members = await getGangMembers(gang.id)
    const splitAmount = members.length ? Math.floor(Number(gang.vault_balance || 0) / members.length) : 0

    if (splitAmount > 0) {
        for (const member of members) {
            const user = await getOrCreateUser(member.member_id)
            await updateUser(member.member_id, { balance: Number(user.balance || 0) + splitAmount })
        }
    }

    const { error } = await supabase.from('gangs').delete().eq('id', gang.id)
    if (error) {
        console.error('Error disbanding gang:', error.message)
        return { error: 'Something broke disbanding that gang.' }
    }

    return { gang, members, splitAmount }
}

export async function getGangInfo(memberId) {
    const gang = await getGangByMember(memberId)
    if (!gang) return null

    const members = await getGangMembers(gang.id)
    const ids = members.map((m) => m.member_id)
    const { data: users } = await supabase.from('users').select('member_id, push_name').in('member_id', ids)
    const nameById = new Map((users || []).map((u) => [u.member_id, u.push_name]))

    return {
        ...gang,
        members: members.map((m) => ({ ...m, pushName: nameById.get(m.member_id) || 'Someone' }))
    }
}

// Admin-panel listing — every gang with member count, for a Gangs tab
// mirroring the existing Vaults tab pattern.
export async function getAllGangs() {
    const { data: gangs, error } = await supabase.from('gangs').select('*').order('vault_balance', { ascending: false })
    if (error) {
        console.error('Error fetching gangs:', error.message)
        return []
    }

    const { data: counts } = await supabase.from('gang_members').select('gang_id')
    const countMap = {}
    for (const row of counts || []) countMap[row.gang_id] = (countMap[row.gang_id] || 0) + 1

    return (gangs || []).map((g) => ({ ...g, memberCount: countMap[g.id] || 0 }))
}

export async function adminDisbandGang(gangId) {
    const { data: members } = await supabase.from('gang_members').select('member_id').eq('gang_id', gangId)
    const { data: gang } = await supabase.from('gangs').select('vault_balance').eq('id', gangId).maybeSingle()

    const splitAmount = members?.length ? Math.floor(Number(gang?.vault_balance || 0) / members.length) : 0
    if (splitAmount > 0) {
        for (const member of members) {
            const user = await getOrCreateUser(member.member_id)
            await updateUser(member.member_id, { balance: Number(user.balance || 0) + splitAmount })
        }
    }

    const { error } = await supabase.from('gangs').delete().eq('id', gangId)
    if (error) {
        console.error('Error admin-disbanding gang:', error.message)
        return { error: 'Something broke disbanding that gang.' }
    }
    return { success: true }
}

// ---------- GANG WARS ----------
const WAR_ACCEPT_WINDOW_MS = 60 * 60 * 1000 // 1 hour to accept or it expires
const WAR_DURATION_MS = 24 * 60 * 60 * 1000 // 24 hours once accepted
const WAR_STEAL_BONUS = 0.18 // flat odds bump on .steal/.rob against an enemy gang member during an active war

async function getGangById(gangId) {
    const { data, error } = await supabase.from('gangs').select('*').eq('id', gangId).maybeSingle()
    if (error) console.error('Error fetching gang:', error.message)
    return data || null
}

// The war a gang is currently in (pending OR active) — a gang can only be in
// one at a time, which keeps the "am I at war with this specific person's
// gang" check simple everywhere else it's needed.
export async function getGangWar(gangId) {
    const { data, error } = await supabase
        .from('gang_wars')
        .select('*')
        .in('status', ['pending_accept', 'active'])
        .or(`challenger_gang_id.eq.${gangId},rival_gang_id.eq.${gangId}`)
        .maybeSingle()

    if (error) {
        console.error('Error fetching gang war:', error.message)
        return null
    }
    return data
}

export async function declareWar(leaderId, rivalName, wager) {
    if (!Number.isInteger(wager) || wager <= 0) return { error: 'Enter a valid wager amount.' }

    const myGang = await getGangByMember(leaderId)
    if (!myGang) return { error: "You're not in a gang." }
    if (myGang.myRank !== 'leader') return { error: 'Only the leader can declare war.' }

    const existingWar = await getGangWar(myGang.id)
    if (existingWar) return { error: 'Your gang is already at war (or has a pending challenge). Resolve that first.' }

    if (Number(myGang.vault_balance || 0) < wager) return { error: "Your gang vault doesn't have that much to wager." }

    const { data: rivalGang, error: rivalError } = await supabase
        .from('gangs')
        .select('*')
        .ilike('name', rivalName.trim())
        .maybeSingle()

    if (rivalError || !rivalGang) return { error: `No gang called *${rivalName}* found.` }
    if (rivalGang.id === myGang.id) return { error: "You can't declare war on your own gang." }

    const rivalExistingWar = await getGangWar(rivalGang.id)
    if (rivalExistingWar) return { error: `*${rivalGang.name}* is already at war with someone else.` }

    // Wager is locked out of the challenger's vault the moment war is
    // declared, not on acceptance — otherwise a leader could withdraw it
    // out from under the challenge while it's pending.
    await supabase.from('gangs').update({ vault_balance: Number(myGang.vault_balance) - wager }).eq('id', myGang.id)

    const { data: war, error } = await supabase
        .from('gang_wars')
        .insert({
            challenger_gang_id: myGang.id,
            rival_gang_id: rivalGang.id,
            wager,
            expires_at: new Date(Date.now() + WAR_ACCEPT_WINDOW_MS).toISOString() // acceptance deadline for now
        })
        .select()
        .maybeSingle()

    if (error) {
        console.error('Error declaring war:', error.message)
        await supabase.from('gangs').update({ vault_balance: Number(myGang.vault_balance) }).eq('id', myGang.id) // refund
        return { error: 'Something broke declaring that war.' }
    }

    return { war, myGang, rivalGang }
}

export async function acceptWar(leaderId) {
    const myGang = await getGangByMember(leaderId)
    if (!myGang) return { error: "You're not in a gang." }
    if (myGang.myRank !== 'leader') return { error: 'Only the leader can accept a war challenge.' }

    const { data: war, error } = await supabase
        .from('gang_wars')
        .select('*')
        .eq('rival_gang_id', myGang.id)
        .eq('status', 'pending_accept')
        .order('declared_at', { ascending: false })
        .limit(1)
        .maybeSingle()

    if (error) {
        console.error('Error fetching war challenge:', error.message)
        return { error: 'Something broke checking your challenges.' }
    }
    if (!war) return { error: 'No pending war challenge for your gang.' }

    if (new Date(war.expires_at).getTime() <= Date.now()) {
        return { error: 'That challenge expired.' } // scheduler will clean it up + refund the challenger
    }

    if (Number(myGang.vault_balance || 0) < war.wager) {
        return { error: `You need to match the ${war.wager.toLocaleString()} habz wager, and your vault doesn't have it.` }
    }

    const challengerGang = await getGangById(war.challenger_gang_id)

    await supabase.from('gangs').update({ vault_balance: Number(myGang.vault_balance) - war.wager }).eq('id', myGang.id)

    const { error: updateError } = await supabase
        .from('gang_wars')
        .update({
            status: 'active',
            accepted_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + WAR_DURATION_MS).toISOString()
        })
        .eq('id', war.id)

    if (updateError) {
        console.error('Error accepting war:', updateError.message)
        await supabase.from('gangs').update({ vault_balance: Number(myGang.vault_balance) }).eq('id', myGang.id) // refund
        return { error: 'Something broke accepting that war.' }
    }

    return { war, myGang, challengerGang }
}

export async function surrenderWar(leaderId) {
    const myGang = await getGangByMember(leaderId)
    if (!myGang) return { error: "You're not in a gang." }
    if (myGang.myRank !== 'leader') return { error: 'Only the leader can surrender.' }

    const war = await getGangWar(myGang.id)
    if (!war || war.status !== 'active') return { error: 'Your gang is not in an active war.' }

    const winnerGangId = war.challenger_gang_id === myGang.id ? war.rival_gang_id : war.challenger_gang_id
    const pot = Number(war.wager) * 2
    const winnerGang = await getGangById(winnerGangId)

    await supabase.from('gangs').update({ vault_balance: Number(winnerGang.vault_balance || 0) + pot }).eq('id', winnerGangId)
    await supabase.from('gang_wars').update({ status: 'surrendered', winner_gang_id: winnerGangId, resolved_at: new Date().toISOString() }).eq('id', war.id)

    return { war, myGang, winnerGang, pot }
}

// Called from .steal and .rob when a hit lands against an enemy gang member
// during an active war — adds to that side's tally and returns whether a
// war bonus should apply to the ODDS (checked separately, before the roll,
// via getWarBonusFor below — this just records a completed hit's earnings).
async function recordWarHit(actorGangId, targetGangId, amount) {
    const war = await getGangWar(actorGangId)
    if (!war || war.status !== 'active') return
    if (war.challenger_gang_id !== targetGangId && war.rival_gang_id !== targetGangId) return // not warring THIS gang

    const isChallenger = war.challenger_gang_id === actorGangId
    const column = isChallenger ? 'challenger_tally' : 'rival_tally'
    const current = isChallenger ? war.challenger_tally : war.rival_tally

    await supabase.from('gang_wars').update({ [column]: Number(current) + amount }).eq('id', war.id)
}

// Checked BEFORE a steal/rob roll — if the stealer and target's gangs are at
// active war with each other, returns the odds bonus; otherwise 0. Also
// returns the gang IDs so the caller can record the hit afterward without a
// second lookup.
async function getWarContext(stealerId, targetId) {
    const stealerGang = await getGangByMember(stealerId)
    if (!stealerGang) return { bonus: 0 }
    const targetGang = await getGangByMember(targetId)
    if (!targetGang) return { bonus: 0 }

    const war = await getGangWar(stealerGang.id)
    if (!war || war.status !== 'active') return { bonus: 0 }
    const isRival = war.challenger_gang_id === targetGang.id || war.rival_gang_id === targetGang.id
    if (!isRival || stealerGang.id === targetGang.id) return { bonus: 0 }

    return { bonus: WAR_STEAL_BONUS, actorGangId: stealerGang.id, targetGangId: targetGang.id }
}

// Scheduler-facing: resolves any war whose window has passed — either an
// unaccepted challenge (refund the challenger) or a finished 24h war (winner
// takes the combined pot, tie refunds both sides). Returns a list of
// broadcast-ready results so the scheduler can announce each one.
export async function resolveExpiredWars() {
    const { data: expired, error } = await supabase
        .from('gang_wars')
        .select('*')
        .in('status', ['pending_accept', 'active'])
        .lte('expires_at', new Date().toISOString())

    if (error) {
        console.error('Error fetching expired wars:', error.message)
        return []
    }

    const results = []
    for (const war of expired || []) {
        if (war.status === 'pending_accept') {
            const challengerGang = await getGangById(war.challenger_gang_id)
            if (challengerGang) {
                await supabase.from('gangs').update({ vault_balance: Number(challengerGang.vault_balance) + Number(war.wager) }).eq('id', war.challenger_gang_id)
            }
            await supabase.from('gang_wars').update({ status: 'expired', resolved_at: new Date().toISOString() }).eq('id', war.id)
            results.push({ type: 'challenge_expired', war, challengerGang })
            continue
        }

        // Active war window ran out — settle it.
        const challengerGang = await getGangById(war.challenger_gang_id)
        const rivalGang = await getGangById(war.rival_gang_id)
        const pot = Number(war.wager) * 2

        let winnerGangId = null
        if (Number(war.challenger_tally) > Number(war.rival_tally)) winnerGangId = war.challenger_gang_id
        else if (Number(war.rival_tally) > Number(war.challenger_tally)) winnerGangId = war.rival_gang_id

        if (winnerGangId) {
            const winnerGang = winnerGangId === war.challenger_gang_id ? challengerGang : rivalGang
            await supabase.from('gangs').update({ vault_balance: Number(winnerGang.vault_balance) + pot }).eq('id', winnerGangId)
        } else {
            // Tie — refund both sides their own wager.
            await supabase.from('gangs').update({ vault_balance: Number(challengerGang.vault_balance) + Number(war.wager) }).eq('id', war.challenger_gang_id)
            await supabase.from('gangs').update({ vault_balance: Number(rivalGang.vault_balance) + Number(war.wager) }).eq('id', war.rival_gang_id)
        }

        await supabase.from('gang_wars').update({ status: 'resolved', winner_gang_id: winnerGangId, resolved_at: new Date().toISOString() }).eq('id', war.id)
        results.push({ type: 'war_resolved', war, challengerGang, rivalGang, winnerGangId, pot })
    }

    return results
}

// ---------- EVENTS ----------
// Admin-triggered temporary modifiers. State lives in bot_settings (single
// row, id=1) — event_type is '' when nothing is running. Cached in-process
// for EVENT_CACHE_TTL_MS since getActiveEvent() gets checked on the hottest
// paths in the bot (every single text message, every steal, every buy),
// same reasoning as the moderator-set and AI-enabled caches below.
const EVENT_TYPES = {
    double_xp: { label: 'Double XP', emoji: '⚡', defaultMultiplier: 2, describe: (m) => `Level-up payouts are ${m}x for a limited time!` },
    double_steal: { label: 'Crime Wave (Steal)', emoji: '🥷', defaultMultiplier: 2, describe: (m) => `.steal success odds are boosted ${m}x for a limited time!` },
    double_rob: { label: 'Crime Wave (Heist)', emoji: '🔫', defaultMultiplier: 2, describe: (m) => `.rob success odds are boosted ${m}x for a limited time!` },
    shop_discount: { label: 'Shop Sale', emoji: '🏷️', defaultMultiplier: 0.5, describe: (m) => `Everything in the shop is ${Math.round((1 - m) * 100)}% off for a limited time!` },
    double_flip: { label: 'Double Flip', emoji: '🎲', defaultMultiplier: 2, describe: (m) => `.flip wins pay out ${m}x for a limited time!` }
}

const EVENT_CACHE_TTL_MS = 15 * 1000
let eventCache = null
let eventCacheTime = 0

// Returns the active event ({ type, multiplier, expiresAt, startedBy }) or
// null if nothing's running / it expired. Does NOT clear an expired event
// from the DB itself — the scheduler does that (and announces the end);
// this just needs to stop applying the effect the moment it's stale.
export async function getActiveEvent() {
    if (eventCache !== undefined && eventCache !== null && Date.now() - eventCacheTime < EVENT_CACHE_TTL_MS) {
        return eventCache.type ? eventCache : null
    }

    const { data, error } = await supabase
        .from('bot_settings')
        .select('event_type, event_multiplier, event_expires_at, event_started_by')
        .eq('id', 1)
        .maybeSingle()

    if (error) {
        console.error('Error fetching active event:', error.message)
        return null
    }

    eventCache = {
        type: data?.event_type || '',
        multiplier: Number(data?.event_multiplier || 1),
        expiresAt: data?.event_expires_at || null,
        startedBy: data?.event_started_by || ''
    }
    eventCacheTime = Date.now()

    if (!eventCache.type) return null
    if (eventCache.expiresAt && new Date(eventCache.expiresAt).getTime() <= Date.now()) return null
    return eventCache
}

function invalidateEventCache() {
    eventCache = null
}

// Returns the multiplier for a specific event type IF it's currently active,
// otherwise 1 (a safe no-op multiplier) — lets call sites do
// `price * (await getEventMultiplierFor('shop_discount'))` without an extra
// null-check at every call site.
export async function getEventMultiplierFor(type) {
    const active = await getActiveEvent()
    return active && active.type === type ? active.multiplier : 1
}

export async function startEvent(type, minutes, multiplier, startedBy) {
    const config = EVENT_TYPES[type]
    if (!config) return { error: `Unknown event type. Try: ${Object.keys(EVENT_TYPES).join(', ')}` }
    if (!Number.isFinite(minutes) || minutes <= 0) return { error: 'Enter a valid duration in minutes.' }

    const effectiveMultiplier = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : config.defaultMultiplier
    const expiresAt = new Date(Date.now() + minutes * 60 * 1000).toISOString()

    const { error } = await supabase
        .from('bot_settings')
        .update({
            event_type: type,
            event_multiplier: effectiveMultiplier,
            event_expires_at: expiresAt,
            event_started_by: startedBy || 'admin'
        })
        .eq('id', 1)

    if (error) {
        console.error('Error starting event:', error.message)
        return { error: 'Something broke starting that event.' }
    }

    invalidateEventCache()
    return { type, config, multiplier: effectiveMultiplier, expiresAt }
}

export async function stopEvent() {
    const active = await getActiveEvent()
    if (!active) return { error: 'No event is currently running.' }

    const { error } = await supabase
        .from('bot_settings')
        .update({ event_type: '', event_multiplier: 1, event_expires_at: null, event_started_by: '' })
        .eq('id', 1)

    if (error) {
        console.error('Error stopping event:', error.message)
        return { error: 'Something broke stopping that event.' }
    }

    invalidateEventCache()
    return { type: active.type, config: EVENT_TYPES[active.type] }
}

export { EVENT_TYPES }

// ---------- ACHIEVEMENTS ----------
// Catalog lives here in code (static content) — only which member has
// unlocked which key lives in the DB (user_achievements table).
const ACHIEVEMENTS = {
    first_blood: { emoji: '🔪', name: 'First Blood', desc: 'Killed someone for the first time' },
    til_death: { emoji: '💍', name: 'Til Death', desc: 'Got married for the first time' },
    heartbreaker: { emoji: '💔', name: 'Heartbreaker', desc: 'Had a proposal rejected' },
    high_roller: { emoji: '🎲', name: 'High Roller', desc: 'Won 1,000,000+ habz on a single flip' },
    big_spender: { emoji: '💸', name: 'Big Spender', desc: 'Bought something worth 50,000,000+ habz' },
    crew_leader: { emoji: '🔫', name: 'Crew Leader', desc: 'Successfully led a heist crew' },
    survivor: { emoji: '☠️', name: 'Survivor', desc: 'Got killed and bounced back 5 times' },
    richie_rich: { emoji: '👑', name: 'Richie Rich', desc: 'Reached 100,000,000 habz balance' }
}

export { ACHIEVEMENTS }

// Idempotent — safe to call even if the member already has it. Returns
// { isNew, achievement } so call sites can decide whether to announce it;
// isNew is false on a repeat grant attempt.
export async function grantAchievement(memberId, key) {
    const achievement = ACHIEVEMENTS[key]
    if (!achievement) return { isNew: false, achievement: null }

    const { data: existing } = await supabase
        .from('user_achievements')
        .select('member_id')
        .eq('member_id', memberId)
        .eq('achievement_key', key)
        .maybeSingle()

    if (existing) return { isNew: false, achievement }

    const { error } = await supabase
        .from('user_achievements')
        .insert({ member_id: memberId, achievement_key: key })

    if (error) {
        // A unique-constraint race (two triggers at once) isn't a real error —
        // it just means someone else's concurrent grant beat this one.
        if (!String(error.message).includes('duplicate')) {
            console.error(`Error granting achievement ${key} to ${memberId}:`, error.message)
        }
        return { isNew: false, achievement }
    }

    return { isNew: true, achievement }
}

export async function getAchievements(memberId) {
    const { data, error } = await supabase
        .from('user_achievements')
        .select('achievement_key, earned_at')
        .eq('member_id', memberId)
        .order('earned_at', { ascending: true })

    if (error) {
        console.error('Error fetching achievements:', error.message)
        return []
    }

    return (data || [])
        .map((row) => ({ key: row.achievement_key, earnedAt: row.earned_at, ...ACHIEVEMENTS[row.achievement_key] }))
        .filter((a) => a.name) // drop any stale/unknown keys gracefully
}

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

    // Centralized threshold check — catches every path that can move a
    // balance (heist, give, level-up, flip, admin adjust, etc.) without
    // needing a grantAchievement() call at each individual call site.
    // Fire-and-forget: this must never add latency to updateUser, which is
    // one of the hottest functions in the whole bot.
    if (data && 'balance' in updates && Number(data.balance) >= 100000000) {
        grantAchievement(memberId, 'richie_rich').catch(() => {})
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
    const leveledUp = Boolean(row?.leveled_up)

    // The RPC above already paid the base LEVEL_UP_REWARD server-side — this
    // only tops up the difference when a double_xp event is running, so the
    // event check only ever runs on an actual level-up, not every message.
    if (leveledUp) {
        const multiplier = await getEventMultiplierFor('double_xp')
        if (multiplier > 1) {
            const topUp = Math.round(LEVEL_UP_REWARD * (multiplier - 1))
            const user = await getOrCreateUser(memberId)
            await updateUser(memberId, { balance: Number(user.balance || 0) + topUp })
        }
    }

    return {
        leveledUp,
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

// ---------- WEEKLY LEADERBOARD ----------
// Ranks by earnings THIS WEEK (balance - weekly_start_balance), not lifetime
// balance — otherwise it'd just always show the same richest few people.
// The delta can't be computed in a plain Supabase .order() (no expression
// support), so this pulls a bounded set ordered by balance as a reasonable
// upper bound, computes the delta in JS, then sorts/slices — fine at this
// bot's scale; would need a proper SQL view if the user base got huge.
export async function getWeeklyLeaderboard(n = 10) {
    const { data, error } = await supabase
        .from('users')
        .select('member_id, push_name, balance, weekly_start_balance')
        .order('balance', { ascending: false })
        .limit(2000)

    if (error) {
        console.error('Error fetching weekly leaderboard:', error.message)
        return []
    }

    return (data || [])
        .map((u) => ({ ...u, weeklyEarnings: Number(u.balance || 0) - Number(u.weekly_start_balance || 0) }))
        .filter((u) => u.weeklyEarnings > 0)
        .sort((a, b) => b.weeklyEarnings - a.weeklyEarnings)
        .slice(0, n)
}

// Called by the scheduler once a week — snapshots everyone's current balance
// as the new baseline, via a Postgres function since bulk "set column =
// another column" isn't expressible through a plain .update() call.
export async function resetWeeklyBalances() {
    const { error } = await supabase.rpc('reset_weekly_balances')
    if (error) console.error('Error resetting weekly balances:', error.message)
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

    const stealMultiplier = await getEventMultiplierFor('double_steal')
    const warContext = await getWarContext(stealerId, targetId)
    const success = Math.random() < Math.min(0.9, (STEAL_SUCCESS_CHANCE + weaponBonus + warContext.bonus) * stealMultiplier)
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
        if (warContext.bonus > 0 && movedAmount > 0) {
            await recordWarHit(warContext.actorGangId, warContext.targetGangId, movedAmount)
        }
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
    const robMultiplier = await getEventMultiplierFor('double_rob')
    // War bonus is based on the crew leader's gang vs. the target's gang —
    // a heist crew can be mixed-gang, so the initiator represents "the crew"
    // for war purposes, same as they do for the crew_leader achievement.
    const warContext = await getWarContext(initiatorId, targetId)
    const success = Math.random() < Math.min(0.9, (ROB_SUCCESS_CHANCE + weaponBonus + warContext.bonus) * robMultiplier)

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

    if (success && warContext.bonus > 0 && totalMoved > 0) {
        await recordWarHit(warContext.actorGangId, warContext.targetGangId, totalMoved)
    }

    let newAchievement = null
    if (success) {
        const result = await grantAchievement(initiatorId, 'crew_leader')
        if (result.isNew) newAchievement = result.achievement
    }

    return { success, totalMoved, perMemberShare, crewSize: crewIds.length, newAchievement }
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
    const flipMultiplier = won ? await getEventMultiplierFor('double_flip') : 1
    const winnings = Math.round(amount * flipMultiplier)
    const newBalance = won ? Number(user.balance || 0) + winnings : Number(user.balance || 0) - amount

    await updateUser(memberId, { balance: newBalance })

    await supabase.from('transactions').insert({
        sender_id: memberId,
        receiver_id: null,
        group_id: groupId,
        amount,
        tx_type: 'coinflip',
        description: won ? 'win' : 'loss'
    })

    let newAchievement = null
    if (won && winnings >= 1000000) {
        const result = await grantAchievement(memberId, 'high_roller')
        if (result.isNew) newAchievement = result.achievement
    }

    return { won, amount, winnings, newAchievement }
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

// Every proposal still awaiting an .accept/.reject — for the admin panel's
// Vaults tab, so pending proposals don't just sit invisible until someone
// acts on them (or never does).
export async function getPendingProposals() {
    const { data, error } = await supabase
        .from('marriages')
        .select('id, partner1_id, partner2_id, proposed_at')
        .eq('status', 'pending')
        .order('proposed_at', { ascending: true })

    if (error) {
        console.error('Error fetching pending proposals:', error.message)
        return []
    }
    if (!data || !data.length) return []

    const ids = [...new Set(data.flatMap((p) => [p.partner1_id, p.partner2_id]))]
    const { data: users } = await supabase
        .from('users')
        .select('member_id, push_name')
        .in('member_id', ids)

    const nameById = new Map((users || []).map((u) => [u.member_id, u.push_name]))

    return data.map((p) => ({
        id: p.id,
        proposerId: p.partner1_id,
        targetId: p.partner2_id,
        proposerName: nameById.get(p.partner1_id) || 'Someone',
        targetName: nameById.get(p.partner2_id) || 'Someone',
        proposedAt: p.proposed_at
    }))
}

// Admin-panel wipe — cancels a specific pending proposal by row id, no matter
// which side it came from. Distinct status from a self-.cancel/.reject so it's
// clear in the data which party (or an admin) ended it.
export async function adminWipeProposal(proposalId) {
    const { error } = await supabase
        .from('marriages')
        .update({ status: 'cancelled' })
        .eq('id', proposalId)
        .eq('status', 'pending')

    if (error) {
        console.error('Error wiping proposal:', error.message)
        return { error: 'Something broke wiping that proposal.' }
    }
    return { success: true }
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

    // Both sides earn it — fire-and-forget, the .accept reply shouldn't wait
    // on two extra DB round trips.
    grantAchievement(accepterId, 'til_death').catch(() => {})
    grantAchievement(proposal.partner1_id, 'til_death').catch(() => {})

    return { spouseId: proposal.partner1_id }
}

// .cancel — only the proposer can withdraw their own outgoing proposal.
export async function cancelProposal(memberId) {
    const { data: proposal, error } = await supabase
        .from('marriages')
        .select('*')
        .eq('partner1_id', memberId)
        .eq('status', 'pending')
        .order('proposed_at', { ascending: false })
        .limit(1)
        .maybeSingle()

    if (error) {
        console.error('Error fetching proposal to cancel:', error.message)
        return { error: 'Something broke checking your proposals.' }
    }
    if (!proposal) return { error: "You don't have a pending proposal to cancel." }

    const { error: updateError } = await supabase
        .from('marriages')
        .update({ status: 'cancelled' })
        .eq('id', proposal.id)

    if (updateError) {
        console.error('Error cancelling proposal:', updateError.message)
        return { error: 'Something broke cancelling that proposal.' }
    }

    return { otherId: proposal.partner2_id }
}

// .reject — only the person who was proposed to can turn it down.
export async function rejectProposal(memberId) {
    const { data: proposal, error } = await supabase
        .from('marriages')
        .select('*')
        .eq('partner2_id', memberId)
        .eq('status', 'pending')
        .order('proposed_at', { ascending: false })
        .limit(1)
        .maybeSingle()

    if (error) {
        console.error('Error fetching proposal to reject:', error.message)
        return { error: 'Something broke checking your proposals.' }
    }
    if (!proposal) return { error: "You don't have a pending proposal to reject." }

    const { error: updateError } = await supabase
        .from('marriages')
        .update({ status: 'rejected' })
        .eq('id', proposal.id)

    if (updateError) {
        console.error('Error rejecting proposal:', updateError.message)
        return { error: 'Something broke rejecting that proposal.' }
    }

    // The heartbreak belongs to whoever got turned down — the proposer.
    grantAchievement(proposal.partner1_id, 'heartbreaker').catch(() => {})

    return { otherId: proposal.partner1_id }
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
    const discount = await getEventMultiplierFor('shop_discount')
    const price = Math.round(item.price * discount)

    const user = await getOrCreateUser(memberId, pushName)
    if (Number(user.balance || 0) < price) {
        return { error: `You need ${price.toLocaleString()} habz for a ${item.name.toLowerCase()}. You're nowhere close.` }
    }

    await updateUser(memberId, { balance: Number(user.balance || 0) - price })

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
        amount: price,
        tx_type: 'shop',
        description: `Bought: ${item.name}`
    })

    let newAchievement = null
    if (price >= 50000000) {
        const result = await grantAchievement(memberId, 'big_spender')
        if (result.isNew) newAchievement = result.achievement
    }

    return { item: { emoji: item.emoji, name: item.name, price }, newAchievement }
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

    const discount = await getEventMultiplierFor('shop_discount')
    const discountedPrice = Math.round(targetGrade.price * discount)

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

    const netCost = discountedPrice - refund
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

    let newAchievement = null
    if (discountedPrice >= 50000000) {
        const result = await grantAchievement(memberId, 'big_spender')
        if (result.isNew) newAchievement = result.achievement
    }

    return { item: { ...targetGrade, price: discountedPrice }, netCost, refund, upgradedFrom, newAchievement }
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
    const newTimesKilled = Number(target.times_killed || 0) + 1
    await updateUser(targetId, {
        balance: 0,
        killed_until: new Date(Date.now() + KILL_LOCKOUT_MS).toISOString(),
        times_killed: newTimesKilled
    })

    await supabase.from('transactions').insert({
        sender_id: actorId,
        receiver_id: null,
        group_id: groupId,
        amount: KILL_COST,
        tx_type: 'kill',
        description: `Killed ${targetId}`
    })

    const newAchievements = []
    const firstBloodResult = await grantAchievement(actorId, 'first_blood')
    if (firstBloodResult.isNew) newAchievements.push({ memberId: actorId, achievement: firstBloodResult.achievement })
    if (newTimesKilled >= 5) {
        const survivorResult = await grantAchievement(targetId, 'survivor')
        if (survivorResult.isNew) newAchievements.push({ memberId: targetId, achievement: survivorResult.achievement })
    }

    return { cost: KILL_COST, newAchievements }
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

// ---------- CHANGELOG BROADCAST ----------
// A single "What's new" entry lives in bot_settings alongside its version
// string. On every startup, the scheduler compares the stored version against
// the current one — set here, in the admin panel — and only broadcasts to
// every group when it's actually different, so routine reconnects/crashes
// (which happen fairly often) never trigger a spam message.

export async function getChangelogState() {
    const { data, error } = await supabase
        .from('bot_settings')
        .select('changelog_version, changelog_text')
        .eq('id', 1)
        .maybeSingle()

    if (error) {
        console.error('Error fetching changelog state:', error.message)
        return { version: '', text: '' }
    }
    return { version: data?.changelog_version || '', text: data?.changelog_text || '' }
}

// Called from the admin panel right before/after a deploy — bumping the
// version here is what actually arms the next-startup broadcast.
export async function setChangelogState(version, text) {
    const { error } = await supabase
        .from('bot_settings')
        .update({ changelog_version: version, changelog_text: text })
        .eq('id', 1)

    if (error) {
        console.error('Error updating changelog state:', error.message)
        return { error: 'Something broke saving that changelog.' }
    }
    return { success: true }
}

// Called once by the scheduler after a broadcast actually goes out, so the
// same version never fires twice even across restarts.
export async function markChangelogBroadcast(version) {
    const { error } = await supabase
        .from('bot_settings')
        .update({ changelog_last_broadcast: version })
        .eq('id', 1)

    if (error) console.error('Error marking changelog as broadcast:', error.message)
}

export async function getLastBroadcastVersion() {
    const { data, error } = await supabase
        .from('bot_settings')
        .select('changelog_last_broadcast')
        .eq('id', 1)
        .maybeSingle()

    if (error) {
        console.error('Error fetching last broadcast version:', error.message)
        return null
    }
    return data?.changelog_last_broadcast || null
}
