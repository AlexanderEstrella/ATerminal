'use strict';
// ── State ──────────────────────────────────────────────────────────────────
let token = localStorage.getItem('at_token');
let currentUser = null;
let socket = null;
let activeSessionId = null;
const openTerminals = new Map(); // sessionId → { term, fitAddon, pane, tab }
const replayedSessions = new Set();
let visibleTabIds = []; // IDs of the ≤3 tabs currently shown; rest live in the overflow dropdown
const watchedSessions = new Set(); // sessionIds to notify on exit
let agentData = []; // cached agents array
let sessionData = []; // cached sessions array
let serverPublicUrl = null;
let agentRefreshTimer = null;
let devicePollTimer = null;
let locationAgentSeq = 0;
let locationBrowseSeq = 0;
let sessionContextSeq = 0;
let currentSessionContext = null;
let sessionContextRefreshTimer = null;
let speechRecognition = null;
let speechListening = false;
const locationState = {
    agentId: '',
    currentPath: '',
    parentPath: '',
    roots: [],
    directories: [],
    files: [],
    recent: [],
    favorites: [],
    favoritePaths: new Set(),
    browseLoading: false,
    savedLoading: false,
    browseError: '',
    savedError: '',
};
// ── DOM helpers ────────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const show = (el) => el.classList.remove('hidden');
const hide = (el) => el.classList.add('hidden');
// ── Screens ────────────────────────────────────────────────────────────────
function showScreen(name) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    const el = $(`#${name}-screen`);
    if (el)
        el.classList.add('active');
}
// ── API ────────────────────────────────────────────────────────────────────
async function apiRequest(method, path, body) {
    const res = await fetch(path, {
        method,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
        logout();
        throw new Error('Session expired');
    }
    const data = await res.json();
    if (!res.ok)
        throw new Error(data.error || `HTTP ${res.status}`);
    return data;
}
async function renderQr(container, text) {
    container.innerHTML = '<span class="empty-state">Loading QR...</span>';
    const data = await apiRequest('POST', '/api/qr', { text });
    const img = document.createElement('img');
    img.alt = '';
    img.src = data.dataUrl;
    container.replaceChildren(img);
}
async function copyText(text, btn) {
    try {
        await navigator.clipboard.writeText(text);
    }
    catch (_) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
    }
    if (btn) {
        const label = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = label; }, 1800);
    }
}
async function shareOrCopy(text, title, btn) {
    if (navigator.share) {
        try {
            const payload = { title, text };
            if (text.startsWith('http'))
                payload.url = text;
            await navigator.share(payload);
            return;
        }
        catch (err) {
            if (err.name === 'AbortError')
                return;
        }
    }
    await copyText(text, btn);
}
function showToast(message, type = 'info', duration = 4000) {
    const container = $('#toast-container');
    if (!container)
        return;
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => { el.remove(); }, duration);
}
// ── Auth ───────────────────────────────────────────────────────────────────
$('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#login-btn');
    const errEl = $('#login-error');
    hide(errEl);
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: $('#username').value.trim(),
                password: $('#password').value,
            }),
        });
        const data = await res.json();
        if (!res.ok)
            throw new Error(data.error || 'Login failed');
        token = data.token;
        currentUser = data.user;
        localStorage.setItem('at_token', token);
        try {
            const status = await apiRequest('GET', '/api/status');
            if (status && status.user)
                currentUser = status.user;
            if (status && status.publicUrl)
                serverPublicUrl = status.publicUrl;
        }
        catch (_) { }
        initDashboard();
    }
    catch (err) {
        errEl.textContent = err.message;
        show(errEl);
    }
    finally {
        btn.disabled = false;
        btn.textContent = 'Sign In';
    }
});
function logout() {
    localStorage.removeItem('at_token');
    token = null;
    currentUser = null;
    if (socket) {
        socket.disconnect();
        socket = null;
    }
    if (agentRefreshTimer) {
        clearInterval(agentRefreshTimer);
        agentRefreshTimer = null;
    }
    if (devicePollTimer) {
        clearInterval(devicePollTimer);
        devicePollTimer = null;
    }
    openTerminals.forEach((t) => t.term.dispose());
    openTerminals.clear();
    activeSessionId = null;
    agentData = [];
    sessionData = [];
    currentSessionContext = null;
    stopSpeechRecognition();
    showScreen('login');
}
// ── Socket ─────────────────────────────────────────────────────────────────
function updateStatusDot() {
    const dot = $('#status-dot');
    if (!dot)
        return;
    if (!socket || !socket.connected) {
        dot.className = 'status-dot disconnected';
        dot.title = 'Disconnected';
    }
    else if (agentData.some((a) => a.status === 'online')) {
        dot.className = 'status-dot agents-online';
        dot.title = 'Connected · machines online';
    }
    else {
        dot.className = 'status-dot connected';
        dot.title = 'Connected · no agents';
    }
}
function connectSocket() {
    socket = io({ auth: { token } });
    let everConnected = false;
    socket.on('connect', () => {
        openTerminals.forEach((_, sessionId) => {
            socket.emit('terminal:attach', { sessionId, noReplay: replayedSessions.has(sessionId) });
        });
        updateStatusDot();
        if (everConnected && openTerminals.size > 0) {
            openTerminals.forEach((entry) => {
                entry.term.writeln('\r\x1b[33m[Reconnected]\x1b[0m');
            });
            showToast('Reconnected', 'online', 3000);
        }
        everConnected = true;
    });
    socket.on('disconnect', () => {
        updateStatusDot();
        if (openTerminals.size > 0) {
            showToast('Connection lost — reconnecting…', 'offline', 5000);
        }
    });
    socket.on('terminal:output', ({ sessionId, data }) => {
        const entry = openTerminals.get(sessionId);
        if (entry)
            entry.term.write(data);
    });
    socket.on('terminal:exit', ({ sessionId, code }) => {
        const entry = openTerminals.get(sessionId);
        if (entry) {
            const clean = code === 0 || code == null;
            const msg = clean
                ? '\r\x1b[2m[Process exited]\x1b[0m'
                : `\r\x1b[33m[Process exited — code ${code}]\x1b[0m`;
            entry.term.writeln(msg);
            entry.term.writeln('\x1b[2m[This session is now history. Use + New to start a fresh one.]\x1b[0m');
        }
        if (watchedSessions.has(sessionId)) {
            watchedSessions.delete(sessionId);
            updateWatchButton();
            if (Notification.permission === 'granted') {
                const s = getSessionById(sessionId);
                new Notification('ATerminal: process finished', {
                    body: (s?.name || s?.shell || 'Session') + ' exited' + (code != null ? ` (code ${code})` : ''),
                    icon: '/icon.svg',
                });
            }
        }
        loadSessions();
        showToast('Process exited', 'info', 3000);
    });
    socket.on('agent:status', ({ hostname, status }) => {
        if (status === 'online') {
            showToast(`${hostname || 'Agent'} connected`, 'online');
        }
        else {
            showToast(`${hostname || 'Agent'} disconnected`, 'offline');
        }
        loadAgents();
        loadSessions();
    });
    socket.on('sessions:changed', () => {
        loadSessions();
    });
    socket.on('terminal:error', ({ sessionId, message }) => {
        const entry = openTerminals.get(sessionId);
        if (entry) {
            entry.term.write(`\r\n\x1b[33m[Error: ${escHtml(message)}]\x1b[0m\r\n`);
        }
    });
}
// ── Agents ─────────────────────────────────────────────────────────────────
async function loadAgents() {
    try {
        const agents = await apiRequest('GET', '/api/agents');
        agentData = agents;
        renderAgentList(agents);
    }
    catch { /* ignore */ }
}
function renderAgentList(agents) {
    const list = $('#agent-list');
    if (agents.length === 0) {
        list.innerHTML = '<div class="empty-state">No machines enrolled</div>';
        return;
    }
    list.innerHTML = agents.map((a) => {
        const platformIcon = { win32: '🖥', darwin: '🍎', linux: '🐧' }[a.platform] || '💻';
        const isOnline = a.status === 'online';
        const badgeClass = isOnline ? 'agent-status-badge online' : 'agent-status-badge offline';
        const badgeText = isOnline ? 'online' : 'offline';
        const lastSeen = a.last_seen ? relativeTime(a.last_seen) : 'never';
        return `
      <div class="agent-card">
        <span class="platform-icon">${platformIcon}</span>
        <div class="agent-card-info">
          <div class="agent-hostname">${escHtml(a.hostname || a.name || a.id)}</div>
          <div class="agent-meta">${escHtml(a.platform || '')} · last seen ${lastSeen}</div>
        </div>
        <span class="${badgeClass}">${badgeText}</span>
        <button class="unpair-btn icon-btn" data-id="${a.id}" title="Unpair agent">✕</button>
      </div>
    `;
    }).join('');
    list.querySelectorAll('.unpair-btn').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!confirm(`Unpair ${btn.closest('.agent-card').querySelector('.agent-hostname').textContent}?`))
                return;
            try {
                await apiRequest('DELETE', `/api/agents/${btn.dataset.id}`);
                await loadAgents();
            }
            catch (err) {
                alert(err.message);
            }
        });
    });
    updateStatusDot();
}
function getOnlineAgents() {
    return agentData.filter((a) => a.status === 'online');
}
// ── Sessions ───────────────────────────────────────────────────────────────
async function loadSessions() {
    try {
        const sessions = await apiRequest('GET', '/api/sessions');
        sessionData = sessions;
        renderSessionList(sessions);
    }
    catch { /* ignore */ }
}
function renderSessionList(sessions) {
    const list = $('#session-list');
    const query = ($('#session-search')?.value || '').trim().toLowerCase();
    const filtered = query
        ? sessions.filter((s) => (s.name || '').toLowerCase().includes(query) ||
            (s.shell || '').toLowerCase().includes(query) ||
            (s.cwd || '').toLowerCase().includes(query))
        : sessions;
    if (filtered.length === 0) {
        list.innerHTML = query
            ? `<div class="empty-state">No sessions match "${escHtml(query)}".</div>`
            : '<div class="empty-state">No sessions. Create one →</div>';
        return;
    }
    const active = filtered
        .filter((s) => s.status === 'active')
        .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0));
    const history = filtered
        .filter((s) => s.status !== 'active')
        .sort((a, b) => Number(b.ended_at || b.created_at || 0) - Number(a.ended_at || a.created_at || 0));
    let html = active.length === 0
        ? '<div class="empty-state">No active sessions.</div>'
        : buildSessionGroupsHtml(active);
    if (history.length > 0) {
        const open = localStorage.getItem('at_history_open') === 'true';
        html += `
      <div class="session-history-hdr" data-open="${open}">
        <span>History (${history.length})</span>
        <div style="display:flex;align-items:center;gap:6px">
          <button class="session-history-clear btn btn-sm btn-ghost" type="button" title="Delete all history">Clear</button>
          <span class="history-chevron">${open ? '▲' : '▼'}</span>
        </div>
      </div>
      <div class="session-history-body${open ? '' : ' hidden'}">
        ${buildSessionGroupsHtml(history)}
      </div>
    `;
    }
    list.innerHTML = html;
    list.querySelector('.session-history-clear')?.addEventListener('click', async (e) => {
        e.stopPropagation(); // don't toggle the section
        if (!confirm('Delete all history sessions?'))
            return;
        try {
            await apiRequest('DELETE', '/api/sessions/history');
            await loadSessions();
        }
        catch (err) {
            showToast(err.message, 'info');
        }
    });
    list.querySelector('.session-history-hdr')?.addEventListener('click', () => {
        const hdr = list.querySelector('.session-history-hdr');
        const body = list.querySelector('.session-history-body');
        const isOpen = hdr.dataset.open === 'true';
        hdr.dataset.open = String(!isOpen);
        hdr.querySelector('.history-chevron').textContent = !isOpen ? '▲' : '▼';
        body.classList.toggle('hidden', isOpen);
        localStorage.setItem('at_history_open', String(!isOpen));
    });
    list.querySelectorAll('.session-item').forEach((item) => {
        item.addEventListener('click', (e) => {
            const killBtn = e.target.closest('.session-kill');
            if (killBtn) {
                e.stopPropagation();
                killSession(killBtn.dataset.id);
                return;
            }
            const sessionId = item.dataset.id;
            const session = sessionData.find((s) => s.id === sessionId);
            if (session) {
                openSession(session);
                closeSidebar();
            }
        });
    });
}
function buildSessionGroupsHtml(sessionList) {
    const groups = new Map();
    sessionList.forEach((s) => {
        if (!groups.has(s.agent_id))
            groups.set(s.agent_id, []);
        groups.get(s.agent_id).push(s);
    });
    let html = '';
    groups.forEach((groupSessions, agentId) => {
        const groupAgent = groupSessions.find((s) => s.agent)?.agent;
        const agent = groupAgent || agentData.find((a) => a.id === agentId);
        const hostname = agent ? (agent.hostname || agent.name || agentId) : agentId;
        html += `<div class="session-group-header">${escHtml(hostname)}</div>`;
        groupSessions.forEach((s) => {
            const isActive = s.status === 'active';
            const dotClass = isActive ? 'session-indicator' : 'session-indicator dead';
            const label = s.name || s.shell || 'Session';
            const sessionMeta = [s.shell || '', isActive ? 'active' : 'history'];
            if (s.cwd)
                sessionMeta.push(locationLabel(s.cwd));
            if (!isActive && s.ended_at)
                sessionMeta.push(`ended ${relativeTime(s.ended_at)}`);
            const openActive = activeSessionId === s.id ? ' active' : '';
            html += `
        <div class="session-item${openActive}" data-id="${s.id}" data-status="${escHtml(s.status || '')}" title="${escHtml(s.cwd || 'Agent default directory')}">
          <div class="${dotClass}"></div>
          <div class="session-info">
            <div class="session-name">${escHtml(label)}</div>
            <div class="session-shell">${escHtml(sessionMeta.filter(Boolean).join(' · '))}</div>
          </div>
          <button class="session-kill" title="Kill session" data-id="${s.id}">✕</button>
        </div>
      `;
        });
    });
    return html;
}
async function killSession(id) {
    if (!confirm('Kill this session?'))
        return;
    try {
        await apiRequest('DELETE', `/api/sessions/${id}`);
        closeTab(id);
        loadSessions();
    }
    catch (err) {
        alert(err.message);
    }
}
// ── New session modal ──────────────────────────────────────────────────────
function getSessionById(sessionId) {
    return sessionData.find((s) => s.id === sessionId)
        || openTerminals.get(sessionId)?.session
        || (currentSessionContext?.session?.id === sessionId ? currentSessionContext.session : null);
}
function renderSessionContext(sessionId = activeSessionId) {
    const panel = $('#session-context-panel');
    if (!panel)
        return;
    if (!sessionId) {
        hide(panel);
        currentSessionContext = null;
        return;
    }
    show(panel);
    const session = getSessionById(sessionId);
    const fallback = session ? { session, agent: session.agent || null, outputPreview: '' } : null;
    updateSessionContext(fallback, true);
    loadSessionContext(sessionId);
}
function scheduleSessionContextRefresh(sessionId) {
    if (sessionContextRefreshTimer)
        clearTimeout(sessionContextRefreshTimer);
    sessionContextRefreshTimer = setTimeout(() => {
        if (activeSessionId === sessionId)
            loadSessionContext(sessionId);
    }, 800);
}
async function loadSessionContext(sessionId) {
    const seq = ++sessionContextSeq;
    try {
        const data = await apiRequest('GET', `/api/sessions/${encodeURIComponent(sessionId)}/context`);
        if (seq !== sessionContextSeq || activeSessionId !== sessionId)
            return;
        currentSessionContext = data;
        updateSessionContext(data, false);
    }
    catch (err) {
        if (seq !== sessionContextSeq || activeSessionId !== sessionId)
            return;
        $('#session-context-output').textContent = err.message || 'Session context unavailable.';
    }
}
function updateSessionContext(data, loading) {
    const titleEl = $('#session-context-title');
    const metaEl = $('#session-context-meta');
    const outputEl = $('#session-context-output');
    if (!titleEl || !metaEl || !outputEl || !activeSessionId)
        return;
    const session = data?.session || getSessionById(activeSessionId);
    if (!session) {
        titleEl.textContent = 'Session context';
        metaEl.textContent = '';
        outputEl.textContent = loading ? 'Loading context...' : 'No session metadata available.';
        return;
    }
    const agent = data?.agent || session.agent || agentData.find((a) => a.id === session.agent_id);
    const agentName = agent ? (agent.hostname || agent.name || agent.id) : session.agent_id;
    const statusParts = [
        session.status || 'unknown',
        session.shell || 'shell',
        agentName ? `${agentName}${agent?.status ? ` (${agent.status})` : ''}` : '',
        session.cwd ? session.cwd : 'Agent default directory',
        session.created_at ? `created ${relativeTime(session.created_at)}` : '',
    ].filter(Boolean);
    titleEl.textContent = session.name || session.shell || 'Session';
    metaEl.textContent = statusParts.join(' · ');
    outputEl.textContent = loading
        ? 'Loading recent output...'
        : (data?.outputPreview?.trimEnd() || 'No recent output yet.');
}
function updateWatchButton() {
    const btn = $('#session-context-watch');
    if (!btn)
        return;
    const watching = activeSessionId && watchedSessions.has(activeSessionId);
    btn.classList.toggle('btn-watching', watching);
    btn.title = watching ? 'Stop watching (notification on exit)' : 'Notify me when this session finishes';
}
function showTerminalContextMenu(x, y, term, sessionId) {
    document.querySelector('.term-context-menu')?.remove();
    const sel = getTerminalSelection(term);
    const menu = document.createElement('div');
    menu.className = 'term-context-menu';
    const copyBtn = document.createElement('button');
    copyBtn.className = 'term-ctx-item';
    copyBtn.textContent = 'Copy';
    if (!sel)
        copyBtn.disabled = true;
    const pasteBtn = document.createElement('button');
    pasteBtn.className = 'term-ctx-item';
    pasteBtn.textContent = 'Paste';
    menu.appendChild(copyBtn);
    menu.appendChild(pasteBtn);
    menu.style.left = `${Math.min(x, window.innerWidth - 160)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - 80)}px`;
    document.body.appendChild(menu);
    copyBtn.addEventListener('click', () => { if (sel)
        copyText(sel); menu.remove(); });
    pasteBtn.addEventListener('click', () => {
        navigator.clipboard.readText()
            .then(text => { if (text)
            sendTerminalInput(sessionId, text); })
            .catch(() => showToast('Clipboard access denied', 'error', 2000));
        menu.remove();
    });
    const dismiss = (e) => {
        if (!menu.contains(e.target)) {
            menu.remove();
            document.removeEventListener('pointerdown', dismiss, true);
        }
    };
    setTimeout(() => document.addEventListener('pointerdown', dismiss, true), 0);
}
function getTerminalSelection(term) {
    return term?.getSelection?.() || term?._aterminalLastSelection || '';
}
function copyTerminalOutput() {
    if (!activeSessionId)
        return;
    const entry = openTerminals.get(activeSessionId);
    if (!entry)
        return;
    const buf = entry.term.buffer.active;
    const start = Math.max(0, buf.length - 500);
    const lines = [];
    for (let i = start; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line)
            lines.push(line.translateToString(true));
    }
    while (lines.length > 0 && !lines[lines.length - 1].trim())
        lines.pop();
    copyText(lines.join('\n'), $('#session-context-copy-output'));
}
function terminalBufferToText(term) {
    const buf = term?.buffer?.active;
    if (!buf)
        return '';
    const lines = [];
    for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line)
            lines.push(line.translateToString(true));
    }
    while (lines.length > 0 && !lines[lines.length - 1].trim())
        lines.pop();
    return cleanTerminalText(lines.join('\n'));
}
function cleanTerminalText(text) {
    return String(text || '')
        .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}
function openTerminalTextView(term) {
    document.querySelector('.terminal-text-view')?.remove();
    const text = terminalBufferToText(term);
    if (!text) {
        showToast('No terminal output to copy yet.', 'info', 2000);
        return;
    }
    const modal = document.createElement('div');
    modal.className = 'modal terminal-text-view';
    modal.innerHTML = `
    <div class="modal-backdrop"></div>
    <div class="modal-card terminal-text-modal">
      <h3>Terminal Text</h3>
      <textarea class="terminal-text-output" readonly></textarea>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost terminal-text-close">Close</button>
        <button type="button" class="btn btn-primary terminal-text-copy">Copy All</button>
      </div>
    </div>
  `;
    document.body.appendChild(modal);
    const output = modal.querySelector('.terminal-text-output');
    output.value = text;
    output.focus();
    output.select();
    modal.querySelector('.modal-backdrop').addEventListener('click', () => modal.remove());
    modal.querySelector('.terminal-text-close').addEventListener('click', () => modal.remove());
    modal.querySelector('.terminal-text-copy').addEventListener('click', () => copyText(output.value, modal.querySelector('.terminal-text-copy')));
}
function copyCurrentSessionContext() {
    if (!activeSessionId)
        return;
    const contextData = currentSessionContext?.session?.id === activeSessionId ? currentSessionContext : null;
    const session = contextData?.session || getSessionById(activeSessionId);
    if (!session)
        return;
    const output = contextData?.outputPreview || $('#session-context-output')?.textContent || '';
    const context = [
        `Session: ${session.name || session.id}`,
        `Status: ${session.status || 'unknown'}`,
        `Shell: ${session.shell || 'unknown'}`,
        `Working directory: ${session.cwd || 'Agent default directory'}`,
        '',
        'Recent output:',
        output || 'No recent output.',
    ].join('\n');
    copyText(context, $('#session-context-copy'));
}
function sendTerminalInput(sessionId, data) {
    if (!sessionId || typeof data !== 'string')
        return false;
    const session = getSessionById(sessionId);
    if (session && session.status !== 'active') {
        showToast('This session is history. Open an active session to type.', 'info');
        return false;
    }
    if (!socket?.connected) {
        showToast('Terminal is disconnected. Reconnecting...', 'offline');
        return false;
    }
    socket.emit(data === '\x03' ? 'terminal:interrupt' : 'terminal:input', { sessionId, data });
    return true;
}
function openNewSessionModal() {
    const agentSelect = $('#session-agent');
    agentSelect.innerHTML = '<option value="">Select an online agent…</option>';
    const online = getOnlineAgents();
    if (online.length === 0) {
        agentSelect.innerHTML = '<option value="">No online agents</option>';
    }
    else {
        online.forEach((a) => {
            const opt = document.createElement('option');
            opt.value = a.id;
            opt.textContent = a.hostname || a.name || a.id;
            agentSelect.appendChild(opt);
        });
    }
    // Reset shell dropdown
    $('#session-shell').innerHTML = '<option value="">Select agent first…</option>';
    resetLocationPicker();
    show($('#session-modal'));
}
function closeNewSessionModal() {
    hide($('#session-modal'));
    $('#session-name').value = '';
    resetLocationPicker();
}
$('#session-agent').addEventListener('change', () => {
    const agentId = $('#session-agent').value;
    const shellSelect = $('#session-shell');
    shellSelect.innerHTML = '';
    resetLocationPicker();
    if (!agentId) {
        shellSelect.innerHTML = '<option value="">Select agent first…</option>';
        return;
    }
    const agent = agentData.find((a) => a.id === agentId);
    const shells = agent && Array.isArray(agent.shells) && agent.shells.length > 0
        ? agent.shells
        : getDefaultShells(agent);
    shells.forEach((sh) => {
        const opt = document.createElement('option');
        opt.value = sh;
        opt.textContent = shellLabel(sh);
        shellSelect.appendChild(opt);
    });
    loadLocationPicker(agentId);
});
function getDefaultShells(agent) {
    if (!agent)
        return ['powershell', 'cmd'];
    if (agent.platform === 'win32')
        return ['powershell', 'cmd', 'wsl'];
    if (agent.platform === 'darwin')
        return ['zsh', 'bash'];
    return ['bash', 'sh'];
}
function shellLabel(sh) {
    const labels = {
        powershell: 'PowerShell',
        cmd: 'Command Prompt (CMD)',
        wsl: 'WSL',
        bash: 'Bash',
        zsh: 'Zsh',
        sh: 'sh',
    };
    return labels[sh] || sh;
}
function resetLocationPicker() {
    locationAgentSeq += 1;
    locationBrowseSeq += 1;
    Object.assign(locationState, {
        agentId: '',
        currentPath: '',
        parentPath: '',
        roots: [],
        directories: [],
        files: [],
        recent: [],
        favorites: [],
        favoritePaths: new Set(),
        browseLoading: false,
        savedLoading: false,
        browseError: '',
        savedError: '',
    });
    setSessionCwd('');
    renderLocationPicker();
}
async function loadLocationPicker(agentId) {
    const seq = ++locationAgentSeq;
    Object.assign(locationState, {
        agentId,
        currentPath: '',
        parentPath: '',
        roots: [],
        directories: [],
        files: [],
        recent: [],
        favorites: [],
        favoritePaths: new Set(),
        browseLoading: true,
        savedLoading: true,
        browseError: '',
        savedError: '',
    });
    setSessionCwd('');
    renderLocationPicker();
    await Promise.all([
        loadSavedLocations(agentId, seq),
        browseLocation(undefined, seq),
    ]);
}
async function loadSavedLocations(agentId, seq = locationAgentSeq) {
    locationState.savedLoading = true;
    locationState.savedError = '';
    renderLocationPicker();
    const [recentResult, favoriteResult] = await Promise.allSettled([
        apiRequest('GET', `/api/locations?agentId=${encodeURIComponent(agentId)}&type=recent`),
        apiRequest('GET', `/api/locations?agentId=${encodeURIComponent(agentId)}&type=favorite`),
    ]);
    if (seq !== locationAgentSeq)
        return;
    locationState.recent = recentResult.status === 'fulfilled'
        ? normalizeLocationList(recentResult.value)
        : [];
    locationState.favorites = favoriteResult.status === 'fulfilled'
        ? normalizeLocationList(favoriteResult.value)
        : [];
    locationState.favoritePaths = new Set(locationState.favorites.map((item) => item.path));
    locationState.savedError = recentResult.status === 'rejected' || favoriteResult.status === 'rejected'
        ? 'Saved locations unavailable.'
        : '';
    locationState.savedLoading = false;
    renderLocationPicker();
}
async function browseLocation(path, seq = locationAgentSeq) {
    if (!locationState.agentId)
        return;
    const browseSeq = ++locationBrowseSeq;
    const requestedPath = normalizePath(path);
    locationState.browseLoading = true;
    locationState.browseError = '';
    renderLocationPicker();
    try {
        const query = requestedPath ? `?path=${encodeURIComponent(requestedPath)}` : '';
        const data = await apiRequest('GET', `/api/agents/${encodeURIComponent(locationState.agentId)}/locations${query}`);
        if (seq !== locationAgentSeq || browseSeq !== locationBrowseSeq)
            return;
        const normalized = normalizeDirectoryResponse(data, requestedPath);
        locationState.currentPath = normalized.currentPath;
        locationState.parentPath = normalized.parentPath;
        locationState.roots = normalized.roots;
        locationState.directories = normalized.directories;
        locationState.files = normalized.files;
        if (normalized.currentPath || requestedPath) {
            setSessionCwd(normalized.currentPath || requestedPath);
        }
    }
    catch (err) {
        if (seq !== locationAgentSeq || browseSeq !== locationBrowseSeq)
            return;
        locationState.browseError = err.message || 'Locations unavailable.';
        locationState.roots = [];
        locationState.directories = [];
        locationState.files = [];
        locationState.parentPath = '';
        if (requestedPath) {
            locationState.currentPath = requestedPath;
            setSessionCwd(requestedPath);
        }
    }
    finally {
        if (seq === locationAgentSeq && browseSeq === locationBrowseSeq) {
            locationState.browseLoading = false;
            renderLocationPicker();
        }
    }
}
function renderLocationPicker() {
    const current = $('#session-location-current');
    const browser = $('#session-location-browser');
    const recent = $('#session-location-recent');
    const favorites = $('#session-location-favorites');
    const upBtn = $('#session-location-up');
    const favBtn = $('#session-favorite-current');
    const cwdInput = $('#session-cwd');
    const cwd = normalizePath(cwdInput?.value || locationState.currentPath);
    if (cwdInput)
        cwdInput.disabled = !locationState.agentId;
    $('#session-cwd-browse').disabled = !locationState.agentId || locationState.browseLoading;
    if (!locationState.agentId) {
        current.textContent = 'Select an agent to browse locations.';
        browser.innerHTML = '<div class="empty-state">Select an agent to browse locations.</div>';
        recent.innerHTML = '<div class="empty-state">Select an agent first.</div>';
        favorites.innerHTML = '<div class="empty-state">Select an agent first.</div>';
        upBtn.disabled = true;
        favBtn.disabled = true;
        favBtn.classList.remove('active');
        favBtn.innerHTML = '&#9734;';
        favBtn.title = 'Add current path to favorites';
        favBtn.setAttribute('aria-label', 'Add current path to favorites');
        return;
    }
    current.textContent = locationState.currentPath || 'Agent default directory';
    upBtn.disabled = !locationState.parentPath || locationState.browseLoading;
    const currentIsFavorite = Boolean(cwd && locationState.favoritePaths.has(cwd));
    favBtn.disabled = !cwd || locationState.savedLoading;
    favBtn.classList.toggle('active', currentIsFavorite);
    favBtn.innerHTML = currentIsFavorite ? '&#9733;' : '&#9734;';
    favBtn.title = currentIsFavorite ? 'Remove current path from favorites' : 'Add current path to favorites';
    favBtn.setAttribute('aria-label', favBtn.title);
    if (locationState.browseLoading) {
        browser.innerHTML = '<div class="empty-state">Loading directories...</div>';
    }
    else if (locationState.browseError) {
        browser.innerHTML = `<div class="empty-state">${escHtml(locationState.browseError)}</div>`;
    }
    else {
        const roots = locationState.roots.map((root) => ({ ...root, isRoot: true }));
        renderLocationRows(browser, [...roots, ...locationState.directories], 'No directories found.');
        locationState.files.forEach((entry) => {
            const row = document.createElement('div');
            row.className = 'location-item file-item';
            const sizeStr = entry.size > 1024 * 1024
                ? `${(entry.size / 1024 / 1024).toFixed(1)}MB`
                : entry.size > 1024
                    ? `${(entry.size / 1024).toFixed(1)}KB`
                    : `${entry.size}B`;
            row.innerHTML = `<span class="location-name">📄 ${escHtml(entry.name)}</span><span class="location-file-size">${sizeStr}</span><button class="btn btn-sm btn-ghost download-file-btn">↓</button>`;
            row.querySelector('.download-file-btn').addEventListener('click', () => downloadFile(locationState.agentId, entry.path));
            browser.appendChild(row);
        });
    }
    if (locationState.savedLoading) {
        recent.innerHTML = '<div class="empty-state">Loading...</div>';
        favorites.innerHTML = '<div class="empty-state">Loading...</div>';
    }
    else if (locationState.savedError) {
        recent.innerHTML = `<div class="empty-state">${escHtml(locationState.savedError)}</div>`;
        favorites.innerHTML = `<div class="empty-state">${escHtml(locationState.savedError)}</div>`;
    }
    else {
        renderLocationRows(recent, locationState.recent, 'No recent locations.');
        renderLocationRows(favorites, locationState.favorites, 'No favorites yet.');
    }
}
function renderLocationRows(container, rows, emptyText) {
    if (!rows.length) {
        container.innerHTML = `<div class="empty-state">${escHtml(emptyText)}</div>`;
        return;
    }
    container.innerHTML = rows.map((item) => {
        const path = normalizePath(item.path);
        const isFav = locationState.favoritePaths.has(path);
        const favoriteTitle = isFav ? 'Remove from favorites' : 'Add to favorites';
        const favoriteIcon = isFav ? '&#9733;' : '&#9734;';
        return `
      <div class="location-row" data-path="${escHtml(path)}">
        <button type="button" class="location-row-main" data-path="${escHtml(path)}" title="${escHtml(path)}">
          <span class="location-label">${escHtml(item.label || item.name || locationLabel(path))}</span>
          <span class="location-path">${escHtml(path)}</span>
        </button>
        <button type="button" class="icon-btn location-row-favorite favorite-toggle${isFav ? ' active' : ''}" data-path="${escHtml(path)}" aria-label="${favoriteTitle}" title="${favoriteTitle}">${favoriteIcon}</button>
      </div>
    `;
    }).join('');
    container.querySelectorAll('.location-row-main').forEach((btn) => {
        btn.addEventListener('click', () => {
            setSessionCwd(btn.dataset.path);
            browseLocation(btn.dataset.path);
        });
    });
    container.querySelectorAll('.location-row-favorite').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleFavorite(btn.dataset.path);
        });
    });
}
async function toggleFavorite(path) {
    const normalizedPath = normalizePath(path);
    if (!locationState.agentId || !normalizedPath)
        return;
    const isFavorite = locationState.favoritePaths.has(normalizedPath);
    try {
        if (isFavorite) {
            await apiRequest('DELETE', '/api/locations/favorites', { agentId: locationState.agentId, path: normalizedPath });
            locationState.favoritePaths.delete(normalizedPath);
        }
        else {
            await apiRequest('POST', '/api/locations/favorites', {
                agentId: locationState.agentId,
                path: normalizedPath,
                label: locationLabel(normalizedPath),
            });
            locationState.favoritePaths.add(normalizedPath);
        }
        renderLocationPicker();
        await loadSavedLocations(locationState.agentId);
    }
    catch (err) {
        alert(err.message);
    }
}
function normalizeLocationList(data) {
    const source = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    const raw = Array.isArray(data)
        ? data
        : [source.locations, source.items, source.entries].find((value) => Array.isArray(value)) || [];
    return raw
        .map((item) => normalizeLocationItem(item))
        .filter(Boolean);
}
function normalizeLocationItem(item) {
    if (typeof item === 'string') {
        const path = normalizePath(item);
        return path ? { path, label: locationLabel(path) } : null;
    }
    if (!item || typeof item !== 'object')
        return null;
    const path = normalizePath(item.path || item.cwd || item.fullPath || item.value || '');
    if (!path)
        return null;
    return {
        path,
        label: item.label || item.name || locationLabel(path),
    };
}
function normalizeDirectoryResponse(data, requestedPath) {
    const source = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    const currentPath = normalizePath(source.path || source.cwd || source.currentPath || source.current || requestedPath || '');
    const rawRoots = Array.isArray(source.roots)
        ? source.roots
        : Array.isArray(source.drives) ? source.drives : [];
    const rawEntries = Array.isArray(data)
        ? data
        : [source.directories, source.entries, source.items, source.locations, source.children]
            .find((value) => Array.isArray(value)) || [];
    const files = rawEntries
        .filter((item) => item && typeof item === 'object' && String(item.type || '').toLowerCase() === 'file')
        .map((item) => {
        const name = item.name || '';
        const path = normalizePath(item.path || item.fullPath || (name ? joinDisplayPath(currentPath, name) : ''));
        if (!path)
            return null;
        return { name: name || path.split(/[\\/]/).pop() || path, path, size: item.size ?? 0 };
    })
        .filter(Boolean);
    return {
        currentPath,
        parentPath: normalizePath(source.parent || source.parentPath || source.up || ''),
        roots: rawRoots
            .map((item) => normalizeDirectoryItem(item, currentPath))
            .filter(Boolean),
        directories: rawEntries
            .map((item) => normalizeDirectoryItem(item, currentPath))
            .filter(Boolean),
        files,
    };
}
function normalizeDirectoryItem(item, currentPath) {
    if (typeof item === 'string') {
        const path = normalizePath(item);
        return path ? { path, label: locationLabel(path) } : null;
    }
    if (!item || typeof item !== 'object')
        return null;
    const type = String(item.type || '').toLowerCase();
    if (type && !['directory', 'dir', 'folder', 'drive'].includes(type) && item.isDirectory !== true) {
        return null;
    }
    let path = normalizePath(item.path || item.fullPath || item.value || '');
    if (!path && item.name)
        path = joinDisplayPath(currentPath, item.name);
    if (!path)
        return null;
    return {
        path,
        label: item.label || item.name || locationLabel(path),
    };
}
function setSessionCwd(path) {
    const cwdInput = $('#session-cwd');
    if (cwdInput)
        cwdInput.value = normalizePath(path);
}
function normalizePath(path) {
    return typeof path === 'string' ? path.trim() : '';
}
function locationLabel(path) {
    const normalized = normalizePath(path);
    if (!normalized)
        return 'Agent default';
    const withoutTrailingSlash = normalized.replace(/[\\/]+$/, '');
    const parts = (withoutTrailingSlash || normalized).split(/[\\/]/);
    return parts[parts.length - 1] || normalized;
}
function joinDisplayPath(parent, name) {
    const cleanName = normalizePath(name);
    if (!cleanName)
        return '';
    const cleanParent = normalizePath(parent);
    if (!cleanParent)
        return cleanName;
    const separator = cleanParent.includes('\\') && !cleanParent.includes('/') ? '\\' : '/';
    return cleanParent.endsWith('\\') || cleanParent.endsWith('/')
        ? `${cleanParent}${cleanName}`
        : `${cleanParent}${separator}${cleanName}`;
}
$('#new-session-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const agentId = $('#session-agent').value;
    const shell = $('#session-shell').value;
    const name = $('#session-name').value.trim();
    const cwd = normalizePath($('#session-cwd').value);
    if (!agentId || !shell) {
        alert('Please select an agent and shell.');
        return;
    }
    try {
        const session = await apiRequest('POST', '/api/sessions', {
            agentId,
            shell,
            name: name || undefined,
            cwd: cwd || undefined,
        });
        closeNewSessionModal();
        loadSessions();
        openSession(session);
        closeSidebar();
    }
    catch (err) {
        alert(err.message);
    }
});
// ── Terminal management ────────────────────────────────────────────────────
function openSession(session) {
    hide($('#welcome-pane'));
    show($('#terminal-area'));
    if (openTerminals.has(session.id)) {
        activateTab(session.id);
        return;
    }
    // Create tab — starts hidden; activateTab → ensureTabVisible will reveal it
    const tab = document.createElement('div');
    tab.className = 'tab tab-hidden';
    tab.dataset.id = session.id;
    tab.innerHTML = `<span>${escHtml(session.name || session.shell || 'Session')}</span><span class="tab-close" data-id="${session.id}">✕</span>`;
    tab.addEventListener('click', (e) => {
        const closeBtn = e.target.closest('.tab-close');
        if (closeBtn) {
            closeTab(closeBtn.dataset.id);
            return;
        }
        activateTab(session.id);
    });
    $('#tab-bar').appendChild(tab);
    // Create terminal pane
    const pane = document.createElement('div');
    pane.className = 'terminal-pane';
    pane.id = `pane-${session.id}`;
    $('#terminals-container').appendChild(pane);
    // Init xterm
    const term = new Terminal({
        theme: {
            background: '#0d1117',
            foreground: '#e6edf3',
            cursor: '#58a6ff',
            selection: 'rgba(88,166,255,0.3)',
            black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
            blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
            brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364',
            brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
            brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
        },
        fontFamily: "'Cascadia Code', 'Fira Code', Consolas, monospace",
        fontSize: 13,
        cursorBlink: true,
        scrollback: 5000,
    });
    const fitAddon = new FitAddon.FitAddon();
    const linksAddon = new WebLinksAddon.WebLinksAddon();
    term.loadAddon(fitAddon);
    // Register localhost link provider before WebLinksAddon so it takes priority
    term.registerLinkProvider(makeLocalhostLinkProvider(term));
    term.loadAddon(linksAddon);
    term.open(pane);
    term.onSelectionChange(() => {
        const sel = term.getSelection();
        if (sel)
            term._aterminalLastSelection = sel;
    });
    // Ctrl+Shift+C = copy selection, Ctrl+Shift+V = paste from clipboard
    term.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown')
            return true;
        if (e.ctrlKey && e.shiftKey && e.key === 'C') {
            const sel = getTerminalSelection(term);
            if (sel)
                copyText(sel);
            return false;
        }
        if (e.ctrlKey && e.shiftKey && e.key === 'V') {
            navigator.clipboard.readText()
                .then(text => { if (text)
                sendTerminalInput(session.id, text); })
                .catch(() => { });
            return false;
        }
        return true;
    });
    // Update tab title when the shell sends an OSC title sequence
    term.onTitleChange((title) => {
        if (title) {
            const span = tab.querySelector('span:first-child');
            if (span)
                span.textContent = title;
        }
    });
    if (session.status !== 'active') {
        const endedAgo = session.ended_at ? ` · ended ${relativeTime(session.ended_at)}` : '';
        term.writeln(`\x1b[2m── Session history${endedAgo} ──\x1b[0m`);
        term.writeln('\x1b[2m   Read-only. Create a new session to run commands.\x1b[0m\r\n');
    }
    term.onData((data) => {
        sendTerminalInput(session.id, data);
    });
    pane.addEventListener('pointerdown', () => {
        requestAnimationFrame(() => term.focus());
    });
    // Intercept wheel events before xterm's handlers (capture phase) so scroll
    // works reliably across all browsers, including cases where xterm's internal
    // wheel listener doesn't fire due to canvas event propagation quirks.
    pane.addEventListener('wheel', (e) => {
        e.preventDefault();
        const lines = e.deltaMode === 1 ? e.deltaY
            : e.deltaMode === 2 ? (e.deltaY > 0 ? term.rows : -term.rows)
                : Math.round(e.deltaY / 20) || (e.deltaY > 0 ? 1 : -1);
        term.scrollLines(lines);
    }, { passive: false, capture: true });
    // Touch scroll for mobile devices
    let _touchScrollY = 0;
    pane.addEventListener('touchstart', (e) => { _touchScrollY = e.touches[0].clientY; }, { passive: true });
    pane.addEventListener('touchmove', (e) => {
        const dy = _touchScrollY - e.touches[0].clientY;
        _touchScrollY = e.touches[0].clientY;
        const lines = Math.round(dy / 15);
        if (lines)
            term.scrollLines(lines);
    }, { passive: true });
    // Right-click context menu with Copy / Paste
    pane.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showTerminalContextMenu(e.clientX, e.clientY, term, session.id);
    });
    openTerminals.set(session.id, { term, fitAddon, pane, tab, session });
    // Observe resize
    const resizeObserver = new ResizeObserver(() => fitTerminal(session.id));
    resizeObserver.observe(pane);
    if (socket?.connected) {
        socket.emit('terminal:attach', { sessionId: session.id, noReplay: replayedSessions.has(session.id) });
        replayedSessions.add(session.id);
    }
    activateTab(session.id);
}
// ── Localhost preview links ────────────────────────────────────────────────
// Intercepts localhost:PORT in terminal output and opens via the Tailscale host
function makeLocalhostLinkProvider(term) {
    return {
        provideLinks(lineIndex, callback) {
            const line = term.buffer.active.getLine(lineIndex);
            if (!line) {
                callback([]);
                return;
            }
            const text = line.translateToString(true);
            // Match http(s)://localhost:PORT or bare localhost:PORT (word-boundary guarded)
            const re = /https?:\/\/(?:localhost|127\.0\.0\.1):(\d{1,5})(?:\/\S*)?|\b(?:localhost|127\.0\.0\.1):(\d{1,5})(?:\/\S*)?\b/g;
            const links = [];
            let m;
            while ((m = re.exec(text)) !== null) {
                const port = m[1] || m[2];
                if (!port || +port > 65535)
                    continue;
                const capturedPort = port;
                links.push({
                    range: {
                        start: { x: m.index + 1, y: lineIndex + 1 },
                        end: { x: m.index + m[0].length + 1, y: lineIndex + 1 },
                    },
                    text: m[0],
                    activate() {
                        window.open(buildPreviewUrl(capturedPort), '_blank', 'noopener');
                    },
                });
            }
            callback(links);
        },
    };
}
function buildPreviewUrl(port) {
    if (!serverPublicUrl)
        return `http://localhost:${port}`;
    try {
        const { hostname } = new URL(serverPublicUrl);
        return `http://${hostname}:${port}`;
    }
    catch {
        return `http://localhost:${port}`;
    }
}
function activateTab(sessionId) {
    ensureTabVisible(sessionId);
    activeSessionId = sessionId;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.id === sessionId));
    document.querySelectorAll('.session-item').forEach((t) => t.classList.toggle('active', t.dataset.id === sessionId));
    document.querySelectorAll('.terminal-pane').forEach((p) => p.classList.remove('active'));
    const entry = openTerminals.get(sessionId);
    if (entry) {
        entry.pane.classList.add('active');
        requestAnimationFrame(() => {
            fitTerminal(sessionId);
            entry.term.focus();
        });
    }
    updateWatchButton();
    refreshTabOverflow();
}
function fitTerminal(sessionId) {
    const entry = openTerminals.get(sessionId);
    if (!entry)
        return;
    try {
        entry.fitAddon.fit();
        const { cols, rows } = entry.term;
        socket?.emit('terminal:resize', { sessionId, cols, rows });
    }
    catch { /* ignore */ }
}
function closeTab(sessionId) {
    const entry = openTerminals.get(sessionId);
    if (!entry)
        return;
    const wasVisible = visibleTabIds.includes(sessionId);
    visibleTabIds = visibleTabIds.filter(id => id !== sessionId);
    socket?.emit('terminal:detach', sessionId);
    entry.term.dispose();
    entry.pane.remove();
    entry.tab.remove();
    openTerminals.delete(sessionId);
    replayedSessions.delete(sessionId);
    if (wasVisible) {
        // Pull an overflow session into the vacated visible slot
        const nextHidden = [...openTerminals.keys()].find(id => !visibleTabIds.includes(id));
        if (nextHidden) {
            visibleTabIds.push(nextHidden);
            document.querySelector(`.tab[data-id="${nextHidden}"]`)?.classList.remove('tab-hidden');
        }
    }
    refreshTabOverflow();
    if (activeSessionId === sessionId) {
        activeSessionId = null;
        const remaining = [...openTerminals.keys()];
        if (remaining.length > 0) {
            activateTab(remaining[remaining.length - 1]);
        }
        else {
            show($('#welcome-pane'));
            hide($('#terminal-area'));
        }
    }
}
// ── Tab visibility & overflow dropdown ─────────────────────────────────────
function ensureTabVisible(sessionId) {
    if (visibleTabIds.includes(sessionId))
        return;
    if (visibleTabIds.length >= 3) {
        const toHide = visibleTabIds.shift();
        document.querySelector(`.tab[data-id="${toHide}"]`)?.classList.add('tab-hidden');
    }
    visibleTabIds.push(sessionId);
    document.querySelector(`.tab[data-id="${sessionId}"]`)?.classList.remove('tab-hidden');
}
function refreshTabOverflow() {
    const btn = $('#tab-overflow-btn');
    if (!btn)
        return;
    const total = openTerminals.size;
    const hiddenCount = total - visibleTabIds.length;
    if (total <= 3) {
        btn.classList.add('hidden');
        return;
    }
    btn.classList.remove('hidden');
    btn.textContent = `+${hiddenCount} ▾`;
}
function openTabOverflowDropdown() {
    document.querySelector('.tab-overflow-dropdown')?.remove();
    const btn = $('#tab-overflow-btn');
    if (!btn)
        return;
    const rect = btn.getBoundingClientRect();
    const dropdown = document.createElement('div');
    dropdown.className = 'tab-overflow-dropdown';
    openTerminals.forEach((entry, sessionId) => {
        const isActive = sessionId === activeSessionId;
        const name = entry.session?.name || entry.session?.shell || 'Session';
        const item = document.createElement('button');
        item.className = `tab-overflow-item${isActive ? ' active' : ''}`;
        item.innerHTML = `<span class="tab-overflow-dot"></span><span class="tab-overflow-name">${escHtml(name)}</span><span class="tab-overflow-close-x" data-id="${sessionId}" title="Close">✕</span>`;
        item.addEventListener('click', (e) => {
            const closeX = e.target.closest('.tab-overflow-close-x');
            if (closeX) {
                dropdown.remove();
                closeTab(closeX.dataset.id);
                return;
            }
            dropdown.remove();
            activateTab(sessionId);
        });
        dropdown.appendChild(item);
    });
    document.body.appendChild(dropdown);
    const dRect = dropdown.getBoundingClientRect();
    dropdown.style.top = `${rect.bottom + 4}px`;
    dropdown.style.left = `${Math.max(4, rect.right - dRect.width)}px`;
    const dismiss = (e) => {
        if (!dropdown.contains(e.target) && e.target !== btn) {
            dropdown.remove();
            document.removeEventListener('pointerdown', dismiss, true);
        }
    };
    setTimeout(() => document.addEventListener('pointerdown', dismiss, true), 0);
}
// ── Enrollment modal ───────────────────────────────────────────────────────
function openEnrollmentModal() {
    loadPendingDevices();
    const localUrl = window.location.origin;
    const publicUrl = serverPublicUrl && serverPublicUrl !== localUrl ? serverPublicUrl : null;
    const primaryUrl = publicUrl || localUrl;
    $('#browser-url-block').textContent = primaryUrl;
    $('#copy-browser-url-btn').onclick = () => copyText(primaryUrl, $('#copy-browser-url-btn'));
    $('#share-browser-url-btn').onclick = () => shareOrCopy(primaryUrl, 'ATerminal Web UI', $('#share-browser-url-btn'));
    renderQr($('#browser-qr-box'), primaryUrl).catch(() => {
        $('#browser-qr-box').innerHTML = '<span class="empty-state">QR unavailable</span>';
    });
    $('#enrollment-token-area').innerHTML = `
    <div class="enroll-option">
      <div class="enroll-option-label">Approve in UI (no token needed)</div>
      <div class="code-block" id="enroll-device-cmd"></div>
      <div class="enroll-url-row">
        <button class="btn btn-sm btn-ghost copy-btn" id="copy-device-cmd-btn">Copy Commands</button>
        ${publicUrl ? `<button class="btn btn-sm btn-ghost copy-btn" id="copy-device-cmd-local-btn">Copy Local Commands</button>` : ''}
      </div>
    </div>
    <div class="enroll-option">
      <div class="enroll-option-label">Pair with QR or link</div>
      <div id="token-area-inner">
        <button id="generate-token-btn" class="btn btn-sm btn-primary">Generate Pairing Link</button>
      </div>
    </div>
  `;
    $('#enroll-device-cmd').textContent = buildEnrollmentCommand(primaryUrl);
    $('#copy-device-cmd-btn').addEventListener('click', () => copyText(buildEnrollmentCommand(primaryUrl), $('#copy-device-cmd-btn')));
    if (publicUrl) {
        $('#copy-device-cmd-local-btn').addEventListener('click', () => copyText(buildEnrollmentCommand(localUrl), $('#copy-device-cmd-local-btn')));
    }
    $('#generate-token-btn').addEventListener('click', generateEnrollmentToken);
    show($('#enrollment-modal'));
}
function closeEnrollmentModal() {
    hide($('#enrollment-modal'));
}
// ── Device approval ────────────────────────────────────────────────────────
async function loadPendingDevices() {
    try {
        const data = await apiRequest('GET', '/api/device/pending');
        const requests = data.requests || [];
        const badge = $('#pending-badge');
        const section = $('#pending-devices-section');
        const list = $('#pending-devices-list');
        if (requests.length === 0) {
            badge.classList.add('hidden');
            section.style.display = 'none';
            return;
        }
        badge.textContent = requests.length;
        badge.classList.remove('hidden');
        section.style.display = '';
        list.innerHTML = requests.map((r) => `
      <div class="device-request-row" data-id="${r.id}">
        <div class="device-request-info">
          <strong>${escHtml(r.hostname)}</strong>
          <span class="device-platform">${escHtml(r.platform)}</span>
          <span class="device-age">${relativeTime(r.created_at)}</span>
        </div>
        <div class="device-request-actions">
          <button class="btn btn-sm btn-primary approve-device-btn" data-id="${r.id}">Approve</button>
          <button class="btn btn-sm btn-ghost reject-device-btn" data-id="${r.id}">Reject</button>
        </div>
      </div>
    `).join('');
        list.querySelectorAll('.approve-device-btn').forEach((btn) => {
            btn.addEventListener('click', () => handleDeviceApproval(btn.dataset.id, 'approve'));
        });
        list.querySelectorAll('.reject-device-btn').forEach((btn) => {
            btn.addEventListener('click', () => handleDeviceApproval(btn.dataset.id, 'reject'));
        });
    }
    catch (_) {
        // silently ignore — user may not be admin
    }
}
async function handleDeviceApproval(id, action) {
    try {
        await apiRequest('POST', `/api/device/${action}/${id}`);
        await loadPendingDevices();
        await loadAgents();
    }
    catch (err) {
        alert(err.message);
    }
}
async function generateEnrollmentToken() {
    const btn = $('#generate-token-btn');
    btn.disabled = true;
    btn.textContent = 'Generating…';
    try {
        const data = await apiRequest('POST', '/api/enrollment/tokens');
        const localUrl = window.location.origin;
        const primaryUrl = serverPublicUrl && serverPublicUrl !== localUrl ? serverPublicUrl : localUrl;
        const command = buildEnrollmentCommand(primaryUrl, data.token);
        const pairLink = buildEnrollmentLink(primaryUrl, data.token);
        $('#token-area-inner').innerHTML = `
      <div class="qr-row">
        <div class="qr-box" id="agent-qr-box">
          <span class="empty-state">Loading QR...</span>
        </div>
        <div class="pair-copy">
          <div class="code-block" id="pair-link-block"></div>
          <div class="enroll-url-row">
            <button class="btn btn-sm btn-ghost copy-btn" id="copy-pair-link-btn">Copy Pairing Link</button>
            <button class="btn btn-sm btn-ghost copy-btn" id="share-pair-link-btn">Share Link</button>
          </div>
          <div class="code-block" id="enroll-code-block"></div>
          <button class="btn btn-sm btn-ghost copy-btn" id="copy-enroll-btn">Copy Commands</button>
          <p class="token-warning">Anyone with this link can enroll one device. It can be used once.</p>
        </div>
      </div>
    `;
        $('#pair-link-block').textContent = pairLink;
        $('#enroll-code-block').textContent = command;
        $('#copy-pair-link-btn').addEventListener('click', () => {
            copyText(pairLink, $('#copy-pair-link-btn'));
        });
        $('#share-pair-link-btn').addEventListener('click', () => {
            shareOrCopy(pairLink, 'ATerminal pairing link', $('#share-pair-link-btn'));
        });
        $('#copy-enroll-btn').addEventListener('click', () => {
            copyText(command, $('#copy-enroll-btn'));
        });
        renderQr($('#agent-qr-box'), pairLink).catch(() => {
            $('#agent-qr-box').innerHTML = '<span class="empty-state">QR unavailable</span>';
        });
    }
    catch (err) {
        btn.disabled = false;
        btn.textContent = 'Generate Pairing Link';
        alert(err.message);
    }
}
function buildEnrollmentCommand(serverUrl, enrollmentToken) {
    const safeServerUrl = normalizeEnrollmentServerUrl(serverUrl);
    const safeToken = normalizeEnrollmentToken(enrollmentToken);
    if (!safeServerUrl || (enrollmentToken && !safeToken))
        return '';
    const enroll = safeToken
        ? `aterminal agent enroll --server ${safeServerUrl} --token ${safeToken}`
        : `aterminal agent enroll --server ${safeServerUrl}`;
    return `${enroll}\naterminal agent start`;
}
function buildEnrollmentLink(serverUrl, enrollmentToken) {
    const safeServerUrl = normalizeEnrollmentServerUrl(serverUrl);
    const safeToken = normalizeEnrollmentToken(enrollmentToken);
    if (!safeServerUrl || !safeToken)
        return '';
    const params = new URLSearchParams({ server: safeServerUrl, token: safeToken });
    return `${safeServerUrl}/#enroll-agent?${params.toString()}`;
}
function normalizeEnrollmentServerUrl(serverUrl) {
    if (typeof serverUrl !== 'string' || /[\s'";&|<>`$\\]/.test(serverUrl))
        return '';
    try {
        const parsed = new URL(serverUrl);
        if (!['http:', 'https:'].includes(parsed.protocol))
            return '';
        if (parsed.username || parsed.password)
            return '';
        return parsed.origin;
    }
    catch (_) {
        return '';
    }
}
function normalizeEnrollmentToken(token) {
    if (!token)
        return '';
    return typeof token === 'string' && /^[A-Za-z0-9_-]{16,512}$/.test(token) ? token : '';
}
// ── Mobile sidebar ─────────────────────────────────────────────────────────
let sidebarOverlay = null;
function openSidebar() {
    $('#sidebar').classList.add('open');
    if (!sidebarOverlay) {
        sidebarOverlay = document.createElement('div');
        sidebarOverlay.className = 'sidebar-overlay';
        sidebarOverlay.addEventListener('click', closeSidebar);
        document.body.appendChild(sidebarOverlay);
    }
    sidebarOverlay.classList.add('visible');
}
function closeSidebar() {
    $('#sidebar').classList.remove('open');
    if (sidebarOverlay)
        sidebarOverlay.classList.remove('visible');
}
// ── Mobile input bar ───────────────────────────────────────────────────────
document.querySelectorAll('.kbd-btn[data-key]').forEach((btn) => {
    btn.addEventListener('click', () => {
        if (!activeSessionId)
            return;
        sendTerminalInput(activeSessionId, btn.dataset.key);
        const entry = openTerminals.get(activeSessionId);
        if (entry)
            entry.term.focus();
    });
});
const mobileTextInput = $('#mobile-text-input');
mobileTextInput.addEventListener('keydown', (e) => {
    if (!activeSessionId)
        return;
    if (e.key === 'Enter') {
        e.preventDefault();
        sendTerminalInput(activeSessionId, '\r');
        mobileTextInput.value = '';
    }
    else if (e.key === 'Backspace' && mobileTextInput.value === '') {
        e.preventDefault();
        sendTerminalInput(activeSessionId, '\x7f');
    }
});
mobileTextInput.addEventListener('input', () => {
    if (!activeSessionId || !mobileTextInput.value)
        return;
    sendTerminalInput(activeSessionId, mobileTextInput.value);
    mobileTextInput.value = '';
});
// When the mobile keyboard appears, scroll the terminal to the latest output.
// We do it twice: immediately (layout already started adjusting) and after
// ~350ms (iOS keyboard animation finishes, visualViewport has settled).
mobileTextInput.addEventListener('focus', () => {
    if (!activeSessionId)
        return;
    const entry = openTerminals.get(activeSessionId);
    if (!entry)
        return;
    requestAnimationFrame(() => entry.term.scrollToBottom());
    setTimeout(() => {
        fitTerminal(activeSessionId);
        entry.term.scrollToBottom();
    }, 350);
});
// Font size controls
let termFontSize = 13;
$('#font-decrease-btn').addEventListener('click', () => {
    termFontSize = Math.max(9, termFontSize - 1);
    openTerminals.forEach(({ term, fitAddon }) => {
        term.options.fontSize = termFontSize;
        try {
            fitAddon.fit();
        }
        catch { }
    });
});
$('#font-increase-btn').addEventListener('click', () => {
    termFontSize = Math.min(20, termFontSize + 1);
    openTerminals.forEach(({ term, fitAddon }) => {
        term.options.fontSize = termFontSize;
        try {
            fitAddon.fit();
        }
        catch { }
    });
});
// Scroll to bottom
$('#scroll-bottom-btn').addEventListener('click', () => {
    if (!activeSessionId)
        return;
    const entry = openTerminals.get(activeSessionId);
    if (entry)
        entry.term.scrollToBottom();
});
// Session overflow dropdown
$('#tab-overflow-btn')?.addEventListener('click', () => {
    if (document.querySelector('.tab-overflow-dropdown')) {
        document.querySelector('.tab-overflow-dropdown').remove();
    }
    else {
        openTabOverflowDropdown();
    }
});
// Copy selected terminal text
$('#copy-selection-btn')?.addEventListener('click', () => {
    if (!activeSessionId)
        return;
    const entry = openTerminals.get(activeSessionId);
    if (!entry)
        return;
    const sel = getTerminalSelection(entry.term);
    if (sel)
        copyText(sel, $('#copy-selection-btn'));
    else
        openTerminalTextView(entry.term);
});
$('#text-output-btn')?.addEventListener('click', () => {
    if (!activeSessionId)
        return;
    const entry = openTerminals.get(activeSessionId);
    if (entry)
        openTerminalTextView(entry.term);
});
// Paste from clipboard into terminal
$('#paste-btn')?.addEventListener('click', () => {
    if (!activeSessionId)
        return;
    navigator.clipboard.readText()
        .then(text => { if (text)
        sendTerminalInput(activeSessionId, text); })
        .catch(() => showToast('Clipboard access denied', 'error', 2000));
});
// ── Command snippets ───────────────────────────────────────────────────────
function loadSnippets() {
    try {
        return JSON.parse(localStorage.getItem('at_snippets') || '[]');
    }
    catch {
        return [];
    }
}
function saveSnippets(snippets) {
    localStorage.setItem('at_snippets', JSON.stringify(snippets));
}
function renderSnippets() {
    const snippets = loadSnippets();
    const list = $('#snippets-list');
    if (!list)
        return;
    if (snippets.length === 0) {
        list.innerHTML = '<div class="empty-state">No snippets yet. Add one below.</div>';
        return;
    }
    list.innerHTML = snippets.map((s, i) => `
    <div class="snippet-row">
      <button class="snippet-run-btn" data-i="${i}">
        <span class="snippet-label">${escHtml(s.label)}</span>
        <span class="snippet-cmd">${escHtml(s.command)}</span>
      </button>
      <button class="icon-btn snippet-delete-btn" data-i="${i}" title="Delete">✕</button>
    </div>
  `).join('');
    list.querySelectorAll('.snippet-run-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const s = loadSnippets()[+btn.dataset.i];
            if (!s || !activeSessionId)
                return;
            sendTerminalInput(activeSessionId, s.command + '\r');
            hide($('#snippets-panel'));
        });
    });
    list.querySelectorAll('.snippet-delete-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const snippets = loadSnippets();
            snippets.splice(+btn.dataset.i, 1);
            saveSnippets(snippets);
            renderSnippets();
        });
    });
}
$('#snippets-toggle-btn').addEventListener('click', () => {
    const panel = $('#snippets-panel');
    if (panel.classList.contains('hidden')) {
        renderSnippets();
        show(panel);
    }
    else {
        hide(panel);
    }
});
$('#snippets-close-btn').addEventListener('click', () => hide($('#snippets-panel')));
$('#snippet-add-btn').addEventListener('click', () => {
    const label = $('#snippet-label-input').value.trim();
    const command = $('#snippet-cmd-input').value.trim();
    if (!label || !command)
        return;
    const snippets = loadSnippets();
    snippets.push({ label, command });
    saveSnippets(snippets);
    $('#snippet-label-input').value = '';
    $('#snippet-cmd-input').value = '';
    renderSnippets();
});
// ── Settings / password change ────────────────────────────────────────────
// Command composer and speech input
function openCommandComposer() {
    const panel = $('#command-composer-panel');
    show(panel);
    const micBtn = $('#composer-mic-btn');
    const speechCtor = getSpeechRecognitionCtor();
    micBtn.disabled = !speechCtor;
    $('#composer-status').textContent = speechCtor
        ? 'Review dictated text before running it.'
        : 'Speech recognition is unavailable here. Use your keyboard dictation instead.';
    requestAnimationFrame(() => $('#composer-input').focus());
}
function closeCommandComposer() {
    stopSpeechRecognition();
    hide($('#command-composer-panel'));
}
function sendComposedCommand(run) {
    if (!activeSessionId) {
        showToast('Open a session before sending a command.', 'info');
        return;
    }
    const input = $('#composer-input');
    const command = input.value;
    if (!command.trim())
        return;
    if (!sendTerminalInput(activeSessionId, run ? `${command}\r` : command))
        return;
    input.value = '';
    closeCommandComposer();
    const entry = openTerminals.get(activeSessionId);
    if (entry)
        entry.term.focus();
}
function getSpeechRecognitionCtor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition;
}
function toggleSpeechRecognition() {
    if (speechListening) {
        stopSpeechRecognition();
        return;
    }
    const SpeechRecognitionCtor = getSpeechRecognitionCtor();
    if (!SpeechRecognitionCtor) {
        $('#composer-status').textContent = 'Speech recognition is unavailable here. Use your keyboard dictation instead.';
        return;
    }
    const recognition = new SpeechRecognitionCtor();
    speechRecognition = recognition;
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';
    recognition.baseText = $('#composer-input').value.trim();
    recognition.onstart = () => setComposerListening(true);
    recognition.onend = () => {
        if (speechRecognition === recognition)
            speechRecognition = null;
        setComposerListening(false);
    };
    recognition.onerror = (event) => {
        $('#composer-status').textContent = event.error ? `Mic error: ${event.error}` : 'Mic input stopped.';
    };
    recognition.onresult = (event) => {
        if (speechRecognition !== recognition || $('#command-composer-panel').classList.contains('hidden'))
            return;
        let transcript = '';
        for (let i = 0; i < event.results.length; i += 1) {
            transcript += event.results[i][0].transcript;
        }
        const base = recognition.baseText || '';
        $('#composer-input').value = [base, transcript.trim()].filter(Boolean).join(' ');
    };
    try {
        recognition.start();
    }
    catch (err) {
        $('#composer-status').textContent = err.message || 'Could not start microphone input.';
        if (speechRecognition === recognition)
            speechRecognition = null;
        setComposerListening(false);
    }
}
function stopSpeechRecognition() {
    if (speechRecognition) {
        try {
            speechRecognition.abort();
        }
        catch (_) {
            try {
                speechRecognition.stop();
            }
            catch (__) { }
        }
        speechRecognition = null;
    }
    setComposerListening(false);
}
function setComposerListening(isListening) {
    speechListening = isListening;
    const btn = $('#composer-mic-btn');
    if (!btn)
        return;
    btn.classList.toggle('active', isListening);
    btn.textContent = isListening ? 'Stop' : 'Mic';
    const status = $('#composer-status');
    if (status)
        status.textContent = isListening ? 'Listening...' : 'Review dictated text before running it.';
}
$('#settings-btn').addEventListener('click', () => {
    hide($('#settings-error'));
    $('#change-password-form').reset();
    show($('#settings-modal'));
});
$('#settings-modal-close').addEventListener('click', () => hide($('#settings-modal')));
$('#settings-modal-backdrop').addEventListener('click', () => hide($('#settings-modal')));
$('#change-password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('#settings-error');
    hide(errEl);
    const currentPassword = $('#current-password').value;
    const newPassword = $('#new-password').value;
    const confirmPassword = $('#confirm-password').value;
    if (newPassword !== confirmPassword) {
        errEl.textContent = 'New passwords do not match';
        show(errEl);
        return;
    }
    if (newPassword.length < 12) {
        errEl.textContent = 'Password must be at least 12 characters';
        show(errEl);
        return;
    }
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
        await apiRequest('POST', '/api/auth/change-password', { currentPassword, newPassword });
        hide($('#settings-modal'));
        showToast('Password changed successfully', 'online');
    }
    catch (err) {
        errEl.textContent = err.message;
        show(errEl);
    }
    finally {
        btn.disabled = false;
    }
});
// ── File download ─────────────────────────────────────────────────────────
function downloadFile(agentId, filePath) {
    const filename = filePath.split(/[\\/]/).pop() || 'download';
    const url = `/api/download?agent=${encodeURIComponent(agentId)}&path=${encodeURIComponent(filePath)}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => {
        if (!r.ok)
            return r.json().then((d) => { throw new Error(d.error || 'Download failed'); });
        return r.blob();
    })
        .then((blob) => {
        const objUrl = URL.createObjectURL(blob);
        a.href = objUrl;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(objUrl);
    })
        .catch((err) => alert(err.message));
}
// ── Helpers ────────────────────────────────────────────────────────────────
function escHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
function relativeTime(iso) {
    const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (diff < 10)
        return 'just now';
    if (diff < 60)
        return `${diff}s ago`;
    if (diff < 3600)
        return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400)
        return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
}
function showPairingScreenFromHash() {
    if (!window.location.hash.startsWith('#enroll-agent?'))
        return false;
    const params = new URLSearchParams(window.location.hash.slice('#enroll-agent?'.length));
    const serverUrl = normalizeEnrollmentServerUrl(params.get('server'));
    const enrollmentToken = normalizeEnrollmentToken(params.get('token'));
    if (!serverUrl || !enrollmentToken)
        return false;
    const command = buildEnrollmentCommand(serverUrl, enrollmentToken);
    if (!command)
        return false;
    $('#pairing-server-label').textContent = serverUrl;
    $('#pairing-command').textContent = command;
    showScreen('pairing');
    return true;
}
function clearPairingLink() {
    history.replaceState(null, document.title, window.location.pathname + window.location.search);
    if (token)
        initDashboard();
    else
        showScreen('login');
}
// ── Init ───────────────────────────────────────────────────────────────────
function initDashboard() {
    showScreen('dashboard');
    // Show enrollment button only for admins
    if (currentUser && currentUser.role === 'admin') {
        show($('#enrollment-btn'));
    }
    else {
        hide($('#enrollment-btn'));
    }
    connectSocket();
    loadAgents();
    loadSessions();
    loadPendingDevices();
    devicePollTimer = setInterval(loadPendingDevices, 5000);
    agentRefreshTimer = setInterval(() => { loadAgents(); loadSessions(); }, 15000);
}
// Button listeners
$('#new-session-btn').addEventListener('click', openNewSessionModal);
$('#new-session-btn-sidebar').addEventListener('click', () => { openNewSessionModal(); closeSidebar(); });
$('#session-search').addEventListener('input', () => {
    renderSessionList(sessionData);
});
$('#welcome-new-session-btn').addEventListener('click', openNewSessionModal);
$('#session-modal-backdrop').addEventListener('click', closeNewSessionModal);
$('#session-modal-cancel').addEventListener('click', closeNewSessionModal);
$('#session-cwd-browse').addEventListener('click', () => browseLocation($('#session-cwd').value));
$('#session-cwd').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter')
        return;
    e.preventDefault();
    browseLocation($('#session-cwd').value);
});
$('#session-cwd').addEventListener('input', renderLocationPicker);
$('#session-location-up').addEventListener('click', () => {
    if (locationState.parentPath)
        browseLocation(locationState.parentPath);
});
$('#session-favorite-current').addEventListener('click', () => {
    toggleFavorite($('#session-cwd').value);
});
$('#session-context-refresh').addEventListener('click', () => {
    if (activeSessionId)
        loadSessionContext(activeSessionId);
});
$('#session-context-copy-output').addEventListener('click', copyTerminalOutput);
$('#session-context-copy').addEventListener('click', copyCurrentSessionContext);
$('#session-context-ctrlc').addEventListener('click', () => {
    if (activeSessionId)
        sendTerminalInput(activeSessionId, '\x03');
});
$('#session-context-watch').addEventListener('click', async () => {
    if (!activeSessionId)
        return;
    if (watchedSessions.has(activeSessionId)) {
        watchedSessions.delete(activeSessionId);
    }
    else {
        if (Notification.permission === 'default') {
            await Notification.requestPermission();
        }
        if (Notification.permission === 'granted') {
            watchedSessions.add(activeSessionId);
        }
        else {
            showToast('Notifications blocked — enable in browser settings.', 'info');
        }
    }
    updateWatchButton();
});
$('#session-context-kill').addEventListener('click', () => {
    if (activeSessionId)
        killSession(activeSessionId);
});
$('#session-context-toggle').addEventListener('click', () => {
    const panel = $('#session-context-panel');
    panel.classList.toggle('collapsed');
    $('#session-context-toggle').textContent = panel.classList.contains('collapsed') ? '+' : '-';
});
$('#composer-toggle-btn').addEventListener('click', openCommandComposer);
$('#composer-close-btn').addEventListener('click', closeCommandComposer);
$('#composer-clear-btn').addEventListener('click', () => { $('#composer-input').value = ''; });
$('#composer-type-btn').addEventListener('click', () => sendComposedCommand(false));
$('#composer-run-btn').addEventListener('click', () => sendComposedCommand(true));
$('#composer-mic-btn').addEventListener('click', toggleSpeechRecognition);
$('#enrollment-btn').addEventListener('click', openEnrollmentModal);
$('#enrollment-modal-backdrop').addEventListener('click', closeEnrollmentModal);
$('#enrollment-modal-close').addEventListener('click', closeEnrollmentModal);
$('#menu-btn').addEventListener('click', () => {
    if ($('#sidebar').classList.contains('open'))
        closeSidebar();
    else
        openSidebar();
});
$('#logout-btn').addEventListener('click', () => {
    if (confirm('Sign out?'))
        logout();
});
$('#copy-pairing-command-btn').addEventListener('click', () => {
    copyText($('#pairing-command').textContent, $('#copy-pairing-command-btn')).then(() => {
        history.replaceState(null, document.title, window.location.pathname + window.location.search);
    });
});
$('#clear-pairing-link-btn').addEventListener('click', clearPairingLink);
// ── Viewport height (shrinks correctly when iOS keyboard appears) ──────────
let _lastVh = 0;
function applyViewportHeight() {
    const vv = window.visualViewport;
    const vh = vv ? vv.height : window.innerHeight;
    const keyboardAppeared = vh < (_lastVh || window.innerHeight);
    _lastVh = vh;
    document.documentElement.style.setProperty('--real-vh', `${vh}px`);
    requestAnimationFrame(() => {
        openTerminals.forEach((entry, id) => {
            fitTerminal(id);
            if (keyboardAppeared)
                entry.term.scrollToBottom();
        });
    });
}
applyViewportHeight();
window.addEventListener('resize', applyViewportHeight);
if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', applyViewportHeight);
}
// ── Boot ───────────────────────────────────────────────────────────────────
if (showPairingScreenFromHash()) {
    // The pairing link is self-contained; no login is required to copy it.
}
else if (token) {
    apiRequest('GET', '/api/status')
        .then((data) => {
        // /api/status may return user info, or we rely on stored user
        // If status returns user, set it; otherwise currentUser stays null
        if (data && data.user)
            currentUser = data.user;
        if (data && data.publicUrl)
            serverPublicUrl = data.publicUrl;
        initDashboard();
    })
        .catch(() => {
        token = null;
        localStorage.removeItem('at_token');
        showScreen('login');
    });
}
else {
    showScreen('login');
}
