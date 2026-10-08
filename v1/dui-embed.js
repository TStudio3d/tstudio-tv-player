/*
  TStudio TV — embedded players (YouTube / Twitch) for the screen page      html/dui-embed.js

  dui.js plays local files and direct links with the <video> element. Links to
  YouTube or Twitch are embeds instead: this module wraps both official player
  APIs behind one tiny interface so dui.js can drive them with the same
  load / play / pause / seek / volume / sync / stop commands.

    const p = await TvEmbed.create('youtube', '<videoId>', container,
        { position, playing, volume, loop, current? }, { loaded(duration|null), ended(), error(msg) })
    p.play(pos) · p.pause(pos) · p.seek(pos) · p.setVolume(0..1) · p.currentTime()
    p.duration() · p.isPaused() · p.live · p.destroy()

  The promise resolves as soon as the player exists; commands before the
  player is ready are dropped. `current()` (optional) returns
  { position, playing, volume } and is read when the player becomes ready, so
  it starts where the server timeline is by then, not where it was at load.

  Both embeds need the page to have a real web origin (the hosted copy of this
  page, see Config.Media.playerUrl): YouTube refuses embeds without a referer
  (error 153) and Twitch requires `parent` = the page's domain over https.
  Everything here is client-side; nothing is stored or relayed anywhere.
*/
(function () {
  'use strict'

  const isWebOrigin = location.protocol === 'https:' || location.protocol === 'http:'
  const API_TIMEOUT_MS = 15000

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script')
      s.src = src
      s.async = true
      s.onload = () => resolve()
      s.onerror = () => reject(new Error('failed to load ' + src))
      document.head.appendChild(s)
    })
  }

  function clamp01(v) {
    v = Number(v)
    if (!Number.isFinite(v)) return 0
    return v < 0 ? 0 : v > 1 ? 1 : v
  }

  // ── YouTube IFrame API ───────────────────────────────────────────────
  let ytPromise = null
  function ensureYouTube() {
    if (ytPromise) return ytPromise
    ytPromise = new Promise((resolve, reject) => {
      if (window.YT && window.YT.Player) { resolve(window.YT); return }
      const previous = window.onYouTubeIframeAPIReady
      window.onYouTubeIframeAPIReady = () => {
        if (typeof previous === 'function') { try { previous() } catch (e) { /* ignore */ } }
        resolve(window.YT)
      }
      loadScript('https://www.youtube.com/iframe_api').catch(reject)
      setTimeout(() => reject(new Error('YouTube player API did not load')), API_TIMEOUT_MS)
    })
    ytPromise.catch(() => { ytPromise = null })
    return ytPromise
  }

  // What the player should do right now (read when it becomes ready).
  function currentOf(opts) {
    const c = typeof opts.current === 'function' ? opts.current() : null
    return c && typeof c === 'object' ? c : opts
  }

  async function createYouTube(container, mediaId, opts, events) {
    const YT = await ensureYouTube()
    const el = document.createElement('div')
    el.className = 'tv-embed'
    container.appendChild(el)

    let loadedReported = false
    const vars = {
      autoplay: 1, controls: 0, disablekb: 1, rel: 0, modestbranding: 1,
      playsinline: 1, iv_load_policy: 3, fs: 0, enablejsapi: 1,
    }
    if (isWebOrigin) { vars.origin = location.origin; vars.widget_referrer = location.href }
    if (opts.position > 1) vars.start = Math.floor(opts.position)
    if (opts.loop) { vars.loop = 1; vars.playlist = mediaId }

    const safe = (fn, fallback) => { try { return fn() } catch (err) { return fallback } }
    let player = null
    const api = {
      provider: 'youtube',
      live: false, // set once the stream reports itself as live (no seeking then)
      play: (pos) => safe(() => { if (typeof pos === 'number' && !api.live) player.seekTo(pos, true); player.playVideo() }),
      pause: (pos) => safe(() => { player.pauseVideo(); if (typeof pos === 'number' && !api.live) player.seekTo(pos, true) }),
      seek: (pos) => safe(() => { if (!api.live) player.seekTo(pos, true) }),
      setVolume: (v) => safe(() => {
        player.setVolume(Math.round(clamp01(v) * 100))
        if (v > 0 && player.isMuted()) player.unMute()
      }),
      currentTime: () => safe(() => player.getCurrentTime() || 0, 0),
      duration: () => safe(() => player.getDuration() || 0, 0),
      isPaused: () => safe(() => player.getPlayerState() !== YT.PlayerState.PLAYING, true),
      destroy: () => { safe(() => player.destroy()); if (el.parentNode) el.parentNode.removeChild(el) },
    }

    player = new YT.Player(el, {
      width: '100%', height: '100%', videoId: mediaId, host: 'https://www.youtube.com',
      playerVars: vars,
      events: {
        onReady: (e) => {
          try {
            const cur = currentOf(opts)
            e.target.unMute() // the player remembers a mute per origin; we never want one
            e.target.setVolume(Math.round(clamp01(cur.volume) * 100))
            if (cur.position > 1) e.target.seekTo(cur.position, true)
            if (cur.playing) e.target.playVideo(); else e.target.pauseVideo()
          } catch (err) { events.error('youtube: ' + (err && err.message)) }
        },
        onStateChange: (e) => {
          if (e.data === YT.PlayerState.PLAYING && !loadedReported) {
            loadedReported = true
            safe(() => { const vd = e.target.getVideoData(); if (vd && vd.isLive) api.live = true })
            let d = 0
            if (!api.live) d = safe(() => e.target.getDuration(), 0)
            events.loaded(d > 0 ? d : null)
          }
          if (e.data === YT.PlayerState.ENDED && !opts.loop && !api.live) events.ended()
        },
        onError: (e) => {
          const codes = { 2: 'invalid video id', 5: 'player error', 100: 'video not found or private', 101: 'embedding disabled by the owner', 150: 'embedding disabled by the owner', 152: 'video unavailable in embeds', 153: 'embed refused (page needs a web origin)' }
          events.error('youtube: ' + (codes[e.data] || ('error ' + e.data)))
        },
      },
    })
    return api
  }

  // ── Twitch embed ────────────────────────────────────────────────────
  let twPromise = null
  function ensureTwitch() {
    if (twPromise) return twPromise
    twPromise = new Promise((resolve, reject) => {
      if (window.Twitch && window.Twitch.Player) { resolve(window.Twitch); return }
      loadScript('https://player.twitch.tv/js/embed/v1.js').then(() => {
        if (window.Twitch && window.Twitch.Player) resolve(window.Twitch)
        else reject(new Error('Twitch player API did not initialise'))
      }).catch(reject)
      setTimeout(() => reject(new Error('Twitch player API did not load')), API_TIMEOUT_MS)
    })
    twPromise.catch(() => { twPromise = null })
    return twPromise
  }

  async function createTwitch(container, mediaId, opts, events) {
    const Twitch = await ensureTwitch()
    const sep = mediaId.indexOf(':')
    const type = sep > 0 ? mediaId.slice(0, sep) : 'channel'
    const id = sep > 0 ? mediaId.slice(sep + 1) : mediaId
    const live = type === 'channel'

    const el = document.createElement('div')
    el.className = 'tv-embed'
    container.appendChild(el)

    const options = { width: '100%', height: '100%', autoplay: true, muted: false, parent: [location.hostname] }
    if (live) options.channel = id
    else options.video = id
    if (!live && opts.position > 0) options.time = Math.floor(opts.position) + 's'

    let player
    try { player = new Twitch.Player(el, options) } catch (err) { events.error('twitch: ' + (err && err.message)); throw err }

    let loadedReported = false
    player.addEventListener(Twitch.Player.READY, () => {
      try {
        const cur = currentOf(opts)
        player.setMuted(false)
        player.setVolume(clamp01(cur.volume))
        if (!live && Math.abs((cur.position || 0) - (opts.position || 0)) > 2) player.seek(cur.position)
        if (!cur.playing) player.pause()
      } catch (err) { /* ignore */ }
    })
    player.addEventListener(Twitch.Player.PLAYING, () => {
      if (loadedReported) return
      loadedReported = true
      let d = 0
      try { d = live ? 0 : player.getDuration() } catch (err) { d = 0 }
      events.loaded(d > 0 ? d : null)
    })
    player.addEventListener(Twitch.Player.ENDED, () => { if (!live) events.ended() })
    player.addEventListener(Twitch.Player.OFFLINE, () => { if (live) events.error('twitch: channel is offline') })

    const safe = (fn, fallback) => { try { return fn() } catch (err) { return fallback } }
    return {
      provider: 'twitch',
      live,
      play: (pos) => safe(() => { if (!live && typeof pos === 'number') player.seek(pos); player.play() }),
      pause: (pos) => safe(() => { player.pause(); if (!live && typeof pos === 'number') player.seek(pos) }),
      seek: (pos) => safe(() => { if (!live) player.seek(pos) }),
      setVolume: (v) => safe(() => { player.setMuted(false); player.setVolume(clamp01(v)) }),
      currentTime: () => safe(() => player.getCurrentTime() || 0, 0),
      duration: () => safe(() => (live ? 0 : player.getDuration() || 0), 0),
      isPaused: () => safe(() => player.isPaused(), true),
      destroy: () => { safe(() => player.pause()); if (el.parentNode) el.parentNode.removeChild(el) },
    }
  }

  // ── public ──────────────────────────────────────────────────────────
  window.TvEmbed = {
    /** True when this page can host third-party embeds at all. */
    supported: isWebOrigin,
    providers: ['youtube', 'twitch'],
    /**
     * @param {'youtube'|'twitch'} provider
     * @param {string} mediaId  youtube video id | 'channel:<name>' | 'video:<id>'
     * @param {HTMLElement} container
     * @param {{position:number, playing:boolean, volume:number, loop:boolean}} opts
     * @param {{loaded:(d:number|null)=>void, ended:()=>void, error:(m:string)=>void}} events
     */
    create(provider, mediaId, container, opts, events) {
      if (!isWebOrigin) {
        return Promise.reject(new Error(provider + ' embeds need the hosted player page (Config.Media.playerUrl)'))
      }
      if (provider === 'youtube') return createYouTube(container, mediaId, opts, events)
      if (provider === 'twitch') return createTwitch(container, mediaId, opts, events)
      return Promise.reject(new Error('unknown provider ' + provider))
    },
  }
})()
