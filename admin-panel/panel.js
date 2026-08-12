// ============================================================
// Habibi Control — panel (dashboard) logic
// Lives only on panel.html. Requires a valid session — redirects
// to login.html (a real page navigation) if none is found or it's
// no longer valid.
// ============================================================

let ws = null
let statusPollTimer = null

function signOut() {
  clearSession()
  session = null
  if (ws) ws.close()
  if (statusPollTimer) clearInterval(statusPollTimer)
  location.href = 'login.html'
}

document.getElementById('btn-signout').addEventListener('click', signOut)

// ============================================================
// App entry
// ============================================================

function enterApp() {
  document.getElementById('settings-server-url').textContent = session.url
  window.scrollTo(0, 0)

  connectWebSocket()
  pollStatus()
  statusPollTimer = setInterval(pollStatus, 15000)

  loadOverview()
}

// ---------- nav ----------

document.querySelectorAll('.rail-btn[data-section]').forEach((btn) => {
  btn.addEventListener('click', () => switchSection(btn.dataset.section))
})

function switchSection(name) {
  document.querySelectorAll('.rail-btn[data-section]').forEach((b) => b.classList.toggle('active', b.dataset.section === name))
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`))

  if (name === 'overview') loadOverview()
  if (name === 'users') loadUsers()
  if (name === 'groups') loadGroups()
  if (name === 'shop') loadShop()
  if (name === 'vaults') { loadVaults(); loadProposals() }
  if (name === 'dead') loadDead()
  if (name === 'moderators') loadModerators()
  if (name === 'settings') loadSettings()
}

// ============================================================
// Status / connection
// ============================================================

async function pollStatus() {
  try {
    const s = await get('/status')
    const orb = document.getElementById('conn-orb')
    const label = document.getElementById('conn-label')
    orb.className = 'pulse-orb ' + (s.connected ? 'online' : s.connectionState === 'close' ? 'offline' : 'pending')
    label.textContent = s.connected ? 'connected' : s.connectionState
    document.getElementById('bot-name').textContent = s.botName || 'Habibi'
    document.getElementById('uptime').textContent = fmtUptime(s.uptimeSeconds)
    document.getElementById('settings-bot-number').textContent = s.botNumber || '—'
    document.getElementById('settings-state').textContent = s.connectionState
  } catch {
    document.getElementById('conn-orb').className = 'pulse-orb offline'
    document.getElementById('conn-label').textContent = 'unreachable'
  }
}

// ============================================================
// Live ticker (websocket + REST fallback)
// ============================================================

function connectWebSocket() {
  try {
    const wsUrl = session.url.replace(/^http/, 'ws').replace(/\/+$/, '') + `/ws?secret=${encodeURIComponent(session.secret)}`
    ws = new WebSocket(wsUrl)
    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data)
        handleLiveEvent(msg)
      } catch { /* ignore malformed frames */ }
    }
    ws.onclose = () => { setTimeout(connectWebSocket, 5000) }
  } catch {
    setTimeout(connectWebSocket, 5000)
  }
}

const tickerItems = []

function handleLiveEvent(msg) {
  if (msg.type === 'connected') return

  const labelMap = {
    airdrop_sent: (p) => `🦩 airdrop ${fmtHabz(p.amount)} habz dropped`,
    balance_adjusted: (p) => `⚙️ balance adjusted → ${p.memberId}`,
    user_killed: (p) => `💀 ${p.memberId} killed`,
    user_revived: (p) => `❤️ ${p.memberId} revived`,
    shop_updated: (p) => `🛒 shop price updated`,
    settings_updated: (p) => `🔧 settings changed`,
    message_sent: (p) => `📣 broadcast sent`,
    vault_wiped: (p) => `🏦 vault wiped → ${p.memberId}`
  }

  const render = labelMap[msg.type]
  if (!render) return

  pushTickerItem(render(msg.payload || {}))
  if (document.querySelectorAll('.view.active')[0]?.id === 'view-overview') loadOverview(true)
}

function pushTickerItem(text) {
  tickerItems.unshift(text)
  if (tickerItems.length > 24) tickerItems.pop()
  renderTicker()
}

function renderTicker() {
  const track = document.getElementById('ticker-track')
  if (!tickerItems.length) {
    track.innerHTML = '<span class="ticker-item ticker-empty">Waiting for activity…</span>'
    return
  }
  // Duplicate the list so the CSS marquee (-50%) loops seamlessly.
  const html = tickerItems.map((t) => `<span class="ticker-item"><span class="ticker-dot"></span>${escapeHtml(t)}</span>`).join('')
  track.innerHTML = html + html
}

async function loadRecentTransactionsIntoTicker() {
  try {
    const { transactions } = await get('/transactions/recent?limit=20')
    tickerItems.length = 0
    for (const tx of transactions) {
      const sign = tx.receiver_id ? '' : '-'
      tickerItems.push(`${tx.tx_type} · ${sign}${fmtHabz(tx.amount)} habz`)
    }
    renderTicker()
  } catch { /* leave placeholder */ }
}

// ============================================================
// Overview
// ============================================================

async function loadOverview(quiet) {
  if (!quiet) {
    document.getElementById('leaderboard-list').innerHTML = '<div class="empty-state">Loading…</div>'
  }
  try {
    const [stats, board] = await Promise.all([get('/stats'), get('/leaderboard/global')])
    document.getElementById('stat-users').textContent = stats.totalUsers.toLocaleString()
    document.getElementById('stat-groups').textContent = stats.totalGroups.toLocaleString()
    document.getElementById('stat-habz').textContent = fmtHabz(stats.totalHabz)
    document.getElementById('stat-volume').textContent = fmtHabz(stats.volume24h)

    const list = document.getElementById('leaderboard-list')
    list.innerHTML = board.leaderboard.length
      ? board.leaderboard.map((u, i) => `
        <div class="row">
          <span class="row-rank">${i + 1}</span>
          <div class="row-main">
            <div class="row-name">${escapeHtml(u.push_name || u.member_id)}</div>
            <div class="row-sub">${escapeHtml(u.member_id)}</div>
          </div>
          <span class="row-value">${fmtHabz(u.balance)}</span>
        </div>`).join('')
      : '<div class="empty-state">No players yet.</div>'
  } catch (err) {
    if (!quiet) toast(err.message, 'err')
  }
  if (!tickerItems.length) loadRecentTransactionsIntoTicker()
}

// ============================================================
// Users
// ============================================================

let userSearchDebounce = null
document.getElementById('user-search').addEventListener('input', (e) => {
  clearTimeout(userSearchDebounce)
  userSearchDebounce = setTimeout(() => loadUsers(e.target.value.trim()), 300)
})

async function loadUsers(q = '') {
  const list = document.getElementById('user-list')
  list.innerHTML = '<div class="empty-state">Loading…</div>'
  try {
    const { users } = await get(`/users${q ? `?q=${encodeURIComponent(q)}` : ''}`)
    list.innerHTML = users.length
      ? users.map((u) => `
        <div class="row clickable" data-id="${escapeHtml(u.member_id)}">
          <div class="row-main">
            <div class="row-name">${escapeHtml(u.push_name || u.member_id)} ${u.killed_until && new Date(u.killed_until) > new Date() ? '<span class="badge dead">dead</span>' : ''}</div>
            <div class="row-sub">${escapeHtml(u.member_id)} · lvl ${u.level ?? 0}</div>
          </div>
          <span class="row-value">${fmtHabz(u.balance)}</span>
        </div>`).join('')
      : '<div class="empty-state">No matches.</div>'

    list.querySelectorAll('.row.clickable').forEach((row) => {
      row.addEventListener('click', () => openUserDetail(row.dataset.id))
    })
  } catch (err) {
    toast(err.message, 'err')
  }
}

document.getElementById('user-detail-close').addEventListener('click', () => {
  document.getElementById('user-detail-panel').hidden = true
})

async function openUserDetail(memberId) {
  const panel = document.getElementById('user-detail-panel')
  const body = document.getElementById('user-detail-body')
  panel.hidden = false
  document.getElementById('user-detail-name').textContent = memberId
  body.innerHTML = '<div class="empty-state">Loading…</div>'
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' })

  try {
    const { profile, inventory } = await get(`/user/${encodeURIComponent(memberId)}`)
    const isDead = profile.killed_until && new Date(profile.killed_until) > new Date()

    body.innerHTML = `
      <div class="kv-row"><span>Name</span><span>${escapeHtml(profile.push_name || '—')}</span></div>
      <div class="kv-row"><span>Balance</span><span>${fmtHabz(profile.balance)} habz</span></div>
      <div class="kv-row"><span>Level</span><span>${profile.level ?? 0}</span></div>
      <div class="kv-row"><span>Vehicle</span><span>${inventory.vehicle ? inventory.vehicle.name : '—'}</span></div>
      <div class="kv-row"><span>House</span><span>${inventory.house ? inventory.house.name : '—'}</span></div>
      <div class="kv-row"><span>Status</span><span>${isDead ? 'dead' : 'alive'}</span></div>

      <div class="row-actions" style="margin-top:14px;">
        <div class="price-edit">
          <input type="number" id="adjust-amount" placeholder="± amount" />
          <button class="btn-secondary" id="btn-adjust">Adjust balance</button>
        </div>
      </div>
      <div class="row-actions" style="margin-top:10px;">
        <button class="btn-secondary" id="btn-reset-steals">Reset steal cooldown</button>
        ${isDead
          ? '<button class="btn-secondary" id="btn-revive">Revive</button>'
          : '<button class="btn-danger" id="btn-kill">Kill</button>'}
      </div>
    `

    body.querySelector('#btn-adjust').addEventListener('click', async () => {
      const amount = Number(document.getElementById('adjust-amount').value)
      if (!amount) return toast('Enter a non-zero amount', 'err')
      try {
        await post('/adjust-balance', { memberId, amount, reason: 'Admin panel adjustment' })
        toast(`Balance adjusted by ${amount > 0 ? '+' : ''}${amount}`)
        openUserDetail(memberId)
        loadUsers(document.getElementById('user-search').value.trim())
      } catch (err) { toast(err.message, 'err') }
    })

    body.querySelector('#btn-reset-steals').addEventListener('click', async () => {
      try {
        await post('/reset-steals', { memberId })
        toast('Steal cooldown reset')
      } catch (err) { toast(err.message, 'err') }
    })

    const killBtn = body.querySelector('#btn-kill')
    if (killBtn) killBtn.addEventListener('click', async () => {
      if (!confirm(`Kill ${memberId}? This wipes their balance and inventory, and locks them out for 25 minutes.`)) return
      try {
        await post(`/user/${encodeURIComponent(memberId)}/kill`, { hours: 1 })
        toast(`${memberId} killed`)
        openUserDetail(memberId)
      } catch (err) { toast(err.message, 'err') }
    })

    const reviveBtn = body.querySelector('#btn-revive')
    if (reviveBtn) reviveBtn.addEventListener('click', async () => {
      try {
        await post(`/user/${encodeURIComponent(memberId)}/revive`)
        toast(`${memberId} revived`)
        openUserDetail(memberId)
      } catch (err) { toast(err.message, 'err') }
    })
  } catch (err) {
    body.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`
  }
}

// ============================================================
// Groups / broadcast
// ============================================================

async function loadGroups() {
  const list = document.getElementById('group-list')
  const select = document.getElementById('broadcast-group')
  list.innerHTML = '<div class="empty-state">Loading…</div>'
  try {
    const { groups } = await get('/groups')
    list.innerHTML = groups.length
      ? groups.map((g) => `
        <div class="row">
          <div class="row-main">
            <div class="row-name">${escapeHtml(g.group_name || g.group_id)}</div>
            <div class="row-sub">${escapeHtml(g.group_id)}</div>
          </div>
          <span class="row-value" style="color:var(--text-lo)">${g.memberCount} members</span>
        </div>`).join('')
      : '<div class="empty-state">No groups registered yet.</div>'

    select.innerHTML = groups.map((g) => `<option value="${escapeHtml(g.group_id)}">${escapeHtml(g.group_name || g.group_id)}</option>`).join('')
  } catch (err) {
    toast(err.message, 'err')
  }
}

document.getElementById('btn-send-message').addEventListener('click', async () => {
  const groupId = document.getElementById('broadcast-group').value
  const text = document.getElementById('broadcast-text').value.trim()
  if (!groupId || !text) return toast('Pick a group and enter a message', 'err')
  try {
    await post('/broadcast/message', { groupId, text })
    toast('Message sent')
    document.getElementById('broadcast-text').value = ''
  } catch (err) { toast(err.message, 'err') }
})

document.getElementById('btn-send-airdrop').addEventListener('click', async () => {
  const groupId = document.getElementById('broadcast-group').value
  const amount = Number(document.getElementById('broadcast-amount').value)
  if (!groupId || !amount || amount <= 0) return toast('Pick a group and a positive amount', 'err')
  try {
    await post('/broadcast/airdrop', { groupId, amount })
    toast(`Airdrop of ${fmtHabz(amount)} habz sent`)
    document.getElementById('broadcast-amount').value = ''
  } catch (err) { toast(err.message, 'err') }
})

// ============================================================
// Shop
// ============================================================

async function loadShop() {
  const wBox = document.getElementById('shop-weapons')
  const vBox = document.getElementById('shop-vehicles')
  const hBox = document.getElementById('shop-houses')
  wBox.innerHTML = vBox.innerHTML = hBox.innerHTML = '<div class="empty-state">Loading…</div>'
  try {
    const { weapons, vehicles, houses } = await get('/shop')
    // Weapon prices are fixed in code, not the database — shown read-only.
    wBox.innerHTML = weapons.map((w) => `
      <div class="row">
        <div class="row-main">
          <div class="row-name">${w.emoji || ''} ${escapeHtml(w.name)}</div>
          <div class="row-sub">grade ${w.grade} · +${Math.round(w.bonus * 100)}% rob/steal odds</div>
        </div>
        <div class="price-edit"><span>${fmtHabz(w.price)} habz</span></div>
      </div>`).join('') || '<div class="empty-state">No weapons configured.</div>'
    vBox.innerHTML = vehicles.map((v) => shopRow(v, 'vehicle')).join('')
    hBox.innerHTML = houses.map((h) => shopRow(h, 'house')).join('')
    wireShopSaves(vBox, 'vehicle')
    wireShopSaves(hBox, 'house')
  } catch (err) {
    toast(err.message, 'err')
  }
}

function shopRow(item, kind) {
  return `
    <div class="row" data-grade="${item.grade}">
      <div class="row-main">
        <div class="row-name">${item.emoji || ''} ${escapeHtml(item.name)}</div>
        <div class="row-sub">grade ${item.grade}${kind === 'vehicle' ? ` · crew ${item.crew_size}` : ` · +${fmtHabz(item.hourly_rate)}/hr`}</div>
      </div>
      <div class="price-edit">
        <input type="number" class="price-input" value="${item.price}" />
        <button class="btn-secondary btn-save-price">Save</button>
      </div>
    </div>`
}

function wireShopSaves(container, kind) {
  container.querySelectorAll('.row').forEach((row) => {
    const grade = row.dataset.grade
    row.querySelector('.btn-save-price').addEventListener('click', async () => {
      const price = Number(row.querySelector('.price-input').value)
      if (!price || price <= 0) return toast('Enter a valid price', 'err')
      try {
        await put(`/shop/${kind}/${grade}`, { price })
        toast(`${kind === 'vehicle' ? 'Vehicle' : 'House'} grade ${grade} updated`)
      } catch (err) { toast(err.message, 'err') }
    })
  })
}

// ============================================================
// Vaults (marriage)
// ============================================================

async function loadVaults() {
  const list = document.getElementById('vault-list')
  list.innerHTML = '<div class="empty-state">Loading…</div>'
  try {
    const { vaults } = await get('/vaults')
    list.innerHTML = vaults.length
      ? vaults.map((v) => `
        <div class="row" data-member1="${escapeHtml(v.partner1Id)}" data-member2="${escapeHtml(v.partner2Id)}">
          <div class="row-main">
            <div class="row-name">💑 ${escapeHtml(v.partner1Name)} & ${escapeHtml(v.partner2Name)}</div>
            <div class="row-sub">married ${timeAgo(v.marriedAt)} · vault: ${fmtHabz(v.vaultBalance)} habz</div>
          </div>
          <div class="row-actions">
            <button class="btn-danger btn-wipe-vault">Wipe vault</button>
          </div>
        </div>`).join('')
      : '<div class="empty-state">No active marriages.</div>'

    list.querySelectorAll('.btn-wipe-vault').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const row = btn.closest('.row')
        const memberId = row.dataset.member1
        if (!confirm('Wipe this vault and dissolve the marriage? This cannot be undone.')) return
        try {
          await post(`/vault/${encodeURIComponent(memberId)}/wipe`)
          toast('Vault wiped')
          loadVaults()
        } catch (err) { toast(err.message, 'err') }
      })
    })
  } catch (err) {
    toast(err.message, 'err')
    list.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`
  }
}

async function loadProposals() {
  const list = document.getElementById('proposal-list')
  list.innerHTML = '<div class="empty-state">Loading…</div>'
  try {
    const { proposals } = await get('/proposals')
    list.innerHTML = proposals.length
      ? proposals.map((p) => `
        <div class="row" data-id="${escapeHtml(p.id)}">
          <div class="row-main">
            <div class="row-name">💌 ${escapeHtml(p.proposerName)} → ${escapeHtml(p.targetName)}</div>
            <div class="row-sub">proposed ${timeAgo(p.proposedAt)}</div>
          </div>
          <div class="row-actions">
            <button class="btn-danger btn-wipe-proposal">Wipe</button>
          </div>
        </div>`).join('')
      : '<div class="empty-state">No pending proposals.</div>'

    list.querySelectorAll('.btn-wipe-proposal').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.closest('.row').dataset.id
        if (!confirm('Wipe this proposal?')) return
        try {
          await post(`/proposal/${encodeURIComponent(id)}/wipe`)
          toast('Proposal wiped')
          loadProposals()
        } catch (err) { toast(err.message, 'err') }
      })
    })
  } catch (err) {
    toast(err.message, 'err')
    list.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`
  }
}

// ============================================================
// Dead / revive
// ============================================================

async function loadDead() {
  const list = document.getElementById('dead-list')
  list.innerHTML = '<div class="empty-state">Loading…</div>'
  try {
    const { users } = await get('/users/dead')
    list.innerHTML = users.length
      ? users.map((u) => `
        <div class="row" data-member="${escapeHtml(u.member_id)}">
          <div class="row-main">
            <div class="row-name">💀 ${escapeHtml(u.push_name || u.member_id)}</div>
            <div class="row-sub">revives ${timeUntil(u.killed_until)}</div>
          </div>
          <div class="row-actions">
            <button class="btn-secondary btn-revive-row">Revive</button>
          </div>
        </div>`).join('')
      : '<div class="empty-state">Nobody is currently dead.</div>'

    list.querySelectorAll('.btn-revive-row').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const memberId = btn.closest('.row').dataset.member
        try {
          await post(`/user/${encodeURIComponent(memberId)}/revive`)
          toast(`${memberId} revived`)
          loadDead()
        } catch (err) { toast(err.message, 'err') }
      })
    })
  } catch (err) {
    toast(err.message, 'err')
    list.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`
  }
}

// ============================================================
// Moderators
// ============================================================

async function loadModerators() {
  const list = document.getElementById('mod-list')
  list.innerHTML = '<div class="empty-state">Loading…</div>'
  try {
    const { moderators } = await get('/moderators')
    list.innerHTML = moderators.length
      ? moderators.map((m) => `
        <div class="row">
          <div class="row-main">
            <div class="row-name">${escapeHtml(m.member_id)}</div>
            <div class="row-sub">added ${timeAgo(m.added_at)}</div>
          </div>
          <button class="btn-ghost btn-remove-mod" data-id="${escapeHtml(m.member_id)}">Remove</button>
        </div>`).join('')
      : '<div class="empty-state">No moderators yet.</div>'

    list.querySelectorAll('.btn-remove-mod').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await del(`/moderators/${encodeURIComponent(btn.dataset.id)}`)
          toast('Moderator removed')
          loadModerators()
        } catch (err) { toast(err.message, 'err') }
      })
    })
  } catch (err) {
    toast(err.message, 'err')
  }
}

document.getElementById('mod-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const input = document.getElementById('mod-input')
  const memberId = input.value.trim()
  if (!memberId) return
  try {
    await post('/moderators', { memberId })
    toast('Moderator added')
    input.value = ''
    loadModerators()
  } catch (err) { toast(err.message, 'err') }
})

// ============================================================
// Settings
// ============================================================

async function loadSettings() {
  try {
    const { aiEnabled } = await get('/settings')
    const toggle = document.getElementById('toggle-ai')
    toggle.setAttribute('aria-checked', String(aiEnabled))
  } catch (err) {
    toast(err.message, 'err')
  }

  try {
    const { version, text } = await get('/changelog')
    document.getElementById('changelog-version').value = version || ''
    document.getElementById('changelog-text').value = text || ''
  } catch (err) {
    toast(err.message, 'err')
  }

  loadEventStatus()
}

async function loadEventStatus() {
  const status = document.getElementById('event-status')
  try {
    const { active } = await get('/event')
    status.textContent = active
      ? `${active.emoji} ${active.label} is running — ${active.description} (ends ${timeUntil(active.expiresAt)})`
      : 'No event is currently running.'
  } catch (err) {
    status.textContent = 'Could not load event status.'
  }
}

document.getElementById('toggle-ai').addEventListener('click', async (e) => {
  const toggle = e.currentTarget
  const next = toggle.getAttribute('aria-checked') !== 'true'
  toggle.setAttribute('aria-checked', String(next))
  try {
    await post('/settings', { aiEnabled: next })
    toast(`AI replies turned ${next ? 'on' : 'off'}`)
  } catch (err) {
    toggle.setAttribute('aria-checked', String(!next))
    toast(err.message, 'err')
  }
})

document.getElementById('changelog-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const version = document.getElementById('changelog-version').value.trim()
  const text = document.getElementById('changelog-text').value.trim()
  if (!version || !text) return toast('Fill in both version and what\'s new', 'err')
  try {
    await post('/changelog', { version, text })
    toast('Changelog saved — will broadcast on next restart if the version is new')
  } catch (err) {
    toast(err.message, 'err')
  }
})

document.getElementById('event-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const type = document.getElementById('event-type').value
  const minutes = Number(document.getElementById('event-minutes').value)
  const multiplierRaw = document.getElementById('event-multiplier').value
  const multiplier = multiplierRaw ? Number(multiplierRaw) : undefined
  if (!minutes || minutes <= 0) return toast('Enter a valid duration in minutes', 'err')
  try {
    await post('/event/start', { type, minutes, multiplier })
    toast('Event started and announced to every group')
    loadEventStatus()
  } catch (err) {
    toast(err.message, 'err')
  }
})

document.getElementById('btn-stop-event').addEventListener('click', async () => {
  try {
    await post('/event/stop')
    toast('Event stopped')
    loadEventStatus()
  } catch (err) {
    toast(err.message, 'err')
  }
})

// ============================================================
// Boot — requires a valid session, or bounce to login.html
// ============================================================

;(function boot() {
  const saved = loadSession()
  if (!saved) {
    location.href = 'login.html'
    return
  }
  session = saved
  api('/ping')
    .then(enterApp)
    .catch(() => {
      session = null
      clearSession()
      location.href = 'login.html'
    })
})()
