/* ============================================================================
   In-world screen page (DUI)                                        html/dui.js
   ----------------------------------------------------------------------------
   Loaded by CreateDui('nui://tstudio_tv/html/dui.html', 1280, 720): one browser
   per playing screen plus one shared standby browser. Its pixels are drawn onto
   TV props and floating quads in the game world.

   Lua → page: SendDuiMessage(dui, json) arrives as a window 'message' event,
   event.data is the parsed object, `type` (alias `action`) selects the handler:
     init     { resourceName, screenId, logo, showLogo, standbyText, standbySubtext, showStandby, driftTolerance }
              logo = Config.Branding.logo relative to html/ ('' = none); the texts are already resolved
     load     { gen, url, name, kind: 'video'|'audio', position, playing, volume, loop }  (volume 0..1)
     play     { position }        pause { position }        seek { position }
     volume   { value }           0..1 — already includes distance falloff + master volume
     sync     { position, playing }   re-seek when |currentTime - position| > driftTolerance
     stop     {}                  unload the media, back to standby
     standby  { text, subtext }   change the idle texts
   Unknown types are ignored. Messages received before `init` are queued and
   applied in order as soon as `init` arrives.

   Page → Lua: POST https://<resourceName>/duiEvent  (RegisterNUICallback 'duiEvent')
     { screenId, event, gen, duration?, error? }
       ready    init handled
       loaded   metadata known (duration included when finite)
       ended    media finished (never while looping)
       error    media failed (short message in `error`)
   Reports are fire-and-forget: every fetch is wrapped and can never throw.

   Views: STAGE   = the single full-bleed <video> on black (plays audio files too)
          AUDIO   = now-playing card + visualizer, covers the stage for kind 'audio'
          STANDBY = branded idle screen (logo + wordmark), also the error fallback
   AUDIO and STANDBY cross-fade over the stage (240 ms) and are display:none
   whenever unused, so their CSS animations cost nothing while a video plays.
   The only fast loop is the analyser's requestAnimationFrame while the audio
   card is visible and playing; the other timers run at 1 s (audio time) and
   30 s (clock) and only while their view shows.
   ============================================================================ */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const noop = () => {};
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const num = (v, fallback) => (isNum(v) ? v : fallback);
  const str = (v, fallback) => (typeof v === 'string' ? v : fallback);
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const pad2 = (n) => (n < 10 ? '0' : '') + n;

  // ── Config (from init) and runtime state ──────────────────────────────────
  const cfg = {
    resourceName: '',
    screenId: '',
    logo: '',             // html/-relative path from Config.Branding.logo ('' = none)
    logoBroken: false,    // the file failed to load → fall back to text / glyph
    showLogo: true,
    standbyText: 'Television',
    standbySubtext: 'No signal',
    showStandby: true,
    driftTolerance: 1.5,
  };
  const state = {
    inited: false,
    gen: 0,
    url: null,          // media url while something is loaded, else null
    kind: 'video',
    name: '',
    playing: false,     // what Lua wants (video.paused is what we have)
    volume: 1,
    pendingSeek: null,  // seconds to apply once metadata is known
    error: null,        // error line shown on the standby view
    errorTimer: 0,      // clears that line a while after `stop`
    embed: null,        // TvEmbed player (YouTube / Twitch) while one is loaded
    embedToken: 0,      // ignores a player that finishes creating after a newer load/stop
    provider: null,
  };
  const embedStage = document.getElementById('embed');
  let pending = [];     // { type, msg } received before init

  // WebAudio graph (see hookAudio). `hooked` = the element is routed through it.
  const ag = { ctx: null, gain: null, analyser: null, data: null, source: null, hooked: false };

  // ── DOM ───────────────────────────────────────────────────────────────────
  let video = $('video'); // `let`: the element is rebuilt when WebAudio must let go of it
  const standbyView = $('standby');
  const audioView = $('audio');
  const standbyLogoEl = $('standbyLogo');
  const standbyTextEl = $('standbyText');
  const standbySubEl = $('standbySub');
  const clockEl = $('clock');
  const audioLogoEl = $('audioLogo');
  const audioGlyphEl = $('audioGlyph');
  const audioNameEl = $('audioName');
  const audioTimeEl = $('audioTime');
  const canvas = $('vis');
  const visCss = $('visCss');

  // ── Reporting back to Lua ─────────────────────────────────────────────────
  function report(event, extra) {
    if (!cfg.resourceName) return;
    const body = { screenId: cfg.screenId, event, gen: state.gen };
    if (extra) Object.assign(body, extra);
    try {
      fetch('https://' + cfg.resourceName + '/duiEvent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).catch(noop);
    } catch (e) { /* never throw */ }
  }

  // ── Branding: the logo ────────────────────────────────────────────────────
  // html/-relative path → URL for this page; tolerates "./", "/" or "html/" prefixes.
  function logoUrl(logo) {
    return './' + String(logo).trim().replace(/^(?:\.\/|\/|html\/)+/i, '');
  }

  // Show the configured logo in `img` (or hide it). Returns whether it shows.
  function applyLogo(img, wanted) {
    const show = wanted && !cfg.logoBroken && cfg.logo.trim() !== '';
    if (show) {
      const url = logoUrl(cfg.logo);
      if (img.getAttribute('src') !== url) img.setAttribute('src', url);
    }
    img.hidden = !show;
    return show;
  }

  function onLogoError() {
    if (cfg.logoBroken) return;
    cfg.logoBroken = true; // a typo in Config.Branding.logo must never leave a broken-image icon
    render();
  }

  // ── Views ─────────────────────────────────────────────────────────────────
  // Cross-fade (CSS opacity, --fade) and display:none once faded out.
  const FADE_MS = 240;
  const viewTimers = new Map();
  function setView(el, show) {
    const pendingHide = viewTimers.get(el);
    if (pendingHide) { clearTimeout(pendingHide); viewTimers.delete(el); }
    if (show) {
      if (el.hidden) { el.hidden = false; void el.offsetWidth; } // start the fade from 0
      el.classList.add('is-on');
    } else if (!el.hidden) {
      el.classList.remove('is-on');
      viewTimers.set(el, setTimeout(() => { viewTimers.delete(el); el.hidden = true; }, FADE_MS));
    }
  }

  function render() {
    const hasEmbed = !!state.embed || state.embedToken < 0; // < 0 marks "creating"
    const hasMedia = !!state.url || hasEmbed;
    const showAudio = hasMedia && state.kind === 'audio' && !hasEmbed;
    if (embedStage) embedStage.hidden = !hasEmbed;
    const showStandby = !hasMedia && cfg.showStandby; // showStandby === false → plain black
    setView(audioView, showAudio);
    setView(standbyView, showStandby);
    if (showStandby) {
      applyLogo(standbyLogoEl, cfg.showLogo);
      standbyTextEl.textContent = cfg.standbyText;
      standbySubEl.textContent = state.error || cfg.standbySubtext;
      standbySubEl.classList.toggle('is-error', !!state.error);
      startClock();
    } else {
      stopClock();
    }
    if (showAudio) {
      audioGlyphEl.hidden = applyLogo(audioLogoEl, true); // generic glyph when there is no logo
      audioNameEl.textContent = state.name || 'Audio';
      startAudioTimer();
    } else {
      stopAudioTimer();
    }
    refreshVis();
  }

  // Clock (standby, bottom-right) — 30 s is plenty for HH:MM.
  let clockTimer = 0;
  function tickClock() {
    const d = new Date();
    clockEl.textContent = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function startClock() { if (!clockTimer) { tickClock(); clockTimer = setInterval(tickClock, 30000); } }
  function stopClock() { if (clockTimer) { clearInterval(clockTimer); clockTimer = 0; } }

  // Elapsed / duration on the audio card — 1 s, only while the card is visible.
  let audioTimer = 0;
  const fmtTime = (t) => { t = Math.max(0, Math.floor(num(t, 0))); return Math.floor(t / 60) + ':' + pad2(t % 60); };
  function tickAudio() {
    const d = video.duration;
    audioTimeEl.textContent = fmtTime(video.currentTime) + ' / ' + (isNum(d) ? fmtTime(d) : '--:--');
  }
  function startAudioTimer() { if (!audioTimer) { tickAudio(); audioTimer = setInterval(tickAudio, 1000); } }
  function stopAudioTimer() { if (audioTimer) { clearInterval(audioTimer); audioTimer = 0; } }

  function clearError() {
    if (state.errorTimer) { clearTimeout(state.errorTimer); state.errorTimer = 0; }
    state.error = null;
  }

  // ── Playback ──────────────────────────────────────────────────────────────
  function tryPlay() {
    if (!state.url) return;
    try {
      const p = video.play();
      if (p && typeof p.catch === 'function') p.catch(noop); // autoplay refusal etc. — retried on the next command
    } catch (e) { /* ignore */ }
  }

  function seekTo(pos) {
    if (!state.url || !isNum(pos)) return;
    pos = Math.max(0, pos);
    if (video.readyState >= 1) {          // HAVE_METADATA — seeking works now
      state.pendingSeek = null;
      try { video.currentTime = pos; } catch (e) { /* ignore */ }
    } else {
      state.pendingSeek = pos;            // applied on loadedmetadata
    }
  }

  function applyVolume(v) {
    state.volume = clamp01(num(v, state.volume));
    if (state.embed) { state.embed.setVolume(state.volume); return; }
    try {
      if (ag.hooked) { ag.gain.gain.value = state.volume; video.volume = 1; } // the graph owns the volume
      else video.volume = state.volume;
    } catch (e) { /* ignore */ }
  }

  function unload() {
    state.url = null;
    state.pendingSeek = null;
    state.playing = false;
    try { video.pause(); } catch (e) { /* ignore */ }
    video.removeAttribute('src');       // not src = '' — that would raise a media error
    try { video.load(); } catch (e) { /* ignore */ }
  }

  // ── Embeds (YouTube / Twitch) ─────────────────────────────────────────────
  function destroyEmbed() {
    if (state.embed) { try { state.embed.destroy(); } catch (e) { /* ignore */ } }
    state.embed = null;
    state.provider = null;
    state.embedToken = Math.abs(state.embedToken) + 1; // invalidates a pending create
  }

  function loadEmbed(m) {
    destroyEmbed();
    unload();
    clearError();
    state.gen = num(m.gen, state.gen);
    state.kind = 'video';
    state.name = str(m.name, '');
    state.playing = typeof m.playing === 'boolean' ? m.playing : true;
    state.provider = str(m.provider, '');
    applyVolume(num(m.volume, state.volume));
    const token = -(Math.abs(state.embedToken) + 1);
    state.embedToken = token; // negative while creating
    render();
    const fail = (msg) => {
      if (state.embedToken !== token && state.embed === null) return; // superseded
      destroyEmbed();
      state.error = 'Error — ' + msg;
      render();
      report('error', { error: msg });
    };
    if (!window.TvEmbed) { fail('embed module missing'); return; }
    window.TvEmbed.create(state.provider, str(m.mediaId, ''), embedStage, {
      position: Math.max(0, num(m.position, 0)), playing: state.playing, volume: state.volume, loop: !!m.loop,
    }, {
      loaded: (d) => { if (state.embedToken === token) report('loaded', isNum(d) && d > 0 ? { duration: d } : null); },
      ended: () => { if (state.embedToken === token) report('ended'); },
      error: (msg) => { if (state.embedToken === token) fail(msg); },
    }).then((player) => {
      if (state.embedToken !== token) { try { player.destroy(); } catch (e) { /* ignore */ } return; }
      state.embed = player;
      render();
    }).catch((err) => fail(err && err.message ? err.message : 'embed failed'));
  }

  function doLoad(m) {
    if (m.provider === 'youtube' || m.provider === 'twitch') { loadEmbed(m); return; }
    if (state.embed || state.embedToken < 0) destroyEmbed();
    const url = str(m.url, '');
    if (!url) return;
    const same = sameOrigin(url);
    if (ag.hooked && !same) rebuildVideo(); // a WebAudio-routed element plays cross-origin media silently
    clearError();
    state.gen = num(m.gen, state.gen);
    state.url = url;
    state.kind = m.kind === 'audio' ? 'audio' : 'video';
    state.name = str(m.name, '');
    state.playing = typeof m.playing === 'boolean' ? m.playing : true;
    state.pendingSeek = Math.max(0, num(m.position, 0));
    video.loop = !!m.loop;
    video.src = url;
    applyVolume(num(m.volume, state.volume));
    if (state.kind === 'audio' && same && !ag.hooked) hookAudio();
    if (state.playing) tryPlay();
    render();
  }

  function doSync(m) {
    if (state.embed) {
      const p = state.embed;
      if (!p.live && isNum(m.position) && Math.abs(p.currentTime() - m.position) > cfg.driftTolerance) p.seek(m.position);
      if (typeof m.playing === 'boolean') {
        state.playing = m.playing;
        if (m.playing && p.isPaused()) p.play(); else if (!m.playing && !p.isPaused()) p.pause();
      }
      return;
    }
    if (!state.url) return;
    if (isNum(m.position)) {
      if (video.readyState < 1) state.pendingSeek = Math.max(0, m.position);
      else if (Math.abs(video.currentTime - m.position) > cfg.driftTolerance) seekTo(m.position);
    }
    if (typeof m.playing === 'boolean') {
      state.playing = m.playing;
      if (m.playing && video.paused && !video.ended) tryPlay();
      else if (!m.playing && !video.paused) { try { video.pause(); } catch (e) { /* ignore */ } }
    }
  }

  function doStop() {
    destroyEmbed();
    unload();
    // Keep an error line readable for a moment after the server stops the broken item.
    if (state.error && !state.errorTimer) {
      state.errorTimer = setTimeout(() => { state.errorTimer = 0; state.error = null; render(); }, 8000);
    }
    render();
  }

  const MEDIA_ERRORS = { 1: 'aborted', 2: 'network error', 3: 'decode error', 4: 'unsupported source' };
  function onVideoError(e) {
    const el = e.target;
    const err = el.error;
    if (el !== video || !state.url || !err || err.code === 1) return; // stale element, unloading, or abort noise
    let msg = MEDIA_ERRORS[err.code] || 'playback error';
    if (err.message) msg += ': ' + String(err.message).slice(0, 72);
    unload();
    clearError();
    state.error = 'Error — ' + msg;
    render();
    report('error', { error: msg });
  }

  function bindVideo(el) {
    el.addEventListener('loadedmetadata', () => {
      if (el !== video || !state.url) return;
      if (state.pendingSeek !== null) seekTo(state.pendingSeek);
      const d = el.duration;
      report('loaded', isNum(d) && d > 0 ? { duration: d } : null);
      if (state.playing && el.paused) tryPlay();
    });
    el.addEventListener('ended', () => {
      if (el === video && state.url && !el.loop) report('ended');
    });
    el.addEventListener('error', onVideoError);
    el.addEventListener('play', refreshVis);
    el.addEventListener('pause', refreshVis);
  }

  // ── WebAudio (same-origin audio files only) ───────────────────────────────
  // source → gain → destination carries the sound (volume lives on the gain
  // node while hooked); source → analyser feeds the bars. A MediaElementSource
  // on a cross-origin file outputs silence, so such media is never hooked and
  // a hooked element is rebuilt before it may load one. If anything throws,
  // the element simply keeps playing on its own and the CSS bars animate.
  const originOf = (url) => {
    const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i.exec(url);
    return m ? (m[1] + '://' + m[2]).toLowerCase() : null;
  };
  const ORIGIN = originOf(location.href);
  function sameOrigin(url) {
    const o = originOf(url);
    if (o === null) return !/^[a-z][a-z0-9+.-]*:/i.test(url); // relative url → same origin
    return !!ORIGIN && o === ORIGIN;
  }

  function hookAudio() {
    try {
      if (!ag.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        ag.ctx = new AC();
        ag.gain = ag.ctx.createGain();
        ag.gain.connect(ag.ctx.destination);
        ag.analyser = ag.ctx.createAnalyser();
        ag.analyser.fftSize = 256;
        ag.analyser.smoothingTimeConstant = 0.8;
        ag.data = new Uint8Array(ag.analyser.frequencyBinCount);
      }
      const attach = () => {
        if (ag.hooked || ag.ctx.state !== 'running') return;   // a suspended context would mean silence
        if (!state.url || !sameOrigin(state.url)) return;       // media changed in the meantime
        try {
          ag.source = ag.ctx.createMediaElementSource(video);
          ag.source.connect(ag.gain);
          ag.source.connect(ag.analyser);
          ag.hooked = true;
          applyVolume(state.volume);                            // hand the volume to the gain node
          refreshVis();
        } catch (e) { ag.source = null; ag.hooked = false; }
      };
      if (ag.ctx.state === 'running') attach();
      else ag.ctx.resume().then(attach).catch(noop);
    } catch (e) { /* no WebAudio here — direct playback, CSS bars */ }
  }

  // A MediaElementSource can never be detached, so swap in a fresh element.
  function rebuildVideo() {
    unload();
    try { if (ag.source) ag.source.disconnect(); } catch (e) { /* ignore */ }
    ag.source = null;
    ag.hooked = false;
    const fresh = video.cloneNode(false); // same attributes (playsinline, preload), no src, no graph
    video.replaceWith(fresh);
    video = fresh;
    bindVideo(video);
  }

  // ── Visualizer: analyser → <canvas> when hooked, CSS bars otherwise ───────
  const BARS = 32;
  const USED_BINS = 40;   // lowest 40 of 128 bins (≈ 0–7.5 kHz) — where music lives
  const vis = { raf: 0, gradient: null };

  function buildCssBars() {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < BARS; i++) {
      const bar = document.createElement('span');
      bar.style.animationDuration = (0.7 + Math.random() * 0.8).toFixed(2) + 's';
      bar.style.animationDelay = (-Math.random() * 1.5).toFixed(2) + 's';
      frag.appendChild(bar);
    }
    visCss.appendChild(frag);
  }

  function sizeCanvas() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h || (canvas.width === w && canvas.height === h)) return;
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d').createLinearGradient(0, h, 0, 0);
    g.addColorStop(0, '#9333ea');
    g.addColorStop(0.55, '#ec4899');
    g.addColorStop(1, '#ffa588');
    vis.gradient = g;
  }

  function drawBars(data) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    if (!ctx || !W || !H) return;
    const gap = Math.max(2, Math.round(W * 0.012));
    const bw = (W - gap * (BARS - 1)) / BARS;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = vis.gradient || '#ec4899';
    for (let i = 0; i < BARS; i++) {
      let v = 0.04;
      if (data) v = Math.max(v, data[Math.floor((i * USED_BINS) / BARS)] / 255);
      const h = Math.max(3, Math.round(v * H));
      ctx.fillRect(Math.round(i * (bw + gap)), H - h, Math.ceil(bw), h);
    }
  }

  function visFrame() {
    vis.raf = 0;
    try {
      ag.analyser.getByteFrequencyData(ag.data);
      drawBars(ag.data);
    } catch (e) { return; }
    vis.raf = requestAnimationFrame(visFrame);
  }

  function refreshVis() {
    const live = ag.hooked && !audioView.hidden;
    const paused = video.paused;
    audioView.classList.toggle('is-live', live);
    audioView.classList.toggle('is-paused', paused);
    if (live) sizeCanvas();
    if (live && !paused) {
      if (!vis.raf) vis.raf = requestAnimationFrame(visFrame);
    } else {
      if (vis.raf) { cancelAnimationFrame(vis.raf); vis.raf = 0; }
      if (live) drawBars(null); // flat stubs while paused
    }
  }

  // ── Messages ──────────────────────────────────────────────────────────────
  function handle(type, m) {
    switch (type) {
      case 'load':   doLoad(m); break;
      case 'play':
        state.playing = true;
        if (state.embed) { state.embed.play(isNum(m.position) ? m.position : undefined); break; }
        seekTo(m.position); tryPlay(); break;
      case 'pause':
        state.playing = false;
        if (state.embed) { state.embed.pause(isNum(m.position) ? m.position : undefined); break; }
        try { video.pause(); } catch (e) { /* ignore */ } seekTo(m.position); break;
      case 'seek':
        if (state.embed) { if (!state.embed.live && isNum(m.position)) state.embed.seek(m.position); break; }
        seekTo(m.position); break;
      case 'volume': applyVolume(m.value); break;
      case 'sync':   doSync(m); break;
      case 'stop':   doStop(); break;
      case 'standby':
        cfg.standbyText = str(m.text, cfg.standbyText);
        cfg.standbySubtext = str(m.subtext, cfg.standbySubtext);
        clearError();
        render();
        break;
      default: break; // unknown types are ignored
    }
  }

  function applyInit(m) {
    cfg.resourceName = str(m.resourceName, cfg.resourceName);
    cfg.screenId = str(m.screenId, cfg.screenId);
    if (typeof m.logo === 'string' && m.logo !== cfg.logo) { cfg.logo = m.logo; cfg.logoBroken = false; }
    if (typeof m.showLogo === 'boolean') cfg.showLogo = m.showLogo;
    cfg.standbyText = str(m.standbyText, cfg.standbyText);
    cfg.standbySubtext = str(m.standbySubtext, cfg.standbySubtext);
    if (typeof m.showStandby === 'boolean') cfg.showStandby = m.showStandby;
    if (num(m.driftTolerance, 0) > 0) cfg.driftTolerance = m.driftTolerance;
    state.inited = true;
    render();
    report('ready');
    const queue = pending;
    pending = [];
    queue.forEach((q) => { try { handle(q.type, q.msg); } catch (e) { /* ignore */ } });
  }

  function onMessage(e) {
    try {
      const msg = e && e.data;
      if (!msg || typeof msg !== 'object') return;
      const type = typeof msg.type === 'string' ? msg.type : msg.action;
      if (typeof type !== 'string') return;
      if (type === 'init') { applyInit(msg); return; }
      if (!state.inited) {
        if (pending.length >= 200) pending.shift();
        pending.push({ type, msg });
        return;
      }
      handle(type, msg);
    } catch (err) { /* a bad message must never take the page down */ }
  }

  // ── Boot: black stage, then the standby view until Lua says otherwise ─────
  bindVideo(video);
  buildCssBars();
  standbyLogoEl.addEventListener('error', onLogoError);
  audioLogoEl.addEventListener('error', onLogoError);
  window.addEventListener('message', onMessage);
  render();
})();
