// Service-worker integration test: runs service-worker.js in a sandbox with a
// fake Cache API, fake fetch and a real XML parser, then drives its protocol.
import fs from 'node:fs';
import vm from 'node:vm';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SW_SRC = fs.readFileSync(`${ROOT}/service-worker.js`, 'utf8');
const SCOPED = 'https://player.test/app/';

/* ------------------------- fake Cache API ------------------------- */
class FakeCache {
  constructor(name) { this.name = name; this.map = new Map(); }
  key(k) { return typeof k === 'string' ? k : k.url; }
  async put(k, res) {
    if (res.status === 206) throw new TypeError('206 responses cannot be cached');
    // The real Cache API fully reads the body before storing — mimic that so
    // streaming/progress code behaves identically.
    const buf = res.body ? await res.arrayBuffer() : new ArrayBuffer(0);
    this.map.set(this.key(k), new Response(buf, { status: res.status, statusText: res.statusText, headers: res.headers }));
  }
  async match(k, opts) { const r = this.map.get(this.key(k)); return r ? r.clone() : undefined; }
  async delete(k) { return this.map.delete(this.key(k)); }
  async keys() { return [...this.map.keys()].map((u) => new Request(u)); }
}
class FakeCaches {
  constructor() { this.stores = new Map(); }
  async open(name) {
    if (!this.stores.has(name)) this.stores.set(name, new FakeCache(name));
    return this.stores.get(name);
  }
  async keys() { return [...this.stores.keys()]; }
  async delete(name) { return this.stores.delete(name); }
}

/* ------------------------- fake network ------------------------- */
const origin = new URL(SCOPED).origin;
const bytes = (n, seed = 1) => new Uint8Array(n).map((_, i) => (i * seed + 7) % 251);

const HLS_MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720
high/index.m3u8
`;
const HLS_MEDIA = (n) => `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-VERSION:3
#EXT-X-MAP:URI="init.mp4"
${Array.from({ length: n }, (_, i) => `#EXTINF:6.0,\nseg${i}.m4s`).join('\n')}
#EXT-X-ENDLIST
`;
const HLS_LIVE = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:6.0,
seg0.ts
#EXTINF:6.0,
seg1.ts
`;

const MPD = `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT30S" minBufferTime="PT2S">
  <BaseURL>https://cdn.test/dash/</BaseURL>
  <Period>
    <AdaptationSet mimeType="video/mp4" contentType="video" segmentAlignment="true">
      <SegmentTemplate timescale="1000" duration="6000" startNumber="1" initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/seg-$Number%03d$.m4s"/>
      <Representation id="v360" bandwidth="800000" width="640" height="360"/>
      <Representation id="v720" bandwidth="2400000" width="1280" height="720"/>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4" contentType="audio" lang="en">
      <SegmentTemplate timescale="1000" duration="6000" startNumber="1" initialization="audio/init.mp4" media="audio/seg-$Number$.m4s"/>
      <Representation id="a1" bandwidth="128000"/>
    </AdaptationSet>
  </Period>
</MPD>`;

const MPD_TIMELINE = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT10S" xmlns="urn:mpeg:dash:schema:mpd:2011">
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <SegmentTemplate initialization="i.mp4" media="t$Time$.m4s" timescale="1000">
        <SegmentTimeline>
          <S t="0" d="3000" r="2"/>
          <S d="1000"/>
        </SegmentTimeline>
      </SegmentTemplate>
      <Representation id="v" bandwidth="1000000"/>
    </AdaptationSet>
  </Period>
</MPD>`;

const MPD_NAMESPACED = MPD
  .replace('<MPD xmlns', '<mpd:MPD xmlns:mpd="urn:mpeg:dash:schema:mpd:2011" xmlns')
  .replace(/<(\/?)(MPD|BaseURL|Period|AdaptationSet|SegmentTemplate|Representation)/g, '<$1mpd:$2')
  .replace('</mpd:MPD>', '</mpd:MPD>')
  .replace('<MPD ', '<mpd:MPD ')
  .replace('<MPD>', '<mpd:MPD>');

const MPD_LIST = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT4S" xmlns="urn:mpeg:dash:schema:mpd:2011">
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <SegmentList>
        <Initialization sourceURL="init.mp4"/>
        <SegmentURL media="s1.m4s"/>
        <SegmentURL media="s2.m4s"/>
      </SegmentList>
      <Representation id="v" bandwidth="500000"/>
    </AdaptationSet>
  </Period>
</MPD>`;

const MPD_LIVE = MPD.replace('type="static"', 'type="dynamic"');
const MPD_SEGMENTBASE = MPD.replace(/<SegmentTemplate[^>]*\/>/g, '<SegmentBase indexRange="0-100"/>');

const fetchLog = [];
const network = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const method = (init.method || (typeof input === 'string' ? 'GET' : input.method) || 'GET').toUpperCase();
  const headers = new Headers(init.headers || (typeof input === 'object' && input.headers) || {});
  fetchLog.push(`${method} ${url}`);

  if (url.endsWith('/app/') || url.endsWith('index.html')) return new Response('<!doctype html><h1>app</h1>', { headers: { 'Content-Type': 'text/html' } });
  if (url.endsWith('styles.css')) return new Response('body{}', { headers: { 'Content-Type': 'text/css' } });
  if (url.endsWith('script.js')) return new Response('//app', { headers: { 'Content-Type': 'text/javascript' } });
  if (url.endsWith('.png') || url.endsWith('manifest.json')) return new Response('x', { headers: { 'Content-Type': 'application/json' } });
  if (url.endsWith('master.m3u8')) return new Response(HLS_MASTER, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
  if (url.endsWith('low/index.m3u8')) return new Response(HLS_MEDIA(5), { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
  if (url.endsWith('high/index.m3u8')) return new Response(HLS_MEDIA(5), { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
  if (url.endsWith('live.m3u8')) return new Response(HLS_LIVE, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
  if (url.endsWith('.m4s') || url.endsWith('.ts') || url.endsWith('init.mp4')) {
    const body = bytes(method === 'HEAD' ? 0 : 4096, url.length);
    const h = new Headers({ 'Content-Type': 'video/mp4', 'Content-Length': '4096', 'Access-Control-Allow-Origin': '*', 'X-From': 'network' });
    if (method === 'HEAD') return new Response(null, { headers: h, status: 200 });
    return new Response(body, { headers: h });
  }
  if (url.endsWith('movie.mp4')) {
    const h = new Headers({ 'Content-Type': 'video/mp4', 'Content-Length': '100000', 'Access-Control-Allow-Origin': '*' });
    if (method === 'HEAD') return new Response(null, { headers: h });
    return new Response(bytes(100000, 3), { headers: h });
  }
  if (url.endsWith('.mpd')) {
    const body = url.includes('timeline') ? MPD_TIMELINE
      : url.includes('live') ? MPD_LIVE
        : url.includes('segbase') ? MPD_SEGMENTBASE
          : url.includes('ns') ? MPD_NAMESPACED
            : url.includes('list') ? MPD_LIST
              : MPD;
    return new Response(body, { headers: { 'Content-Type': 'application/dash+xml', 'Access-Control-Allow-Origin': '*' } });
  }
  if (url.endsWith('blocked.mp4')) throw new TypeError('Failed to fetch (CORS)');
  return new Response('not found', { status: 404 });
};

/* ------------------------- fake SW globals ------------------------ */
const broadcast = [];
const clients = {
  matchAll: async () => [{ postMessage: (m) => broadcast.push(m) }],
  claim: async () => { },
};
const listeners = {};
let swSelf;
const sandbox = {
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  URL, URLSearchParams, Request, Response, Headers, Blob, TransformStream, ReadableStream, TextEncoder, TextDecoder,
  // NOTE: no DOMParser here on purpose — service workers do not have it.
  fetch: network,
  caches: new FakeCaches(),
  Date, Math, JSON, Number, String, Object, Array, RegExp, Error, TypeError, Promise, Set, Map, parseInt, parseFloat, isFinite, AbortController,
  structuredClone,
};
sandbox.self = {
  registration: { scope: SCOPED },
  location: new URL(SCOPED),
  clients,
  skipWaiting: async () => { swSelf.skipped = true; },
  addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
swSelf = sandbox.self;
vm.createContext(sandbox);
vm.runInContext(SW_SRC, sandbox, { filename: 'service-worker.js' });

/* ------------------------- helpers ------------------------- */
let fired = 0;
async function fire(type, event) {
  const fns = listeners[type] || [];
  const waits = [];
  const ev = { ...event, waitUntil: (p) => waits.push(p) };
  for (const fn of fns) fn(ev);
  await Promise.all(waits);
  fired++;
}
async function message(payload) {
  const fns = listeners['message'] || [];
  let result = null;
  const waits = [];
  const port = { postMessage: (d) => { result = d; } };
  const ev = { data: payload, ports: [port], waitUntil: (p) => waits.push(p) };
  for (const fn of fns) fn(ev);
  await Promise.all(waits);
  // message handlers are async internally — wait for the port reply
  for (let i = 0; i < 200 && result === null; i++) await new Promise((r) => setTimeout(r, 10));
  return result;
}
/** undici cannot build mode:'navigate' requests — emulate them for the SW. */
function makeRequest(url, init = {}) {
  if (init.mode === 'navigate') {
    return {
      url, method: init.method || 'GET', mode: 'navigate', cache: init.cache || 'default',
      headers: new Headers(init.headers || {}), destination: 'document',
    };
  }
  return new Request(url, init);
}
async function fetchEvent(url, init = {}) {
  const request = makeRequest(url, init);
  let response = null;
  const waits = [];
  const ev = { request, waitUntil: (p) => waits.push(p), respondWith: (p) => { response = p; } };
  for (const fn of listeners['fetch'] || []) fn(ev);
  await Promise.all(waits);
  return response ? await response : null;
}

const results = [];
const check = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${cond ? '' : '  → ' + extra}`);
};

/* ------------------------- tests ------------------------- */
console.log('\n— lifecycle —');
// Simulate an existing installation: shell updates must leave its offline media
// cache and download index intact.
const legacyMediaCache = await sandbox.caches.open('nebula-media-1.0.6');
legacyMediaCache.map.set('https://cdn.test/already-downloaded.mp4', new Response('saved media'));
const legacyIndexCache = await sandbox.caches.open('nebula-index-1.0.6');
legacyIndexCache.map.set(new URL('__nebula__/index.json', SCOPED).toString(),
  new Response(JSON.stringify({ version: 1, items: [] }), { headers: { 'Content-Type': 'application/json' } }));
await fire('install', {});
// Look the shell cache up by prefix so a version bump does not break the harness.
const shellCacheName = (await sandbox.caches.keys()).find((n) => n.startsWith('nebula-shell-'));
check('install completes and precaches the shell', (await sandbox.caches.open(shellCacheName)).map.size >= 8,
  String((await sandbox.caches.open(shellCacheName)).map.size));
check('install skips waiting', swSelf.skipped === true);
await fire('activate', {});
const retainedCacheNames = await sandbox.caches.keys();
const retainedMedia = await (await sandbox.caches.open('nebula-media-1.0.6'))
  .match('https://cdn.test/already-downloaded.mp4');
check('shell update preserves existing offline media and index caches',
  retainedCacheNames.includes('nebula-media-1.0.6') && retainedCacheNames.includes('nebula-index-1.0.6')
    && retainedMedia && await retainedMedia.text() === 'saved media');

console.log('\n— app shell —');
const shellRes = await fetchEvent(SCOPED, { mode: 'navigate' });
check('offline navigation returns the cached shell', shellRes && /<h1>app<\/h1>/.test(await shellRes.text()));

console.log('\n— URL analysis —');
const a1 = await message({ type: 'analyze', url: 'https://cdn.test/hls/master.m3u8', kind: 'hls' });
check('HLS analyze succeeds', a1?.ok === true, JSON.stringify(a1));
check('HLS analyze counts 3 manifests + 2 renditions × (1 init + 5 segments)', a1?.files === 15, String(a1?.files));
check('HLS analyze estimates bytes from the segments', a1?.bytes === 12 * 4096, String(a1?.bytes));
const a2 = await message({ type: 'analyze', url: 'https://cdn.test/dash/index.mpd', kind: 'dash' });
check('DASH analyze succeeds', a2?.ok === true, JSON.stringify(a2));
check('DASH analyze picks highest video + audio (1 mpd + 5+5+2 inits)', a2?.files === 13, String(a2?.files));
const a3 = await message({ type: 'analyze', url: 'https://cdn.test/hls/live.m3u8', kind: 'hls' });
check('live HLS is refused', a3?.ok === false && a3.error === 'live', JSON.stringify(a3));
const a4 = await message({ type: 'analyze', url: 'https://cdn.test/dash/segbase.mpd', kind: 'dash' });
check('SegmentBase MPD is refused with a helpful error', a4?.ok === false && /SegmentBase/i.test(a4.error), JSON.stringify(a4));
const aNs = await message({ type: 'analyze', url: 'https://cdn.test/dash/ns.mpd', kind: 'dash' });
check('namespaced MPD (mpd: prefix) parses too', aNs?.ok === true, JSON.stringify(aNs));
const aList = await message({ type: 'analyze', url: 'https://cdn.test/dash/list.mpd', kind: 'dash' });
check('SegmentList MPD is supported (1 mpd + 1 init + 2 segments)', aList?.ok === true && aList.files === 4, JSON.stringify(aList));
const a5 = await message({ type: 'analyze', url: 'https://cdn.test/movie.mp4', kind: 'progressive' });
check('progressive analyze reads Content-Length', a5?.ok === true && a5.bytes === 100000, JSON.stringify(a5));

console.log('\n— HLS download —');
const dl = await message({ type: 'download', url: 'https://cdn.test/hls/master.m3u8', kind: 'hls', title: 'HLS Demo', expect: a1.bytes, files: a1.files });
check('download starts and returns an id', dl?.ok === true && typeof dl.id === 'string', JSON.stringify(dl));
await new Promise((r) => setTimeout(r, 900));
const complete = broadcast.find((m) => m.type === 'download-complete');
check('download-complete broadcast', !!complete, JSON.stringify(broadcast.slice(-3)));
check('progress events were broadcast', broadcast.some((m) => m.type === 'download-progress'));
check('downloaded byte count covers every stored resource', complete?.bytes >= 12 * 4096, String(complete?.bytes));

const list = await message({ type: 'list-downloads' });
check('list-downloads returns the record', list?.ok && list.items.length === 1, JSON.stringify(list));
check('record keeps duration from the playlist', Math.abs(list.items[0].duration - 30) < 0.01, String(list.items[0]?.duration));
check('record stores resource paths for later matching', list.items[0].resourcePaths.length === 15, String(list.items[0].resourcePaths.length));

console.log('\n— offline playback of the stream —');
const segRes = await fetchEvent('https://cdn.test/hls/high/seg1.m4s');
check('cached segment is served offline', segRes && segRes.status === 200, segRes && segRes.status);
check('segment was served by our offline handler (Accept-Ranges added)', segRes?.headers.get('Accept-Ranges') === 'bytes');
check('segment body is intact', segRes && (await segRes.arrayBuffer()).byteLength === 4096);
const rangeRes = await fetchEvent('https://cdn.test/hls/high/seg1.m4s', { headers: { Range: 'bytes=10-19' } });
check('range request on a cached segment → 206', rangeRes?.status === 206, String(rangeRes?.status));
check('range headers are correct', rangeRes?.headers.get('Content-Range') === 'bytes 10-19/4096', rangeRes?.headers.get('Content-Range'));
check('range body length is 10 bytes', rangeRes && (await rangeRes.arrayBuffer()).byteLength === 10);
const manifestRes = await fetchEvent('https://cdn.test/hls/master.m3u8');
check('cached manifest is served offline', manifestRes && /EXTM3U/.test(await manifestRes.text()));
check('manifest also came from our handler', manifestRes?.headers.get('Accept-Ranges') === 'bytes');

console.log('\n— progressive download + synthetic URL —');
const dl2 = await message({ type: 'download', url: 'https://cdn.test/movie.mp4', kind: 'progressive', title: 'Movie', expect: 100000, files: 1 });
await new Promise((r) => setTimeout(r, 700));
const comp2 = broadcast.filter((m) => m.type === 'download-complete').pop();
check('progressive download completes', comp2?.title === 'Movie', JSON.stringify(comp2));
check('progressive byte count is the real file size', comp2?.bytes === 100000, String(comp2?.bytes));
const list2 = await message({ type: 'list-downloads' });
const movie = list2.items.find((i) => i.title === 'Movie');
check('synthetic play URL is recorded', /__nebula__\/.+\/stream$/.test(movie?.playUrl || ''), movie?.playUrl);
const streamRes = await fetchEvent(movie.playUrl);
check('synthetic stream URL plays back', streamRes?.status === 200 && (await streamRes.arrayBuffer()).byteLength === 100000);
check('whole-file response advertises Accept-Ranges', streamRes?.headers.get('Accept-Ranges') === 'bytes');
const midRes = await fetchEvent(movie.playUrl, { headers: { Range: 'bytes=500-999' } });
check('seeking works: middle range → 206 with 500 bytes', midRes?.status === 206 && (await midRes.arrayBuffer()).byteLength === 500, String(midRes?.status));
const tailRes = await fetchEvent(movie.playUrl, { headers: { Range: 'bytes=99990-' } });
check('open-ended range → correct tail slice', tailRes?.status === 206 && tailRes.headers.get('Content-Range') === 'bytes 99990-99999/100000',
  tailRes?.headers.get('Content-Range'));
const badRange = await fetchEvent(movie.playUrl, { headers: { Range: 'bytes=200000-300000' } });
check('unsatisfiable range → 416', badRange?.status === 416, String(badRange?.status));

console.log('\n— aliasing & re-downloads —');
const aliasRes = await fetchEvent('https://cdn.test/movie.mp4');
check('original URL of a stored file also plays offline (alias)', aliasRes?.status === 200 && (await aliasRes.arrayBuffer()).byteLength === 100000, String(aliasRes?.status));
const aliasRange = await fetchEvent('https://cdn.test/movie.mp4', { headers: { Range: 'bytes=0-99' } });
check('alias supports ranges too', aliasRange?.status === 206 && (await aliasRange.arrayBuffer()).byteLength === 100, String(aliasRange?.status));
await message({ type: 'download', url: 'https://cdn.test/movie.mp4', kind: 'progressive', title: 'Movie again', expect: 100000, files: 1 });
await new Promise((r) => setTimeout(r, 800));
const dedup = await message({ type: 'list-downloads' });
check('re-downloading the same URL does not duplicate the entry', dedup.items.filter((i) => i.url === 'https://cdn.test/movie.mp4').length === 1,
  JSON.stringify(dedup.items.map((i) => i.title)));

console.log('\n— failures & cleanup —');
const blocked = await message({ type: 'download', url: 'https://cdn.test/blocked.mp4', kind: 'progressive', title: 'Blocked' });
await new Promise((r) => setTimeout(r, 500));
const errEvent = broadcast.filter((m) => m.type === 'download-error').pop();
check('CORS-blocked download reports an error', errEvent?.error === 'cors', JSON.stringify(errEvent));
check('failed downloads are not listed', (await message({ type: 'list-downloads' })).items.length === 2);

const canceled = await message({ type: 'download', url: 'https://cdn.test/hls/master.m3u8', kind: 'hls', title: 'Cancel me' });
await message({ type: 'download-cancel', id: canceled.id });
await new Promise((r) => setTimeout(r, 400));
check('cancel aborts the job', broadcast.some((m) => m.type === 'download-error' && m.id === canceled.id), JSON.stringify(broadcast.filter((m) => m.type === 'download-error').map((m) => m.error)));

const freshMovie = (await message({ type: 'list-downloads' })).items.find((i) => i.title.startsWith('Movie'));
const del = await message({ type: 'delete-download', id: freshMovie.id });
check('delete-download succeeds', del?.ok === true);
const after = await message({ type: 'list-downloads' });
check('deleted video is gone from the list', after.items.length === 1, String(after.items.length));
const gone = await fetchEvent(freshMovie.playUrl);
check('deleted stream URL is no longer served', gone === null || gone.status === 404, String(gone && gone.status));

const clear = await message({ type: 'clear-downloads' });
check('clear-downloads empties the library', clear?.ok === true && (await message({ type: 'list-downloads' })).items.length === 0);

console.log('\n— misc —');
check('ping returns the version', (await message({ type: 'ping' }))?.ok === true);
check('unknown messages are rejected', (await message({ type: 'nope' }))?.ok === false);
const postRes = await fetchEvent('https://cdn.test/movie.mp4', { method: 'POST' });
check('non-GET requests are ignored by the SW', postRes === null);
const passthrough = await fetchEvent('https://cdn.test/uncached.mp4');
check('uncached cross-origin media is not intercepted (avoids CORS/Referer breakage)', passthrough === null);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log('FAILED: ' + failed.map((f) => f.name).join(', ')); process.exit(1); }
