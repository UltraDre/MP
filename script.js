/* =====================================================================
 * Nebula Player — script.js
 * ---------------------------------------------------------------------
 * A framework-free media player with:
 *   • progressive download playback (MP4/WebM/…) + HLS (hls.js) + DASH (dash.js)
 *   • local file playback (file picker, folder picker, drag & drop)
 *   • offline downloads through the Cache API / service worker
 *   • playlist, subtitles (.vtt/.srt), gestures, keyboard shortcuts
 *   • theme, volume, speed and playlist persistence in localStorage
 *
 * Module map (search for the banner numbers):
 *   01 Utilities          07 MediaSession
 *   02 Persistence        08 Controls
 *   03 UI helpers         09 Menus       | 10 Gestures
 *   04 Media helpers      11 Keyboard    | 12 Playlist
 *   05 StreamEngine       13 Offline     | 14 Subtitles
 *   06 Player             15 SubtitleSearch
 *   16 Sources + MovieSearch | 17 Theme | 18 Shell | 19 UI | 20 Boot
 * ===================================================================== */

'use strict';

/* =====================================================================
 * 01. UTILITIES
 * ===================================================================*/

/** Shorthand query helpers. */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Tiny element factory: el('div', { class: 'x', text: 'hi' }, childNode) */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Create an <svg><use href="#id"></svg> icon from the inline sprite. */
function icon(id, size) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  if (size) { svg.style.width = svg.style.height = size + 'px'; }
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#' + id);
  svg.append(use);
  return svg;
}

/** Feature test for service-worker support (some engines expose it as undefined). */
const hasServiceWorker = () => typeof navigator !== 'undefined' && !!navigator.serviceWorker;

/** matchMedia wrapper that never throws (older engines / test environments). */
function mediaQuery(query) {
  if (typeof window.matchMedia !== 'function') {
    return { matches: false, media: query, addEventListener() { }, addListener() { } };
  }
  return window.matchMedia(query);
}

/** Safari exposes preservesPitch under a prefix. */
function setPreservesPitch(videoEl, value) {
  try {
    if ('preservesPitch' in videoEl) videoEl.preservesPitch = value;
    if ('webkitPreservesPitch' in videoEl) videoEl.webkitPreservesPitch = value;
    if ('mozPreservesPitch' in videoEl) videoEl.mozPreservesPitch = value;
  } catch { /* unsupported */ }
}

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
const uid = () => 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/** 3725 → "1:02:05" / 65 → "1:05" */
function fmtTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
}

/** 1536000 → "1.46 MB" */
function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function debounce(fn, ms = 200) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
function throttle(fn, ms = 100) {
  let last = 0, timer;
  return (...args) => {
    const now = Date.now();
    if (now - last >= ms) { last = now; fn(...args); }
    else { clearTimeout(timer); timer = setTimeout(() => { last = Date.now(); fn(...args); }, ms - (now - last)); }
  };
}

/** Filename / title from a URL (falls back to the host). */
function nameFromUrl(url, maxLen = 90) {
  try {
    const u = new URL(url, location.href);
    const base = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    const title = base || u.hostname;
    return title.length > maxLen ? title.slice(0, maxLen - 1) + '…' : title;
  } catch {
    return String(url).slice(0, maxLen);
  }
}

/** Human readable byte range / host, used in list subtitles. */
function hostFromUrl(url) {
  try { return new URL(url, location.href).host; } catch { return ''; }
}

/** Hostname without a leading www. */
function hostName(url) {
  try { return new URL(url, location.href).hostname.replace(/^www\./i, '').toLowerCase(); } catch { return ''; }
}

/**
 * Rewrite share-page URLs that have a well-known direct-file equivalent
 * (Google Drive, Dropbox, GitHub blob pages). Returns the original string
 * when nothing applies.
 */
function rewriteMediaUrl(raw) {
  const value = String(raw || '').trim();
  try {
    const u = new URL(value);
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();

    const driveId = u.pathname.match(/\/file\/d\/([^/]+)/)?.[1]
      || ((host === 'drive.google.com' || host === 'docs.google.com') ? u.searchParams.get('id') : null);
    if (driveId && /(?:^|\.)google\.com$/.test(host)) {
      return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(driveId)}`;
    }

    if (host === 'dropbox.com' || host.endsWith('.dropbox.com')) {
      u.searchParams.set('dl', '1');
      return u.toString();
    }

    if (host === 'github.com' && /\/blob\//.test(u.pathname)) {
      return value.replace('://github.com/', '://raw.githubusercontent.com/').replace('/blob/', '/');
    }
  } catch { /* keep original */ }
  return value;
}

/**
 * Watch-page hosts that cannot be fed to <video>. Empty string = looks playable.
 */
function unplayableHint(url) {
  const host = hostName(url);
  if (!host) return '';
  if (/(?:^|\.)youtube\.com$|(?:^|\.)youtube-nocookie\.com$|^youtu\.be$/.test(host)) {
    return 'YouTube watch-page links cannot be played here. Paste a direct MP4/WebM/HLS URL, or open the file from your device.';
  }
  if (/(?:^|\.)vimeo\.com$/.test(host)) {
    return 'Vimeo page links cannot be played here. Use a direct MP4/HLS URL or a local file.';
  }
  if (/(?:^|\.)(?:tiktok|instagram|facebook|twitter|x)\.com$|^fb\.watch$/.test(host)) {
    return 'Social media page links cannot be played directly. Use a direct media file URL or a local file.';
  }
  if (/(?:^|\.)(?:netflix|twitch|dailymotion)\.com$/.test(host)) {
    return 'This site does not expose a direct media file. Use an MP4/WebM/HLS/DASH URL or a local file.';
  }
  return '';
}

/* =====================================================================
 * 02. PERSISTENCE (localStorage)
 * ===================================================================*/

const SETTINGS_KEY = 'nebula.settings.v1';
const PLAYLIST_KEY = 'nebula.playlist.v1';

const Settings = {
  data: {
    theme: null,            // 'dark' | 'light' | null (= follow system)
    volume: 1,
    muted: false,
    speed: 1,
    preservePitch: true,
    loopMode: 'off',        // 'off' | 'all' | 'one'
    shuffle: false,
    captionsEnabled: true,  // do we auto-show available subtitle tracks?
    subtitleDelay: 0,
    seekZones: false,       // double-tap left/right third = ±10s (opt-in)
    lastVolume: 1,
    subSearchLang: '',      // preferred language for the online subtitle search
    subSearchProxy: true,   // retry blocked (CORS) subtitle requests through a proxy
    subSearchProxyUrl: '',  // optional custom proxy prefix / template ({url})
    subSearchApiKey: '',    // optional opensubtitles.com API key (3rd source)
    subSearchAutoSearch: true, // search as soon as the dialog opens for a video
  },

  load() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) Object.assign(this.data, JSON.parse(raw));
    } catch (err) { console.warn('[settings] unable to read', err); }
    return this.data;
  },

  /** Persist (writes are debounced to keep localStorage traffic low). */
  save: debounce(function () {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(Settings.data)); }
    catch (err) { console.warn('[settings] unable to save', err); }
  }, 150),

  set(key, value) { this.data[key] = value; this.save(); return value; },
  get(key) { return this.data[key]; },
};

/* =====================================================================
 * 03. UI HELPERS (toasts, dialogs, notices)
 * ===================================================================*/

const Toast = {
  host: null,
  init() { this.host = $('#toasts'); },
  /**
   * show('Saved', 'ok' | 'err' | 'warn' | 'info', ms, key?)
   * Passing a `key` replaces the previous toast with the same key, so
   * repeated feedback (volume steps, speed changes…) never stacks up.
   */
  show(message, kind = 'info', ms = 3200, key = null) {
    if (!this.host) return;
    const icons = { ok: 'i-check-circle', err: 'i-warn', warn: 'i-warn', info: 'i-play' };
    if (key) $$(`[data-toast-key="${key}"]`, this.host).forEach((n) => n.remove());
    const node = el('div', { class: `toast ${kind}`, role: 'status', dataset: key ? { toastKey: key } : {} },
      icon(icons[kind] || icons.info),
      el('span', { text: message }));
    this.host.append(node);
    const kill = () => {
      node.classList.add('out');
      setTimeout(() => node.remove(), 240);
    };
    setTimeout(kill, ms);
    node.addEventListener('click', kill);
  },
  ok(m, ms, key) { this.show(m, 'ok', ms, key); },
  err(m, ms, key) { this.show(m, 'err', ms ?? 5000, key); },
  warn(m, ms, key) { this.show(m, 'warn', ms ?? 4500, key); },
};

/** Promise-based confirm dialog built on <dialog>. */
function confirmDialog(title, message, okLabel = 'Confirm') {
  const dlg = $('#confirmDialog');
  $('#confirmTitle').textContent = title;
  $('#confirmMessage').textContent = message;
  const okBtn = $('#confirmOk');
  okBtn.textContent = okLabel;
  return new Promise((resolve) => {
    const done = () => {
      dlg.removeEventListener('close', done);
      resolve(dlg.returnValue === 'ok');
    };
    dlg.addEventListener('close', done);
    dlg.returnValue = '';
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else resolve(window.confirm(`${title}\n\n${message}`));
  });
}

const UIState = {
  setSw(text) { $('#swState').textContent = text; },
};

/* =====================================================================
 * 04. MEDIA HELPERS — format detection & source objects
 * ===================================================================*/

const MEDIA = {
  hls: /\.m3u8(\?|#|$)/i,
  dash: /\.mpd(\?|#|$)/i,
  progressive: /\.(mp4|m4v|mov|webm|ogv|ogg|mp3|m4a|aac|flac|wav|opus)(\?|#|$)/i,
  subtitle: /\.(vtt|srt)(\?|#|$)/i,
};

/** → 'hls' | 'dash' | 'progressive' | 'unknown' */
function detectType(url, fallback = 'unknown') {
  const clean = String(url || '').trim();
  if (!clean) return fallback;
  if (MEDIA.hls.test(clean)) return 'hls';
  if (MEDIA.dash.test(clean)) return 'dash';
  if (MEDIA.progressive.test(clean)) return 'progressive';
  if (/\/manifest\(format=mpd/.test(clean) || /format=mpd/i.test(clean)) return 'dash';
  if (/\/manifest\(format=m3u8/.test(clean) || /format=m3u8/i.test(clean)) return 'hls';
  return fallback;
}

/** Extensions accepted when scanning a web page for playable videos. */
const SCAN_MEDIA_EXT = /\.(mp4|m4v|mov|webm|ogv|ogg|mp3|m4a|aac|flac|wav|opus|mkv|m3u8|mpd)(\?|#|$)/i;

/**
 * Media-looking URLs inside raw page text (players that inject sources from
 * JavaScript/JSON). Matches absolute (`https://…`), protocol-relative (`//…`)
 * and root-relative (`/…`) URLs ending in a playable extension.
 */
const SCAN_TEXT_RE = /(?:(?:https?:)?\/\/|\/)[^\s"'`<>\\|,;()[\]{}]+?\.(?:mp4|m4v|mov|webm|ogv|ogg|mp3|m4a|aac|flac|wav|opus|mkv|m3u8|mpd)(?:\?[^\s"'`<>\\|,;()[\]{}]*)?/gi;

const isStreamType = (t) => t === 'hls' || t === 'dash';

/** 'progressive' → the MIME we advertise to the <video> element. */
function mimeFor(type, url = '') {
  if (type === 'hls') return 'application/vnd.apple.mpegurl';
  if (type === 'dash') return 'application/dash+xml';
  const ext = (String(url).split(/[?#]/)[0].match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
  return {
    mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
    ogv: 'video/ogg', ogg: 'video/ogg', mkv: 'video/x-matroska',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
    wav: 'audio/wav', opus: 'audio/ogg',
  }[ext] || '';
}

/* =====================================================================
 * 05. STREAM ENGINE — loads hls.js / dash.js on demand
 * ===================================================================*/

const StreamEngine = {
  /** Local copies ship with the app so downloaded streams play offline too. */
  libs: {
    hls: {
      global: 'Hls',
      sources: [
        'vendor/hls.min.js',
        'https://cdn.jsdelivr.net/npm/hls.js@1.7.3/dist/hls.min.js',
        'https://unpkg.com/hls.js@1.7.3/dist/hls.min.js',
      ],
    },
    dash: {
      global: 'dashjs',
      sources: [
        'vendor/dash.all.min.js',
        'https://cdn.jsdelivr.net/npm/dashjs@5.2.1/dist/dash.all.min.js',
        'https://cdn.dashjs.org/v5.2.1/dash.all.min.js',
      ],
    },
  },
  _promises: {},
  hls: null,
  dash: null,

  /** Load a <script> once, resolving to true/false. */
  _loadScript(src, timeout = 12000) {
    return new Promise((resolve) => {
      const s = document.createElement('script');
      let settled = false;
      const finish = (ok) => { if (!settled) { settled = true; s.remove(); resolve(ok); } };
      s.src = src;
      s.async = true;
      s.onload = () => finish(true);
      s.onerror = () => finish(false);
      setTimeout(() => finish(false), timeout);
      document.head.append(s);
    });
  },

  /** Make sure window[name] exists (tries local copy, then CDNs). */
  async ensureLibrary(which) {
    const cfg = this.libs[which];
    if (!cfg) return false;
    if (window[cfg.global]) return true;
    if (this._promises[which]) return this._promises[which];

    this._promises[which] = (async () => {
      for (const src of cfg.sources) {
        if (window[cfg.global]) return true;
        const ok = await this._loadScript(src);
        if (ok && window[cfg.global]) {
          console.info(`[StreamEngine] loaded ${which} from ${src}`);
          return true;
        }
      }
      delete this._promises[which]; // allow another attempt later
      return false;
    })();
    return this._promises[which];
  },

  /** Tear down any previous streaming instance. */
  destroy() {
    if (this.hls) {
      try { this.hls.destroy(); } catch (err) { console.warn(err); }
      this.hls = null;
    }
    if (this.dash) {
      try { this.dash.reset(); } catch (err) { console.warn(err); }
      this.dash = null;
    }
  },

  /**
   * Attach a stream to the <video> element.
   * @returns {Promise<{ok:boolean, mode:string, error?:string, controls?:object}>}
   */
  async attach(video, url, type, handlers = {}) {
    this.destroy();
    if (type === 'hls') return this._attachHls(video, url, handlers);
    if (type === 'dash') return this._attachDash(video, url, handlers);
    return { ok: false, mode: 'none', error: 'Not a streaming type' };
  },

  async _attachHls(video, url, handlers) {
    // Native HLS (Safari, iOS, some Android) — preferred when available
    // because it keeps hardware decoding and AirPlay support.
    const canNative = !!video.canPlayType('application/vnd.apple.mpegurl');
    if (canNative && (!window.Hls || !window.Hls.isSupported())) {
      video.referrerPolicy = 'no-referrer';
      video.src = url;
      return { ok: true, mode: 'native-hls' };
    }

    const loaded = await this.ensureLibrary('hls');
    if (!loaded) return { ok: false, mode: 'none', error: 'hls.js could not be loaded (offline and not cached?)' };
    if (!window.Hls.isSupported()) {
      if (canNative) {
        video.referrerPolicy = 'no-referrer';
        video.src = url;
        return { ok: true, mode: 'native-hls' };
      }
      return { ok: false, mode: 'none', error: 'This browser cannot play HLS (no MSE support).' };
    }

    const hls = new window.Hls({
      enableWorker: true,
      lowLatencyMode: true,
      backBufferLength: 90,
      maxBufferLength: 60,
      manifestLoadingTimeOut: 15000,
      fragLoadingTimeOut: 60000,
      xhrSetup(xhr) {
        try { xhr.withCredentials = false; } catch { /* ignore */ }
      },
      fetchSetup(context, initParams) {
        try {
          const init = Object.assign({}, initParams || {}, {
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
          });
          return new Request(context.url, init);
        } catch {
          return new Request(context.url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
        }
      },
    });
    this.hls = hls;

    hls.on(window.Hls.Events.ERROR, (_evt, data) => {
      if (!data.fatal) {
        if (data.details === 'bufferStalledError') handlers.onStall?.();
        return;
      }
      switch (data.type) {
        case window.Hls.ErrorTypes.NETWORK_ERROR:
          handlers.onFatal?.(`Network error (${data.details}). Retrying…`, 'network');
          try { hls.startLoad(); } catch { /* noop */ }
          break;
        case window.Hls.ErrorTypes.MEDIA_ERROR:
          handlers.onFatal?.(`Media error (${data.details}). Recovering…`, 'media');
          try { hls.recoverMediaError(); } catch { /* noop */ }
          break;
        default:
          handlers.onFatal?.(`Fatal streaming error: ${data.details}`, 'fatal');
          hls.destroy();
          this.hls = null;
      }
    });

    hls.on(window.Hls.Events.MANIFEST_PARSED, (_e, data) => {
      handlers.onStreamReady?.({ levels: data.levels?.length || 0 });
    });

    // Optional quality lock (used when playing a downloaded copy offline).
    hls.on(window.Hls.Events.LEVEL_LOADED, (_e, data) => handlers.onLevelLoaded?.(data));

    return new Promise((resolve) => {
      const settle = (result) => { clearTimeout(t); resolve(result); };
      const t = setTimeout(() => settle({ ok: true, mode: 'hls' }), 4000); // assume ok; errors surface via events
      hls.once(window.Hls.Events.MANIFEST_PARSED, () => settle({ ok: true, mode: 'hls', hls }));
      hls.once(window.Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) settle({ ok: false, mode: 'none', error: `HLS load failed: ${data.details}` });
      });
      try {
        hls.loadSource(url);
        hls.attachMedia(video);
      } catch (err) {
        settle({ ok: false, mode: 'none', error: String(err && err.message || err) });
      }
    });
  },

  async _attachDash(video, url, handlers) {
    const loaded = await this.ensureLibrary('dash');
    if (!loaded) return { ok: false, mode: 'none', error: 'dash.js could not be loaded (offline and not cached?)' };
    if (!window.dashjs || !window.dashjs.MediaPlayer) {
      return { ok: false, mode: 'none', error: 'dash.js is unavailable in this browser.' };
    }

    const player = window.dashjs.MediaPlayer().create();
    this.dash = player;
    player.updateSettings({
      streaming: {
        buffer: { fastSwitchEnabled: true },
        retryAttempts: { MPD: 4, MediaSegment: 4 },
      },
    });
    player.on(window.dashjs.MediaPlayer.events.ERROR, (e) => {
      const msg = e?.error?.message || e?.error || 'unknown error';
      if (String(e?.error?.code) === '10' /* MEDIA_ERROR */) {
        handlers.onFatal?.(`Media error: ${msg}`, 'media');
      } else {
        handlers.onFatal?.(`DASH error: ${msg}`, 'fatal');
      }
    });
    player.on(window.dashjs.MediaPlayer.events.MANIFEST_LOADED, () => handlers.onStreamReady?.({}));
    try { video.referrerPolicy = 'no-referrer'; } catch { /* ignore */ }
    player.initialize(video, url, false);
    this.dash = player;
    return { ok: true, mode: 'dash', dash: player };
  },
};

/* =====================================================================
 * 06. PLAYER — the core playback controller
 * ===================================================================*/

const Player = {
  video: null,
  current: null,        // active media item
  objectUrls: new Set(),// blob urls we must revoke
  resumeMap: new Map(), // item.id → seconds (in-memory resume points)
  _spinnerTimer: null,
  _errorRetry: null,
  _hasPlayed: false,
  _loadGen: 0,

  init() {
    this.video = $('#video');
    const v = this.video;
    try { v.referrerPolicy = 'no-referrer'; } catch { /* ignore */ }

    /* ---- core element events ---- */
    /* Play/pause is intentionally silent: no overlay icon, no text — the
       control-bar play button is the only state indicator. */
    v.addEventListener('play', () => {
      document.body.classList.add('is-playing');
      this._hasPlayed = true;
      this.updatePlayButton();
      MediaSession.update();
    });
    v.addEventListener('pause', () => {
      document.body.classList.remove('is-playing');
      this.updatePlayButton();
      this.hideSpinner();
      this.rememberPosition();
      MediaSession.update();
    });
    v.addEventListener('ended', () => { this.onEnded(); MediaSession.update(); });
    v.addEventListener('progress', throttle(() => Controls.renderProgress(), 250));
    v.addEventListener('durationchange', () => { Controls.renderProgress(); Controls.renderDuration(); });
    v.addEventListener('volumechange', () => Controls.renderVolume());
    v.addEventListener('ratechange', () => Controls.renderSpeed());
    v.addEventListener('seeking', () => { if (v.readyState < 3) this.showSpinner(); });
    v.addEventListener('seeked', () => this.hideSpinner());
    v.addEventListener('waiting', () => this.showSpinner());
    v.addEventListener('stalled', () => this.showSpinner());
    v.addEventListener('canplay', () => this.hideSpinner());
    v.addEventListener('canplaythrough', () => this.hideSpinner());
    v.addEventListener('playing', () => { this.hideSpinner(); this.setError(null); });
    v.addEventListener('loadedmetadata', () => { Controls.renderDuration(); this.hideEmptyState(); });
    v.addEventListener('error', () => this.onMediaError());

    /* ---- restore persisted settings ---- */
    const s = Settings.data;
    v.volume = clamp(s.volume ?? 1, 0, 1);
    v.muted = !!s.muted;
    setPreservesPitch(v, s.preservePitch !== false);
    this.setSpeed(s.speed || 1, { silent: true });

    return this;
  },

  setSpeed(rate, { silent = false } = {}) {
    const r = clamp(rate, 0.25, 4);
    this.video.playbackRate = r;
    this.video.defaultPlaybackRate = r;
    Settings.set('speed', r);
    Controls.renderSpeed();
    if (!silent) Toast.show(`${r}× speed`, 'info', 1400, 'speed');
    return r;
  },

  setVolume(value, { fromUser = true } = {}) {
    const v = clamp(value, 0, 1);
    this.video.volume = v;
    if (v > 0 && this.video.muted) this.video.muted = false;
    if (v > 0) Settings.set('lastVolume', v);
    Settings.set('volume', v);
    Settings.set('muted', this.video.muted);
    Controls.renderVolume();
    if (fromUser) MediaSession.updateVolumeHint();
  },

  setMuted(muted, { silent = false } = {}) {
    this.video.muted = !!muted;
    Settings.set('muted', this.video.muted);
    Controls.renderVolume();
    if (!silent) Toast.show(this.video.muted ? 'Muted' : 'Unmuted', 'info', 1100, 'mute');
  },

  toggleMute() { this.setMuted(!this.video.muted); },

  /** +0.05 / −0.05 volume steps with a UI toast. */
  nudgeVolume(delta) {
    const target = clamp((this.video.muted ? 0 : this.video.volume) + delta, 0, 1);
    if (this.video.muted && delta > 0) this.video.muted = false;
    this.setVolume(target);
    Toast.show(`Volume ${Math.round(target * 100)}%`, 'info', 1100, 'volume');
  },

  togglePlay() { this.video.paused ? this.play() : this.pause(); },

  play() {
    const p = this.video.play();
    if (p && typeof p.catch === 'function') {
      p.catch((err) => {
        // NotAllowedError = autoplay policy; AbortError = a new load interrupted play().
        if (err && err.name === 'NotAllowedError') {
          Toast.warn('Autoplay was blocked — press play to start.');
          Controls.showBigPlay(true);
        } else if (err && err.name !== 'AbortError') {
          console.warn('[player] play() rejected', err);
        }
      });
    }
  },

  pause() { this.video.pause(); },

  /** Seek by delta seconds (clamped). Used by keys & gestures. */
  seekBy(delta) {
    const v = this.video;
    if (!Number.isFinite(v.duration)) return;
    v.currentTime = clamp(v.currentTime + delta, 0, Math.max(0, v.duration - 0.05));
    Controls.flashSeek(delta > 0 ? 'right' : 'left');
  },

  seekTo(seconds) {
    const v = this.video;
    const dur = Number.isFinite(v.duration) ? v.duration : 0;
    v.currentTime = clamp(seconds, 0, Math.max(0, dur - 0.05));
  },

  seekPercent(pct) {
    const v = this.video;
    if (!Number.isFinite(v.duration)) return;
    this.seekTo((pct / 100) * v.duration);
  },

  frameStep(forward = true) {
    this.pause();
    const fps = 30; // approximation — browsers do not expose frame rate
    this.video.currentTime = clamp(this.video.currentTime + (forward ? 1 : -1) / fps, 0, this.video.duration || 0);
  },

  showSpinner() {
    // Never show the buffering dots unless we actually have a source in flight.
    if (!this.current) return;
    const v = this.video;
    if (!v) return;
    if (!v.src && !v.currentSrc && !StreamEngine.hls && !StreamEngine.dash) return;
    clearTimeout(this._spinnerTimer);
    this._spinnerTimer = setTimeout(() => {
      if (!this.current) return;
      const node = $('#spinner');
      if (node) { node.hidden = false; node.setAttribute('aria-hidden', 'false'); }
    }, 220);
  },
  hideSpinner() {
    clearTimeout(this._spinnerTimer);
    this._spinnerTimer = null;
    const node = $('#spinner');
    if (node) { node.hidden = true; node.setAttribute('aria-hidden', 'true'); }
  },

  hideEmptyState() {
    $('#emptyState').hidden = true;
    document.body.classList.remove('is-empty');
  },
  showEmptyState() {
    this.hideSpinner();
    $('#emptyState').hidden = false;
    document.body.classList.add('is-empty');
  },

  /** Show a friendly error card. Pass null to clear. */
  setError(error, { retry = null } = {}) {
    const box = $('#errorBox');
    if (!error) { box.hidden = true; this._errorRetry = null; return; }
    $('#errorTitle').textContent = error.title || 'Playback error';
    $('#errorDetail').textContent = error.detail || '';
    box.hidden = false;
    this._errorRetry = retry;
    this.hideSpinner();
  },

  retry() {
    if (typeof this._errorRetry === 'function') { const fn = this._errorRetry; this._errorRetry = null; this.setError(null); fn(); }
    else if (this.current) { this.load(this.current, { force: true }); }
  },

  onMediaError() {
    const v = this.video;
    const err = v.error;
    if (!err) return;
    // Stream libraries report their own fatal errors.
    if (StreamEngine.hls || StreamEngine.dash) { console.warn('[player] media error while streaming', err); return; }
    const item = this.current;
    // Remote progressive files get a blob-fallback + a clearer message.
    if (item && item.kind === 'remote' && !isStreamType(item.type || detectType(item.url))) {
      return;
    }
    const map = {
      1: { title: 'Playback aborted', detail: 'The media download was aborted.' },
      2: { title: 'Network error', detail: 'The video could not be fetched. Check the URL and your connection.' },
      3: { title: 'Decoding error', detail: 'The file could not be decoded. The container or codec may be unsupported (try MP4/H.264 or WebM/VP9).' },
      4: { title: 'Format not supported', detail: 'This browser cannot play this source directly. Try HLS/DASH or a different file.' },
    };
    const info = map[err.code] || { title: 'Playback error', detail: err.message || 'Unknown media error.' };
    this.setError(info, { retry: () => this.current && this.load(this.current, { force: true }) });
  },

  /** Remember where we were (used to resume after a reload / item switch). */
  rememberPosition() {
    if (!this.current || !Number.isFinite(this.video.duration) || this.video.currentTime < 5) return;
    this.resumeMap.set(this.current.id, this.video.currentTime);
  },

  /* -----------------------------------------------------------------
   * load(item) — the single entry point for playing something
   * item: { id, kind:'remote'|'file'|'offline', title, url, type, file?, objectUrl?, offline? }
   * ---------------------------------------------------------------- */
  async load(item, { autoplay = true, force = false } = {}) {
    if (!item) return;
    if (!force && this.current && this.current.id === item.id &&
        (this.video.currentSrc || this.video.src) && !this.video.error) {
      if (autoplay) this.play();
      return;
    }

    this.rememberPosition();
    StreamEngine.destroy();
    this.setError(null);
    this.hideEmptyState();
    this._hasPlayed = false;
    this._loadGen = (this._loadGen || 0) + 1;
    const loadGen = this._loadGen;
    this.current = item;
    this.showSpinner();
    Playlist.markCurrent(item.id);
    UI.renderCurrentTitle(item);
    MediaSession.setMetadata(item);

    const v = this.video;
    const type = item.type || detectType(item.url, 'progressive');
    const src = item.objectUrl || item.url;

    // Reset + preload hint so the browser starts fetching immediately.
    v.removeAttribute('src');
    v.innerHTML = '';               // drop previous <track> children
    Subtitles.onSourceChanged();
    try { v.load(); } catch { /* noop */ }

    // A previously stored resume point (same session only).
    const resumeAt = this.resumeMap.get(item.id) || 0;
    const applyResume = () => {
      if (resumeAt > 5 && Number.isFinite(v.duration) && v.duration - resumeAt > 3) {
        v.currentTime = resumeAt;
        Toast.show(`Resumed at ${fmtTime(resumeAt)}`, 'info', 2000);
      }
      Controls.renderDuration();
    };

    if (isStreamType(type)) {
      const result = await StreamEngine.attach(v, src, type, {
        onFatal: (msg, kind) => {
          if (kind === 'network') { Toast.warn(msg); return; }
          this.setError({ title: kind === 'media' ? 'Media error' : `${type.toUpperCase()} error`, detail: msg },
            { retry: () => this.load(item, { force: true }) });
        },
        onStreamReady: () => { this.hideSpinner(); applyResume(); Subtitles.enableAutoTracks(); },
        onStall: () => this.showSpinner(),
      });

      if (!result.ok) {
        this.setError({ title: `${type.toUpperCase()} could not be loaded`, detail: result.error },
          { retry: () => this.load(item, { force: true }) });
        return;
      }
      UI.setBadge(type === 'hls' ? 'HLS' : 'DASH');
      v.addEventListener('loadedmetadata', applyResume, { once: true });
    } else {
      try { v.referrerPolicy = 'no-referrer'; } catch { /* ignore */ }
      v.removeAttribute('crossorigin');
      v.src = src;
      v.preload = 'auto';
      UI.setBadge(item.kind === 'file' ? 'LOCAL' : (item.kind === 'offline' ? 'OFFLINE' : 'FILE'));
      v.addEventListener('loadedmetadata', applyResume, { once: true });
      // Progressive files: try a CORS blob fallback, then a clear error.
      if (item.kind === 'remote') {
        item._blobTried = false;
        v.addEventListener('error', () => {
          if (loadGen !== this._loadGen || this.current !== item) return;
          this._onRemoteError(item);
        }, { once: true });
      }
    }

    UI.renderOfflineBadge(!!item.offline);

    // Subtitles: explicit tracks attached to the item + sidecar detection.
    Subtitles.attachItemTracks(item);
    Subtitles.detectSidecars(item).catch(() => { /* optional */ });

    if (autoplay) this.play();
    else this.updatePlayButton();
  },

  /**
   * Remote progressive playback failed. Try fetching the file as a blob
   * (helps when the <video> request was blocked by Referer but CORS allows
   * a no-referrer fetch). Then surface a specific error.
   */
  async _onRemoteError(item) {
    if (!item || this.current !== item) return;
    if (!item._blobTried && item.url && /^https?:/i.test(item.url)) {
      item._blobTried = true;
      try {
        const res = await fetch(item.url, {
          mode: 'cors',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          cache: 'no-store',
        });
        if (res.ok) {
          const blob = await res.blob();
          if (blob && blob.size > 0) {
            const obj = URL.createObjectURL(blob);
            this.objectUrls.add(obj);
            item.objectUrl = obj;
            this.video.src = obj;
            this.play();
            return;
          }
        }
      } catch { /* CORS fetch failed too — fall through to the error card */ }
    }
    this.hideSpinner();
    this.setError(this._remoteErrorInfo(item), {
      retry: () => { item._blobTried = false; this.load(item, { force: true }); },
    });
  },

  _remoteErrorInfo(item) {
    const hint = unplayableHint(item && item.url);
    return {
      title: 'Cannot load this video',
      detail: hint || 'The URL may be wrong, the host unreachable, or the file is not a direct video stream. Use an MP4/WebM file, an .m3u8 HLS playlist, or an .mpd DASH manifest — watch pages cannot be played.',
    };
  },

  updatePlayButton() {
    const v = this.video;
    const playing = !v.paused && !v.ended;
    $('#btnPlay').setAttribute('aria-label', playing ? 'Pause' : 'Play');
    // Persistent center play only before the first successful play (or after
    // ended, so the user can tap to replay). Mid-playback pause uses the 1s flash.
    const showCenter = !playing && !!this.current && (!this._hasPlayed || v.ended);
    Controls.showBigPlay(showCenter);
  },

  /** End of the current item: honour loop-one / loop-all / shuffle. */
  onEnded() {
    const mode = Settings.get('loopMode');
    if (mode === 'one') { this.video.currentTime = 0; this.play(); return; }
    Playlist.advance(1, { auto: true });
  },

  /** Release blob URLs created for local files. */
  revoke(item) {
    if (item && item.objectUrl) {
      URL.revokeObjectURL(item.objectUrl);
      this.objectUrls.delete(item.objectUrl);
    }
  },
};

/* =====================================================================
 * 07. MEDIA SESSION — OS-level media keys / notification controls
 * ===================================================================*/

const MediaSession = {
  supported: 'mediaSession' in navigator,

  setMetadata(item) {
    if (!this.supported || !window.MediaMetadata) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: item.title || 'Unknown title',
        artist: item.kind === 'file' ? 'Local file' : (hostFromUrl(item.url) || 'Nebula Player'),
        album: 'Nebula Player',
      });
    } catch (err) { console.warn('[mediaSession]', err); }
  },

  update() {
    if (!this.supported) return;
    const playing = !Player.video.paused;
    try {
      navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
      navigator.mediaSession.setActionHandler('play', () => Player.play());
      navigator.mediaSession.setActionHandler('pause', () => Player.pause());
      navigator.mediaSession.setActionHandler('seekbackward', () => Player.seekBy(-10));
      navigator.mediaSession.setActionHandler('seekforward', () => Player.seekBy(10));
      navigator.mediaSession.setActionHandler('previoustrack', () => Playlist.advance(-1));
      navigator.mediaSession.setActionHandler('nexttrack', () => Playlist.advance(1));
    } catch (err) { /* some actions unsupported — ignore */ }
  },

  updateVolumeHint() { /* placeholder for future position state sync */ },
};

/* =====================================================================
 * 08. CONTROLS — binds the control bar to the player
 * ===================================================================*/

const Controls = {
  seeking: false,
  hideTimer: null,

  init() {
    const v = Player.video;

    /* --- play / pause / nav --- */
    $('#btnPlay').addEventListener('click', () => Player.togglePlay());
    $('#bigPlay').addEventListener('click', (e) => { e.stopPropagation(); Player.play(); });
    $('#btnPrev').addEventListener('click', () => Playlist.advance(-1));
    $('#btnNext').addEventListener('click', () => Playlist.advance(1));
    $('#btnBack10').addEventListener('click', () => Player.seekBy(-10));
    $('#btnFwd10').addEventListener('click', () => Player.seekBy(10));

    /* --- seek bar --- */
    const seek = $('#seek');
    const scrubTo = (clientX) => {
      const rect = seek.getBoundingClientRect();
      const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
      const dur = Number.isFinite(v.duration) ? v.duration : 0;
      return ratio * dur;
    };
    // Show a live tooltip while hovering / dragging.
    const tooltip = $('#seekTooltip');
    const moveTooltip = (clientX) => {
      const rect = seek.getBoundingClientRect();
      const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
      tooltip.textContent = fmtTime(ratio * (Number.isFinite(v.duration) ? v.duration : 0));
      tooltip.style.left = `${ratio * rect.width}px`;
      tooltip.hidden = false;
    };
    seek.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse' || this.seeking) moveTooltip(e.clientX); });
    seek.addEventListener('pointerleave', () => { if (!this.seeking) tooltip.hidden = true; });
    seek.addEventListener('pointerdown', () => { this.seeking = true; tooltip.hidden = false; });
    seek.addEventListener('input', (e) => {
      // Live scrub feedback: show the target time while dragging.
      const dur = Number.isFinite(v.duration) ? v.duration : 0;
      $('#timeCurrent').textContent = fmtTime((e.target.value / 1000) * dur);
      seek.style.setProperty('--progress', `${e.target.value / 10}%`);
      moveTooltip(e.clientX || seek.getBoundingClientRect().left);
    });
    const commitSeek = (e) => {
      const target = (e.target.value / 1000) * (Number.isFinite(v.duration) ? v.duration : 0);
      Player.seekTo(target);
      this.seeking = false;
      tooltip.hidden = true;
      Controls.renderProgress();
    };
    seek.addEventListener('change', commitSeek);
    // Pointer-based commit (covers touch where 'change' may lag)
    seek.addEventListener('pointerup', (e) => { if (this.seeking) commitSeek({ target: seek, clientX: e.clientX }); });
    window.addEventListener('pointerup', () => { this.seeking = false; });

    /* --- volume --- */
    const vol = $('#volume');
    vol.addEventListener('input', () => {
      Player.setVolume(parseFloat(vol.value));
      vol.style.setProperty('--progress', `${vol.value * 100}%`);
    });
    $('#btnMute').addEventListener('click', () => Player.toggleMute());

    /* --- shuffle / loop / speed / captions / pip / fullscreen --- */
    $('#btnShuffle').addEventListener('click', () => Playlist.toggleShuffle());
    $('#btnLoop').addEventListener('click', () => Playlist.cycleLoop());
    $('#btnSpeed').addEventListener('click', (e) => { e.stopPropagation(); Menus.toggle('speed', $('#btnSpeed')); });
    $('#btnCaptions').addEventListener('click', (e) => { e.stopPropagation(); Menus.toggle('subtitles', $('#btnCaptions')); });
    $('#btnPip').addEventListener('click', () => this.togglePip());
    $('#btnFullscreen').addEventListener('click', () => this.toggleFullscreen());
    $('#btnDownload').addEventListener('click', () => Offline.downloadCurrent());

    /* --- error card --- */
    $('#btnErrorRetry').addEventListener('click', () => Player.retry());
    $('#btnErrorDismiss').addEventListener('click', () => Player.setError(null));

    /* --- empty state quick actions --- */
    $('#btnEmptyLocal').addEventListener('click', (e) => { e.stopPropagation(); $('#fileInput').click(); });
    $('#btnEmptySearch').addEventListener('click', (e) => { e.stopPropagation(); MovieSearch.open(); });

    /* --- fullscreen state --- */
    document.addEventListener('fullscreenchange', () => {
      const fs = !!document.fullscreenElement;
      document.body.classList.toggle('is-fullscreen', fs);
      $('#btnFullscreen').setAttribute('aria-label', fs ? 'Exit fullscreen' : 'Fullscreen');
    });

    /* --- picture-in-picture support detection --- */
    if ('pictureInPictureEnabled' in document && document.pictureInPictureEnabled) {
      $('#btnPip').hidden = false;
    }

    /* --- keep the seek bar in sync while playing --- */
    v.addEventListener('timeupdate', () => { if (!this.seeking) this.renderProgress(); });

    this.renderVolume();
    this.renderSpeed();
    this.renderLoop();
    this.renderShuffle();
    this.renderProgress();
  },

  showBigPlay(show) { $('#bigPlay').hidden = !show; },

  renderProgress() {
    const v = Player.video;
    const seek = $('#seek');
    const dur = Number.isFinite(v.duration) ? v.duration : 0;
    const pct = dur ? (v.currentTime / dur) * 100 : 0;
    if (!this.seeking) {
      seek.value = String(pct * 10);
      seek.style.setProperty('--progress', `${pct}%`);
      $('#timeCurrent').textContent = fmtTime(v.currentTime);
      seek.setAttribute('aria-valuetext', `${fmtTime(v.currentTime)} of ${fmtTime(dur)}`);
    }
    // Buffered portion (last buffered range is the most useful indicator)
    try {
      if (v.buffered.length && dur) {
        const end = v.buffered.end(v.buffered.length - 1);
        seek.style.setProperty('--buffered', `${(end / dur) * 100}%`);
      }
    } catch { /* buffered can throw on some browsers */ }
  },

  renderDuration() {
    const v = Player.video;
    $('#timeDuration').textContent = Number.isFinite(v.duration) ? fmtTime(v.duration) : (isStreamType(Player.current?.type) ? 'LIVE' : '0:00');
  },

  renderVolume() {
    const v = Player.video;
    const vol = $('#volume');
    const effective = v.muted ? 0 : v.volume;
    vol.value = String(effective);
    vol.style.setProperty('--progress', `${effective * 100}%`);
    $('#volumeOut').textContent = `${Math.round(effective * 100)}%`;
    document.body.classList.toggle('is-muted', v.muted || v.volume === 0);
    document.body.classList.toggle('is-vol-low', !v.muted && v.volume > 0 && v.volume <= 0.5);
  },

  renderSpeed() {
    const rate = Player.video.playbackRate;
    $('#speedLabel').textContent = `${rate}×`;
    $$('#speedGrid button').forEach((b) => b.setAttribute('aria-pressed', String(parseFloat(b.dataset.speed) === rate)));
  },

  renderLoop() {
    const mode = Settings.get('loopMode');
    const btn = $('#btnLoop');
    document.body.classList.toggle('loop-all', mode === 'all');
    document.body.classList.toggle('loop-one', mode === 'one');
    btn.setAttribute('aria-pressed', String(mode !== 'off'));
    btn.setAttribute('aria-label', `Loop mode: ${mode}`);
  },

  renderShuffle() {
    const on = !!Settings.get('shuffle');
    $('#btnShuffle').setAttribute('aria-pressed', String(on));
    document.body.classList.toggle('is-shuffle', on);
  },

  /** Visual ripple for seek gestures / keys. */
  flashSeek(side) {
    const node = $(side === 'right' ? '#seekFlashRight' : '#seekFlashLeft');
    node.querySelector('span').textContent = side === 'right' ? '10s' : '10s';
    node.classList.remove('show'); void node.offsetWidth; node.classList.add('show');
  },

  async toggleFullscreen() {
    const target = $('#playerColumn');
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (target.requestFullscreen) await target.requestFullscreen({ navigationUI: 'hide' });
      else if (Player.video.webkitEnterFullscreen) Player.video.webkitEnterFullscreen(); // iOS Safari fallback
      else Toast.warn('Fullscreen is not available in this browser.');
    } catch (err) {
      Toast.err('Fullscreen failed: ' + (err.message || err));
    }
  },

  async togglePip() {
    const v = Player.video;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (document.pictureInPictureEnabled) await v.requestPictureInPicture();
      else if (v.webkitSetPresentationMode) {
        v.webkitSetPresentationMode(v.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
      } else Toast.warn('Picture-in-picture is not supported here.');
    } catch (err) {
      Toast.err('Picture-in-picture failed: ' + (err.message || err));
    }
  },

  /* Chrome is toggled by a single tap — no auto-hide, no mouse-move reveal. */
  scheduleAutoHide() { clearTimeout(this.hideTimer); },
  setBarVisible(visible) {
    $('#controlsBar').classList.toggle('is-hidden', !visible);
    document.body.classList.toggle('controls-hidden', !visible);
    clearTimeout(this.hideTimer);
  },
  toggleBar() { this.setBarVisible($('#controlsBar').classList.contains('is-hidden')); },
};

/* =====================================================================
 * 09. MENUS — speed popup & subtitle sheet
 * ===================================================================*/

const Menus = {
  open: null,

  init() {
    /* Speed buttons */
    const speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
    const grid = $('#speedGrid');
    speeds.forEach((s) => {
      grid.append(el('button', {
        type: 'button', text: `${s}×`, 'data-speed': s, 'aria-pressed': 'false',
        onclick: () => { Player.setSpeed(s); },
      }));
    });
    $('#preservePitch').addEventListener('change', (e) => {
      setPreservesPitch(Player.video, e.target.checked);
      Settings.set('preservePitch', e.target.checked);
      Toast.show(e.target.checked ? 'Pitch preserved' : 'Pitch changes with speed', 'info', 1500);
    });

    /* Close menus on outside click / Escape */
    document.addEventListener('click', (e) => {
      if (!this.open) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target && (this.open.contains(target) || target.closest('#btnSpeed, #btnCaptions'))) return;
      this.close();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.open) this.close(); });

    /* Subtitle sheet wiring lives in Subtitles.init() */
  },

  toggle(which, anchor) {
    if (which === 'speed') {
      const node = $('#speedMenu');
      const isOpen = !node.hidden;
      this.close();
      if (!isOpen) {
        node.hidden = false;
        $('#btnSpeed').setAttribute('aria-expanded', 'true');
        this.open = node;
        node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    } else {
      Subtitles.toggleSheet(anchor);
    }
  },

  close() {
    if (!this.open) return;
    // The subtitle sheet has its own close routine (keeps aria-expanded in sync).
    if (this.open === $('#subtitleSheet')) { Subtitles.closeSheet(); return; }
    this.open.hidden = true;
    $('#btnSpeed').setAttribute('aria-expanded', 'false');
    this.open = null;
  },
};

/* =====================================================================
 * 10. GESTURES — double-tap / double-click / single tap
 * ===================================================================*/

const Gestures = {
  DOUBLE_TAP_MS: 300,
  MOVE_TOLERANCE: 60,      // px — a "tap" must not move much
  SWIPE_THRESHOLD: 36,     // px — lock to seek/volume after deliberate movement
  SEEK_SECONDS_PER_PIXEL: 0.1,
  lastTouchEnd: 0,
  lastTap: { time: 0, x: 0, y: 0 },
  singleTapTimer: null,
  gestureHudTimer: null,
  touchStart: null,
  touchGesture: null,
  ignoreTouchEnd: false,

  init() {
    const stage = $('#playerStage');

    /* ---------- Touch (mobile / tablets) ---------- */
    stage.addEventListener('touchstart', (e) => this.handleTouchStart(e), { passive: false });
    stage.addEventListener('touchmove', (e) => this.handleTouchMove(e), { passive: false });
    stage.addEventListener('touchend', (e) => this.handleTouchEnd(e), { passive: true });
    stage.addEventListener('touchcancel', () => this.cancelTouchGesture(), { passive: true });

    /* ---------- Mouse (desktop) ---------- */
    stage.addEventListener('dblclick', (e) => {
      if (Gestures.isInteractive(e.target)) return;
      e.preventDefault();
      clearTimeout(Gestures.singleTapTimer);
      Gestures.singleTapTimer = null;
      Gestures.handleDoubleTap(e.clientX);
    });

    stage.addEventListener('click', (e) => {
      // Ignore clicks synthesised by touch (they follow touchend).
      if (performance.now() - Gestures.lastTouchEnd < 800) return;
      if (Gestures.isInteractive(e.target)) return;
      // Delay so a double-click can cancel the chrome toggle.
      clearTimeout(Gestures.singleTapTimer);
      Gestures.singleTapTimer = setTimeout(() => {
        Gestures.singleTapTimer = null;
        Gestures.handleSingleTap();
      }, Gestures.DOUBLE_TAP_MS + 20);
    });

    /* ---------- Drag & drop of files over the stage ---------- */
    DragDrop.bindStage(stage);
  },

  handleTouchStart(e) {
    if (e.touches.length > 1) {
      this.ignoreTouchEnd = true;
      this.touchStart = null;
      this.touchGesture = null;
      clearTimeout(this.singleTapTimer);
      this.singleTapTimer = null;
      this.hideGestureHud(0);
      return;
    }
    if (this.ignoreTouchEnd || this.isInteractive(e.target)) return;
    const touch = e.touches[0];
    if (!touch) return;
    this.touchStart = { identifier: touch.identifier, x: touch.clientX, y: touch.clientY, target: e.target };
    this.touchGesture = null;
    // Suppress browser panning/zoom only when the gesture starts on the stage.
    if (e.cancelable) e.preventDefault();
  },

  handleTouchMove(e) {
    if (!this.touchStart || this.ignoreTouchEnd) return;
    if (e.touches.length > 1) {
      this.ignoreTouchEnd = true;
      this.touchStart = null;
      this.touchGesture = null;
      this.hideGestureHud(0);
      return;
    }
    const touch = e.touches[0];
    if (!touch || touch.identifier !== this.touchStart.identifier) return;
    const dx = touch.clientX - this.touchStart.x;
    const dy = touch.clientY - this.touchStart.y;

    if (!this.touchGesture) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < this.SWIPE_THRESHOLD) return;
      const video = Player.video;
      this.touchGesture = {
        axis: Math.abs(dx) >= Math.abs(dy) ? 'seek' : 'volume',
        startX: this.touchStart.x,
        startY: this.touchStart.y,
        startTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
        startVolume: video.muted ? 0 : video.volume,
      };
      // A swipe must never fall through to a single/double-tap action.
      clearTimeout(this.singleTapTimer);
      this.singleTapTimer = null;
      this.lastTap.time = 0;
    }

    if (e.cancelable) e.preventDefault();
    this.updateTouchGesture(touch.clientX, touch.clientY);
  },

  handleTouchEnd(e) {
    if (e.touches.length > 0) return; // fingers still down = pinch
    const now = performance.now();
    this.lastTouchEnd = now;
    if (this.ignoreTouchEnd) {
      this.ignoreTouchEnd = false;
      this.touchStart = null;
      this.touchGesture = null;
      this.lastTap.time = 0;
      return;
    }

    const touch = e.changedTouches[0];
    if (this.touchGesture) {
      if (touch) this.updateTouchGesture(touch.clientX, touch.clientY);
      this.touchGesture = null;
      this.touchStart = null;
      this.lastTap.time = 0;
      this.hideGestureHud(650);
      return;
    }

    const start = this.touchStart;
    this.touchStart = null;
    if (this.isInteractive(e.target) || (start && this.isInteractive(start.target)) || !touch) return;

    const isDouble = (now - this.lastTap.time) <= this.DOUBLE_TAP_MS &&
      Math.hypot(touch.clientX - this.lastTap.x, touch.clientY - this.lastTap.y) <= this.MOVE_TOLERANCE;

    if (isDouble) {
      clearTimeout(this.singleTapTimer);
      this.singleTapTimer = null;
      this.lastTap.time = 0;
      this.handleDoubleTap(touch.clientX);
    } else {
      this.lastTap = { time: now, x: touch.clientX, y: touch.clientY };
      // Delay the single-tap action so a second tap can cancel it.
      clearTimeout(this.singleTapTimer);
      this.singleTapTimer = setTimeout(() => {
        this.singleTapTimer = null;
        this.handleSingleTap();
      }, this.DOUBLE_TAP_MS + 20);
    }
  },

  updateTouchGesture(clientX, clientY) {
    const gesture = this.touchGesture;
    if (!gesture) return;
    if (gesture.axis === 'seek') {
      const video = Player.video;
      if (!Number.isFinite(video.duration) || video.duration <= 0) {
        this.showGestureHud('seek', 'Seek unavailable', 'right');
        return;
      }
      const target = clamp(
        gesture.startTime + (clientX - gesture.startX) * this.SEEK_SECONDS_PER_PIXEL,
        0,
        Math.max(0, video.duration - 0.05)
      );
      Player.seekTo(target);
      Controls.renderProgress();
      const delta = target - gesture.startTime;
      const label = `${delta >= 0 ? '+' : '−'}${Math.round(Math.abs(delta))}s`;
      this.showGestureHud('seek', label, delta >= 0 ? 'right' : 'left');
      return;
    }

    const stageHeight = $('#playerStage').getBoundingClientRect().height || 240;
    const target = clamp(gesture.startVolume - (clientY - gesture.startY) / Math.max(stageHeight, 180), 0, 1);
    Player.setVolume(target);
    this.showGestureHud('volume', `${Math.round((Player.video.muted ? 0 : Player.video.volume) * 100)}%`);
  },

  showGestureHud(kind, label, direction = 'right') {
    const hud = $('#gestureHud');
    const use = hud.querySelector('use');
    const symbol = kind === 'volume' ? '#i-vol-high' : direction === 'left' ? '#i-prev' : '#i-next';
    use.setAttribute('href', symbol);
    $('#gestureHudLabel').textContent = label;
    hud.hidden = false;
    hud.setAttribute('aria-hidden', 'false');
    clearTimeout(this.gestureHudTimer);
  },

  hideGestureHud(delay = 0) {
    clearTimeout(this.gestureHudTimer);
    const hide = () => {
      const hud = $('#gestureHud');
      if (!hud) return;
      hud.hidden = true;
      hud.setAttribute('aria-hidden', 'true');
    };
    if (delay > 0) this.gestureHudTimer = setTimeout(hide, delay);
    else hide();
  },

  cancelTouchGesture() {
    this.touchStart = null;
    this.touchGesture = null;
    this.ignoreTouchEnd = false;
    this.lastTap.time = 0;
    clearTimeout(this.singleTapTimer);
    this.singleTapTimer = null;
    this.hideGestureHud(0);
  },

  /** True when the event target is part of the interactive UI (never gesture). */
  isInteractive(target) {
    if (!target || !(target instanceof Element)) return false;
    return !!target.closest(
      'button, a, input, select, textarea, label, output, dialog, .controls, .card, .sheet, .popup, ' +
      '.sidebar, .item, .title-strip, .download-bar, .toast, .error-box, .empty-state, video::-webkit-media-controls'
    );
  },

  /** Which third of the stage was tapped? 'left' | 'center' | 'right' */
  zoneOf(clientX) {
    const rect = $('#playerStage').getBoundingClientRect();
    const ratio = (clientX - rect.left) / rect.width;
    if (ratio < 0.33) return 'left';
    if (ratio > 0.67) return 'right';
    return 'center';
  },

  /**
   * Main double-tap behaviour: toggle play/pause anywhere.
   * Optional (opt-in) seek zones: left/right third seek ∓10s instead.
   */
  handleDoubleTap(clientX) {
    const zones = !!Settings.get('seekZones');
    const zone = zones ? this.zoneOf(clientX) : 'center';

    if (zone === 'left') { Player.seekBy(-10); return; }
    if (zone === 'right') { Player.seekBy(10); return; }

    // Silent play/pause: no overlay icon, no text, no control-bar reveal.
    Player.togglePlay();
  },

  /** Single tap toggles the control bar visibility. */
  handleSingleTap() {
    const hidden = $('#controlsBar').classList.contains('is-hidden');
    Controls.setBarVisible(hidden);
    if (!hidden) clearTimeout(Controls.hideTimer);
  },
};

/* =====================================================================
 * 11. KEYBOARD SHORTCUTS
 * ===================================================================*/

const Keyboard = {
  init() {
    document.addEventListener('keydown', (e) => this.onKeyDown(e));
  },

  /**
   * True while the user is entering text — shortcuts must not hijack it.
   * Sliders / checkboxes are *not* text entry: they stay shortcut-friendly
   * (their own arrow/space handling is preserved further down).
   */
  isTyping(e) {
    const t = e.target;
    if (!t) return false;
    if (t.isContentEditable) return true;
    const tag = t.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') {
      const type = (t.getAttribute('type') || 'text').toLowerCase();
      return !['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'file'].includes(type);
    }
    return false;
  },

  onKeyDown(e) {
    // Let the browser handle its own shortcuts (Ctrl+R, Cmd+L, …)
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const typing = this.isTyping(e);
    const v = Player.video;
    const key = e.key;

    // Space on a focused button/checkbox belongs to that control.
    if (key === ' ' && e.target?.matches?.('button, input, a[href], summary')) return;

    // Escape closes dialogs / panels even while typing.
    if (key === 'Escape') {
      if (document.fullscreenElement) { document.exitFullscreen?.(); return; }
      if (Menus.open) { Menus.close(); return; }
      if ($('#sidebar').classList.contains('open')) { Shell.closePanel(); return; }
      return;
    }

    if (typing) return;

    // Native range-input behaviour (↑/↓/←/→) should win when a slider has focus.
    const onRange = e.target && e.target.matches?.('input[type="range"]');
    const isArrow = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key);

    switch (key) {
      case ' ':
      case 'Spacebar':
      case 'k':
      case 'K':
        e.preventDefault(); Player.togglePlay(); Controls.setBarVisible(true); break;

      case 'ArrowLeft': case 'j': case 'J':
        if (onRange && key === 'ArrowLeft') return;
        e.preventDefault(); Player.seekBy(key === 'ArrowLeft' ? -5 : -10); break;

      case 'ArrowRight': case 'l': case 'L':
        if (onRange && key === 'ArrowRight') return;
        e.preventDefault(); Player.seekBy(key === 'ArrowRight' ? 5 : 10); break;

      case 'ArrowUp':
        if (onRange) return;
        e.preventDefault(); Player.nudgeVolume(0.05); break;

      case 'ArrowDown':
        if (onRange) return;
        e.preventDefault(); Player.nudgeVolume(-0.05); break;

      case 'm': case 'M': e.preventDefault(); Player.toggleMute(); break;
      case 'f': case 'F': e.preventDefault(); Controls.toggleFullscreen(); break;
      case 'p': case 'P': e.preventDefault(); Controls.togglePip(); break;
      case 'c': case 'C':
        e.preventDefault();
        if (e.shiftKey) SubtitleSearch.open(); else Subtitles.toggleEnabled();
        break;
      case 's': case 'S': e.preventDefault(); Toast.show(Playlist.toggleShuffle() ? 'Shuffle on' : 'Shuffle off', 'info', 1200, 'mode'); break;
      case 'r': case 'R': e.preventDefault(); Toast.show(`Loop: ${Playlist.cycleLoop()}`, 'info', 1200, 'mode'); break;
      case 't': case 'T': e.preventDefault(); Theme.toggle(); break;
      case 'd': case 'D': e.preventDefault(); Offline.downloadCurrent(); break;
      case 'n': e.preventDefault(); Playlist.advance(1); break;
      case 'N': e.preventDefault(); Playlist.advance(-1); break;
      case 'Home': e.preventDefault(); Player.seekTo(0); break;
      case 'End': e.preventDefault(); if (Number.isFinite(v.duration)) Player.seekTo(v.duration - 0.5); break;
      case ',': e.preventDefault(); Player.frameStep(false); break;
      case '.': e.preventDefault(); Player.frameStep(true); break;
      case '[': e.preventDefault(); Subtitles.setDelay(Settings.get('subtitleDelay') - 0.5); break;
      case ']': e.preventDefault(); Subtitles.setDelay(Settings.get('subtitleDelay') + 0.5); break;
      case '>': e.preventDefault(); Player.setSpeed(+(v.playbackRate + 0.25).toFixed(2)); break;   // Shift+>
      case '<': e.preventDefault(); Player.setSpeed(+(v.playbackRate - 0.25).toFixed(2)); break;   // Shift+<
      case '?': e.preventDefault(); Shell.openDialog('#shortcutsDialog'); break;
      case '/': if (e.shiftKey) { e.preventDefault(); Shell.openDialog('#shortcutsDialog'); } break;
      default: {
        // 0-9 jump to 0%…90%
        if (/^[0-9]$/.test(key)) {
          e.preventDefault();
          Player.seekPercent(Number(key) * 10);
        }
      }
    }
    if ([' ', 'k'].includes(key.toLowerCase()) || isArrow || key === 'm') Controls.scheduleAutoHide();
  },
};

/* =====================================================================
 * 12. PLAYLIST — queue, reorder, persistence, navigation
 * ===================================================================*/

const Playlist = {
  items: [],
  currentId: null,
  draggedId: null,

  init() {
    this.load();
    this.render();

    // Delegated clicks (play / remove / move up / move down)
    $('#playlistList').addEventListener('click', (e) => {
      const li = e.target.closest('.item');
      if (!li) return;
      const id = li.dataset.id;
      const action = e.target.closest('[data-action]')?.dataset.action || 'play';
      if (action === 'play') this.play(id);
      else if (action === 'remove') this.remove(id);
      else if (action === 'up') this.move(id, -1);
      else if (action === 'down') this.move(id, 1);
    });

    // Drag & drop reordering
    const list = $('#playlistList');
    list.addEventListener('dragstart', (e) => {
      const li = e.target.closest('.item');
      if (!li) return;
      this.draggedId = li.dataset.id;
      li.classList.add('is-dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', li.dataset.id); } catch { /* Safari */ }
    });
    list.addEventListener('dragend', (e) => {
      e.target.closest('.item')?.classList.remove('is-dragging');
      $$('.item', list).forEach((n) => n.classList.remove('drop-before', 'drop-after'));
      this.draggedId = null;
    });
    list.addEventListener('dragover', (e) => {
      if (!this.draggedId) return;
      e.preventDefault();
      const li = e.target.closest('.item');
      $$('.item', list).forEach((n) => n.classList.remove('drop-before', 'drop-after'));
      if (!li || li.dataset.id === this.draggedId) return;
      const rect = li.getBoundingClientRect();
      li.classList.add(e.clientY < rect.top + rect.height / 2 ? 'drop-before' : 'drop-after');
    });
    list.addEventListener('drop', (e) => {
      if (!this.draggedId) return;
      e.preventDefault();
      const li = e.target.closest('.item');
      const draggedId = this.draggedId;
      if (!li || li.dataset.id === draggedId) return;
      const rect = li.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      this.reorder(draggedId, li.dataset.id, before);
    });

    // Toolbar
    $('#btnClearPlaylist').addEventListener('click', async () => {
      if (!this.items.length) return;
      if (await confirmDialog('Clear playlist?', 'This removes every item from the playlist. Downloaded videos stay on your device.', 'Clear')) {
        this.items = [];
        this.currentId = null;
        this.save(); this.render();
        Toast.ok('Playlist cleared');
      }
    });
    $('#btnExportPlaylist').addEventListener('click', () => this.export());
    $('#btnImportPlaylist').addEventListener('click', () => $('#playlistInput').click());
    $('#playlistInput').addEventListener('change', (e) => { this.import(e.target.files?.[0]); e.target.value = ''; });
  },

  /* ---------- data ---------- */

  /** Serializable subset (local files can't be persisted). */
  serializable() {
    return this.items
      .filter((it) => it.kind !== 'file')
      .map((it) => ({ id: it.id, kind: it.kind, title: it.title, url: it.url, type: it.type, offline: !!it.offline, addedAt: it.addedAt }));
  },

  save: debounce(function () {
    try {
      localStorage.setItem(PLAYLIST_KEY, JSON.stringify({ version: 1, items: Playlist.serializable() }));
    } catch (err) { console.warn('[playlist] save failed', err); }
  }, 200),

  load() {
    try {
      const raw = localStorage.getItem(PLAYLIST_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.items)) return;
      this.items = data.items
        .filter((it) => it && typeof it.url === 'string' && !it.url.startsWith('blob:'))
        .map((it) => ({ ...it, id: it.id || uid(), type: it.type || detectType(it.url, 'progressive') }));
    } catch (err) { console.warn('[playlist] load failed', err); }
  },

  /* ---------- queries ---------- */

  has(item) {
    return this.items.some((it) =>
      (item.url && it.url === item.url && it.kind === item.kind) ||
      (item.file && it.file === item.file));
  },

  indexOf(id) { return this.items.findIndex((it) => it.id === id); },
  get current() { return this.items.find((it) => it.id === this.currentId) || Player.current; },

  /* ---------- mutations ---------- */

  /** Add an item (dedupes by URL / file) and optionally play it. */
  add(item, { play = false, silent = false } = {}) {
    let existing = this.items.find((it) => (item.url && it.url === item.url && it.kind === item.kind) || (item.file && it.file === item.file));
    if (existing) {
      if (!silent) Toast.show('Already in the playlist', 'info', 1800);
      if (play) this.play(existing.id);
      return existing;
    }
    const entry = { id: item.id || uid(), addedAt: Date.now(), ...item };
    this.items.push(entry);
    this.save(); this.render();
    if (!silent) Toast.ok(`Added: ${entry.title}`);
    if (play) this.play(entry.id);
    return entry;
  },

  remove(id) {
    const idx = this.indexOf(id);
    if (idx === -1) return;
    const [removed] = this.items.splice(idx, 1);
    Player.revoke(removed);
    if (this.currentId === id) this.currentId = null;
    this.save(); this.render();
    Toast.show(`Removed: ${removed.title}`, 'info', 1800);
  },

  move(id, delta) {
    const idx = this.indexOf(id);
    const next = idx + delta;
    if (idx === -1 || next < 0 || next >= this.items.length) return;
    const [it] = this.items.splice(idx, 1);
    this.items.splice(next, 0, it);
    this.save(); this.render();
  },

  reorder(draggedId, targetId, before) {
    const from = this.indexOf(draggedId);
    let to = this.indexOf(targetId);
    if (from === -1 || to === -1 || from === to) return;
    const [it] = this.items.splice(from, 1);
    to = this.indexOf(targetId) + (before ? 0 : 1);
    this.items.splice(to, 0, it);
    this.save(); this.render();
  },

  clear() { this.items = []; this.save(); this.render(); },

  /* ---------- navigation ---------- */

  play(id, opts = {}) {
    const item = typeof id === 'object' ? id : this.items.find((it) => it.id === id);
    if (!item) return;
    Playlist.currentId = item.id;
    Player.load(item, opts);
  },

  /** Next / previous item honouring shuffle + loop modes. */
  advance(direction = 1, { auto = false } = {}) {
    if (!this.items.length) return;
    const shuffle = !!Settings.get('shuffle');
    const loop = Settings.get('loopMode');
    const idx = this.currentId ? this.indexOf(this.currentId) : -1;

    if (auto && idx === this.items.length - 1 && loop === 'off' && !shuffle) return; // stop at the end

    let nextIdx;
    if (shuffle && this.items.length > 1) {
      do { nextIdx = Math.floor(Math.random() * this.items.length); } while (nextIdx === idx);
    } else {
      nextIdx = idx + direction;
      if (nextIdx >= this.items.length) nextIdx = 0;
      if (nextIdx < 0) nextIdx = this.items.length - 1;
    }
    const next = this.items[nextIdx];
    if (!next) return;
    if (next.kind === 'file' && !next.objectUrl && next.file) {
      next.objectUrl = URL.createObjectURL(next.file); // blob URLs die on reload
    }
    this.play(next.id);
  },

  toggleShuffle() {
    const on = !Settings.get('shuffle');
    Settings.set('shuffle', on);
    Controls.renderShuffle();
    return on;
  },

  cycleLoop() {
    const order = ['off', 'all', 'one'];
    const next = order[(order.indexOf(Settings.get('loopMode')) + 1) % order.length];
    Settings.set('loopMode', next);
    Controls.renderLoop();
    return next;
  },

  /* ---------- import / export ---------- */

  export() {
    if (!this.items.length) { Toast.warn('Playlist is empty'); return; }
    const data = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), items: this.serializable() }, null, 2);
    const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    const a = el('a', { href: url, download: `nebula-playlist-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    Toast.ok('Playlist exported');
  },

  async import(file) {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const list = Array.isArray(data) ? data : data.items;
      if (!Array.isArray(list)) throw new Error('Unrecognised playlist format');
      let added = 0;
      for (const raw of list) {
        if (!raw?.url || raw.url.startsWith('blob:')) continue;
        const type = raw.type || detectType(raw.url, 'progressive');
        const entry = { id: uid(), kind: raw.kind === 'offline' ? 'offline' : 'remote', title: raw.title || nameFromUrl(raw.url), url: raw.url, type, offline: !!raw.offline, addedAt: Date.now() };
        if (this.has(entry)) continue;
        this.items.push(entry); added++;
      }
      this.save(); this.render();
      Toast.ok(`Imported ${added} item${added === 1 ? '' : 's'}`);
    } catch (err) {
      Toast.err('Import failed: ' + (err.message || err));
    }
  },

  /* ---------- rendering ---------- */

  markCurrent(id) {
    this.currentId = id;
    $$('#playlistList .item').forEach((li) => li.classList.toggle('is-current', li.dataset.id === id));
  },

  tagFor(item) {
    if (item.kind === 'file') return { cls: 'tag-file', label: 'Local' };
    if (item.kind === 'offline' || item.offline) return { cls: 'tag-offline', label: 'Offline' };
    if (item.type === 'hls') return { cls: 'tag-hls', label: 'HLS' };
    if (item.type === 'dash') return { cls: 'tag-dash', label: 'DASH' };
    if (item.type === 'progressive') return { cls: 'tag-mp4', label: 'File' };
    return { cls: '', label: 'URL' };
  },

  render() {
    const list = $('#playlistList');
    list.textContent = '';
    $('#playlistCount').textContent = String(this.items.length);
    $('#playlistEmpty').hidden = this.items.length > 0;

    this.items.forEach((item, i) => {
      const tag = this.tagFor(item);
      const li = el('li', {
        class: `item${item.id === this.currentId ? ' is-current' : ''}`,
        dataset: { id: item.id },
        draggable: 'true',
      },
        el('span', { class: 'item-index', text: String(i + 1) }),
        el('button', { class: 'item-main', type: 'button', 'data-action': 'play', title: item.kind === 'file' ? item.title : item.url },
          el('span', { class: 'item-title', text: item.title }),
          el('span', { class: 'item-sub' },
            tag.label ? el('span', { class: `tag ${tag.cls}`, text: tag.label }) : null,
            el('span', { text: item.kind === 'file' ? 'on this device' : (hostFromUrl(item.url) || 'url') }),
            item.duration ? el('span', { text: '· ' + fmtTime(item.duration) }) : null,
          ),
        ),
        el('div', { class: 'item-actions' },
          el('button', { class: 'icon-btn', type: 'button', 'data-action': 'up', 'aria-label': `Move ${item.title} up`, title: 'Move up' }, icon('i-up')),
          el('button', { class: 'icon-btn', type: 'button', 'data-action': 'down', 'aria-label': `Move ${item.title} down`, title: 'Move down' }, icon('i-down')),
          el('button', { class: 'icon-btn danger', type: 'button', 'data-action': 'remove', 'aria-label': `Remove ${item.title}`, title: 'Remove' }, icon('i-close')),
        ),
      );
      list.append(li);
    });
  },
};

/* =====================================================================
 * 13. OFFLINE — downloads through the service worker + Cache API
 * ===================================================================*/

const Offline = {
  records: [],
  active: null,          // { id, title, received, total }
  swReady: false,

  async init() {
    this.swReady = hasServiceWorker();
    await this.refresh({ silent: true });
    $('#btnDownloadCancel').addEventListener('click', () => this.cancel());
    $('#btnRefreshDownloads').addEventListener('click', () => this.refresh());
    $('#btnPurgeDownloads').addEventListener('click', () => this.purgeAll());
    $('#downloadsList').addEventListener('click', (e) => {
      const li = e.target.closest('.item');
      if (!li) return;
      const id = li.dataset.id;
      const action = e.target.closest('[data-action]')?.dataset.action || 'play';
      if (action === 'play') this.play(id);
      else if (action === 'queue') this.queue(id);
      else if (action === 'delete') this.remove(id);
    });
  },

  /* ---------- service worker messaging ---------- */

  async controller() {
    if (!hasServiceWorker()) return null;
    if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller;
    const reg = await navigator.serviceWorker.ready.catch(() => null);
    return reg?.active || null;
  },

  /** Request/response helper (the SW always replies with {ok, ...}). */
  async send(type, payload = {}, timeout = 20000) {
    const sw = await this.controller();
    if (!sw) return { ok: false, error: 'no-service-worker' };
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => resolve({ ok: false, error: 'timeout' }), timeout);
      channel.port1.onmessage = (event) => { clearTimeout(timer); resolve(event.data || { ok: false }); };
      try { sw.postMessage({ type, ...payload }, [channel.port2]); }
      catch (err) { clearTimeout(timer); resolve({ ok: false, error: String(err) }); }
    });
  },

  /** Broadcast listener: progress + completion events from the SW. */
  handleServiceWorkerMessage(event) {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'download-progress') Offline.onProgress(data);
    else if (data.type === 'download-complete') Offline.onComplete(data);
    else if (data.type === 'download-error') Offline.onError(data);
  },

  /* ---------- downloads ---------- */

  /** Download the item that is playing right now (or explain why we can't). */
  async downloadCurrent() {
    const item = Player.current;
    if (!item) { Toast.warn('Load a video first'); return; }
    if (item.kind === 'file') {
      Toast.show('Local files are already available offline.', 'info');
      return;
    }
    if (item.offline) { Toast.show('This video is already stored offline.', 'info'); return; }

    await this.refresh({ silent: true });
    const already = this.records.find((rec) => rec.url === item.url);
    if (already) {
      item.offline = true;
      UI.renderOfflineBadge(true);
      Toast.ok(`Already stored offline: ${already.title}`);
      return;
    }
    await this.download(item);
  },

  async download(item) {
    if (!hasServiceWorker()) {
      Toast.err('Offline downloads need a service worker — serve the app over http(s).');
      return;
    }
    if (!navigator.onLine) { Toast.warn('You are offline — connect first to download.'); return; }
    if (this.active) { Toast.warn('A download is already running.'); return; }

    const type = item.type || detectType(item.url, 'progressive');

    // 1) Ask the service worker to analyse the source (size estimate for streams)
    Toast.show('Preparing download…', 'info', 2000);
    const info = await this.send('analyze', { url: item.url, kind: type }, 45000);
    if (!info?.ok && type !== 'progressive') {
      // Analysis failures for HLS/DASH are fatal — we cannot enumerate segments.
      Toast.err('Could not analyse stream: ' + (info?.error || 'unknown error'));
      return;
    }

    // 2) Confirm large downloads
    if (info?.bytes > 200 * 1024 * 1024) {
      const ok = await confirmDialog('Large download',
        `“${item.title}” looks like about ${fmtBytes(info.bytes)}${info.files ? ` across ${info.files} requests` : ''}. Store it on this device for offline playback?`,
        'Download');
      if (!ok) return;
    }

    // 3) Kick off the download in the service worker
    const started = await this.send('download', {
      url: item.url, kind: type, title: item.title, expect: info?.bytes || 0, files: info?.files || 0,
    }, 30000);

    if (!started?.ok) {
      const map = {
        'no-service-worker': 'Offline storage needs the service worker — run the app from a local server over http(s).',
        'cors': 'This server does not allow cross-origin downloads (CORS). Try a source that sends Access-Control-Allow-Origin.',
        'live': 'Live streams cannot be stored offline.',
        timeout: 'The download request timed out. Is the service worker registered?',
      };
      Toast.err(map[started?.error] || `Download failed: ${started?.error || 'unknown error'}`);
      return;
    }

    this.active = {
      id: started.id,
      title: item.title,
      received: 0,
      total: info?.bytes || 0,
      filesDone: 0,
      filesTotal: info?.files || 0,
    };
    this.renderDownloadBar();
    Toast.show(`Downloading “${item.title}”…`, 'info', 2600);
  },

  cancel() {
    if (!this.active) return;
    this.send('download-cancel', { id: this.active.id }, 4000);
    Toast.warn('Download cancelled');
    this.active = null;
    $('#downloadBar').hidden = true;
  },

  onProgress(data) {
    if (!this.active || data.id !== this.active.id) {
      // A download started from another tab — still show it.
      this.active = { id: data.id, title: data.title || 'Video', received: 0, total: 0 };
    }
    this.active.received = data.received || 0;
    if (data.total) this.active.total = data.total;
    this.active.filesDone = data.filesDone || 0;
    this.active.filesTotal = data.filesTotal || 0;
    this.renderDownloadBar();
  },

  async onComplete(data) {
    if (this.active?.id === data.id) {
      this.active = null;
      $('#downloadBar').hidden = true;
    }
    Toast.ok(`“${data.title || 'Video'}” is available offline (${fmtBytes(data.bytes)})`, 5000);
    if (Player.current && data.url === Player.current.url) {
      Player.current.offline = true;
      UI.renderOfflineBadge(true);
    }
    await this.refresh();
  },

  onError(data) {
    if (this.active?.id === data.id) {
      this.active = null;
      $('#downloadBar').hidden = true;
    }
    Toast.err(`Download failed: ${data.error || 'unknown error'}`, 6000);
  },

  renderDownloadBar() {
    const bar = $('#downloadBar');
    if (!this.active) { bar.hidden = true; return; }
    bar.hidden = false;
    const { received = 0, total = 0, title, filesDone = 0, filesTotal = 0 } = this.active;

    // Prefer byte progress; fall back to "file x of y" for streams of unknown size.
    let pct = total ? clamp((received / total) * 100, 0, 100) : 0;
    if (!total && filesTotal) pct = clamp((filesDone / filesTotal) * 100, 0, 100);

    let detail;
    if (total) detail = `${fmtBytes(received)} of ${fmtBytes(total)}`;
    else if (filesTotal) detail = `${filesDone} / ${filesTotal} files · ${fmtBytes(received)}`;
    else if (received) detail = fmtBytes(received);
    else detail = 'starting…';

    $('#downloadName').textContent = `${title} — ${detail}`;
    $('#downloadFill').style.width = `${pct}%`;
    $('#downloadPct').textContent = pct ? `${Math.round(pct)}%` : '…';
  },

  /* ---------- library ---------- */

  async refresh({ silent = false } = {}) {
    const res = await this.send('list-downloads', {}, 8000);
    if (!res?.ok) {
      if (!silent && res?.error && res.error !== 'no-service-worker') console.warn('[offline] list failed', res.error);
      this.records = [];
    } else {
      this.records = res.items || [];
    }
    this.render();
    this.renderStorageNote();
    return this.records;
  },

  render() {
    const list = $('#downloadsList');
    list.textContent = '';
    $('#downloadsCount').textContent = String(this.records.length);
    $('#downloadsEmpty').hidden = this.records.length > 0;

    this.records.forEach((rec) => {
      const li = el('li', { class: 'item', dataset: { id: rec.id } },
        el('span', { class: 'item-index' }, icon('i-check')),
        el('button', { class: 'item-main', type: 'button', 'data-action': 'play', title: rec.url },
          el('span', { class: 'item-title', text: rec.title }),
          el('span', { class: 'item-sub' },
            el('span', { class: `tag ${rec.kind === 'progressive' ? 'tag-file' : 'tag-hls'}`, text: rec.kind === 'progressive' ? 'File' : rec.kind.toUpperCase() }),
            el('span', { text: fmtBytes(rec.bytes) }),
            rec.date ? el('span', { text: '· ' + new Date(rec.date).toLocaleDateString() }) : null,
          ),
        ),
        el('div', { class: 'item-actions' },
          el('button', { class: 'icon-btn', type: 'button', 'data-action': 'queue', 'aria-label': `Add ${rec.title} to playlist`, title: 'Add to playlist' }, icon('i-plus')),
          el('button', { class: 'icon-btn danger', type: 'button', 'data-action': 'delete', 'aria-label': `Delete ${rec.title}`, title: 'Delete from device' }, icon('i-trash')),
        ),
      );
      list.append(li);
    });
  },

  async renderStorageNote() {
    try {
      if (navigator.storage?.estimate) {
        const { usage = 0, quota = 0 } = await navigator.storage.estimate();
        const text = quota
          ? `Browser storage in use: ${fmtBytes(usage)} of ~${fmtBytes(quota)} available to this origin.`
          : '';
        $('#storageNote').textContent = text;
        $('#quotaLabel').textContent = text ? `Storage: ${fmtBytes(usage)} / ${fmtBytes(quota)}` : '';
      }
      // Ask once per session for persistent storage so the browser does not
      // evict downloads when the device runs low on space.
      if (!this._askedPersist && navigator.storage?.persist) {
        this._askedPersist = true;
        const persisted = await navigator.storage.persisted?.();
        if (!persisted && this.records.length) {
          const granted = await navigator.storage.persist();
          if (granted) Toast.show('Storage marked as persistent — downloads are safer.', 'ok', 3200);
        }
      }
    } catch (err) { console.warn('[offline] storage estimate failed', err); }
  },

  /** Play a downloaded item (works with no network). */
  async play(id) {
    const rec = this.records.find((r) => r.id === id);
    if (!rec) return;
    const item = {
      id: 'off-' + rec.id,
      kind: 'offline',
      title: rec.title,
      url: rec.playUrl,
      type: rec.kind,
      offline: true,
      bitrate: rec.bitrate,
    };
    // Replace an identical playlist entry with the offline one when present.
    const existing = Playlist.items.find((it) => it.url === item.url);
    if (existing) {
      existing.offline = true;
      if (item.url !== rec.url) existing.originalUrl = existing.originalUrl || rec.url;
      Playlist.play(existing.id);
    } else {
      Playlist.add(item, { play: true, silent: true });
    }
    Shell.closePanel();
  },

  queue(id) {
    const rec = this.records.find((r) => r.id === id);
    if (!rec) return;
    Playlist.add({ id: 'off-' + rec.id, kind: 'offline', title: rec.title, url: rec.playUrl, type: rec.kind, offline: true });
  },

  async remove(id) {
    const rec = this.records.find((r) => r.id === id);
    if (!rec) return;
    if (!await confirmDialog('Delete offline copy?', `“${rec.title}” (${fmtBytes(rec.bytes)}) will be removed from this device.`, 'Delete')) return;
    const res = await this.send('delete-download', { id }, 8000);
    if (res?.ok) {
      // Point playlist entries back at the remote URL instead of a synthetic one.
      Playlist.items.forEach((it) => {
        if (it.url === rec.playUrl || it.url === rec.url) {
          it.offline = false;
          if (it.originalUrl) it.url = it.originalUrl;
        }
      });
      Playlist.save(); Playlist.render();
      if (Player.current && (Player.current.url === rec.playUrl || Player.current.url === rec.url)) {
        UI.renderOfflineBadge(false);
      }
      Toast.ok('Deleted');
      await this.refresh();
    } else Toast.err('Delete failed: ' + (res?.error || 'unknown'));
  },

  async purgeAll() {
    if (!this.records.length) { Toast.show('Nothing stored offline yet', 'info'); return; }
    if (!await confirmDialog('Delete all offline videos?', `${this.records.length} stored video(s) will be removed from this device.`, 'Delete all')) return;
    const res = await this.send('clear-downloads', {}, 15000);
    if (res?.ok) { Toast.ok('All offline videos deleted'); await this.refresh(); }
    else Toast.err('Delete failed: ' + (res?.error || 'unknown'));
  },
};

/* =====================================================================
 * 14. SUBTITLES — external .vtt/.srt tracks, toggling, delay
 * ===================================================================*/

const Subtitles = {
  tracks: [],        // { id, label, lang, blobUrl, kind:'external'|'sidecar', text }
  activeId: null,       // selected external/sidecar track
  activeEmbedded: 0,    // selected in-band (embedded) track index
  embeddedMode: false,  // true while an in-band track is selected
  delay: 0,
  delayOriginals: new WeakMap(),
  detectedFor: null,

  init() {
    $('#subtitleToggle').addEventListener('change', (e) => this.setEnabled(e.target.checked));
    $('#btnSubtitleLoad').addEventListener('click', (e) => { e.stopPropagation(); $('#subtitleInput').click(); });
    $('#btnSubtitleClose').addEventListener('click', (e) => { e.stopPropagation(); this.closeSheet(); });
    $('#btnSubtitleDelayMinus').addEventListener('click', () => this.setDelay(this.delay - 0.5));
    $('#btnSubtitleDelayPlus').addEventListener('click', () => this.setDelay(this.delay + 0.5));
    $('#subtitleInput').addEventListener('change', (e) => {
      this.addFiles(Array.from(e.target.files || []));
      e.target.value = '';
    });

    // Embedded / in-band tracks (HLS, MP4 with soft subs)
    Player.video.textTracks.addEventListener?.('addtrack', () => this.render());
    Player.video.addEventListener('loadedmetadata', () => this.enableAutoTracks());

    this.setDelay(Settings.get('subtitleDelay') || 0, { silent: true });
    $('#subtitleToggle').checked = Settings.get('captionsEnabled') !== false;
  },

  /* ---------- sheet ---------- */

  toggleSheet(anchor) {
    const sheet = $('#subtitleSheet');
    if (!sheet.hidden) { this.closeSheet(); return; }
    sheet.hidden = false;
    $('#btnCaptions').setAttribute('aria-expanded', 'true');
    Menus.open = sheet;
    sheet.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  },

  closeSheet() {
    $('#subtitleSheet').hidden = true;
    $('#btnCaptions').setAttribute('aria-expanded', 'false');
    if (Menus.open === $('#subtitleSheet')) Menus.open = null;
  },

  /* ---------- track management ---------- */

  async addFiles(files) {
    let added = 0;
    for (const file of files) {
      const raw = await file.text();
      const label = file.name.replace(/\.[^.]+$/, '');
      const text = /^\s*WEBVTT/.test(raw) ? raw : this.srtToVtt(raw);
      this.tracks.push({
        id: uid(),
        label,
        lang: '',
        kind: 'external',
        text,
        blobUrl: URL.createObjectURL(new Blob([text], { type: 'text/vtt' })),
      });
      added++;
    }
    if (added) {
      Toast.ok(`Loaded ${added} subtitle file${added === 1 ? '' : 's'}`);
      this.attachItemTracks(Player.current, { keepExisting: true });
      this.select(this.tracks[this.tracks.length - 1].id);
      this.setEnabled(true);
    }
  },

  /**
   * Add a subtitle track from raw text.
   * Used for drag & dropped .vtt/.srt files and for subtitles downloaded from
   * the online search (`kind: 'online'`). Passing text that is already WebVTT
   * is fine — SRT is detected and converted on the fly.
   *
   * @param {string} label   display name (must be unique)
   * @param {string} rawText .srt or .vtt contents
   * @param {{lang?:string, kind?:'external'|'sidecar'|'online', source?:string}} [opts]
   * @returns {object|null} the created track, or null when the label exists
   */
  addFromText(label, rawText, { lang = '', kind = 'external', source = '' } = {}) {
    const text = /^\s*WEBVTT/.test(rawText) ? rawText : this.srtToVtt(rawText);
    if (this.tracks.some((t) => t.label === label)) return null;
    const track = {
      id: uid(),
      label,
      lang,
      kind,
      source,
      text,
      blobUrl: URL.createObjectURL(new Blob([text], { type: 'text/vtt' })),
    };
    this.tracks.push(track);
    this.syncTrackElements();
    this.render();
    this.select(track.id);
    return track;
  },

  /** Minimal but robust SRT → WebVTT conversion. */
  srtToVtt(srt) {
    const body = String(srt)
      .replace(/^\uFEFF/, '')
      .replace(/\r\n|\r/g, '\n')
      .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    return `WEBVTT\n\n${body}\n`;
  },

  /** Attach item-provided subtitle files (sidecars found by the folder picker). */
  attachItemTracks(item, { keepExisting = false } = {}) {
    if (!keepExisting) this.tracks = [];
    if (item?.subtitles?.length) {
      item.subtitles.forEach((sub) => {
        if (this.tracks.some((t) => t.label === sub.label)) return;
        this.tracks.push({ id: uid(), label: sub.label, kind: 'sidecar', text: sub.text, blobUrl: URL.createObjectURL(new Blob([sub.text], { type: 'text/vtt' })) });
      });
    }
    this.syncTrackElements();
    this.render();
    this.applyDelay();
  },

  /** Rebuild the <track> children of the video element from this.tracks. */
  syncTrackElements() {
    const v = Player.video;
    $$('track[data-managed]', v).forEach((t) => t.remove());
    this.tracks.forEach((t) => {
      const track = el('track', {
        kind: 'subtitles',
        label: t.label,
        srclang: t.lang || 'und',
        src: t.blobUrl,
        'data-managed': 'true',
        'data-id': t.id,
      });
      track.addEventListener('load', () => this.applyDelay());
      v.append(track);
      t.element = track;
    });
  },

  /**
   * Look for sidecar subtitles:
   *  • local files → item.subtitles (filled by the folder picker)
   *  • remote URLs → try <video>.vtt / <video>.srt next to the media file
   */
  async detectSidecars(item) {
    if (!item || item.kind === 'file') return;
    if (this.detectedFor === item.id) return;
    this.detectedFor = item.id;
    if (!navigator.onLine) return;
    if (!/^https?:/i.test(item.url || '')) return;

    const base = item.url.replace(/[?#].*$/, '').replace(/\.[a-z0-9]+$/i, '');
    const candidates = [base + '.vtt', base + '.srt'];
    for (const url of candidates) {
      try {
        const res = await fetch(url, { mode: 'cors', signal: AbortSignal.timeout?.(6000) });
        if (!res.ok) continue;
        const raw = await res.text();
        if (!/WEBVTT|-->/.test(raw)) continue;
        const text = /^\s*WEBVTT/.test(raw) ? raw : this.srtToVtt(raw);
        const label = nameFromUrl(url);
        if (this.tracks.some((t) => t.label === label)) return;
        this.tracks.push({ id: uid(), label, kind: 'sidecar', text, blobUrl: URL.createObjectURL(new Blob([text], { type: 'text/vtt' })) });
        this.syncTrackElements(); this.render();
        Toast.show(`Subtitles found: ${label}`, 'ok', 2500);
        this.setEnabled(true);
        return;
      } catch { /* not found — that's fine */ }
    }
  },

  onSourceChanged() {
    this.detectedFor = null;
    this.tracks.forEach((t) => t.blobUrl && URL.revokeObjectURL(t.blobUrl));
    this.tracks = [];
    this.activeId = null;
    this.activeEmbedded = 0;
    this.embeddedMode = false;
    this.render();
  },

  /**
   * Turn subtitles on/off.
   * @param {boolean} enabled
   * @param {{notify?:boolean}} [opts] notify=false is used for automatic
   *        enablement (loading a video must not spam toasts).
   */
  setEnabled(enabled, { notify = true } = {}) {
    Settings.set('captionsEnabled', !!enabled);
    const v = Player.video;
    // Managed (external / sidecar / online) tracks: show exactly the selected one.
    this.tracks.forEach((t) => {
      if (!t.element?.track) return;
      t.element.track.mode = enabled && !this.embeddedMode && t.id === this.activeId ? 'showing' : 'disabled';
    });
    // In-band tracks (HLS, MP4 soft subs): show only the selected index.
    let seen = -1;
    for (let i = 0; i < v.textTracks.length; i++) {
      const tt = v.textTracks[i];
      if (tt.kind !== 'subtitles' && tt.kind !== 'captions') continue;
      seen++;
      tt.mode = enabled && this.embeddedMode && seen === this.activeEmbedded ? 'showing' : 'disabled';
    }
    const hasTracks = this.tracks.length > 0 || this.countEmbedded() > 0;
    document.body.classList.toggle('captions-on', !!enabled && hasTracks);
    $('#subtitleToggle').checked = !!enabled;

    if (!notify) return;
    if (hasTracks) Toast.show(enabled ? 'Subtitles on' : 'Subtitles off', 'info', 1100);
    else if (enabled) Toast.warn('No subtitle tracks loaded — use the CC panel to load a .vtt/.srt file or search online (Shift+C).');
  },

  /** Number of in-band (embedded) subtitle tracks exposed by the media element. */
  countEmbedded() {
    let n = 0;
    const v = Player.video;
    for (let i = 0; i < v.textTracks.length; i++) {
      const kind = v.textTracks[i].kind;
      if (kind === 'subtitles' || kind === 'captions') n++;
    }
    return n;
  },

  toggleEnabled() { this.setEnabled(!Settings.get('captionsEnabled')); },

  select(id) {
    this.activeId = id;
    this.embeddedMode = false;
    this.setEnabled(true);
    this.render();
  },

  selectEmbedded(index) {
    this.activeId = null;
    this.embeddedMode = true;
    this.activeEmbedded = index;
    this.setEnabled(true);
    this.render();
  },

  /** Shift every cue by `seconds` (positive = later). */
  setDelay(seconds, { silent = false } = {}) {
    this.delay = Math.round(clamp(seconds, -60, 60) * 10) / 10;
    Settings.set('subtitleDelay', this.delay);
    $('#subtitleDelayOut').textContent = `${this.delay > 0 ? '+' : ''}${this.delay.toFixed(1)}s`;
    this.applyDelay();
    if (!silent) Toast.show(`Subtitle delay ${this.delay > 0 ? '+' : ''}${this.delay.toFixed(1)}s`, 'info', 1400, 'subdelay');
  },

  applyDelay() {
    const tracks = [];
    if (this.activeId) {
      const t = this.tracks.find((x) => x.id === this.activeId);
      if (t?.element?.track) tracks.push(t.element.track);
    }
    for (let i = 0; i < Player.video.textTracks.length; i++) tracks.push(Player.video.textTracks[i]);

    tracks.forEach((track) => {
      const cues = track.cues;
      if (!cues) return;
      for (let i = 0; i < cues.length; i++) {
        const cue = cues[i];
        if (!this.delayOriginals.has(cue)) this.delayOriginals.set(cue, { start: cue.startTime, end: cue.endTime });
        const original = this.delayOriginals.get(cue);
        cue.startTime = Math.max(0, original.start + this.delay);
        cue.endTime = Math.max(0.05, original.end + this.delay);
      }
    });
  },

  /** Auto-select the first available track (respecting the saved preference). */
  enableAutoTracks() {
    this.applyDelay();
    if (Settings.get('captionsEnabled') === false) {
      this.setEnabled(false);
      return;
    }
    const firstManaged = this.tracks[0];
    if (firstManaged && !this.activeId && !this.embeddedMode) {
      this.activeId = firstManaged.id;
      this.embeddedMode = false;
    }
    this.setEnabled(true, { notify: false });
  },

  render() {
    const list = $('#subtitleTracks');
    list.textContent = '';

    // In-band tracks exposed by the media element / hls.js
    const embedded = [];
    for (let i = 0; i < Player.video.textTracks.length; i++) {
      const tt = Player.video.textTracks[i];
      if (tt.kind === 'subtitles' || tt.kind === 'captions') embedded.push(tt);
    }

    if (!this.tracks.length && !embedded.length) {
      list.append(el('li', {}, el('span', { class: 'muted', text: 'No subtitle tracks for this video yet.' })));
    }

    this.tracks.forEach((t) => {
      const id = `track-${t.id}`;
      list.append(el('li', {},
        el('label', { for: id },
          el('input', {
            type: 'radio', name: 'subtitle-track', id, value: t.id,
            checked: t.id === this.activeId ? 'checked' : null,
            onchange: () => this.select(t.id),
          }),
          el('span', { text: t.label || 'Untitled' }),
          el('span', { class: 'muted', text: t.kind === 'sidecar' ? '· sidecar' : t.kind === 'online' ? `· ${t.source || 'online'}` : '' }),
        ),
      ));
    });

    embedded.forEach((tt, i) => {
      const id = `embedded-${i}`;
      list.append(el('li', {},
        el('label', { for: id },
          el('input', {
            type: 'radio', name: 'subtitle-track', id, value: 'embedded-' + i,
            checked: this.embeddedMode && this.activeEmbedded === i ? 'checked' : null,
            onchange: () => this.selectEmbedded(i),
          }),
          el('span', { text: tt.label || tt.language || `Embedded ${i + 1}` }),
          el('span', { class: 'muted', text: '· embedded' }),
        ),
      ));
    });

    // "Off" option
    if (this.tracks.length || embedded.length) {
      list.append(el('li', {},
        el('label', { for: 'track-off' },
          el('input', { type: 'radio', name: 'subtitle-track', id: 'track-off', checked: !Settings.get('captionsEnabled') ? 'checked' : null, onchange: () => this.setEnabled(false) }),
          el('span', { text: 'Off' }),
        ),
      ));
    }
  },
};

/* =====================================================================
 * 15. ONLINE SUBTITLE SEARCH — find, download and load subtitles by name
 * ---------------------------------------------------------------------
 * Opened from the CC panel ("Search online…") or with Shift+C. The name
 * of the current video is filled in for you; typing another name (or a
 * show + season/episode) searches that instead. Results load with one
 * click, or can be saved to disk. Everything that is downloaded is
 * converted to WebVTT before it is attached to the <video> element.
 *
 * Sources, merged into one ranked list:
 *   • OpenSubtitles     — legacy REST search (rest.opensubtitles.org)
 *   • OpenSubtitles     — via the Stremio addon (IMDb based, CORS friendly)
 *   • OpenSubtitles.com — official API, only when an API key is configured
 *
 * Browsers refuse cross-origin reads when a host sends no CORS headers,
 * so blocked requests are retried through public CORS proxies when the
 * "Retry blocked requests" option is enabled (on by default).
 * ===================================================================*/

/** Languages offered by the online subtitle search (ISO 639-1 + 639-2/B). */
const SUB_LANGS = [
  { code: 'en', iso3: 'eng', name: 'English' },
  { code: 'es', iso3: 'spa', name: 'Spanish' },
  { code: 'pt', iso3: 'por', name: 'Portuguese' },
  { code: 'pt-BR', iso3: 'pob', name: 'Portuguese (Brazil)' },
  { code: 'fr', iso3: 'fre', name: 'French' },
  { code: 'de', iso3: 'ger', name: 'German' },
  { code: 'it', iso3: 'ita', name: 'Italian' },
  { code: 'nl', iso3: 'nld', name: 'Dutch' },
  { code: 'pl', iso3: 'pol', name: 'Polish' },
  { code: 'ru', iso3: 'rus', name: 'Russian' },
  { code: 'uk', iso3: 'ukr', name: 'Ukrainian' },
  { code: 'tr', iso3: 'tur', name: 'Turkish' },
  { code: 'ar', iso3: 'ara', name: 'Arabic' },
  { code: 'he', iso3: 'heb', name: 'Hebrew' },
  { code: 'el', iso3: 'ell', name: 'Greek' },
  { code: 'cs', iso3: 'cze', name: 'Czech' },
  { code: 'sk', iso3: 'slo', name: 'Slovak' },
  { code: 'hu', iso3: 'hun', name: 'Hungarian' },
  { code: 'ro', iso3: 'rum', name: 'Romanian' },
  { code: 'bg', iso3: 'bul', name: 'Bulgarian' },
  { code: 'hr', iso3: 'hrv', name: 'Croatian' },
  { code: 'sr', iso3: 'srp', name: 'Serbian' },
  { code: 'sl', iso3: 'slv', name: 'Slovenian' },
  { code: 'sv', iso3: 'swe', name: 'Swedish' },
  { code: 'no', iso3: 'nor', name: 'Norwegian' },
  { code: 'da', iso3: 'dan', name: 'Danish' },
  { code: 'fi', iso3: 'fin', name: 'Finnish' },
  { code: 'is', iso3: 'ice', name: 'Icelandic' },
  { code: 'et', iso3: 'est', name: 'Estonian' },
  { code: 'lv', iso3: 'lav', name: 'Latvian' },
  { code: 'lt', iso3: 'lit', name: 'Lithuanian' },
  { code: 'hi', iso3: 'hin', name: 'Hindi' },
  { code: 'bn', iso3: 'ben', name: 'Bengali' },
  { code: 'ta', iso3: 'tam', name: 'Tamil' },
  { code: 'te', iso3: 'tel', name: 'Telugu' },
  { code: 'ml', iso3: 'mal', name: 'Malayalam' },
  { code: 'ur', iso3: 'urd', name: 'Urdu' },
  { code: 'ne', iso3: 'nep', name: 'Nepali' },
  { code: 'si', iso3: 'sin', name: 'Sinhala' },
  { code: 'zh', iso3: 'chi', name: 'Chinese (simplified)' },
  { code: 'zh-TW', iso3: 'cht', name: 'Chinese (traditional)' },
  { code: 'ja', iso3: 'jpn', name: 'Japanese' },
  { code: 'ko', iso3: 'kor', name: 'Korean' },
  { code: 'vi', iso3: 'vie', name: 'Vietnamese' },
  { code: 'th', iso3: 'tha', name: 'Thai' },
  { code: 'id', iso3: 'ind', name: 'Indonesian' },
  { code: 'ms', iso3: 'may', name: 'Malay' },
  { code: 'fil', iso3: 'fil', name: 'Filipino' },
  { code: 'fa', iso3: 'per', name: 'Persian' },
  { code: 'ca', iso3: 'cat', name: 'Catalan' },
  { code: 'sq', iso3: 'alb', name: 'Albanian' },
  { code: 'mk', iso3: 'mac', name: 'Macedonian' },
  { code: 'ka', iso3: 'geo', name: 'Georgian' },
  { code: 'hy', iso3: 'arm', name: 'Armenian' },
  { code: 'az', iso3: 'aze', name: 'Azerbaijani' },
  { code: 'kk', iso3: 'kaz', name: 'Kazakh' },
  { code: 'uz', iso3: 'uzb', name: 'Uzbek' },
  { code: 'af', iso3: 'afr', name: 'Afrikaans' },
  { code: 'sw', iso3: 'swa', name: 'Swahili' },
  { code: 'my', iso3: 'bur', name: 'Burmese' },
  { code: 'km', iso3: 'khm', name: 'Khmer' },
  { code: 'mn', iso3: 'mon', name: 'Mongolian' },
];

/** Public CORS proxies, tried in order when a source refuses the browser. */
const SUB_PROXIES = [
  { label: 'allorigins', wrap: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` },
  { label: 'codetabs', wrap: (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}` },
  { label: 'corsproxy.io', wrap: (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}` },
];

/** 8298 → "8.3k" (used for the download counters in the result list). */
function fmtCount(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(v);
}

/**
 * Split a file name into a searchable title + season/episode/year.
 * "Show.S02E04.1080p.WEB-DL.x264-GRP.mkv" → { title: 'Show', season: '2', episode: '4', year: '' }
 * "Big.Buck.Bunny.2008.720p.mp4"          → { title: 'Big Buck Bunny', season: '', episode: '', year: '2008' }
 */
function parseMediaName(raw) {
  let name = String(raw || '').trim();
  try { name = decodeURIComponent(name); } catch { /* keep as-is */ }
  name = name.replace(/[?#].*$/, '').replace(/\.[a-z0-9]{2,4}$/i, '');

  let season = '', episode = '';
  const sxe = name.match(/\bS(\d{1,2})[\s._-]?E(\d{1,3})\b/i);
  const alt = name.match(/\b(\d{1,2})x(\d{2,3})\b/);
  const sOnly = name.match(/\bS(\d{1,2})\b/i);
  if (sxe) { season = String(+sxe[1]); episode = String(+sxe[2]); }
  else if (alt) { season = String(+alt[1]); episode = String(+alt[2]); }
  else if (sOnly) { season = String(+sOnly[1]); }

  // Cut the release tags off: quality, source, codec, audio, year…
  const cut = name.search(
    /\b(?:19|20)\d{2}\b|\b(?:480|576|720|1080|1440|2160|4320)p\b|\b(?:4k|uhd|hdr10?|dv|sdr|dvdrip|bdrip|brrip|webrip|web-dl|webdl|bluray|blu-ray|hdtv|remux|repack|proper|extended|imax|multi|dual|dubbed|subbed|x264|x265|h264|h265|hevc|av1|xvid|divx|aac|ac3|eac3|dts|ddp?5|atmos)\b/i
  );
  let title = cut > 0 ? name.slice(0, cut) : name;
  title = title
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/[._]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/[-–—:;,]+\s*$/, '')
    .trim();
  if (!title) title = name.replace(/[._]+/g, ' ').trim();
  return { title, season, episode, year: (name.match(/\b(19|20)\d{2}\b/) || [''])[0] };
}

/**
 * Small network helper for the online search: timeouts, gzip, text
 * decoding and transparent retries through CORS proxies.
 */
const Net = {
  /** AbortSignal + timer pair; always call `done()` when the request ends. */
  timeout(ms) {
    if (typeof AbortController !== 'function') return { signal: undefined, done() { } };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), ms);
    return { signal: ctrl.signal, done: () => clearTimeout(timer) };
  },

  /** Fetch `url` as bytes. Failures carry a `code`: 'http' | 'timeout' | 'blocked'. */
  async bytes(url, { timeout = 15000, headers = null } = {}) {
    const { signal, done } = this.timeout(timeout);
    try {
      const res = await fetch(url, {
        mode: 'cors', credentials: 'omit', redirect: 'follow', referrerPolicy: 'no-referrer',
        signal, ...(headers ? { headers } : {}),
      });
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { code: 'http', status: res.status });
      return new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      if (!err?.code) err.code = signal?.aborted ? 'timeout' : 'blocked';
      throw err;
    } finally { done(); }
  },

  /** Fetch text, transparently unpacking `.gz` subtitle files. */
  async text(url, { encoding = '', timeout = 15000, headers = null } = {}) {
    const raw = await this.bytes(url, { timeout, headers });
    const data = this.isGzip(raw) ? await this.ungzip(raw) : raw;
    return this.decode(data, encoding);
  },

  isGzip(bytes) { return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b; },

  async ungzip(bytes) {
    if (typeof DecompressionStream !== 'function') {
      throw Object.assign(new Error('gzip is not supported here'), { code: 'gzip' });
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  },

  /** Decode bytes using the encoding reported by the source (fallbacks included). */
  decode(bytes, encoding = '') {
    const attempt = (label) => {
      try { return new TextDecoder(label).decode(bytes); } catch { return null; }
    };
    const map = {
      ASCII: 'utf-8', 'UTF-8': 'utf-8', UTF8: 'utf-8', 'UTF-16': 'utf-16le',
      'ISO-8859-1': 'iso-8859-1', 'ISO-8859-15': 'iso-8859-15', 'ISO-8859-2': 'iso-8859-2',
      CP1250: 'windows-1250', CP1251: 'windows-1251', CP1252: 'windows-1252',
      CP1253: 'windows-1253', CP1254: 'windows-1254', CP1255: 'windows-1255',
      CP1256: 'windows-1256', CP1257: 'windows-1257', CP1258: 'windows-1258',
      'KOI8-R': 'koi8-r', 'BIG5': 'big5', 'GB18030': 'gb18030',
    };
    const key = String(encoding || '').toUpperCase().replace(/[^A-Z0-9-]/g, '');
    let out = attempt(map[key] || 'utf-8') ?? attempt('utf-8') ?? '';
    if (out.includes('\uFFFD')) {
      const retry = attempt('windows-1252');
      if (retry && !retry.includes('\uFFFD')) out = retry;
    }
    return out.replace(/^\uFEFF/, '');
  },

  /** Parse a JSON body, tolerating stray whitespace / error pages. */
  jsonFrom(text) {
    const trimmed = String(text || '').trim().replace(/^\)\]\}',?/, '');
    try { return JSON.parse(trimmed); }
    catch { throw Object.assign(new Error('unexpected response'), { code: 'parse' }); }
  },

  /**
   * Fetch the first of `urls` that answers → { text, url, via }.
   * Direct requests come first; when `proxy` is on, blocked requests are
   * retried through the public proxies (and an optional custom one).
   */
  async fetchText(urls, { encoding = '', proxy = false, timeout = 15000, headers = null } = {}) {
    const routes = [];
    if (proxy) {
      const custom = String(Settings.get('subSearchProxyUrl') || '').trim();
      if (custom) {
        routes.push({
          label: 'custom proxy',
          wrap: (u) => (custom.includes('{url}') ? custom.replace('{url}', encodeURIComponent(u)) : custom + u),
        });
      }
      routes.push(...SUB_PROXIES);
    }
    const failures = [];
    for (const url of urls) {
      if (!url) continue;
      try { return { text: await this.text(url, { encoding, timeout, headers }), url, via: '' }; }
      catch (err) { failures.push(err); }
      for (const route of routes) {
        try {
          // Proxies are slower than a direct hit — don't wait as long for them.
          const text = await this.text(route.wrap(url), { timeout: Math.min(10000, timeout), encoding });
          if (/^\s*(?:<!doctype|<html)/i.test(text)) throw Object.assign(new Error('proxy returned a page'), { code: 'proxy' });
          return { text, url, via: route.label };
        } catch (err) { failures.push(err); }
      }
    }
    const blocked = failures.some((e) => e?.code === 'blocked');
    const timedOut = failures.some((e) => e?.code === 'timeout');
    throw Object.assign(new Error('request failed'), {
      code: blocked ? 'cors' : timedOut ? 'timeout' : (failures[0]?.code || 'failed'),
      failures,
    });
  },

  async getJson(url, opts = {}) {
    return this.jsonFrom((await this.fetchText([url], opts)).text);
  },

  /** POST JSON (used for the OpenSubtitles.com download ticket). */
  async postJson(url, body, { timeout = 15000, headers = {} } = {}) {
    const { signal, done } = this.timeout(timeout);
    try {
      const res = await fetch(url, {
        method: 'POST', mode: 'cors', credentials: 'omit',
        headers, body: JSON.stringify(body), signal,
      });
      if (!res.ok) {
        throw Object.assign(new Error(`HTTP ${res.status}`), {
          code: res.status === 401 || res.status === 403 ? 'apikey' : 'http', status: res.status,
        });
      }
      return this.jsonFrom(await res.text());
    } catch (err) {
      if (!err?.code) err.code = signal?.aborted ? 'timeout' : 'blocked';
      throw err;
    } finally { done(); }
  },
};

/** Providers — every one returns the same result shape. */
const SubSources = {
  /** Human readable reason for a failed provider. */
  reason(err, proxy) {
    const code = err?.code;
    if (code === 'cors' || code === 'blocked') {
      return proxy ? 'unreachable' : 'blocked by CORS — enable “Retry blocked requests”';
    }
    if (code === 'http') return `server error (HTTP ${err.status || '?'})`;
    if (code === 'timeout') return 'timed out';
    if (code === 'parse') return 'unexpected response';
    if (code === 'noimdb') return 'no matching title in the IMDb index';
    if (code === 'needepisode') return 'TV show — add season & episode';
    if (code === 'apikey') return 'API key rejected';
    return 'unavailable';
  },

  /* ---- OpenSubtitles — legacy REST search --------------------------- */

  async openSubtitles({ query, lang, season, episode, proxy }) {
    const parts = ['search', `query-${encodeURIComponent(query)}`];
    if (lang?.iso3) parts.push(`sublanguageid-${lang.iso3}`);
    if (season) parts.push(`season-${Number(season)}`);
    if (episode) parts.push(`episode-${Number(episode)}`);
    const rows = await Net.getJson(`https://rest.opensubtitles.org/${parts.join('/')}`, { proxy, timeout: 15000 });
    if (!Array.isArray(rows)) return [];

    let list = rows;
    // When season/episode were given, prefer the rows that actually carry them.
    if (season && episode) {
      const tagged = rows.filter((r) => String(r.SeriesSeason || '0') !== '0');
      if (tagged.length) {
        list = tagged.filter((r) => String(r.SeriesSeason) === String(+season) && String(r.SeriesEpisode) === String(+episode));
      }
    }

    return list.slice(0, 80).map((row) => {
      const info = SubtitleSearch.langInfo(row.SubLanguageID || row.ISO639 || '');
      const fileId = String(row.IDSubtitleFile || '');
      const format = String(row.SubFormat || 'srt').toLowerCase();
      return {
        source: 'OpenSubtitles',
        title: row.SubFileName || row.MovieReleaseName || row.MovieName || '',
        lang: info?.code || '',
        langName: row.LanguageName || info?.name || '',
        format,
        usable: !/^(zip|rar|7z|sub)$/.test(format),   // .ass/.ssa still open fine, MicroDVD does not
        downloads: Number(row.SubDownloadsCnt) || 0,
        rating: Number(row.SubRating) || 0,
        hd: row.SubHD === '1',
        hi: row.SubHearingImpaired === '1',
        trusted: row.SubFromTrusted === '1' || /trusted|admin/i.test(row.UserRank || ''),
        encoding: row.SubEncoding || '',
        year: row.MovieYear && row.MovieYear !== '0' ? row.MovieYear : '',
        // subs5.strem.io serves the same file as UTF-8 text (browser friendly);
        // the official .gz link stays as a fallback for Net.
        url: fileId ? `https://subs5.strem.io/en/download/subencoding-stremio-utf8/src-api/file/${fileId}` : '',
        altUrl: row.SubDownloadLink || '',
      };
    });
  },

  /* ---- OpenSubtitles via the Stremio addon (IMDb based) ------------- */

  /**
   * Free-text name → IMDb id, using IMDb's public suggestion endpoint
   * (falling back to Stremio's Cinemeta catalogue).
   */
  async resolveImdb(query, { proxy = false, series = false } = {}) {
    const slug = String(query).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
    if (!slug) return null;
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const wanted = norm(query);
    const score = (rows) => {
      const items = rows.filter((it) => /^tt\d+$/.test(String(it.id || '')) && !/episode/i.test(it.qid || ''));
      if (!items.length) return null;
      const scored = items.map((it, i) => {
        const title = norm(it.l || it.name);
        let s = i;
        if (title === wanted) s -= 30;
        else if (title.startsWith(wanted) || wanted.startsWith(title)) s -= 10;
        if (/series/i.test(it.qid || '') === series) s -= 15;
        return { it, s };
      }).sort((a, b) => a.s - b.s);
      const best = scored[0].it;
      return { id: best.id, series: /series/i.test(best.qid || ''), title: best.l || best.name || '' };
    };

    try {
      const data = await Net.getJson(`https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(slug)}.json`, { proxy, timeout: 10000 });
      const match = score(Array.isArray(data?.d) ? data.d : []);
      if (match) return match;
    } catch (err) {
      if (err?.code === 'cors' || err?.code === 'blocked' || err?.code === 'timeout') throw err;
    }

    // Fallback: Stremio's Cinemeta catalogue search.
    const type = series ? 'series' : 'movie';
    const data = await Net.getJson(`https://v3-cinemeta.strem.io/catalog/${type}/top/search=${encodeURIComponent(query)}.json`, { proxy, timeout: 10000 });
    return score(Array.isArray(data?.metas) ? data.metas.map((m) => ({ id: m.imdb_id || m.id, l: m.name, qid: m.type === 'series' ? 'tvSeries' : 'movie' })) : []);
  },

  async stremio({ query, lang, season, episode, proxy }) {
    const match = await this.resolveImdb(query, { proxy, series: !!season });
    if (!match) throw Object.assign(new Error('no IMDb match'), { code: 'noimdb' });
    if (match.series && !season) throw Object.assign(new Error('needs season/episode'), { code: 'needepisode' });
    const path = match.series
      ? `series/${match.id}:${Number(season)}:${Number(episode || 1)}`
      : `movie/${match.id}`;
    const data = await Net.getJson(`https://opensubtitles-v3.strem.io/subtitles/${path}.json`, { proxy, timeout: 15000 });
    const rows = Array.isArray(data?.subtitles) ? data.subtitles : [];
    return rows
      .filter((row) => SubtitleSearch.langMatches(row.lang, lang))
      .slice(0, 80)
      .map((row) => {
        const info = SubtitleSearch.langInfo(row.lang);
        const name = row.subtitleFileName || row.movieReleaseName || match.title || query;
        return {
          source: 'OpenSubtitles (Stremio)',
          title: name,
          lang: info?.code || String(row.lang || '').toLowerCase(),
          langName: info?.name || row.lang || '',
          format: /\.vtt$/i.test(name) ? 'vtt' : 'srt',
          usable: true,
          downloads: 0,
          rating: 0,
          hd: !!row.hd,
          hi: /\b(hi|sdh)\b/i.test(name),
          trusted: !!row.fromTrusted,
          encoding: row.SubEncoding || '',
          year: '',
          url: row.url || '',
          altUrl: '',
        };
      })
      .filter((r) => r.url);
  },

  /* ---- OpenSubtitles.com — official API (needs a free API key) ------ */

  async openSubtitlesCom({ query, lang, season, episode, proxy, apiKey }) {
    if (!apiKey) return [];
    const params = new URLSearchParams({ query, order_by: 'download_count', order_direction: 'desc' });
    if (lang?.code) params.set('languages', lang.code);
    if (season) {
      params.set('season_number', String(Number(season)));
      params.set('episode_number', String(Number(episode || 1)));
      params.set('type', 'episode');
    } else {
      params.set('type', 'movie');
    }
    const data = await Net.getJson(`https://api.opensubtitles.com/api/v1/subtitles?${params.toString()}`, {
      proxy, timeout: 15000, headers: { 'Api-Key': apiKey, Accept: 'application/json' },
    });
    const rows = Array.isArray(data?.data) ? data.data : [];
    return rows.slice(0, 60).map((entry) => {
      const a = entry.attributes || {};
      const file = (a.files || [])[0] || {};
      const details = a.feature_details || {};
      const info = SubtitleSearch.langInfo(a.language);
      return {
        source: 'OpenSubtitles.com',
        title: file.file_name || details.title || a.release || query,
        lang: info?.code || String(a.language || '').toLowerCase(),
        langName: info?.name || a.language || '',
        format: /\.vtt$/i.test(file.file_name || '') ? 'vtt' : 'srt',
        usable: true,
        downloads: Number(a.download_count) || 0,
        rating: Number(a.ratings) || 0,
        hd: !!a.hd,
        hi: !!a.hearing_impaired,
        trusted: !!a.from_trusted,
        encoding: '',
        year: details.year || '',
        fileId: file.file_id || '',
        ticket: true,          // needs POST /download before a link exists
        url: '',
        altUrl: '',
      };
    }).filter((r) => r.fileId);
  },

  /** Exchange an OpenSubtitles.com file id for a short-lived link. */
  async osComDownloadLink(fileId, apiKey) {
    const data = await Net.postJson('https://api.opensubtitles.com/api/v1/download', { file_id: Number(fileId) }, {
      timeout: 15000,
      headers: { 'Api-Key': apiKey, Accept: 'application/json', 'Content-Type': 'application/json' },
    });
    if (!data?.link) throw Object.assign(new Error('no download link'), { code: 'failed' });
    return data.link;
  },
};

const SubtitleSearch = {
  results: [],
  busy: false,
  loading: false,
  lastUsedKey: null,
  prefilledFor: null,
  autoSearchedFor: null,
  searchToken: 0,

  init() {
    /* Language list (kept in JS so the HTML stays readable) */
    const select = $('#subSearchLang');
    select.append(el('option', { value: '', text: 'Any language' }));
    SUB_LANGS.forEach((l) => select.append(el('option', { value: l.code, text: l.name })));
    select.value = this.preferredLang()?.code || '';
    select.addEventListener('change', () => Settings.set('subSearchLang', select.value));

    /* Entry points */
    $('#btnSubtitleOnline').addEventListener('click', (e) => { e.stopPropagation(); this.open(); });
    $('#btnSubSearchClose').addEventListener('click', () => this.close());
    $('#btnSubSearchCancel').addEventListener('click', () => this.close());
    $('#subSearchForm').addEventListener('submit', (e) => { e.preventDefault(); this.search(); });

    /* Result list (delegated: the row loads, the small button saves) */
    $('#subSearchResults').addEventListener('click', (e) => {
      const row = e.target.closest('.sub-result');
      if (!row) return;
      const result = this.results.find((r) => r.key === row.dataset.key);
      if (!result) return;
      if (e.target.closest('[data-action="save"]')) this.save(result);
      else this.use(result);
    });

    /* Manual link / file */
    $('#btnSubSearchUrl').addEventListener('click', () => this.loadFromUrl($('#subSearchUrl').value));
    $('#subSearchUrl').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.loadFromUrl($('#subSearchUrl').value); }
    });
    $('#btnSubSearchFile').addEventListener('click', () => { this.close(); $('#subtitleInput').click(); });

    /* Options */
    const proxy = $('#subSearchProxy');
    proxy.checked = Settings.get('subSearchProxy') !== false;
    proxy.addEventListener('change', () => Settings.set('subSearchProxy', proxy.checked));

    const key = $('#subSearchApiKey');
    key.value = Settings.get('subSearchApiKey') || '';
    key.addEventListener('change', () => Settings.set('subSearchApiKey', key.value.trim()));

    ['#subSearchSeason', '#subSearchEpisode'].forEach((sel) => {
      $(sel).addEventListener('change', () => { if ($('#subSearchQuery').value.trim()) this.search(); });
    });
  },

  /* ---------- helpers ---------- */

  /** ISO-639 code / 3-letter code / English name → language record. */
  langInfo(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return null;
    const byCode = SUB_LANGS.find((l) => l.code.toLowerCase() === raw);
    if (byCode) return byCode;
    const byIso3 = SUB_LANGS.find((l) => l.iso3.toLowerCase() === raw);
    if (byIso3) return byIso3;
    const alias = { zht: 'zh-TW', cht: 'zh-TW', zhe: 'zh', zho: 'zh', zhcn: 'zh', scc: 'sr', pob: 'pt-BR', pb: 'pt-BR' };
    if (alias[raw]) return SUB_LANGS.find((l) => l.code === alias[raw]) || null;
    return SUB_LANGS.find((l) => l.name.toLowerCase() === raw) || null;
  },

  /** True when `actual` (any code form) matches `wanted` ("pt" ↔ "pt-BR"). */
  langMatches(actual, wanted) {
    if (!wanted) return true;
    const info = this.langInfo(actual);
    if (!info) return false;
    if (info.code === wanted.code) return true;
    const base = (s) => String(s || '').split('-')[0].toLowerCase();
    return base(info.code) === base(wanted.code);
  },

  /** The user's stored choice, else the browser language. */
  preferredLang() {
    const stored = this.langInfo(Settings.get('subSearchLang'));
    if (stored) return stored;
    const nav = String(navigator.language || '').split('-')[0];
    return this.langInfo(nav);
  },

  proxyOn() {
    const box = $('#subSearchProxy');
    return box ? box.checked : Settings.get('subSearchProxy') !== false;
  },

  /** Best available name of the current video (release name if we have it). */
  mediaName(item) {
    if (!item) return '';
    const file = item.file?.name || (item.kind === 'file' ? item.title : '');
    const url = item.url && !/^blob:/i.test(item.url) ? nameFromUrl(item.url) : '';
    const candidates = [file, item.title, url].filter((v) => v && !/^https?:/i.test(v));
    candidates.sort((a, b) => b.length - a.length);
    return candidates[0] || '';
  },

  /** Fill the query (and season/episode) in from the current playlist item. */
  prefill() {
    const item = Player.current || Playlist.current;
    const id = item?.id || 'none';
    const field = $('#subSearchQuery');
    if (this.prefilledFor === id && field.value.trim()) return;
    this.prefilledFor = id;
    const parsed = parseMediaName(this.mediaName(item));
    field.value = parsed.title || '';
    $('#subSearchSeason').value = parsed.season || '';
    $('#subSearchEpisode').value = parsed.episode || '';
  },

  /* ---------- dialog ---------- */

  open({ auto = true } = {}) {
    const dlg = $('#subSearchDialog');
    if (!dlg) return;
    this.prefill();
    $('#subSearchApiKey').value = Settings.get('subSearchApiKey') || '';
    Shell.openDialog('#subSearchDialog');
    setTimeout(() => $('#subSearchQuery').focus?.(), 60);
    const item = Player.current;
    const key = item?.id || 'none';
    if (auto && Settings.get('subSearchAutoSearch') !== false && navigator.onLine !== false
      && $('#subSearchQuery').value.trim() && this.autoSearchedFor !== key) {
      this.autoSearchedFor = key;
      this.search();
    }
  },

  close() {
    const dlg = $('#subSearchDialog');
    if (!dlg) return;
    if (typeof dlg.close === 'function') dlg.close();
    else dlg.removeAttribute('open');
  },

  setStatus(text, kind = '') {
    const node = $('#subSearchStatus');
    node.textContent = text;
    node.classList.toggle('is-busy', kind === 'busy');
    node.classList.toggle('is-warn', kind === 'warn');
  },

  /* ---------- search ---------- */

  async search({ query } = {}) {
    const field = $('#subSearchQuery');
    const q = String(query ?? field.value ?? '').trim();
    if (!q) { this.setStatus('Type a name to search for.', 'warn'); return; }
    if (navigator.onLine === false) {
      this.setStatus('You are offline — the online search needs a connection.', 'warn');
      return;
    }
    field.value = q;

    const lang = this.langInfo($('#subSearchLang').value);
    const season = $('#subSearchSeason').value.trim();
    const episode = $('#subSearchEpisode').value.trim();
    const proxy = this.proxyOn();
    const apiKey = ($('#subSearchApiKey').value || '').trim();
    const ctx = { query: q, lang, season, episode, proxy, apiKey };

    const token = ++this.searchToken;
    this.busy = true;
    this.setStatus(`Searching “${q}”…`, 'busy');

    const jobs = [
      ['OpenSubtitles', () => SubSources.openSubtitles(ctx)],
      ['OpenSubtitles (Stremio)', () => SubSources.stremio(ctx)],
    ];
    if (apiKey) jobs.push(['OpenSubtitles.com', () => SubSources.openSubtitlesCom(ctx)]);

    const settled = await Promise.allSettled(jobs.map(([, run]) => run()));
    if (token !== this.searchToken) return;      // a newer search superseded this one
    this.busy = false;

    const found = [];
    const notes = [];
    settled.forEach((outcome, i) => {
      const name = jobs[i][0];
      if (outcome.status === 'fulfilled') {
        found.push(...outcome.value);
        if (!outcome.value.length) notes.push(`${name}: no matches`);
      } else {
        console.warn('[subsearch]', name, outcome.reason);
        notes.push(`${name}: ${SubSources.reason(outcome.reason, proxy)}`);
      }
    });

    this.results = this.rank(found, lang);
    this.render();

    const counts = {};
    this.results.forEach((r) => { counts[r.source] = (counts[r.source] || 0) + 1; });
    const summary = Object.entries(counts).map(([src, n]) => `${n} from ${src}`).join(' · ');
    const extra = notes.length ? ` — ${notes.join(' · ')}` : '';
    if (!this.results.length) {
      this.setStatus(`No subtitles found for “${q}”${extra}. Try a shorter name or another language.`, 'warn');
      return;
    }
    this.setStatus(
      `${this.results.length} result${this.results.length === 1 ? '' : 's'}: ${summary}. Click one to load it.${extra}`,
      ''
    );
  },

  /** Dedupe, drop unusable formats to the bottom and sort by usefulness. */
  rank(list, lang) {
    const seen = new Set();
    const unique = [];
    list.forEach((r) => {
      const key = (r.url || r.altUrl || '') + '|' + (r.title || '');
      if (seen.has(key)) return;
      seen.add(key);
      unique.push(r);
    });

    const score = (r) => {
      let s = 0;
      if (lang && this.langMatches(r.lang, lang)) s += 1e6;
      if (!r.usable) s -= 5e5;
      s += Math.log10(1 + (r.downloads || 0)) * 1e4;
      s += (r.rating || 0) * 500;
      if (r.trusted) s += 500;
      if (r.hi) s -= 250;
      return s;
    };
    return unique
      .sort((a, b) => score(b) - score(a))
      .slice(0, 150)
      .map((r, i) => ({ ...r, key: 'r' + i }));
  },

  render() {
    const list = $('#subSearchResults');
    list.textContent = '';
    this.results.forEach((r) => list.append(this.row(r)));
  },

  row(r) {
    const tags = [
      el('span', { class: 'tag lang', text: r.langName || r.lang || '?' }),
    ];
    if (r.downloads) tags.push(el('span', { class: 'tag', text: `⤓ ${fmtCount(r.downloads)}` }));
    if (r.rating) tags.push(el('span', { class: 'tag', text: `★ ${r.rating.toFixed(1)}` }));
    if (r.hd) tags.push(el('span', { class: 'tag hd', text: 'HD' }));
    if (r.hi) tags.push(el('span', { class: 'tag', text: 'HI' }));
    if (r.year) tags.push(el('span', { text: String(r.year) }));
    tags.push(el('span', { text: r.source }));
    if (!r.usable) tags.push(el('span', { class: 'muted', text: `· ${r.format || 'unknown'} — download only` }));

    const item = el('li', { class: 'sub-result', dataset: { key: r.key } },
      el('button', {
        class: 'sub-result-main', type: 'button', 'data-action': 'use',
        title: `Load “${r.title || 'subtitle'}”`,
      },
        el('span', { class: 'sub-result-name', text: r.title || 'Untitled subtitle' }),
        el('span', { class: 'sub-result-meta' }, tags)),
      el('div', { class: 'sub-result-actions' },
        el('button', {
          class: 'icon-btn sm', type: 'button', 'data-action': 'save',
          title: 'Save this subtitle to your device', 'aria-label': 'Save subtitle file',
        }, icon('i-download'))),
    );
    if (r.key === this.lastUsedKey) item.classList.add('is-active');
    return item;
  },

  /* ---------- downloading ---------- */

  /** Fetch the text of one result (handling .gz, encodings and proxies). */
  async download(result) {
    let urls = [result.url, result.altUrl].filter(Boolean);
    if (result.ticket && result.fileId) {
      const apiKey = ($('#subSearchApiKey').value || '').trim();
      const link = await SubSources.osComDownloadLink(result.fileId, apiKey);
      urls = [link, ...urls];
    }
    if (!urls.length) throw Object.assign(new Error('no download link'), { code: 'failed' });
    return Net.fetchText(urls, { encoding: result.encoding, proxy: this.proxyOn() });
  },

  /** Load a result into the player as an online subtitle track. */
  async use(result) {
    if (this.loading) return;
    this.loading = true;
    Toast.show('Downloading subtitle…', 'info', 30000, 'subsearch');
    try {
      const { text, via } = await this.download(result);
      const vtt = /^\s*WEBVTT/.test(text) ? text : Subtitles.srtToVtt(text);
      if (!/-->/.test(vtt)) throw Object.assign(new Error('no cues'), { code: 'format' });
      const track = Subtitles.addFromText(this.trackLabel(result), vtt, {
        lang: result.lang || '',
        kind: 'online',
        source: result.source,
      });
      if (!track) { Toast.show('That subtitle is already loaded', 'info', 2200, 'subsearch'); return; }
      this.lastUsedKey = result.key;
      if (result.lang) Settings.set('subSearchLang', result.lang);
      this.close();
      Toast.ok(`Subtitles loaded — ${result.langName || result.lang || 'online'}${via ? ` (via ${via})` : ''}`, 3200, 'subsearch');
    } catch (err) {
      console.warn('[subsearch] load failed', err);
      Toast.err(this.loadError(err), 6000, 'subsearch');
    } finally { this.loading = false; }
  },

  /** Download a result and save it to disk (.srt / .vtt). */
  async save(result) {
    Toast.show('Downloading subtitle…', 'info', 30000, 'subsearch');
    try {
      const { text, via } = await this.download(result);
      const name = this.fileName(result);
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
      const a = el('a', { href: url, download: name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      Toast.ok(`Saved ${name}${via ? ` (via ${via})` : ''}`, 3500, 'subsearch');
    } catch (err) {
      console.warn('[subsearch] save failed', err);
      Toast.err(this.loadError(err), 6000, 'subsearch');
    }
  },

  /** Paste-a-link flow: fetch any .srt/.vtt URL and attach it. */
  async loadFromUrl(raw) {
    const url = String(raw || '').trim();
    if (!/^https?:\/\/\S+$/i.test(url)) { Toast.warn('Paste a full http(s) link to a .srt or .vtt file'); return; }
    const lang = this.langInfo($('#subSearchLang').value);
    Toast.show('Downloading subtitle…', 'info', 30000, 'subsearch');
    try {
      const { text, via } = await Net.fetchText([url], { proxy: this.proxyOn() });
      const vtt = /^\s*WEBVTT/.test(text) ? text : Subtitles.srtToVtt(text);
      if (!/-->/.test(vtt)) throw Object.assign(new Error('no cues'), { code: 'format' });
      const track = Subtitles.addFromText(this.trackLabel({ title: this.mediaName(Player.current) || nameFromUrl(url) }), vtt, {
        lang: lang?.code || '',
        kind: 'online',
        source: via ? `link (${via})` : 'link',
      });
      if (!track) { Toast.show('That subtitle is already loaded', 'info', 2200, 'subsearch'); return; }
      $('#subSearchUrl').value = '';
      this.close();
      Toast.ok(`Subtitles loaded${via ? ` (via ${via})` : ''}`, 3200, 'subsearch');
    } catch (err) {
      console.warn('[subsearch] link failed', err);
      Toast.err(this.loadError(err), 6000, 'subsearch');
    }
  },

  /** Unique track label derived from the result (CC panel shows it). */
  trackLabel(result) {
    const base = String(result?.title || 'Online subtitle')
      .replace(/\.(srt|vtt|ass|ssa|sub|zip)$/i, '')
      .replace(/[._]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 60) || 'Online subtitle';
    let label = base;
    let n = 2;
    while (Subtitles.tracks.some((t) => t.label === label) && n < 50) label = `${base} (${n++})`;
    return label;
  },

  /** Name used when saving to disk: "Video.en.srt". */
  fileName(result) {
    const base = parseMediaName(this.mediaName(Player.current)).title
      || String(result?.title || 'subtitle').replace(/\.[^.]+$/, '');
    const lang = result?.lang || 'sub';
    const ext = /vtt/i.test(result?.format || '') ? 'vtt' : 'srt';
    return `${base.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 60)}.${lang}.${ext}`;
  },

  /** Friendly explanation for a failed download / load. */
  loadError(err) {
    switch (err?.code) {
      case 'gzip': return 'That source only offers a compressed (.gz) file and this browser cannot unpack it — save it and open it manually.';
      case 'format': return 'That file does not contain readable .srt/.vtt subtitles.';
      case 'cors': return 'The download was blocked by the host (CORS). Turn on “Retry blocked requests” or pick another result.';
      case 'timeout': return 'The subtitle host took too long to answer.';
      case 'http': return `The subtitle host answered with HTTP ${err.status || '?'}.`;
      case 'apikey': return 'The OpenSubtitles.com API key was rejected — check it in “More options”.';
      default: return 'Could not load that subtitle.';
    }
  },
};

/* =====================================================================
 * 16. SOURCES — URL input, local files, folders, drag & drop, samples
 * ===================================================================*/

const Sources = {
  SAMPLES: [
    { title: 'Sintel trailer (MP4, progressive)', url: 'https://media.w3.org/2010/05/sintel/trailer.mp4' },
    { title: 'Big Buck Bunny (MP4, Google sample)', url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4' },
    { title: 'Bipbop (HLS, Apple sample)', url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8' },
    { title: 'DASH-IF sample (MPD)', url: 'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd' },
  ],

  init() {
    /* URL form */
    $('#urlForm').addEventListener('submit', (e) => {
      e.preventDefault();
      this.loadFromInput({ play: true });
    });
    $('#btnQueueUrl').addEventListener('click', (e) => { e.preventDefault(); this.loadFromInput({ play: false }); });
    $('#btnSearchMovies').addEventListener('click', () => MovieSearch.open({ query: MovieSearch.queryFromUrlInput() }));

    /* Local files */
    $('#btnAddLocal').addEventListener('click', () => $('#fileInput').click());
    $('#btnAddFolder').addEventListener('click', () => $('#folderInput').click());
    $('#fileInput').addEventListener('change', (e) => { this.handleFiles(Array.from(e.target.files || []), { play: true }); e.target.value = ''; });
    $('#folderInput').addEventListener('change', (e) => { this.handleFiles(Array.from(e.target.files || []), { play: true }); e.target.value = ''; });

    DragDrop.init();
  },

  /**
   * Validate + normalise the URL field, then play or queue it.
   * Links that are not direct media files (i.e. ordinary web pages) are
   * fetched and scanned instead: every video found on the page is added
   * to the playlist automatically.
   */
  loadFromInput({ play = true } = {}) {
    const input = $('#urlInput');
    let value = input.value.trim();
    if (!value) { input.focus(); Toast.warn('Paste a video URL first'); return; }

    // Tolerate a missing protocol ("example.com/video.mp4")
    if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) {
      value = (/^(localhost|127\.0\.0\.1|\[::1\]|(\d{1,3}\.){3}\d{1,3})/i.test(value) ? 'http://' : 'https://') + value;
    }
    value = rewriteMediaUrl(value);
    input.value = value;
    let parsed;
    try { parsed = new URL(value); } catch { Toast.err('That does not look like a valid URL'); return; }
    if (!/^https?:$/.test(parsed.protocol)) { Toast.err('Only http(s) URLs can be played from the network'); return; }

    const type = detectType(value, '');
    if (!type) {
      // Not a direct file/stream URL — scan the page for videos.
      this.scanPageForVideos(value, { play });
      return;
    }

    const item = {
      id: uid(),
      kind: 'remote',
      title: nameFromUrl(value),
      url: value,
      type,
    };
    const entry = Playlist.add(item, { silent: true });
    if (entry) entry.type = entry.type || type;
    if (play) Playlist.play(entry.id);
    else Toast.ok(`Queued: ${entry.title}`);
    if (play) Toast.show(`Loading ${type === 'hls' ? 'HLS' : type === 'dash' ? 'DASH' : 'video'} stream…`, 'info', 1800);
  },

  /* ------------------------------------------------------------------
   * Page scanning — a submitted link that is not a direct media file is
   * fetched, parsed for video sources, and every video found is queued.
   * ---------------------------------------------------------------- */

  /** Cap on how many videos one page scan may add to the playlist. */
  MAX_SCAN_ITEMS: 50,

  /** Fetch `pageUrl`, extract its videos and add them to the playlist. */
  async scanPageForVideos(pageUrl, { play = true } = {}) {
    const host = hostName(pageUrl) || 'the page';
    Toast.show(`Scanning ${host} for videos…`, 'info', 8000, 'scan');
    try {
      const found = await this.fetchPageMedia(pageUrl);
      if (!found.length) {
        Toast.warn(`No playable videos found on ${host}`, 4500, 'scan');
        return;
      }
      let added = 0;
      let first = null;
      for (const candidate of found) {
        if (Playlist.items.some((it) => it.url === candidate.url)) continue;
        const entry = Playlist.add({
          id: uid(),
          kind: 'remote',
          title: candidate.title,
          url: candidate.url,
          type: detectType(candidate.url, 'progressive'),
        }, { silent: true });
        if (entry) { added += 1; if (!first) first = entry; }
      }
      if (!added) {
        Toast.show('Those videos are already in the playlist', 'info', 3000, 'scan');
        return;
      }
      Toast.ok(`Added ${added} video${added === 1 ? '' : 's'} from ${host}`, 4000, 'scan');
      if (play && first) Playlist.play(first.id);
    } catch (err) {
      console.warn('[scan] failed', err);
      const hint = unplayableHint(pageUrl);
      Toast.err(hint || `Could not scan ${host} — the site blocks cross-origin reads. Paste a direct video URL instead.`, 6000, 'scan');
    }
  },

  /** Fetch a page and return the list of candidate media URLs on it. */
  async fetchPageMedia(pageUrl) {
    const opts = { credentials: 'omit', redirect: 'follow', referrerPolicy: 'no-referrer' };
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      opts.signal = AbortSignal.timeout(15000);
    }
    const res = await fetch(pageUrl, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = String(await res.text()).slice(0, 4_000_000); // cap pathological pages
    return this.extractMediaUrls(html, res.url || pageUrl);
  },

  /** Collect playable media URLs out of raw page HTML (DOM + inline text). */
  extractMediaUrls(html, baseUrl) {
    const found = [];
    const seen = new Set();

    /** Resolve `raw` against the page URL; keep it only if it is playable media. */
    const accept = (raw, title = '') => {
      if (!raw || typeof raw !== 'string') return;
      const clean = raw.trim();
      if (!clean || /^(?:blob|data|javascript):/i.test(clean)) return;
      let abs;
      try { abs = new URL(clean, baseUrl).href; } catch { return; }
      if (!/^https?:\/\//i.test(abs)) return;
      if (seen.has(abs) || !SCAN_MEDIA_EXT.test(abs)) return;
      seen.add(abs);
      found.push({ url: abs, title: String(title).trim().slice(0, 90) || nameFromUrl(abs) });
    };

    /* 1. Structured markup: <video>/<source>, og:video metas, media links. */
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      doc.querySelectorAll('video[src], video source[src], source[type^="video"]').forEach((node) => {
        accept(node.getAttribute('src'));
      });
      doc.querySelectorAll(
        'meta[property="og:video"], meta[property="og:video:url"], ' +
        'meta[property="og:video:secure_url"], meta[name="twitter:player:stream"]'
      ).forEach((node) => accept(node.getAttribute('content')));
      doc.querySelectorAll('a[href]').forEach((a) => accept(a.getAttribute('href'), a.textContent));
    } catch { /* unparseable markup — the raw-text sweep below still runs */ }

    /* 2. Raw sweep: URLs the page injects through JavaScript / JSON. */
    SCAN_TEXT_RE.lastIndex = 0;
    let m;
    while ((m = SCAN_TEXT_RE.exec(html)) !== null) accept(m[0]);

    return found.slice(0, this.MAX_SCAN_ITEMS);
  },

  /** Add (and maybe play) local File objects. */
  handleFiles(files, { play = true } = {}) {
    const videos = [];
    const subtitles = new Map(); // basename → { text }

    const readTasks = [];
    files.forEach((file) => {
      const name = file.name || '';
      if (MEDIA.subtitle.test(name)) {
        readTasks.push(file.text().then((raw) => {
          const text = /^\s*WEBVTT/.test(raw) ? raw : Subtitles.srtToVtt(raw);
          subtitles.set(name.replace(/\.[^.]+$/, ''), text);
        }).catch(() => { }));
      } else if (file.type.startsWith('video') || file.type.startsWith('audio') ||
                 /\.(mp4|m4v|mov|webm|mkv|ogv|ogg|mp3|m4a|aac|flac|wav|ts)$/i.test(name)) {
        videos.push(file);
      }
    });

    Promise.all(readTasks).then(() => {
      if (!videos.length) {
        // Subtitle-only selection: attach to whatever is currently playing.
        if (subtitles.size && Player.current) {
          let added = 0;
          subtitles.forEach((text, label) => { if (Subtitles.addFromText(label, text)) added++; });
          Subtitles.setEnabled(true);
          Toast.ok(added ? `Added ${added} subtitle track${added === 1 ? '' : 's'}` : 'Those subtitles are already loaded');
        } else {
          Toast.warn(files.length ? 'No playable video or subtitle files in that selection' : 'No files selected');
        }
        return;
      }
      const items = videos.map((file) => {
        const base = file.name.replace(/\.[^.]+$/, '');
        const matched = subtitles.get(base);
        return {
          id: uid(),
          kind: 'file',
          title: file.name,
          url: '',
          type: 'progressive',
          file,
          size: file.size,
          objectUrl: URL.createObjectURL(file),
          subtitles: matched ? [{ label: base, text: matched }] : undefined,
        };
      });

      // Queue everything, play the first (or the requested one)
      items.forEach((item, i) => Playlist.add(item, { play: play && i === 0, silent: true }));
      Toast.ok(`${items.length} file${items.length === 1 ? '' : 's'} added${play ? '' : ' to playlist'}`);
      Shell.closePanel();
    });
  },

  loadSample() {
    const next = this.SAMPLES[this._sampleIdx || 0];
    this._sampleIdx = ((this._sampleIdx || 0) + 1) % this.SAMPLES.length;
    $('#urlInput').value = next.url;
    Toast.show(`Sample needs internet: ${next.title}`, 'info', 3000);
    this.loadFromInput({ play: true });
  },
};

/* ------------------------------------------------------------------
 * Movie title search — Internet Archive's openly licensed catalog only.
 * Search metadata is checked before a direct video file is offered; the
 * Archive item page and declared license remain visible for verification.
 * ---------------------------------------------------------------- */
const MovieSearch = {
  SEARCH_URL: 'https://archive.org/advancedsearch.php',
  METADATA_URL: 'https://archive.org/metadata/',
  MAX_LOOKUPS: 24,
  MAX_RESULTS: 10,
  LOOKUP_CONCURRENCY: 4,
  searchToken: 0,
  controller: null,
  timeoutId: null,
  lastQuery: '',

  init() {
    $('#movieSearchForm').addEventListener('submit', (e) => {
      e.preventDefault();
      this.search();
    });
    $('#btnMovieSearchClose').addEventListener('click', () => this.close());
    $('#btnMovieSearchCancel').addEventListener('click', () => this.close());
    $('#movieSearchDialog').addEventListener('close', () => this.cancelPending());
  },

  /** A non-URL typed into the online-video field is a handy search prefill. */
  queryFromUrlInput() {
    const raw = String($('#urlInput')?.value || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw) || /^(?:www\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}(?::\d+)?(?:\/|$)/i.test(raw)) return '';
    return raw;
  },

  open({ query } = {}) {
    const field = $('#movieSearchQuery');
    const initial = String(query ?? this.queryFromUrlInput() ?? '').trim() || this.lastQuery;
    field.value = initial.slice(0, 120);
    $('#movieSearchResults').replaceChildren();
    this.setStatus('Enter a title to search public-domain and Creative Commons movie files.');
    Shell.openDialog('#movieSearchDialog');
    setTimeout(() => field.focus?.(), 60);
  },

  close() {
    const dialog = $('#movieSearchDialog');
    if (!dialog) return;
    if (typeof dialog.close === 'function') dialog.close();
    else {
      dialog.removeAttribute('open');
      this.cancelPending();
    }
  },

  cancelPending() {
    this.searchToken++;
    this.controller?.abort();
    this.controller = null;
    if (this.timeoutId) clearTimeout(this.timeoutId);
    this.timeoutId = null;
    const button = $('#btnMovieSearchGo');
    if (button) button.disabled = false;
  },

  setStatus(text, kind = '') {
    const status = $('#movieSearchStatus');
    status.textContent = text;
    status.classList.toggle('is-busy', kind === 'busy');
    status.classList.toggle('is-warn', kind === 'warn');
  },

  /** Quote a title as one Lucene phrase before URLSearchParams encodes it. */
  quotePhrase(value) {
    return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  },

  searchUrl(query) {
    const params = new URLSearchParams();
    params.set('q', `title:${this.quotePhrase(query)} AND mediatype:movies AND licenseurl:*`);
    ['identifier', 'title', 'year', 'creator', 'licenseurl', 'mediatype'].forEach((field) => params.append('fl[]', field));
    params.set('rows', String(this.MAX_LOOKUPS));
    params.set('page', '1');
    params.set('sort[]', 'downloads desc');
    params.set('output', 'json');
    return `${this.SEARCH_URL}?${params.toString()}`;
  },

  /** Only accept Creative Commons and public-domain license URLs. */
  licenseInfo(raw) {
    const value = Array.isArray(raw) ? raw.find((v) => typeof v === 'string') : raw;
    if (typeof value !== 'string' || !value.trim()) return null;
    let url;
    try { url = new URL(value.trim()); } catch { return null; }
    if (!/^https?:$/.test(url.protocol) || !/^(?:www\.)?creativecommons\.org$/i.test(url.hostname)) return null;
    const path = url.pathname.toLowerCase();
    const isPublicDomain = path.startsWith('/publicdomain/') || /^\/licenses\/publicdomain(?:\/|$)/.test(path);
    const isCreativeCommons = /^\/licenses\/[a-z0-9][a-z0-9-]*(?:\/|$)/.test(path);
    if (!isPublicDomain && !isCreativeCommons) return null;
    return {
      url: url.href,
      label: isPublicDomain ? 'Public domain · uploader-marked' : 'Creative Commons · uploader-marked',
    };
  },

  /** Choose a likely browser-playable video file, preferring MP4/WebM. */
  videoFile(files) {
    const accepted = new Set(['mp4', 'm4v', 'mov', 'webm', 'ogv', 'ogg', 'mkv']);
    const priority = { mp4: 0, webm: 1, m4v: 2, mov: 3, ogv: 4, ogg: 5, mkv: 6 };
    return (Array.isArray(files) ? files : Object.values(files || {}))
      .filter((file) => file && typeof file.name === 'string' && file.source !== 'metadata')
      .map((file) => {
        const name = file.name.trim();
        const ext = name.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() || '';
        return { ...file, name, ext };
      })
      .filter((file) => accepted.has(file.ext)
        && !file.name.startsWith('/')
        && !file.name.split('/').some((part) => !part || part === '.' || part === '..'))
      .sort((a, b) => priority[a.ext] - priority[b.ext])[0] || null;
  },

  directFileUrl(identifier, fileName) {
    const path = fileName.split('/').map((part) => encodeURIComponent(part)).join('/');
    return `https://archive.org/download/${encodeURIComponent(identifier)}/${path}`;
  },

  async fetchJson(url, signal) {
    const response = await fetch(url, {
      credentials: 'omit', redirect: 'follow', referrerPolicy: 'no-referrer', signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  },

  async resolveHit(hit, signal) {
    const identifier = String(hit?.identifier || '').trim();
    if (!/^[a-z0-9][a-z0-9._-]{0,199}$/i.test(identifier)) return null;
    const record = await this.fetchJson(`${this.METADATA_URL}${encodeURIComponent(identifier)}`, signal);
    const metadata = record?.metadata || {};
    if (metadata.mediatype && String(metadata.mediatype).toLowerCase() !== 'movies') return null;

    const license = this.licenseInfo(metadata.licenseurl || hit.licenseurl);
    if (!license) return null;
    const file = this.videoFile(record.files);
    if (!file) return null;

    const title = String(metadata.title || hit.title || identifier).trim().slice(0, 180) || identifier;
    const year = String(metadata.year || hit.year || '').match(/\b\d{4}\b/)?.[0] || '';
    const creatorValue = metadata.creator || hit.creator || '';
    const creator = (Array.isArray(creatorValue) ? creatorValue.join(', ') : String(creatorValue))
      .replace(/\s+/g, ' ').trim().slice(0, 100);
    const url = this.directFileUrl(identifier, file.name);
    return {
      identifier,
      title,
      year,
      creator,
      license,
      fileName: file.name,
      fileSize: Number(file.size) || 0,
      url,
      type: detectType(url, 'progressive'),
      detailsUrl: `https://archive.org/details/${encodeURIComponent(identifier)}`,
    };
  },

  async resolveHits(hits, signal) {
    const unique = [];
    const seen = new Set();
    for (const hit of hits.slice(0, this.MAX_LOOKUPS)) {
      const id = String(hit?.identifier || '');
      if (id && !seen.has(id)) { seen.add(id); unique.push(hit); }
    }
    const resolved = new Array(unique.length);
    let next = 0;
    const worker = async () => {
      while (next < unique.length && !signal.aborted) {
        const index = next++;
        try { resolved[index] = await this.resolveHit(unique[index], signal); }
        catch (err) {
          if (signal.aborted) return;
          console.warn('[movie-search] skipped an unreadable Archive record', err);
          resolved[index] = null;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.LOOKUP_CONCURRENCY, unique.length) }, worker));
    return resolved.filter(Boolean).slice(0, this.MAX_RESULTS);
  },

  async search() {
    const field = $('#movieSearchQuery');
    const query = String(field.value || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    if (!query) {
      this.setStatus('Enter a movie name to search.', 'warn');
      field.focus();
      return;
    }
    if (navigator.onLine === false) {
      this.setStatus('You are offline — movie search needs an internet connection.', 'warn');
      return;
    }

    this.controller?.abort();
    if (this.timeoutId) clearTimeout(this.timeoutId);
    this.timeoutId = null;
    const controller = new AbortController();
    this.controller = controller;
    const token = ++this.searchToken;
    this.lastQuery = query;
    field.value = query;
    $('#movieSearchResults').replaceChildren();
    $('#btnMovieSearchGo').disabled = true;
    this.setStatus(`Searching Internet Archive for “${query}”…`, 'busy');
    this.timeoutId = setTimeout(() => controller.abort(), 30000);

    try {
      const data = await this.fetchJson(this.searchUrl(query), controller.signal);
      const hits = data?.response?.docs;
      if (!Array.isArray(hits)) throw new Error('Unexpected search response');
      const movies = await this.resolveHits(hits, controller.signal);
      if (token !== this.searchToken) return;
      if (controller.signal.aborted) {
        this.setStatus('Search timed out or was cancelled. Try again.', 'warn');
        return;
      }
      if (!movies.length) {
        this.setStatus('No matching public-domain or Creative Commons item with a direct video file was found. Try another title or spelling.');
        return;
      }
      this.renderResults(movies);
      this.setStatus(`Found ${movies.length} direct video file${movies.length === 1 ? '' : 's'} on Internet Archive. Check each record’s license before streaming.`);
    } catch (err) {
      if (token !== this.searchToken) return;
      if (controller.signal.aborted) this.setStatus('Search timed out or was cancelled. Try again.', 'warn');
      else {
        console.warn('[movie-search] search failed', err);
        this.setStatus('Could not reach Internet Archive. Check your connection and try again.', 'warn');
      }
    } finally {
      if (token === this.searchToken) {
        if (this.timeoutId) clearTimeout(this.timeoutId);
        this.timeoutId = null;
        this.controller = null;
        $('#btnMovieSearchGo').disabled = false;
      }
    }
  },

  renderResults(movies) {
    const list = $('#movieSearchResults');
    list.replaceChildren();
    movies.forEach((movie) => {
      const title = el('a', {
        class: 'movie-result-title movie-result-link',
        href: movie.detailsUrl,
        target: '_blank',
        rel: 'noopener noreferrer',
        text: movie.title,
      });
      const meta = el('div', { class: 'movie-result-meta' });
      if (movie.year) meta.append(el('span', { class: 'tag', text: movie.year }));
      if (movie.creator) meta.append(el('span', { text: `by ${movie.creator}` }));
      const extension = movie.fileName.split('.').pop().toUpperCase();
      const mediaText = `${extension} direct file${movie.fileSize ? ` · ${fmtBytes(movie.fileSize)}` : ''}`;
      meta.append(el('span', { class: 'tag', text: mediaText }));
      meta.append(el('a', {
        class: 'tag license', href: movie.license.url, target: '_blank',
        rel: 'noopener noreferrer', text: movie.license.label,
      }));
      meta.append(el('a', {
        class: 'movie-result-link', href: movie.url, target: '_blank',
        rel: 'noopener noreferrer', text: 'Open direct video',
      }));
      meta.append(el('a', {
        class: 'movie-result-link', href: movie.detailsUrl, target: '_blank',
        rel: 'noopener noreferrer', text: 'View record',
      }));

      const main = el('div', { class: 'movie-result-main' }, title, meta);
      const actions = el('div', { class: 'movie-result-actions' });
      const play = el('button', { class: 'btn btn-primary', type: 'button', 'data-action': 'play', 'aria-label': `Play ${movie.title}` }, icon('i-play'), 'Play');
      play.addEventListener('click', () => this.playMovie(movie));
      const queue = el('button', { class: 'btn', type: 'button', 'data-action': 'queue', 'aria-label': `Queue ${movie.title}` }, icon('i-plus'), 'Queue');
      queue.addEventListener('click', () => this.queueMovie(movie));
      actions.append(play, queue);
      list.append(el('li', { class: 'movie-result' }, main, actions));
    });
  },

  playlistItem(movie) {
    return {
      id: uid(), kind: 'remote', title: movie.title, url: movie.url, type: movie.type,
    };
  },

  queueMovie(movie) {
    const item = this.playlistItem(movie);
    const alreadyQueued = Playlist.has(item);
    const entry = Playlist.add(item, { silent: true });
    Toast.show(alreadyQueued ? `Already in playlist: ${entry.title}` : `Queued: ${entry.title}`, alreadyQueued ? 'info' : 'ok', 2200);
  },

  playMovie(movie) {
    const entry = Playlist.add(this.playlistItem(movie), { silent: true });
    this.close();
    Playlist.play(entry.id);
  },
};

/** Drag & drop of files onto the stage / drop zone. */
const DragDrop = {
  init() {
    const zone = $('#dropZone');
    zone.addEventListener('click', () => $('#fileInput').click());
    zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#fileInput').click(); } });
    ['dragenter', 'dragover'].forEach((evt) => zone.addEventListener(evt, (e) => { e.preventDefault(); zone.classList.add('drag-over'); }));
    ['dragleave', 'drop'].forEach((evt) => zone.addEventListener(evt, () => zone.classList.remove('drag-over')));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      Sources.handleFiles(Array.from(e.dataTransfer?.files || []), { play: true });
    });

    // Window-wide guard so dropped files don't navigate the page away.
    window.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
    window.addEventListener('drop', (e) => {
      const hasFiles = e.dataTransfer?.types?.includes('Files');
      if (!hasFiles) return;
      if (e.target.closest('#dropZone, #playlistList, .item, .stage')) return; // handled locally
      e.preventDefault();
      Sources.handleFiles(Array.from(e.dataTransfer.files || []), { play: true });
    });
  },

  /** Highlight the stage while a file is dragged over it. */
  bindStage(stage) {
    let depth = 0;
    stage.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      depth++;
      $('#dropVeil').hidden = false;
    });
    stage.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) $('#dropVeil').hidden = true;
    });
    stage.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
    stage.addEventListener('drop', (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      depth = 0;
      $('#dropVeil').hidden = true;
      Sources.handleFiles(Array.from(e.dataTransfer.files || []), { play: true });
    });
  },
};

/* =====================================================================
 * 17. THEME
 * ===================================================================*/

const Theme = {
  init() {
    const saved = Settings.get('theme');
    const prefersLight = mediaQuery('(prefers-color-scheme: light)').matches;
    this.apply(saved || (prefersLight ? 'light' : 'dark'));
    $('#btnTheme').addEventListener('click', () => this.toggle());
    // Follow the OS only while the user has not chosen explicitly.
    mediaQuery('(prefers-color-scheme: light)').addEventListener?.('change', (e) => {
      if (!Settings.get('theme')) this.apply(e.matches ? 'light' : 'dark');
    });
  },
  apply(theme) {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f4f6fb' : '#0b1020');
  },
  toggle() {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    Settings.set('theme', next);
    this.apply(next);
    Toast.show(`${next === 'light' ? 'Light' : 'Dark'} theme`, 'info', 1200);
  },
};

/* =====================================================================
 * 18. SHELL — app-wide wiring (network state, panel, dialogs, install)
 * ===================================================================*/

const Shell = {
  deferredInstall: null,

  init() {
    /* Network status pills + notices */
    const syncOnline = () => {
      const online = navigator.onLine;
      document.body.classList.toggle('is-offline', !online);
      $('#netLabel').textContent = online ? 'Online' : 'Offline';
      $('#offlineNotice').hidden = online;
    };
    window.addEventListener('online', () => { syncOnline(); Toast.ok('Back online'); Offline.refresh({ silent: true }); Playlist.render(); });
    window.addEventListener('offline', () => { syncOnline(); Toast.warn('Offline — downloaded videos and local files still work'); });
    syncOnline();

    /* service worker / secure-context notice (file:// or http on a LAN IP) */
    const secure = window.isSecureContext || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (!secure || location.protocol === 'file:') {
      $('#insecureNotice').hidden = false;
      UIState.setSw('unavailable (insecure context)');
    }

    /* Sidebar / panel */
    $('#btnPanelToggle').addEventListener('click', () => this.togglePanel());
    $('#scrim').addEventListener('click', () => this.closePanel());
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.closePanel(); });

    /* Shortcuts dialog */
    $('#btnShortcuts').addEventListener('click', () => this.openDialog('#shortcutsDialog'));
    $$('[data-close-dialog]').forEach((b) => b.addEventListener('click', (e) => e.target.closest('dialog')?.close()));
    $('#optSeekZones').checked = !!Settings.get('seekZones');
    $('#optSeekZones').addEventListener('change', (e) => Settings.set('seekZones', e.target.checked));

    /* Install prompt (PWA) */
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.deferredInstall = e;
      $('#btnInstall').hidden = false;
    });
    $('#btnInstall').addEventListener('click', async () => {
      if (!this.deferredInstall) return;
      this.deferredInstall.prompt();
      const { outcome } = await this.deferredInstall.userChoice;
      if (outcome === 'accepted') Toast.ok('Installing Nebula Player…');
      this.deferredInstall = null;
      $('#btnInstall').hidden = true;
    });
    window.addEventListener('appinstalled', () => Toast.ok('App installed'));

    /* Service worker messages (download progress / completion) */
    if (hasServiceWorker()) {
      navigator.serviceWorker.addEventListener('message', (e) => Offline.handleServiceWorkerMessage(e));
    }

    /* Zoom lock — the page must never zoom: pinch, Ctrl+wheel and iOS
       gesture events are all blocked here; the viewport meta in index.html
       (maximum-scale=1, user-scalable=no) and stage/page `touch-action`
       rules in styles.css cover the rest. Text inputs are kept at 16px in CSS so
       focusing a field never triggers the iOS type-to-zoom either. */
    const blockGesture = (e) => e.preventDefault();
    document.addEventListener('gesturestart', blockGesture);
    document.addEventListener('gesturechange', blockGesture);
    document.addEventListener('gestureend', blockGesture);
    document.addEventListener('touchmove', (e) => {
      if (e.touches.length > 1) e.preventDefault();   // two-finger pinch
    }, { passive: false });
    window.addEventListener('wheel', (e) => {
      if (e.ctrlKey) e.preventDefault();              // trackpad pinch / Ctrl+scroll
    }, { passive: false });
  },

  isMobilePanel() { return mediaQuery('(max-width: 1079px)').matches; },

  togglePanel() {
    const sidebar = $('#sidebar');
    sidebar.classList.contains('open') ? this.closePanel() : this.openPanel();
  },

  openPanel() {
    $('#sidebar').classList.add('open');
    $('#scrim').hidden = false;
    requestAnimationFrame(() => $('#scrim').classList.add('show'));
    $('#btnPanelToggle').setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
  },

  closePanel() {
    const sidebar = $('#sidebar');
    if (!sidebar.classList.contains('open')) return;
    sidebar.classList.remove('open');
    const scrim = $('#scrim');
    scrim.classList.remove('show');
    setTimeout(() => { scrim.hidden = true; }, 220);
    $('#btnPanelToggle').setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
  },

  openDialog(selector) {
    const dlg = $(selector);
    if (!dlg) return;
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  },
};

/* =====================================================================
 * 19. UI — small view helpers shared by modules
 * ===================================================================*/

const UI = {
  renderCurrentTitle(item) {
    if (!item) {
      $('#nowPlayingTitle').textContent = '—';
      $('#nowPlayingLabel').textContent = 'Nothing playing';
      return;
    }
    const title = item.title || nameFromUrl(item.url || '') || 'Untitled';
    $('#nowPlayingTitle').textContent = title;
    $('#nowPlayingTitle').title = item.url || title;
    $('#nowPlayingLabel').textContent = item.offline ? 'Offline copy'
      : item.kind === 'file' ? 'Local file'
        : item.kind === 'offline' ? 'Offline copy'
          : 'Streaming';
  },

  setBadge(text) {
    const badge = $('#sourceBadge');
    if (!text) { badge.hidden = true; return; }
    badge.textContent = text;
    badge.hidden = false;
  },

  renderOfflineBadge(on) { $('#offlineBadge').hidden = !on; },
};

/* =====================================================================
 * 20. BOOT
 * ===================================================================*/

const App = {
  async start() {
    Settings.load();
    Toast.init();
    Theme.init();

    Player.init();
    Controls.init();
    Menus.init();
    Subtitles.init();
    SubtitleSearch.init();
    Gestures.init();
    Keyboard.init();
    Playlist.init();
    Sources.init();
    MovieSearch.init();
    Shell.init();
    await Offline.init();

    /* Respect a ?url= parameter so links can be shared/bookmarked. */
    const params = new URLSearchParams(location.search);
    const shared = params.get('url');
    if (shared) {
      $('#urlInput').value = shared;
      Sources.loadFromInput({ play: true });
    } else {
      // The playlist is restored from localStorage, but we intentionally do not
      // preload anything — autoplay is blocked anyway and it would cost bandwidth.
      Player.showEmptyState();
    }

    /* Ctrl/Cmd+V anywhere: paste a URL or subtitle text. */
    document.addEventListener('paste', (e) => {
      const text = e.clipboardData?.getData('text')?.trim();
      if (!text) return;
      if (Gestures.isInteractive(e.target)) return;
      if (/^https?:\/\/\S+$/i.test(text)) {
        e.preventDefault();
        $('#urlInput').value = text;
        Sources.loadFromInput({ play: true });
      }
    });

    /* Persist the resume point when the tab goes away. */
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') Player.rememberPosition();
    });
    window.addEventListener('beforeunload', () => Player.rememberPosition());

    /* Register the service worker (PWA / offline downloads). */
    await this.registerServiceWorker();

    /* Media Session action handlers */
    MediaSession.update();

    console.info('%cNebula Player ready', 'color:#7c5cff;font-weight:bold');
  },

  async registerServiceWorker() {
    if (!hasServiceWorker()) { UIState.setSw('not supported'); return; }
    if (location.protocol === 'file:') { UIState.setSw('unavailable on file://'); return; }
    try {
      UIState.setSw('registering…');
      const reg = await navigator.serviceWorker.register('service-worker.js', { scope: './' });
      UIState.setSw(reg.active ? 'active' : 'installing…');
      reg.addEventListener('updatefound', () => UIState.setSw('updating…'));
      await navigator.serviceWorker.ready;
      UIState.setSw('active');
      // The SW may have activated after the page loaded — refresh the library.
      Offline.refresh({ silent: true });
    } catch (err) {
      console.warn('[sw] registration failed', err);
      UIState.setSw('registration failed');
    }
  },
};

// Kick everything off once the DOM is parsed (the script is loaded as a module,
// so the DOM is ready by now — but guard anyway).
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => App.start());
else App.start();
