const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { createListenAuth } = require('./listenAuth');

function sendJson(res, statusCode, payload) {
  res.setHeader('Cache-Control', 'no-store');
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

function sendHtml(res, statusCode, html) {
  res.setHeader('Cache-Control', 'no-store');
  res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function sendText(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function readJsonBody(req, maxBytes = 4096) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let failed = false;

    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > maxBytes) {
        failed = true;
        const error = new Error('Request body too large.');
        error.statusCode = 413;
        reject(error);
        return;
      }
      body += chunk.toString('utf8');
    });

    req.on('end', () => {
      if (failed) return;
      if (!body) {
        const error = new Error('A JSON body is required.');
        error.statusCode = 400;
        reject(error);
        return;
      }
      try {
        const value = JSON.parse(body);
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('Expected a JSON object.');
        }
        resolve(value);
      } catch {
        const error = new Error('Invalid JSON body.');
        error.statusCode = 400;
        reject(error);
      }
    });

    req.on('error', (error) => {
      if (!failed) reject(error);
    });
  });
}

function writeStructuredLog(severity, event, details = {}) {
  const record = JSON.stringify({
    timestamp: new Date().toISOString(),
    severity,
    event,
    ...details,
  });
  if (severity === 'ERROR') console.error(record);
  else if (severity === 'WARNING') console.warn(record);
  else console.log(record);
}

function buildHealthPayload({ runtimeState, client, getDiagnostics }) {
  const memoryUsage = process.memoryUsage();
  const diagnostics = typeof getDiagnostics === 'function' ? getDiagnostics() : {};

  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    service: runtimeState.service,
    discord: {
      ready: typeof client.isReady === 'function' ? client.isReady() : false,
      ping: Number.isFinite(client.ws?.ping) ? client.ws.ping : null,
      guilds: client.guilds?.cache?.size ?? 0,
      users: client.users?.cache?.size ?? 0,
      ...runtimeState.discord
    },
    database: runtimeState.database,
    voice: runtimeState.voice,
    keepAlive: runtimeState.keepAlive,
    process: runtimeState.process,
    memory: {
      rssMb: Math.round(memoryUsage.rss / 1024 / 1024),
      heapUsedMb: Math.round(memoryUsage.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(memoryUsage.heapTotal / 1024 / 1024)
    },
    diagnostics
  };
}

function buildListenPageHtml(authenticated = false) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🤖</text></svg>">
    <title>403 Forbidden</title>
    <style>
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      body { background: #000; }

      /* ── GIF background ── */
      #bg {
        position: fixed; inset: 0;
        background: url('/bg.gif') center/cover no-repeat;
        opacity: 0.45;
        z-index: 0;
        pointer-events: none;
      }

      /* ── gate screen ── */
      #gate {
        position: fixed; inset: 0;
        background: transparent;
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10;
        transition: opacity .6s ease;
      }
      #gate.fade-out { opacity: 0; pointer-events: none; }
      .terminal {
        width: min(460px, 92vw);
        font-family: 'Courier New', Courier, monospace;
        color: #00ff41;
        font-size: 0.82rem;
        line-height: 1.7;
        user-select: none;
        background: rgba(0,0,0,0.82);
        padding: 28px 24px;
        border: 1px solid #0d3d14;
      }
      .t-line { white-space: pre; }
      .t-dim { color: #1a6b22; }
      .t-warn { color: #ff3c3c; }
      .t-hi { color: #00ff41; font-weight: bold; }
      .slots {
        display: flex;
        gap: 10px;
        margin: 18px 0 6px;
      }
      .slot {
        width: 28px; height: 28px;
        border: 1px solid #1a6b22;
        display: flex; align-items: center; justify-content: center;
        font-size: 1rem;
        transition: border-color .15s, color .15s;
      }
      .slot.filled { border-color: #00ff41; color: #00ff41; }
      .slot.err    { border-color: #ff3c3c; color: #ff3c3c; animation: shake .35s ease; }
      @keyframes shake {
        0%,100%{transform:translateX(0)}
        20%{transform:translateX(-5px)}
        40%{transform:translateX(5px)}
        60%{transform:translateX(-4px)}
        80%{transform:translateX(4px)}
      }
      .blink { animation: blink 1s step-end infinite; }
      @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
      #t-status { min-height: 1.2em; margin-top: 6px; }

      /* ── keypad grid ── */
      .keypad {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 6px;
        margin: 12px 0 4px;
      }
      .kp {
        padding: 12px 0;
        background: rgba(0,0,0,0.6);
        color: #00ff41;
        border: 1px solid #1a6b22;
        font-family: 'Courier New', Courier, monospace;
        font-size: 0.95rem;
        font-weight: bold;
        cursor: pointer;
        letter-spacing: 0.05em;
        transition: background .1s, border-color .1s;
        user-select: none;
      }
      .kp:hover   { background: rgba(0,255,65,0.1); border-color: #00ff41; }
      .kp:active  { background: rgba(0,255,65,0.25); }
      .kp-clr     { color: #f59e0b; border-color: #7c5a00; }
      .kp-clr:hover { background: rgba(245,158,11,0.1); border-color: #f59e0b; }
      .kp-enter   { color: #00ff41; border-color: #00ff41; background: rgba(0,255,65,0.08); }
      .kp-enter:hover { background: rgba(0,255,65,0.22); }
      .auth-input {
        width: 100%;
        margin-top: 12px;
        padding: 12px;
        background: #000a00;
        color: #00ff41;
        border: 1px solid #1a6b22;
        font: 16px 'Courier New', Courier, monospace;
      }
      .auth-submit { width: 100%; margin-top: 8px; }

      /* ── listen UI (hidden until unlocked) ── */
      #app {
        display: none;
        min-height: 100vh;
        background: transparent;
        align-items: center;
        justify-content: center;
        padding: 20px;
        position: relative;
        z-index: 10;
      }
      #app.visible { display: flex; }

      /* ── app panel ── */
      .app-panel {
        width: min(340px, 92vw);
        background: rgba(0,0,0,0.88);
        border: 1px solid #0d3d14;
        font-family: 'Courier New', Courier, monospace;
        padding: 32px 24px 24px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0;
      }

      /* channel row */
      .deafen-divider {
        width: 100%;
        border: none;
        border-top: 1px solid #0a2a0e;
        margin: 4px 0 14px;
      }
      .deafen-row {
        width: 100%;
        font-size: 0.78rem;
        color: #1a6b22;
        margin-bottom: 5px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .deafen-row span { color: #00ff41; }

      /* intercept status line */
      .intercept-status {
        width: 100%;
        font-size: 0.72rem;
        color: #1a6b22;
        letter-spacing: 0.06em;
        min-height: 1.4em;
        margin-bottom: 2px;
      }
      .intercept-status.active { color: #00ff41; }

      /* viz bars */
      .viz {
        display: none;
        gap: 3px;
        align-items: flex-end;
        height: 14px;
        margin-left: 6px;
        vertical-align: middle;
      }
      .viz.active { display: inline-flex; }
      .viz-bar {
        width: 3px;
        background: #00ff41;
        animation: vbar 0.8s ease-in-out infinite alternate;
      }
      .viz-bar:nth-child(1){ height: 5px;  animation-delay: 0s;   }
      .viz-bar:nth-child(2){ height: 12px; animation-delay: .1s;  }
      .viz-bar:nth-child(3){ height: 8px;  animation-delay: .2s;  }
      .viz-bar:nth-child(4){ height: 14px; animation-delay: .05s; }
      .viz-bar:nth-child(5){ height: 6px;  animation-delay: .15s; }
      @keyframes vbar { from{opacity:.3} to{opacity:1} }

      /* channel select */
      .ch-select-wrap { width: 100%; margin-bottom: 4px; }
      select {
        width: 100%;
        padding: 6px 10px;
        background: #000a00;
        color: #00ff41;
        border: 1px solid #0d3d14;
        font-family: 'Courier New', Courier, monospace;
        font-size: 0.78rem;
        outline: none;
        cursor: pointer;
        appearance: none;
        -webkit-appearance: none;
      }
      select:focus { border-color: #00ff41; }
      select option { background: #000; color: #00ff41; }

      /* action button */
      .cmd-btn {
        margin-top: 16px;
        width: 100%;
        padding: 11px 14px;
        background: rgba(0,255,65,0.06);
        color: #00ff41;
        border: 1px solid #00ff41;
        font-family: 'Courier New', Courier, monospace;
        font-size: 0.82rem;
        font-weight: bold;
        letter-spacing: 0.08em;
        cursor: pointer;
        text-align: center;
        transition: background .12s, color .12s;
      }
      .cmd-btn:disabled {
        border-color: #0d3d14;
        color: #0d3d14;
        background: transparent;
        cursor: not-allowed;
      }
      .cmd-btn:not(:disabled):hover { background: #00ff41; color: #000; }
      .cmd-btn.stop { border-color: #00ff41; color: #00ff41; background: rgba(0,255,65,0.12); }
      .cmd-btn.stop:not(:disabled):hover { background: #00ff41; color: #000; }

      .blink-r { animation: blink 1s step-end infinite; color: #00ff41; }
      .app-prompt {
        margin-top: 14px;
        font-size: 0.72rem;
        color: #1a6b22;
        font-family: 'Courier New', Courier, monospace;
        align-self: flex-start;
      }

      /* ── mobile ── */
      * { -webkit-tap-highlight-color: transparent; }
      body { overflow-x: hidden; }
      .t-line { white-space: pre-wrap; word-break: break-word; }
      @media (max-width: 480px) {
        .terminal { padding: 20px 16px; font-size: 0.78rem; }
        .slot { width: 32px; height: 32px; font-size: 1.1rem; }
        .slots { gap: 8px; margin: 14px 0 4px; }
        .kp { padding: 16px 0; font-size: 1.1rem; -webkit-tap-highlight-color: transparent; }
        .keypad { gap: 8px; margin: 14px 0 6px; }
        .kp-clr, .kp-enter { font-size: 0.95rem; }
        #t-status { font-size: 0.75rem; }
        .app-panel { padding: 24px 16px 20px; }
        .deafen-row { font-size: 0.72rem; }
        .cmd-btn { padding: 14px; font-size: 0.85rem; }
        select { font-size: 16px; /* prevents iOS zoom */ }
      }
    </style>
  </head>
  <body>
    <div id="bg"></div>

    <!-- ═══════════════════  GATE  ═══════════════════ -->
    <div id="gate">
      <div class="terminal">
        <div class="t-line t-dim">──────────────────────────────────────</div>
        <div class="t-line t-hi">  RESTRICTED ACCESS TERMINAL v2.1.0</div>
        <div class="t-line t-dim">──────────────────────────────────────</div>
        <div class="t-line">&nbsp;</div>
        <div class="t-line t-dim">  [SYS] authentication required</div>
        <div class="t-line t-dim">  [SYS] awaiting input sequence...</div>
        <div class="t-line">&nbsp;</div>
        <form id="authForm">
          <label class="t-line" for="passkey">  ENTER ACCESS KEY</label>
          <input id="passkey" name="passkey" class="auth-input" type="password"
            autocomplete="current-password" maxlength="256" required>
          <button class="kp kp-enter auth-submit" type="submit">AUTHENTICATE</button>
        </form>
        <div class="t-line t-dim" id="t-status">&nbsp;</div>
      </div>
    </div>

    <!-- ═══════════════════  APP  ═══════════════════ -->
    <div id="app">
      <div class="app-panel">

        <hr class="deafen-divider">

        <div class="deafen-row">CHANNEL &gt; <span id="channelInfo">no active voice channel</span></div>
        <div class="deafen-row">SERVER &nbsp;&gt; <span id="serverInfo">—</span></div>

        <div class="ch-select-wrap" id="selectWrap" style="display:none;">
          <select id="channelSelect"></select>
        </div>

        <div class="intercept-status" id="interceptStatus">
          &gt; idle — no intercept active
        </div>
        <span class="viz" id="viz">
          <span class="viz-bar"></span><span class="viz-bar"></span>
          <span class="viz-bar"></span><span class="viz-bar"></span>
          <span class="viz-bar"></span>
        </span>

        <button class="cmd-btn" id="listenBtn" disabled>INTERCEPT AUDIO</button>

        <div class="app-prompt">root@localhost:~$ <span class="blink-r">▋</span></div>
      </div>
    </div>

    <script>
      /* ══════════════════════════════════════════════
         Server-validated access gate
      ══════════════════════════════════════════════ */
      let lockout = false;

      const gate    = document.getElementById('gate');
      const tStatus = document.getElementById('t-status');
      const authForm = document.getElementById('authForm');
      const passkeyInput = document.getElementById('passkey');

      function deny(msg) {
        lockout = true;
        passkeyInput.value = '';
        tStatus.className = 't-line t-warn';
        tStatus.textContent = '  [ERR] ' + msg;
        setTimeout(() => {
          lockout = false;
          tStatus.className = 't-line t-dim';
          tStatus.textContent = '  [SYS] awaiting input sequence...';
          passkeyInput.focus();
        }, 900);
      }

      function unlock() {
        tStatus.className = 't-line t-hi';
        tStatus.textContent = '  [OK]  access granted';
        lockout = true;
        gate.classList.add('fade-out');
        setTimeout(() => {
          gate.style.display = 'none';
          document.getElementById('app').classList.add('visible');
          initApp();
        }, 650);
      }

      async function handleEnter(event) {
        event.preventDefault();
        if (lockout) return;
        lockout = true;
        tStatus.className = 't-line t-dim';
        tStatus.textContent = '  [SYS] verifying access...';
        try {
          const response = await fetch('/listen/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ passkey: passkeyInput.value })
          });
          if (!response.ok) {
            deny(response.status === 429
              ? 'TOO MANY ATTEMPTS — TRY AGAIN LATER'
              : 'ACCESS DENIED — CHECK ACCESS KEY');
            return;
          }
          unlock();
        } catch {
          deny('AUTH SERVER UNAVAILABLE');
        }
      }
      authForm.addEventListener('submit', handleEnter);

      /* ══════════════════════════════════════════════
         AUDIO APP (boots only after unlock)
      ══════════════════════════════════════════════ */
      function initApp() {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const listenBtn = document.getElementById('listenBtn');
        const channelSelect = document.getElementById('channelSelect');
        const selectWrap = document.getElementById('selectWrap');

        let listening = false;
        let ws = null;
        let currentGuildId = null;
        let knownStreams = [];
        let streamWasOffline = false;
        let reconnectTimer = null;
        let reconnectDelay = 1000;
        let manuallyDisconnected = false;

        // ── MediaSource audio player ─────────────────────────────────────
        // Server sends WebM Opus chunks via FFmpeg — no raw PCM, no hand-rolled
        // scheduling. We feed chunks straight into a native <audio> element via
        // MediaSource Extensions; the browser decoder handles buffering/timing.
        let audioEl = null;
        let mediaSource = null;
        let sourceBuffer = null;
        let chunkQueue = [];
        let sbReady = false;

        function appendNext() {
          if (!sbReady || !sourceBuffer || sourceBuffer.updating) return;
          if (chunkQueue.length === 0) return;
          try {
            sourceBuffer.appendBuffer(chunkQueue.shift());
          } catch (err) {
            if (err.name === 'QuotaExceededError' && audioEl) {
              const ct = audioEl.currentTime;
              if (ct > 10 && sourceBuffer.buffered.length > 0) {
                try { sourceBuffer.remove(0, ct - 5); } catch {}
              } else {
                chunkQueue = [];
              }
            }
          }
        }

        function feedChunk(arrayBuffer) {
          chunkQueue.push(arrayBuffer);
          appendNext();
        }

        function setupAudio() {
          teardownAudio();
          audioEl = new Audio();
          audioEl.volume = 1.0;
          mediaSource = new MediaSource();
          audioEl.src = URL.createObjectURL(mediaSource);

          mediaSource.addEventListener('sourceopen', () => {
            try {
              sourceBuffer = mediaSource.addSourceBuffer('audio/webm; codecs=opus');
              sourceBuffer.mode = 'sequence';
              sourceBuffer.addEventListener('updateend', () => {
                // Prune >30s of old audio to prevent memory/quota bloat
                if (audioEl && !sourceBuffer.updating && sourceBuffer.buffered.length > 0) {
                  const ct = audioEl.currentTime;
                  if (ct > 30) {
                    try { sourceBuffer.remove(0, ct - 10); return; } catch {}
                  }
                }
                appendNext();
              });
              sourceBuffer.addEventListener('error', (e) => {
                console.warn('[listen] SourceBuffer error', e);
              });
              sbReady = true;
              appendNext();
            } catch (err) {
              console.error('[listen] addSourceBuffer failed:', err);
            }
          });

          // Resume on stall / buffer underrun
          const resume = () => { try { audioEl.play(); } catch {} };
          audioEl.addEventListener('stalled', resume);
          audioEl.addEventListener('waiting', resume);
          audioEl.addEventListener('ended',   resume);
          audioEl.play().catch(() => {});
        }

        function teardownAudio() {
          sbReady = false;
          chunkQueue = [];
          sourceBuffer = null;
          if (mediaSource && mediaSource.readyState === 'open') {
            try { mediaSource.endOfStream(); } catch {}
          }
          mediaSource = null;
          if (audioEl) {
            try { audioEl.pause(); } catch {}
            audioEl.src = '';
            audioEl = null;
          }
        }
        // ────────────────────────────────────────────────────────────────

        function setStatus(active, channelName, guildName, extra) {
          const viz = document.getElementById('viz');
          const interceptStatus = document.getElementById('interceptStatus');
          const deafenIcon = document.getElementById('deafenIcon');
          const isRecon = extra === 'Reconnecting…';

          document.getElementById('channelInfo').textContent = active
            ? (channelName || 'voice channel') : 'no active channel';
          document.getElementById('serverInfo').textContent = guildName || '—';

          if (interceptStatus) {
            if (isRecon) {
              interceptStatus.className = 'intercept-status';
              interceptStatus.innerHTML = '&gt; reconnecting...';
            } else if (active && listening) {
              interceptStatus.className = 'intercept-status active';
              interceptStatus.innerHTML = '&gt; intercepting audio <span class="viz" id="viz"></span>';
            } else if (active) {
              interceptStatus.className = 'intercept-status';
              interceptStatus.textContent = '> channel active — not intercepting';
            } else {
              interceptStatus.className = 'intercept-status';
              interceptStatus.textContent = '> idle — no intercept active';
            }
          }

          if (viz) viz.className = 'viz' + (active && listening && !isRecon ? ' active' : '');
          if (deafenIcon) deafenIcon.className = 'deafen-icon' + (active && listening ? ' intercepting' : '');
          listenBtn.disabled = !active && !isRecon;
        }

        function scheduleReconnect(guildId) {
          if (manuallyDisconnected) return;
          if (reconnectTimer) return;
          setStatus(false, null, null, 'Reconnecting…');
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            reconnectDelay = Math.min(reconnectDelay * 2, 30000);
            connect(guildId || currentGuildId, { isReconnect: true });
          }, reconnectDelay);
        }

        async function refreshStreamList() {
          try {
            const res = await fetch('/voice-status');
            const data = await res.json();
            knownStreams = data.streams || [];
            if (knownStreams.length > 0) {
              selectWrap.style.display = 'block';
              const prevValue = channelSelect.value;
              channelSelect.innerHTML = knownStreams
                .map((s) => {
                  const label = (s.guildName ? s.guildName + ' — ' : '') + '#' + (s.channelName || s.guildId);
                  return '<option value="' + s.guildId + '">' + label + '</option>';
                })
                .join('');
              if (prevValue && knownStreams.some((s) => s.guildId === prevValue)) {
                channelSelect.value = prevValue;
              }
            } else {
              selectWrap.style.display = 'none';
            }
            if (!currentGuildId && knownStreams.length > 0) {
              connect(knownStreams[0].guildId);
            } else if (currentGuildId && streamWasOffline && knownStreams.length > 0) {
              const target = knownStreams.find((s) => s.guildId === currentGuildId) || knownStreams[0];
              streamWasOffline = false;
              connect(target.guildId);
            } else if (knownStreams.length === 0) {
              setStatus(false, null, null);
            }
          } catch {
            // ignore — poll will retry
          }
        }

        function connect(guildId, { isReconnect = false } = {}) {
          if (ws) {
            ws._noReconnect = true;
            try { ws.close(); } catch {}
            ws = null;
          }
          if (!isReconnect) reconnectDelay = 1000;
          currentGuildId = guildId || null;
          const qs = currentGuildId ? ('?guildId=' + encodeURIComponent(currentGuildId)) : '';
          const socket = new WebSocket(proto + '//' + location.host + '/voice-stream' + qs);
          socket.binaryType = 'arraybuffer';
          ws = socket;

          socket.onopen = () => { reconnectDelay = 1000; };

          socket.onmessage = (ev) => {
            if (typeof ev.data === 'string') {
              try {
                const msg = JSON.parse(ev.data);
                if (msg.type === 'status') {
                  setStatus(msg.active, msg.channelName, msg.guildName);
                  streamWasOffline = !msg.active;
                } else if (msg.type === 'stream-reset') {
                  // FFmpeg respawned (crash recovery) — recreate SourceBuffer so
                  // the new encoder epoch's init segment is accepted cleanly.
                  if (listening) {
                    teardownAudio();
                    setupAudio();
                  }
                }
              } catch {}
              return;
            }
            // Binary: WebM Opus chunk from FFmpeg -> feed to MediaSource
            if (listening && ev.data instanceof ArrayBuffer) {
              feedChunk(ev.data);
            }
          };

          socket.onclose = (ev) => {
            if (socket._noReconnect || manuallyDisconnected) return;
            console.warn('[listen] WS closed (code=' + ev.code + '), reconnecting in ' + reconnectDelay + 'ms');
            scheduleReconnect(currentGuildId);
          };

          socket.onerror = () => {
            if (socket._noReconnect || manuallyDisconnected) return;
            scheduleReconnect(currentGuildId);
          };
        }

        channelSelect.addEventListener('change', () => {
          manuallyDisconnected = false;
          connect(channelSelect.value);
        });

        listenBtn.addEventListener('click', async () => {
          if (!listening) {
            manuallyDisconnected = false;
            listening = true;
            setupAudio();
            listenBtn.textContent = 'STOP INTERCEPT';
            listenBtn.classList.add('stop');

            if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
              const targetGuild = currentGuildId || (knownStreams[0] && knownStreams[0].guildId) || null;
              if (targetGuild) connect(targetGuild);
            }
          } else {
            manuallyDisconnected = true;
            if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
            listening = false;
            if (ws) { ws._noReconnect = true; try { ws.close(); } catch {} ws = null; }
            teardownAudio();
            listenBtn.textContent = 'INTERCEPT AUDIO';
            listenBtn.classList.remove('stop');
          }
        });

        refreshStreamList();
        setInterval(refreshStreamList, 5000);
      }

      if (${authenticated ? 'true' : 'false'}) unlock();
    </script>
  </body>
</html>`;
}

function createWebServer({ config, runtimeState, client, getDiagnostics, liveVoiceStream, onJoinChannel }) {
  const listenAuth = createListenAuth({
    passkey: config.listenPasskey,
    sessionSecret: config.sessionSecret,
    secureCookies: config.nodeEnv === 'production',
  });
  let failedAuthAttempts = 0;
  let authFailureWindowStarted = Date.now();
  let authLockoutUntil = 0;
  const protectedPaths = new Set([
    '/diagnostics',
    '/voice-status',
    '/join-channel',
  ]);
  const server = http.createServer(async (req, res) => {
    const rawRequestId = String(req.headers['x-request-id'] || '');
    const requestId = /^[A-Za-z0-9._-]{1,64}$/.test(rawRequestId) ? rawRequestId : randomUUID();
    const startedAt = Date.now();
    let requestPath = '/';
    let errorCategory = null;

    res.setHeader('X-Request-ID', requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');

    try {
      const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
      requestPath = requestUrl.pathname;

      if (requestPath === '/listen/auth') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' });
          return;
        }
        if (!listenAuth.enabled) {
          errorCategory = 'authentication_not_configured';
          sendJson(res, 503, { error: 'Audio listener authentication is not configured.' });
          return;
        }
        if (authLockoutUntil > Date.now()) {
          errorCategory = 'authentication_rate_limited';
          res.setHeader('Retry-After', String(Math.ceil((authLockoutUntil - Date.now()) / 1000)));
          sendJson(res, 429, { error: 'Too many authentication failures.' });
          return;
        }

        let body;
        try {
          body = await readJsonBody(req, 4096);
        } catch (error) {
          errorCategory = error.statusCode === 413 ? 'request_body_too_large' : 'invalid_json';
          sendJson(res, error.statusCode || 400, { error: errorCategory });
          return;
        }

        const passkey = typeof body.passkey === 'string' ? body.passkey : '';
        if (passkey.length > 256 || !listenAuth.verifyPasskey(passkey)) {
          if (Date.now() - authFailureWindowStarted >= 15 * 60 * 1000) {
            failedAuthAttempts = 0;
            authFailureWindowStarted = Date.now();
          }
          failedAuthAttempts++;
          if (failedAuthAttempts >= 8) {
            authLockoutUntil = Date.now() + 15 * 60 * 1000;
            failedAuthAttempts = 0;
            authFailureWindowStarted = Date.now();
          }
          errorCategory = 'authentication_failed';
          sendJson(res, 401, { error: 'Authentication failed.' });
          return;
        }

        failedAuthAttempts = 0;
        authFailureWindowStarted = Date.now();
        authLockoutUntil = 0;
        res.setHeader('Set-Cookie', listenAuth.issueSessionCookie());
        sendJson(res, 200, { ok: true });
        return;
      }

      if (protectedPaths.has(requestPath)) {
        if (!listenAuth.enabled) {
          errorCategory = 'authentication_not_configured';
          sendJson(res, 503, { error: 'Audio listener authentication is not configured.' });
          return;
        }
        if (!listenAuth.isAuthorized(req)) {
          errorCategory = 'authentication_required';
          sendJson(res, 401, { error: 'Authentication required.' });
          return;
        }
      }

      if (req.method !== 'GET' && !(requestPath === '/join-channel' && req.method === 'POST')) {
        sendJson(res, 405, { error: 'Method not allowed' });
        return;
      }

    if (requestPath === '/') {
      const discordReady = typeof client.isReady === 'function' ? client.isReady() : false;
      const statusLabel = discordReady ? '[ ONLINE ]' : '[ CONNECTING ]';
      sendHtml(res, 200, `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🤖</text></svg>">
  <title>JANJAN // SYS</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      background: #000;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    #bg {
      position: fixed; inset: 0;
      background: url('/bg.gif') center/cover no-repeat;
      opacity: 0.45;
      z-index: 0;
      pointer-events: none;
    }
    .terminal {
      position: relative;
      z-index: 1;
      width: min(440px, 100%);
      background: rgba(0,0,0,0.82);
      border: 1px solid #0d3d14;
      padding: 28px 24px;
      font-family: 'Courier New', Courier, monospace;
      color: #00ff41;
      font-size: 0.82rem;
      line-height: 1.8;
    }
    .t-dim  { color: #1a6b22; }
    .t-hi   { color: #00ff41; font-weight: bold; }
    .t-warn { color: #ff3c3c; }
    .t-amber{ color: #f59e0b; }
    .blink  { animation: blink 1s step-end infinite; }
    @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
    .divider { color: #1a6b22; }
    .status-ok  { color: #00ff41; font-weight: bold; }
    .status-off { color: #f59e0b; font-weight: bold; }
    .links { margin-top: 10px; display: flex; flex-direction: column; gap: 4px; }
    a.cmd {
      display: flex;
      align-items: baseline;
      gap: 10px;
      padding: 7px 0;
      text-decoration: none;
      color: #00ff41;
      font-family: 'Courier New', Courier, monospace;
      font-size: 0.82rem;
      border-bottom: 1px solid #0a2a0e;
      transition: color .12s;
    }
    a.cmd:last-child { border-bottom: none; }
    a.cmd:hover { color: #fff; }
    a.cmd:hover .cmd-arrow { color: #00ff41; }
    .cmd-prompt { color: #1a6b22; flex-shrink: 0; }
    .cmd-label  { flex: 1; }
    .cmd-desc   { color: #1a6b22; font-size: 0.75rem; }
    .cmd-arrow  { color: #0d3d14; font-size: 1rem; transition: color .12s; }
    * { -webkit-tap-highlight-color: transparent; }
    body { overflow-x: hidden; }
    @media (max-width: 480px) {
      body { padding: 12px; align-items: flex-start; padding-top: 40px; }
      .terminal { padding: 20px 16px; font-size: 0.78rem; }
      a.cmd { font-size: 0.78rem; padding: 10px 0; }
      .cmd-desc { display: none; }
    }
  </style>
</head>
<body>
  <div id="bg"></div>
  <div class="terminal">
    <div class="divider">────────────────────────────────────────</div>
    <div class="t-hi">  JANJAN SYSTEM TERMINAL v1.0</div>
    <div class="divider">────────────────────────────────────────</div>
    <div>&nbsp;</div>
    <div class="t-dim">  [SYS] host       &gt; discord.gg/janjan</div>
    <div class="t-dim">  [SYS] process    &gt; node index.js</div>
    <div>  [SYS] status     &gt; <span class="${discordReady ? 'status-ok' : 'status-off'}">${statusLabel}</span></div>
    <div>&nbsp;</div>
    <div class="divider">────────────────────────────────────────</div>
    <div class="t-dim">  AVAILABLE COMMANDS</div>
    <div class="divider">────────────────────────────────────────</div>
    <div class="links">
      <a class="cmd" href="/listen">
        <span class="cmd-prompt">$</span>
        <span class="cmd-label">./listen <span class="cmd-desc">-- stream voice channel live</span></span>
        <span class="cmd-arrow">›</span>
      </a>
      <a class="cmd" href="/health">
        <span class="cmd-prompt">$</span>
        <span class="cmd-label">./health <span class="cmd-desc">-- liveness check</span></span>
        <span class="cmd-arrow">›</span>
      </a>
      <a class="cmd" href="/ping">
        <span class="cmd-prompt">$</span>
        <span class="cmd-label">./ping <span class="cmd-desc">-- uptime check</span></span>
        <span class="cmd-arrow">›</span>
      </a>
    </div>
    <div>&nbsp;</div>
    <div class="t-dim">  root@janjan:~$ <span class="blink">▋</span></div>
  </div>
</body>
</html>`);
      return;
    }

    if (requestPath === '/health') {
      sendJson(res, 200, {
        status: 'ok',
        service: runtimeState.service.name,
        timestamp: new Date().toISOString(),
        uptimeSeconds: Math.round(process.uptime()),
      });
      return;
    }

    if (requestPath === '/ready') {
      const checks = {
        discord: typeof client.isReady === 'function' ? client.isReady() : false,
        database: Boolean(runtimeState.database.connected),
        shuttingDown: Boolean(runtimeState.process.shuttingDown),
      };
      const ready = checks.discord && checks.database && !checks.shuttingDown;
      sendJson(res, ready ? 200 : 503, {
        ready,
        checks,
        timestamp: new Date().toISOString()
      });
      return;
    }

    if (requestPath === '/diagnostics') {
      sendJson(res, 200, buildHealthPayload({ runtimeState, client, getDiagnostics }));
      return;
    }

    if (requestPath === '/ping') {
      sendJson(res, 200, {
        message: 'pong',
        timestamp: new Date().toISOString(),
        uptimeSeconds: Math.round(process.uptime())
      });
      return;
    }

    if (requestPath === '/listen') {
      if (!listenAuth.enabled) {
        errorCategory = 'authentication_not_configured';
        sendJson(res, 503, { error: 'Set LISTEN_PASSKEY (16+ characters) and SESSION_SECRET (32+ characters).' });
        return;
      }
      sendHtml(res, 200, buildListenPageHtml(listenAuth.isAuthorized(req)));
      return;
    }

    if (requestPath === '/bg.gif') {
      const fs = require('node:fs');
      const path = require('node:path');
      // Use process.cwd() so the path resolves correctly regardless of where the module is located (works on Render too)
      const gifPath = path.join(process.cwd(), 'public/bg.gif');
      try {
        const data = fs.readFileSync(gifPath);
        res.writeHead(200, { 'Content-Type': 'image/gif', 'Cache-Control': 'public, max-age=86400' });
        res.end(data);
      } catch {
        sendText(res, 404, 'Not found');
      }
      return;
    }

    if (requestPath === '/voice-status') {
      const guildId = requestUrl.searchParams.get('guildId');
      sendJson(res, 200, liveVoiceStream ? liveVoiceStream.getStatus(guildId) : { active: false, streams: [] });
      return;
    }

    if (requestPath === '/join-channel') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'Method not allowed' });
        return;
      }
      let body;
      try {
        body = await readJsonBody(req, 1024);
      } catch (error) {
        errorCategory = error.statusCode === 413 ? 'request_body_too_large' : 'invalid_json';
        sendJson(res, error.statusCode || 400, { error: errorCategory });
        return;
      }
      const channelId = typeof body.channelId === 'string' ? body.channelId.trim() : '';
      if (!channelId) {
        sendJson(res, 400, { error: 'Missing channelId.' });
        return;
      }
      const channel = client.channels?.cache?.get(channelId);
      if (!channel) {
        sendJson(res, 404, { error: 'Channel not found in cache', channelId });
        return;
      }
      if (channel.type !== 2 && channel.type !== 13) {
        sendJson(res, 400, { error: 'Not a voice channel', type: channel.type });
        return;
      }
      if (typeof onJoinChannel !== 'function') {
        sendJson(res, 500, { error: 'Channel join is unavailable.' });
        return;
      }
      try {
        await onJoinChannel(channel.id, channel.guild.id, channel.guild.voiceAdapterCreator, channel.name, channel.guild.name);
        sendJson(res, 200, { ok: true, channelId: channel.id, channelName: channel.name, guildId: channel.guild.id, guildName: channel.guild.name });
      } catch (err) {
        errorCategory = 'channel_join_failed';
        sendJson(res, 500, { error: 'Channel join failed.' });
      }
      return;
    }

    sendText(res, 404, 'Not found');
    } catch (error) {
      const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
      errorCategory = statusCode >= 500 ? 'internal_error' : 'invalid_request';
      if (statusCode >= 500) {
        sendJson(res, 500, { error: 'Internal server error.' });
      } else {
        sendJson(res, statusCode, { error: errorCategory });
      }
    } finally {
      const statusCode = res.statusCode || 500;
      const severity = statusCode >= 500 ? 'ERROR' : statusCode >= 400 ? 'WARNING' : 'INFO';
      writeStructuredLog(severity, 'http_request_completed', {
        requestId,
        method: req.method,
        route: requestPath,
        statusCode,
        durationMs: Math.max(0, Date.now() - startedAt),
        errorCategory,
      });
    }
  });

  if (liveVoiceStream) {
    server.on('upgrade', (req, socket, head) => {
      const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
      if (
        requestUrl.pathname === '/voice-stream' &&
        listenAuth.enabled &&
        listenAuth.isAuthorized(req)
      ) {
        liveVoiceStream.handleUpgrade(req, socket, head);
      } else {
        socket.destroy();
      }
    });
  }

  return {
    start() {
      return new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        server.once('error', onError);
        server.listen(config.port, '0.0.0.0', () => {
          server.off('error', onError);
          const address = server.address();
          writeStructuredLog('INFO', 'http_server_listening', {
            host: '0.0.0.0',
            port: typeof address === 'object' && address ? address.port : config.port,
            environment: config.nodeEnv,
          });
          resolve(server);
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
  };
}

module.exports = {
  createWebServer,
  buildHealthPayload,
  buildListenPageHtml,
};
