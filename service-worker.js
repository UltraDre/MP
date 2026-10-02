/* =====================================================================
 * Nebula Player — service-worker.js
 * ---------------------------------------------------------------------
 * Responsibilities
 *   1. App shell caching  → the UI boots with no network.
 *   2. Offline video storage (Cache API):
 *        • progressive files  → stored as one blob under a synthetic URL
 *        • HLS (.m3u8)        → manifest + every segment/init/key cached by URL
 *        • DASH (.mpd)        → MPD + init/media segments of the chosen
 *                               video + audio representations
 *   3. Range requests       → 206 partial responses sliced out of the cached
 *                             blob so seeking works while offline.
 *   4. Messaging API        → the page drives downloads via postMessage
 *                             (analyze / download / cancel / list / delete).
 *
 * Internal URL space (never linked to directly):
 *      <scope>__nebula__/index.json          download index (metadata only)
 *      <scope>__nebula__/<id>/stream         synthetic URL of a stored file
 * ===================================================================*/

'use strict';

/* ---------------------------------------------------------------------
 * Configuration
 * ------------------------------------------------------------------ */
const VERSION = '1.0.0';
const SHELL_CACHE = `nebula-shell-${VERSION}`;
const MEDIA_CACHE = `nebula-media-${VERSION}`;
const INDEX_CACHE = `nebula-index-${VERSION}`;
const KEEP_CACHES = [SHELL_CACHE, MEDIA_CACHE, INDEX_CACHE];

/** Folder-like prefix for internal URLs (kept out of the app's real routes). */
const OFFLINE_DIR = '__nebula__';

/** Files that make up the application shell. */
const SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './script.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
];

/* ---------------------------------------------------------------------
 * Small helpers
 * ------------------------------------------------------------------ */
const scopeUrl = (path) => new URL(path, self.registration.scope);

/** In-memory state (rebuilt lazily after the SW is restarted). */
const state = {
  index: null,          // { version, items: [record, …] }
  indexCache: null,     // Cache instance for the index
  mediaCache: null,     // Cache instance for media
  jobs: new Map(),      // active downloads: id → { controller, cancelled }
};

/** Fetch with credentials omitted — media hosts rarely need cookies, and this
 *  keeps cached responses usable across sessions without "Private" mismatches. */
const MEDIA_FETCH_INIT = { credentials: 'omit', cache: 'no-store' };

async function getCache(name) {
  return caches.open(name);
}

/* ----------------------------- index ------------------------------- */
async function loadIndex() {
  if (state.index) return state.index;
  state.indexCache = state.indexCache || await getCache(INDEX_CACHE);
  const res = await state.indexCache.match(scopeUrl(`${OFFLINE_DIR}/index.json`).toString());
  state.index = res ? await res.json() : { version: 1, items: [] };
  if (!Array.isArray(state.index.items)) state.index.items = [];
  return state.index;
}

let saveChain = Promise.resolve();
function saveIndex() {
  // Serialise writes so concurrent downloads cannot clobber the index.
  saveChain = saveChain.then(async () => {
    const cache = state.indexCache || await getCache(INDEX_CACHE);
    const body = JSON.stringify(state.index);
    await cache.put(
      scopeUrl(`${OFFLINE_DIR}/index.json`).toString(),
      new Response(body, { headers: { 'Content-Type': 'application/json' } }),
    );
  }).catch((err) => console.warn('[sw] index save failed', err));
  return saveChain;
}

/* --------------------------- messaging ----------------------------- */
async function broadcast(message) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  for (const client of clients) {
    try { client.postMessage(message); } catch { /* client gone */ }
  }
}

/** Reply to the page: on the transferred port when provided, else broadcast. */
function reply(event, data) {
  const port = event.ports && event.ports[0];
  if (port) port.postMessage(data);
  else event.source?.postMessage(data);
}

/* ---------------------------------------------------------------------
 * Lifecycle
 * ------------------------------------------------------------------ */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await getCache(SHELL_CACHE);
    // Cache assets individually so one failure cannot break the install.
    await Promise.allSettled(SHELL_ASSETS.map(async (asset) => {
      const request = new Request(scopeUrl(asset).toString(), { cache: 'reload' });
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop caches from previous versions (but never the current media store).
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith('nebula-') && !KEEP_CACHES.includes(n)).map((n) => caches.delete(n)));
    // Keep the shell fresh.
    await Promise.allSettled(SHELL_ASSETS.map(async (asset) => {
      const url = scopeUrl(asset).toString();
      try {
        const res = await fetch(new Request(url, { cache: 'reload' }));
        if (res.ok) (await getCache(SHELL_CACHE)).put(url, res);
      } catch { /* offline install — the previous cache stays */ }
    }));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  event.waitUntil(handleMessage(data, event));
});

async function handleMessage(data, event) {
  try {
    switch (data.type) {
      case 'skip-waiting':
        await self.skipWaiting();
        return;
      case 'ping':
        reply(event, { ok: true, version: VERSION });
        return;
      case 'analyze':
        reply(event, await analyze(data));
        return;
      case 'download':
        reply(event, await startDownload(data));
        return;
      case 'download-cancel':
        cancelDownload(data.id);
        reply(event, { ok: true });
        return;
      case 'list-downloads':
        reply(event, await listDownloads());
        return;
      case 'delete-download':
        reply(event, await deleteDownload(data.id));
        return;
      case 'clear-downloads':
        reply(event, await clearDownloads());
        return;
      default:
        reply(event, { ok: false, error: `unknown message: ${data.type}` });
    }
  } catch (err) {
    console.warn('[sw] message handler failed', data?.type, err);
    reply(event, { ok: false, error: String(err && err.message || err) });
  }
}

/* =====================================================================
 * FETCH HANDLING
 * ===================================================================*/
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only plain GETs over http(s) are our business.
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (!/^https?:$/.test(url.protocol)) return;

  // Chrome's "only-if-cached" probes must not hit the network.
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;

  event.respondWith(route(request, url).catch((err) => {
    console.warn('[sw] fetch failed', request.url, err);
    return new Response('Offline and not cached.', {
      status: 504, statusText: 'Gateway Timeout',
      headers: { 'Content-Type': 'text/plain' },
    });
  }));
});

async function route(request, url) {
  /* 1 ── Stored videos (synthetic stream URLs + cached stream resources) */
  const offlineResponse = await serveOfflineMedia(request, url);
  if (offlineResponse) return offlineResponse;

  /* 2 ── Navigations → app shell (offline capable) */
  if (request.mode === 'navigate') return serveShell(request);

  /* 3 ── Same-origin static assets → cache first, refresh in the background */
  if (url.origin === self.location.origin) {
    try {
      const asset = await serveStatic(request, url);
      if (asset) return asset;
    } catch { /* offline → fall through to the media cache */ }
  }

  /* 4 ── Anything else: try network, fall back to the media cache */
  try {
    return await fetch(request);
  } catch (err) {
    const cached = await matchMedia(request.url);
    if (cached) return withAcceptRanges(cached);
    throw err;
  }
}

/** Look a URL up in the offline media cache. */
async function matchMedia(url) {
  const cache = await getCache(MEDIA_CACHE);
  return (await cache.match(url, { ignoreVary: true })) || null;
}

/* --------------------------- app shell ----------------------------- */
async function serveShell(request) {
  const cache = await getCache(SHELL_CACHE);
  const cached = (await cache.match(request, { ignoreSearch: true })) ||
                 (await cache.match(scopeUrl('index.html').toString())) ||
                 (await cache.match(scopeUrl('./').toString()));
  if (cached) {
    // Refresh in the background (stale-while-revalidate) but never block.
    fetch(request).then((res) => { if (res.ok) cache.put(request, res.clone()); }).catch(() => { });
    return cached;
  }
  try {
    return await fetch(request);
  } catch (err) {
    // Offline with an empty shell cache — still show something useful.
    return new Response(
      '<!doctype html><meta charset="utf-8"><title>Offline</title>' +
      '<body style="font:16px system-ui;background:#0b1020;color:#eef2ff;padding:2rem">' +
      '<h1>Offline</h1><p>The app shell is not cached yet. Open the app once while online, then reload.</p></body>',
      { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }
}

/* ------------------------ same-origin assets ----------------------- */
async function serveStatic(request, url) {
  const cache = await getCache(SHELL_CACHE);
  const cached = await cache.match(url.toString());
  if (cached) {
    fetch(request).then((res) => { if (res.ok) cache.put(url.toString(), res.clone()); }).catch(() => { });
    return cached;
  }
  // Not cached yet: fetch and opportunistically store text/script/style assets.
  const response = await fetch(request);
  const type = response.headers.get('Content-Type') || '';
  if (response.ok && /(javascript|css|json|image|font|text)/i.test(type) && !/text\/html/i.test(type)) {
    cache.put(url.toString(), response.clone()).catch(() => { });
  }
  return response;
}

/* =====================================================================
 * OFFLINE MEDIA — serving cached video with Range support
 * ===================================================================*/

/**
 * Returns a Response when the request belongs to a stored video,
 * otherwise null so the normal routing can continue.
 */
async function serveOfflineMedia(request, url) {
  const index = await loadIndex();
  if (!index.items.length) return null;

  const pathname = url.pathname;
  let record = index.items.find((rec) =>
    (rec.playPath && rec.playPath === pathname) ||
    (rec.resourcePaths && rec.resourcePaths.includes(pathname)));

  // Aliasing: the original network URL of a stored progressive file resolves to
  // the stored copy, so playlist entries created before the download keep
  // working offline (and the app never has to rewrite the user's URL).
  if (!record) {
    record = index.items.find((rec) => rec.kind === 'progressive' && rec.url === request.url);
  }
  if (!record) return null;

  const cache = await getCache(MEDIA_CACHE);
  const key = record.playPath === pathname ? record.playUrl : request.url;
  const cached = (await cache.match(key, { ignoreVary: true })) ||
                 (await cache.match(request.url, { ignoreVary: true })) ||
                 (record.playUrl && await cache.match(record.playUrl, { ignoreVary: true }));
  if (!cached) return null;                       // let it fall through to the network

  // Synthetic "stream" URLs always get range treatment (that is how seeking
  // works for a single stored blob). Real stream resources only need it when
  // the client asked for a byte range.
  const isSynthetic = record.playPath === pathname;
  if (isSynthetic || request.headers.has('range')) {
    return respondWithRange(request, cached);
  }
  return withAcceptRanges(cached);
}

/** Slice a cached response to satisfy a Range request (or return the whole body). */
async function respondWithRange(request, cachedResponse) {
  // Opaque responses (no-cors downloads) cannot be read — hand them over as-is.
  if (cachedResponse.type === 'opaque') return cachedResponse;

  const blob = await cachedResponse.blob();
  const size = blob.size;
  const headers = new Headers(cachedResponse.headers);
  headers.set('Accept-Ranges', 'bytes');
  headers.delete('Content-Encoding');
  headers.delete('Transfer-Encoding');

  const rangeHeader = request.headers.get('range');
  if (!rangeHeader) {
    headers.set('Content-Length', String(size));
    return new Response(blob, { status: 200, statusText: 'OK', headers });
  }

  const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
  let start = match && match[1] ? parseInt(match[1], 10) : 0;
  let end = match && match[2] ? parseInt(match[2], 10) : size - 1;
  if (!Number.isFinite(start) || start < 0) start = 0;
  if (!Number.isFinite(end) || end >= size) end = size - 1;
  if (start > end) {
    return new Response(null, {
      status: 416, statusText: 'Range Not Satisfiable',
      headers: { 'Content-Range': `bytes */${size}` },
    });
  }

  headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(end - start + 1));
  return new Response(blob.slice(start, end + 1), { status: 206, statusText: 'Partial Content', headers });
}

/** Cached responses for whole resources advertise range support. */
function withAcceptRanges(response) {
  if (response.type === 'opaque') return response;
  const headers = new Headers(response.headers);
  headers.set('Accept-Ranges', 'bytes');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/* =====================================================================
 * NETWORK HELPERS (used by analyze + download)
 * ===================================================================*/

/** fetch() that never uses the HTTP cache, with an abort signal. */
async function mediaFetch(url, init = {}) {
  return fetch(url, { ...MEDIA_FETCH_INIT, ...init });
}

/** Best-effort size of a remote resource (HEAD, then a 1-byte range GET). */
async function remoteSize(url, signal) {
  try {
    const head = await mediaFetch(url, { method: 'HEAD', signal });
    if (head.ok) {
      const len = Number(head.headers.get('Content-Length'));
      if (Number.isFinite(len) && len > 0) return len;
    }
  } catch { /* fall through */ }
  try {
    const res = await mediaFetch(url, { headers: { Range: 'bytes=0-0' }, signal });
    const contentRange = res.headers.get('Content-Range');
    if (contentRange) {
      const total = Number(contentRange.split('/')[1]);
      if (Number.isFinite(total) && total > 0) return total;
    }
    const len = Number(res.headers.get('Content-Length'));
    return Number.isFinite(len) && len > 0 ? len : 0;
  } catch {
    return 0;
  }
}

/** Rough size estimate for a list of URLs (samples up to 12 of them). */
async function estimateBytes(urls, signal) {
  if (!urls.length) return 0;
  const step = Math.max(1, Math.floor(urls.length / 12));
  let total = 0, counted = 0;
  for (let i = 0; i < urls.length && counted < 12; i += step) {
    const size = await remoteSize(urls[i], signal);
    if (size) { total += size; counted++; }
  }
  return counted ? Math.round((total / counted) * urls.length) : 0;
}

/* =====================================================================
 * PLAYLIST PARSING — HLS & DASH
 * ===================================================================*/

const abs = (value, base) => { try { return new URL(value, base).toString(); } catch { return null; } };

/** Read `#EXT-X-…:KEY=VALUE` attributes. */
function hlsAttr(line, name) {
  const re = new RegExp(`${name}=("[^"]*"|[^,]*)`);
  const m = re.exec(line);
  if (!m) return null;
  return m[1].replace(/^"|"$/g, '');
}

/** Parse an HLS playlist into its sub-playlists and media resources. */
function parseHlsPlaylist(text, baseUrl) {
  const out = { variants: [], segments: [], keys: [], maps: [], duration: 0, isLive: true, byteRange: false };
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const next = (lines[i + 1] || '').trim();
      if (next && !next.startsWith('#')) { const u = abs(next, baseUrl); if (u) out.variants.push(u); i++; }
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const uri = hlsAttr(line, 'URI'); if (uri) { const u = abs(uri, baseUrl); if (u) out.variants.push(u); }
    } else if (line.startsWith('#EXT-X-I-FRAME-STREAM-INF:')) {
      const uri = hlsAttr(line, 'URI'); if (uri) { const u = abs(uri, baseUrl); if (u) out.variants.push(u); }
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const uri = hlsAttr(line, 'URI'); if (uri) { const u = abs(uri, baseUrl); if (u) out.keys.push(u); }
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const uri = hlsAttr(line, 'URI'); if (uri) { const u = abs(uri, baseUrl); if (u) out.maps.push(u); }
    } else if (line.startsWith('#EXTINF:')) {
      out.duration += parseFloat(line.slice(8)) || 0;
    } else if (line.startsWith('#EXT-X-ENDLIST')) {
      out.isLive = false;
    } else if (line.startsWith('#EXT-X-BYTERANGE')) {
      out.byteRange = true;
    } else if (!line.startsWith('#')) {
      const u = abs(line, baseUrl);
      if (u) out.segments.push(u);
    }
  }
  return out;
}

/**
 * Walk an HLS source and collect every URL needed to play it offline.
 * @returns {{ok:boolean, error?:string, manifests:string[], resources:string[], live:boolean, duration:number, byteRange:boolean}}
 */
async function collectHls(url, signal) {
  const manifests = new Set();
  const resources = new Set();
  const queue = [url];
  const seen = new Set();
  let live = false, byteRange = false, duration = 0;
  let mediaPlaylists = 0;

  while (queue.length) {
    const current = queue.shift();
    if (seen.has(current) || seen.size > 60) continue;
    seen.add(current);

    const res = await mediaFetch(current, { signal });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} while reading ${current}` };
    const text = await res.text();
    const parsed = parseHlsPlaylist(text, current);
    manifests.add(current);

    if (parsed.byteRange) byteRange = true;
    if (parsed.variants.length && !parsed.segments.length) {
      parsed.variants.forEach((v) => queue.push(v));      // master playlist → descend
    } else {
      mediaPlaylists++;
      duration = Math.max(duration, parsed.duration);
      if (parsed.isLive) live = true;
      parsed.segments.forEach((s) => resources.add(s));
      parsed.keys.forEach((k) => resources.add(k));
      parsed.maps.forEach((m) => resources.add(m));
    }
  }

  if (!mediaPlaylists) return { ok: false, error: 'No media playlist found in that .m3u8' };
  if (live) return { ok: false, error: 'live' };
  return {
    ok: true,
    manifests: [...manifests],
    resources: [...resources],
    live: false,
    byteRange,
    duration,
  };
}

/* ------------------------------- DASH ------------------------------ */

/**
 * Minimal XML scanner.
 *
 * Service workers do NOT expose DOMParser (see whatwg/html#11068), so the MPD
 * is parsed with a tiny well-formedness-tolerant scanner instead of a DOM.
 * Namespace prefixes are stripped and comments/prologs are ignored.
 *
 * @returns {{name:string, attrs:Object, children:Array, parent:Object|null, text:string}}
 */
function parseXmlLite(text) {
  const tagRe = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  const attrRe = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  const local = (name) => (name.includes(':') ? name.slice(name.indexOf(':') + 1) : name);

  const root = { name: '#document', attrs: {}, children: [], parent: null, text: '' };
  let current = root;
  let last = 0;
  let match;
  while ((match = tagRe.exec(text))) {
    const chunk = text.slice(last, match.index);
    if (chunk.trim()) current.text += chunk.trim();
    last = tagRe.lastIndex;

    const [, closing, rawName, rawAttrs, selfClose] = match;
    const name = local(rawName);

    if (closing) {
      if (current.parent) current = current.parent;
      continue;
    }

    const node = { name, attrs: {}, children: [], parent: current, text: '' };
    let attr;
    attrRe.lastIndex = 0;
    while ((attr = attrRe.exec(rawAttrs))) {
      node.attrs[local(attr[1])] = attr[2] !== undefined ? attr[2] : attr[3];
    }
    current.children.push(node);
    if (!selfClose) current = node;
  }
  return root;
}

/** Direct children / child lookup helpers for the scanner output. */
const xmlChildren = (node, name) => (node ? node.children.filter((c) => c.name === name) : []);
const xmlChild = (node, name) => (node ? node.children.find((c) => c.name === name) || null : null);

/** Substitute $Number$ / $RepresentationID$ / $Bandwidth$ / $Time$ in a template. */
function fillTemplate(template, vars) {
  return template.replace(/\$(\w+)(?:%0(\d+)d)?\$/g, (_m, name, pad) => {
    const value = vars[name];
    if (value === undefined) return '';
    const str = String(value);
    return pad ? str.padStart(parseInt(pad, 10), '0') : str;
  });
}

/** Parse an ISO-8601 duration (PT1H2M3.5S) into seconds. */
function parseIsoDuration(value) {
  if (!value) return 0;
  const m = /P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?/.exec(value);
  if (!m) return 0;
  return (Number(m[1] || 0) * 31536000) + (Number(m[2] || 0) * 2592000) + (Number(m[3] || 0) * 86400) +
         (Number(m[4] || 0) * 3600) + (Number(m[5] || 0) * 60) + Number(m[6] || 0);
}

/**
 * Collect the URLs of a DASH MPD: the manifest itself plus the init/media
 * segments of the highest-bandwidth video and audio representations.
 * @returns {{ok:boolean, error?:string, resources:string[], duration:number, bitrate:number}}
 */
async function collectDash(url, signal) {
  const res = await mediaFetch(url, { signal });
  if (!res.ok) return { ok: false, error: `HTTP ${res.status} while reading the MPD` };
  const text = await res.text();

  const doc = parseXmlLite(text);
  const mpd = xmlChild(doc, 'MPD');
  if (!mpd) return { ok: false, error: 'Invalid MPD (no <MPD> element found)' };
  if ((mpd.attrs.type || 'static') === 'dynamic') return { ok: false, error: 'live' };

  const resources = new Set([url]);
  const duration = parseIsoDuration(mpd.attrs.mediaPresentationDuration);

  /** Resolve the effective BaseURL chain (MPD → Period → AdaptationSet → Representation). */
  const baseOf = (node) => {
    const chain = [];
    let cur = node;
    while (cur && cur.name !== '#document') {
      const b = xmlChildren(cur, 'BaseURL').map((n) => (n.text || '').trim()).filter(Boolean).pop();
      if (b) chain.unshift(b);
      cur = cur.parent;
    }
    let base = url;
    for (const part of chain) base = abs(part, base) || base;
    return base;
  };

  /** Nearest ancestor (or self) that carries a child element of that name. */
  const templateOf = (node, name) => {
    let cur = node;
    while (cur && cur.name !== '#document') {
      const found = xmlChild(cur, name);
      if (found) return found;
      cur = cur.parent;
    }
    return null;
  };

  const periods = xmlChildren(mpd, 'Period');
  if (periods.length > 1) console.info('[sw] multi-period MPD — only the first period will be stored');
  const period = periods[0];
  if (!period) return { ok: false, error: 'MPD has no Period' };
  const periodDuration = parseIsoDuration(xmlChild(period, 'Duration')?.text) || duration;

  // Choose one video + one audio representation (highest bandwidth each).
  const adaptationSets = xmlChildren(period, 'AdaptationSet');
  const chosen = [];
  for (const set of adaptationSets) {
    const mime = set.attrs.mimeType || '';
    const contentType = set.attrs.contentType ||
      (mime.startsWith('video') ? 'video' : mime.startsWith('audio') ? 'audio' : mime.startsWith('text') ? 'text' : 'other');
    const reps = xmlChildren(set, 'Representation');
    if (!reps.length) continue;
    if (contentType === 'text') { reps.forEach((r) => chosen.push({ set, rep: r })); continue; }
    if (contentType !== 'video' && contentType !== 'audio') continue;
    reps.sort((a, b) => Number(b.attrs.bandwidth || 0) - Number(a.attrs.bandwidth || 0));
    chosen.push({ set, rep: reps[0] });
  }
  if (!chosen.length) return { ok: false, error: 'No downloadable representations found in the MPD' };

  let topBitrate = 0;
  let unsupported = null;

  for (const { set, rep } of chosen) {
    const bandwidth = Number(rep.attrs.bandwidth || set.attrs.bandwidth || 0);
    if (bandwidth > topBitrate) topBitrate = bandwidth;

    const repBase = baseOf(rep) || baseOf(set);
    const vars = {
      RepresentationID: rep.attrs.id || '',
      Bandwidth: rep.attrs.bandwidth || set.attrs.bandwidth || '',
    };

    const template = templateOf(rep, 'SegmentTemplate');
    const list = templateOf(rep, 'SegmentList');

    if (template) {
      const media = template.attrs.media;
      const init = template.attrs.initialization;
      if (init) {
        const u = abs(fillTemplate(init, vars), repBase);
        if (u) resources.add(u);
      }
      if (!media) { unsupported = 'SegmentTemplate without a media template'; continue; }

      const timescale = Number(template.attrs.timescale || 1);
      const timeline = xmlChild(template, 'SegmentTimeline');

      if (timeline) {
        // Explicit segment timeline: walk every <S> entry (r = repeat count).
        let time = 0;
        const starts = [];
        for (const s of xmlChildren(timeline, 'S')) {
          const d = Number(s.attrs.d || 0);
          if (s.attrs.t !== undefined) time = Number(s.attrs.t);
          const repeat = Number(s.attrs.r !== undefined ? s.attrs.r : 0);
          if (repeat >= 0) {
            for (let i = 0; i <= repeat; i++) { starts.push(time); time += d; }
          } else {
            // r="-1" → repeat until the end of the period
            const limit = periodDuration * timescale;
            while (time < limit) { starts.push(time); time += d; }
          }
        }
        starts.forEach((t) => {
          const u = abs(fillTemplate(media, { ...vars, Number: t / timescale, Time: t, NumberPad: t }), repBase);
          if (u) resources.add(u);
        });
      } else {
        // Fixed segment duration → derive the segment count from the period.
        const segDuration = Number(template.attrs.duration || 0) / timescale;
        if (!segDuration) { unsupported = 'SegmentTemplate without SegmentTimeline or duration'; continue; }
        if (!periodDuration) { unsupported = 'the MPD does not declare a duration'; continue; }
        const startNumber = Number(template.attrs.startNumber || 1);
        const count = Math.max(1, Math.ceil(periodDuration / segDuration));
        for (let i = 0; i < count; i++) {
          const u = abs(fillTemplate(media, { ...vars, Number: startNumber + i }), repBase);
          if (u) resources.add(u);
        }
      }
    } else if (list) {
      const init = xmlChild(list, 'Initialization');
      if (init?.attrs.sourceURL) {
        const u = abs(init.attrs.sourceURL, repBase);
        if (u) resources.add(u);
      }
      for (const seg of xmlChildren(list, 'SegmentURL')) {
        if (seg.attrs.media) {
          const u = abs(seg.attrs.media, repBase);
          if (u) resources.add(u);
        }
      }
    } else {
      unsupported = 'SegmentBase / single-file MPDs (download the MP4 file instead)';
    }
  }

  if (resources.size <= 1) {
    return { ok: false, error: unsupported || 'Could not enumerate any segments' };
  }
  return { ok: true, resources: [...resources], duration, bitrate: topBitrate };
}

/* =====================================================================
 * ANALYZE — size estimate before downloading
 * ===================================================================*/
async function analyze({ url, kind }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 40000);
  try {
    if (kind === 'hls') {
      const info = await collectHls(url, controller.signal);
      if (!info.ok) return { ok: false, error: info.error };
      const bytes = await estimateBytes(info.resources, controller.signal);
      return { ok: true, bytes, files: info.resources.length + info.manifests.length, duration: info.duration, byteRange: info.byteRange };
    }
    if (kind === 'dash') {
      const info = await collectDash(url, controller.signal);
      if (!info.ok) return { ok: false, error: info.error };
      const bytes = await estimateBytes(info.resources, controller.signal);
      return { ok: true, bytes, files: info.resources.length, duration: info.duration, bitrate: info.bitrate };
    }
    // Progressive file: ask the server for the size (needs CORS to be readable).
    const size = await remoteSize(url, controller.signal);
    if (size) return { ok: true, bytes: size, files: 1 };
    // Unknown size — the actual download decides whether the host cooperates.
    return { ok: true, bytes: 0, files: 1, unknownSize: true };
  } finally {
    clearTimeout(timer);
  }
}

/* =====================================================================
 * DOWNLOADS
 * ===================================================================*/

function cancelDownload(id) {
  const job = state.jobs.get(id);
  if (job) {
    job.cancelled = true;
    try { job.controller.abort(); } catch { /* noop */ }
  }
}

/**
 * Shared state for one download job.
 *
 * Byte accounting lives here (not in the worker loops) because several workers
 * download in parallel: read-modify-write on a local variable inside each
 * worker would lose counts. Incrementing `bytes` between awaits is safe since
 * the sandboxed JS runs on a single thread.
 */
function createJob({ id, title, total = 0, filesTotal = 0, controller }) {
  const state = {
    id,
    title,
    controller,
    total,
    filesTotal,
    bytes: 0,
    done: 0,
    _last: 0,
    /** Add downloaded bytes and (throttled) notify the pages. */
    add(n) {
      if (!n) return;
      state.bytes += n;
      state.notify(false);
    },
    /** Mark one resource as finished. */
    finishFile() {
      state.done++;
      state.notify(true);
    },
    notify(force) {
      const now = Date.now();
      if (!force && now - state._last < 250) return;
      state._last = now;
      broadcast({
        type: 'download-progress',
        id: state.id,
        title: state.title,
        total: state.total,
        received: state.bytes,
        filesDone: state.done,
        filesTotal: state.filesTotal,
      });
    },
  };
  return state;
}

async function startDownload({ url, kind, title, expect = 0, files = 0 }) {
  const id = 'dl' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const controller = new AbortController();
  state.jobs.set(id, { controller, cancelled: false, id });

  // Run in the background so the page gets its response immediately.
  (async () => {
    try {
      let record;
      const job = createJob({ id, title, total: expect, filesTotal: files, controller });
      const params = { id, url, title, expect, files, controller, job };
      if (kind === 'hls') record = await downloadHls(params);
      else if (kind === 'dash') record = await downloadDash(params);
      else record = await downloadProgressive(params);

      const index = await loadIndex();
      // One record per source URL: a re-download replaces the previous copy.
      const stale = index.items.filter((it) => it.id !== id && it.url === record.url);
      for (const old of stale) await dropRecord(old);
      index.items = index.items.filter((it) => it.id !== id && it.url !== record.url).concat(record);
      await saveIndex();
      await broadcast({ type: 'download-complete', id, title: record.title, bytes: record.bytes, url: record.url });
    } catch (err) {
      const message = state.jobs.get(id)?.cancelled ? 'cancelled' : String(err && err.message || err);
      await broadcast({ type: 'download-error', id, title, error: message });
    } finally {
      state.jobs.delete(id);
    }
  })();

  return { ok: true, id, mode: kind };
}

/**
 * Fetch a URL and store it in the media cache while reporting byte progress.
 * Reading the body through a counting stream matters: Cache.put() consumes the
 * response body, which is what drives the progress callbacks.
 *
 * @param {string} resourceUrl URL to download
 * @param {object} job job state from createJob() (byte accounting + cancellation)
 * @param {string} [storeKey] cache key (defaults to the request URL)
 */
async function fetchAndStore(cache, resourceUrl, job, storeKey = resourceUrl) {
  const signal = job?.controller?.signal;
  const response = await mediaFetch(resourceUrl, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${resourceUrl}`);

  // Build a "clean" response: strip length/encoding headers that no longer
  // describe the (possibly decompressed) body we are about to store.
  const headers = new Headers(response.headers);
  headers.delete('Content-Length');
  headers.delete('Content-Encoding');
  headers.delete('Content-Range');
  headers.delete('Transfer-Encoding');
  headers.set('Accept-Ranges', 'bytes');

  let streamed = false;
  let body = response.body;
  if (body && typeof TransformStream === 'function') {
    streamed = true;
    const counter = new TransformStream({
      transform(chunk, controller) {
        job?.add(chunk.byteLength);
        controller.enqueue(chunk);
      },
    });
    body = body.pipeThrough(counter);
  }

  const stored = new Response(body, { status: 200, statusText: 'OK', headers });
  await cache.put(storeKey, stored);   // consumes the body → drives the counter

  if (!streamed) job?.add(Number(response.headers.get('Content-Length')) || 0);
}

/** Progressive file (MP4/WebM/…) → one cached blob under a synthetic URL. */
async function downloadProgressive({ id, url, title, expect, files, controller, job }) {
  const cache = await getCache(MEDIA_CACHE);
  const playPath = scopeUrl(`${OFFLINE_DIR}/${id}/stream`).pathname;
  const playUrl = scopeUrl(playPath).toString();

  let bytes = 0;
  let opaque = false;

  try {
    await fetchAndStore(cache, url, job, playUrl);
    job.total = job.total || expect || 0;
    bytes = job.bytes;
    job.filesTotal = 1;
    job.finishFile();
  } catch (err) {
    if (controller.signal.aborted) throw err;
    // CORS blocked the readable download — try an opaque fetch so the video is
    // at least available offline (no progress bar, limited seeking).
    try {
      const res = await mediaFetch(url, { mode: 'no-cors', signal: controller.signal });
      await cache.put(playUrl, res);
      opaque = true;
      bytes = 0;
      job.total = 0;
      job.filesTotal = 1;
      job.bytes = 0;
      job.finishFile();
    } catch {
      throw new Error('cors');
    }
  }

  // Prefer the real stored size (works for same-origin/CORS bodies).
  if (!opaque) {
    try {
      const stored = await cache.match(playUrl, { ignoreVary: true });
      if (stored) bytes = (await stored.blob()).size;
    } catch { /* keep the streamed count */ }
  }

  return {
    id,
    kind: 'progressive',
    title,
    url,
    playUrl,
    playPath,
    bytes,
    opaque,
    files: 1,
    date: Date.now(),
  };
}

/** HLS → cache the manifest and every segment under their real URLs. */
async function downloadHls({ id, url, title, expect, files, controller, job }) {
  const cache = await getCache(MEDIA_CACHE);
  const info = await collectHls(url, controller.signal);
  if (!info.ok) throw new Error(info.error);

  const all = [...info.manifests, ...info.resources];
  job.filesTotal = all.length;

  // Concurrency-limited downloads keep memory and sockets in check.
  const queue = [...all];
  const workers = Array.from({ length: 4 }, async () => {
    while (queue.length) {
      if (controller.signal.aborted) throw new Error('cancelled');
      const target = queue.shift();
      const isManifest = info.manifests.includes(target);
      let attempt = 0;
      // Two attempts per resource: transient CDN hiccups are common.
      for (;;) {
        try {
          await fetchAndStore(cache, target, job);
          break;
        } catch (err) {
          attempt++;
          if (attempt >= 2 || isManifest) throw err;
          await new Promise((r) => setTimeout(r, 400 * attempt));
        }
      }
      job.finishFile();
    }
  });

  await Promise.all(workers);
  job.notify(true);

  return {
    id,
    kind: 'hls',
    title,
    url,
    playUrl: url,
    playPath: new URL(url).pathname,
    resourcePaths: all.map((u) => new URL(u).pathname),
    bytes: job.bytes,
    duration: info.duration,
    byteRange: info.byteRange,
    files: all.length,
    date: Date.now(),
  };
}

/** DASH → cache the MPD plus init/media segments of the chosen renditions. */
async function downloadDash({ id, url, title, expect, files, controller, job }) {
  const cache = await getCache(MEDIA_CACHE);
  const info = await collectDash(url, controller.signal);
  if (!info.ok) throw new Error(info.error);

  const all = info.resources;
  job.filesTotal = all.length;

  const queue = [...all];
  const workers = Array.from({ length: 4 }, async () => {
    while (queue.length) {
      if (controller.signal.aborted) throw new Error('cancelled');
      const target = queue.shift();
      await fetchAndStore(cache, target, job);
      job.finishFile();
    }
  });
  await Promise.all(workers);

  return {
    id,
    kind: 'dash',
    title,
    url,
    playUrl: url,
    playPath: new URL(url).pathname,
    resourcePaths: all.map((u) => new URL(u).pathname),
    bytes: job.bytes,
    duration: info.duration,
    bitrate: info.bitrate,
    files: all.length,
    date: Date.now(),
  };
}

/* =====================================================================
 * LIBRARY MANAGEMENT
 * ===================================================================*/
async function listDownloads() {
  const index = await loadIndex();
  // Sanity check the cache so the list never shows ghost entries.
  const cache = await getCache(MEDIA_CACHE);
  const items = [];
  for (const rec of index.items) {
    const hit = await cache.match(rec.playUrl, { ignoreVary: true });
    if (hit) items.push(rec);
  }
  if (items.length !== index.items.length) {
    index.items = items;
    await saveIndex();
  }
  return { ok: true, items, version: VERSION };
}

/** Remove every cached resource that belongs to one record. */
async function dropRecord(rec) {
  const cache = await getCache(MEDIA_CACHE);
  const urls = new Set([rec.playUrl, rec.url, scopeUrl(`${OFFLINE_DIR}/${rec.id}/stream`).toString()].filter(Boolean));
  const paths = new Set(rec.resourcePaths || []);
  if (rec.playPath) paths.add(rec.playPath);

  // Walk the cache once and remove everything belonging to this record
  // (stream segments are stored under their own absolute URLs).
  for (const request of await cache.keys()) {
    const url = new URL(request.url);
    if (urls.has(request.url) || paths.has(url.pathname)) {
      await cache.delete(request, { ignoreVary: true }).catch(() => { });
    }
  }
}

async function deleteDownload(id) {
  const index = await loadIndex();
  const rec = index.items.find((it) => it.id === id);
  if (!rec) return { ok: false, error: 'not-found' };

  await dropRecord(rec);
  index.items = index.items.filter((it) => it.id !== id);
  await saveIndex();
  return { ok: true };
}

async function clearDownloads() {
  const index = await loadIndex();
  const ids = index.items.map((it) => it.id);
  for (const id of ids) await deleteDownload(id);
  // Belt and braces: drop the whole media cache and start clean.
  await caches.delete(MEDIA_CACHE);
  state.index = { version: 1, items: [] };
  state.mediaCache = null;
  await saveIndex();
  return { ok: true };
}
