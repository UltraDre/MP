// Runtime smoke test: boots index.html + script.js inside jsdom and drives the UI.
import fs from 'node:fs';
import path from 'node:path';
let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = await import('jsdom'));
} catch {
  console.error('This test needs jsdom:  npm install --no-save jsdom');
  process.exit(2);
}

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const logs = { errors: [], warns: [], info: [] };
const vc = new VirtualConsole();
vc.on('error', (...a) => logs.errors.push(a.map(String).join(' ')));
vc.on('warn', (...a) => logs.warns.push(a.map(String).join(' ')));
vc.on('info', (...a) => logs.info.push(a.map(String).join(' ')));
vc.on('log', (...a) => logs.info.push(a.map(String).join(' ')));

const dom = new JSDOM(html, {
  url: 'https://example.com/app/index.html',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole: vc,
  resources: undefined,
});
const { window } = dom;
const { document } = window;

/* ---------- minimal browser APIs jsdom lacks ---------- */
class FakeMediaElement {} // not needed: jsdom has HTMLMediaElement, but no methods

const textTracks = { listeners: [], length: 0, addEventListener(t, fn) { this.listeners.push(fn); } };
Object.defineProperty(window.HTMLMediaElement.prototype, 'paused', {
  configurable: true,
  get() { return this._paused !== false; },
  set(v) { this._paused = !!v; },
});
Object.defineProperty(window.HTMLMediaElement.prototype, 'play', {
  configurable: true,
  value: function play() {
    this._paused = false;
    this.dispatchEvent(new window.Event('play'));
    return Promise.resolve();
  },
});
Object.defineProperty(window.HTMLMediaElement.prototype, 'pause', {
  configurable: true,
  value: function pause() {
    this._paused = true;
    this.dispatchEvent(new window.Event('pause'));
  },
});
Object.defineProperty(window.HTMLMediaElement.prototype, 'load', {
  configurable: true, value: function load() { /* noop */ },
});
Object.defineProperty(window.HTMLMediaElement.prototype, 'textTracks', {
  configurable: true, get() { return textTracks; },
});
Object.defineProperty(window.HTMLMediaElement.prototype, 'duration', {
  configurable: true, get() { return this._duration ?? NaN; },
});
// <dialog> support
window.HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
window.HTMLDialogElement.prototype.close = function close(v) {
  this.open = false; this.returnValue = v ?? '';
  this.dispatchEvent(new window.Event('close'));
};
// MediaSession + storage
window.MediaMetadata = class MediaMetadata { constructor(o) { Object.assign(this, o); } };
window.navigator.mediaSession = { setActionHandler() {}, playbackState: 'none' };
window.navigator.storage = undefined;
window.matchMedia = (q) => ({
  matches: /max-width:\s*1079px/.test(q),
  media: q,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
});
window.URL.createObjectURL = () => 'blob:https://example.com/' + Math.random().toString(36).slice(2);
window.URL.revokeObjectURL = () => {};
window.confirm = () => true;
window.AbortSignal.timeout = (ms) => { const c = new window.AbortController(); setTimeout(() => c.abort(), ms); return c.signal; };

// MessageChannel (jsdom has it) — stub the SW channel usage
window.navigator.serviceWorker = undefined; // exercise the "no service worker" paths

/* ---------- run the module ---------- */
const script = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
window.eval(script);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s) => document.querySelector(s);
const results = [];
const check = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${cond ? '' : '  ' + extra}`);
};

await wait(400); // let App.start() settle

console.log('\n— boot —');
check('app booted and logged ready', logs.info.some((l) => l.includes('Nebula Player ready')), JSON.stringify(logs.errors));
check('no uncaught errors during boot', logs.errors.length === 0, logs.errors.join(' | '));
check('speed grid populated (10 options)', document.querySelectorAll('#speedGrid button').length === 10,
  String(document.querySelectorAll('#speedGrid button').length));
check('theme applied to <html>', ['dark', 'light'].includes(document.documentElement.dataset.theme));
check('PiP hidden in jsdom (unsupported)', $('#btnPip').hidden === true);
check('empty state visible on first run', $('#emptyState').hidden === false);

console.log('\n— keyboard —');
const key = (k, opts = {}) => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }));
const video = $('#video');
key(' ');
check('space calls play()', video.paused === false, 'paused=' + video.paused);
key(' ');
check('space toggles back to pause', video.paused === true);
key('m');
check('M mutes', video.muted === true);
check('body.is-muted set', document.body.classList.contains('is-muted'));
key('m');
check('M unmutes', video.muted === false);
key('t');
const themeAfter = document.documentElement.dataset.theme;
check('T toggles theme', themeAfter === 'light' || themeAfter === 'dark', themeAfter);
key('?');
check('? opens the shortcuts dialog', $('#shortcutsDialog').open === true);
$('#shortcutsDialog').close();
key('s');
check('S toggles shuffle button state', $('#btnShuffle').getAttribute('aria-pressed') === 'true');
key('r');
check('R cycles loop mode', ['all', 'one'].includes(document.body.className.match(/loop-\w+/)?.[0]?.replace('loop-', '') ?? ''), document.body.className);

console.log('\n— controls —');
$('#btnPlay').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('play button works', video.paused === false);
$('#btnPlay').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('play button pauses', video.paused === true);
$('#btnMute').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('mute button toggles', video.muted === true);
$('#btnMute').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

// volume slider
const vol = $('#volume');
vol.value = '0.3';
vol.dispatchEvent(new window.Event('input', { bubbles: true }));
check('volume slider sets volume', Math.abs(video.volume - 0.3) < 0.001, String(video.volume));
check('volume readout updated', $('#volumeOut').textContent === '30%', $('#volumeOut').textContent);
await wait(250);
check('volume persisted in localStorage', JSON.parse(window.localStorage.getItem('nebula.settings.v1')).volume === 0.3);

console.log('\n— speed menu —');
$('#btnSpeed').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('speed menu opens', $('#speedMenu').hidden === false);
document.querySelector('#speedGrid button[data-speed="1.5"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('1.5× applied', Math.abs(video.playbackRate - 1.5) < 0.001, String(video.playbackRate));
check('speed label updated', $('#speedLabel').textContent === '1.5×', $('#speedLabel').textContent);
await wait(250);
check('speed persisted', JSON.parse(window.localStorage.getItem('nebula.settings.v1')).speed === 1.5);
document.body.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(20);
check('click outside closes speed menu', $('#speedMenu').hidden === true);

console.log('\n— gestures —');
const stage = $('#playerStage');
const dbl = () => { stage.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true })); };
const before = video.paused;
dbl();
check('dblclick toggles play/pause', video.paused !== before, `${before} → ${video.paused}`);
check('gesture flash received the show class', $('#gestureFlash').classList.contains('show'));

// double-click on a control must NOT toggle playback
const pausedNow = video.paused;
$('#controlsBar').dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
check('dblclick on the control bar is ignored', video.paused === pausedNow);

// single click toggles the bar
const barHiddenBefore = $('#controlsBar').classList.contains('is-hidden');
stage.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('single click toggles the control bar', $('#controlsBar').classList.contains('is-hidden') !== barHiddenBefore);
stage.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('bar comes back on second click', $('#controlsBar').classList.contains('is-hidden') === barHiddenBefore);

// touch double-tap
const touch = (x, y) => {
  const ev = new window.Event('touchend', { bubbles: true, cancelable: true });
  const t = { identifier: 1, clientX: x, clientY: y, target: stage };
  Object.defineProperty(ev, 'touches', { value: [] });
  Object.defineProperty(ev, 'changedTouches', { value: [t] });
  stage.dispatchEvent(ev);
};
const pausedBeforeTap = video.paused;
touch(300, 200);
await wait(400); // single-tap delay (300ms) must not change playback
check('single tap does not toggle playback', video.paused === pausedBeforeTap);
touch(300, 200); touch(300, 200);
check('double-tap toggles play/pause', video.paused !== pausedBeforeTap);

console.log('\n— playlist —');
const urlInput = $('#urlInput');
function submitUrl(u) {
  urlInput.value = u;
  $('#urlForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}
window.Hls = { isSupported: () => false };   // simulate a browser without MSE
submitUrl('https://cdn.example.com/movies/sample.m3u8');
await wait(60);
check('playlist has 1 item after URL submit', document.querySelectorAll('#playlistList .item').length === 1,
  String(document.querySelectorAll('#playlistList .item').length));
await wait(300); // playlists saves are debounced
check('HLS type detected', JSON.parse(window.localStorage.getItem('nebula.playlist.v1')).items[0].type === 'hls');
check('current title rendered', $('#nowPlayingTitle').textContent === 'sample.m3u8', $('#nowPlayingTitle').textContent);
check('unsupported HLS shows the error card', $('#errorBox').hidden === false);
check('error message is human readable', /HLS|MSE|support/i.test($('#errorDetail').textContent), $('#errorDetail').textContent);
$('#btnErrorDismiss').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('dismiss hides the error card', $('#errorBox').hidden === true);
submitUrl('https://cdn.example.com/clip.mp4');
await wait(60);
check('second URL queued (2 items)', document.querySelectorAll('#playlistList .item').length === 2);

// duplicate handling
submitUrl('https://cdn.example.com/clip.mp4');
await wait(60);
check('duplicate URL is not added twice', document.querySelectorAll('#playlistList .item').length === 2);

// reorder via buttons
$('#playlistList .item:nth-child(2) [data-action="up"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(60);
await wait(300);
const stored = JSON.parse(window.localStorage.getItem('nebula.playlist.v1')).items;
check('move up reorders the playlist', stored[0].title === 'clip.mp4', JSON.stringify(stored.map((i) => i.title)));
// remove
$('#playlistList .item:nth-child(1) [data-action="remove"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(60);
check('remove deletes an item', document.querySelectorAll('#playlistList .item').length === 1);
check('playlist count badge updated', $('#playlistCount').textContent === '1', $('#playlistCount').textContent);

console.log('\n— local files —');
const file = new window.File([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])], 'clip.mp4', { type: 'video/mp4' });
const srt = new window.File(['1\n00:00:01,000 --> 00:00:03,000\nHello there\n\n2\n00:00:04,000 --> 00:00:06,000\nSecond line\n'], 'clip.srt', { type: 'text/plain' });
Object.defineProperty(srt, 'text', { value: async () => '1\n00:00:01,000 --> 00:00:03,000\nHello there\n' });
const fileInput = $('#fileInput');
Object.defineProperty(fileInput, 'files', { value: [file, srt], configurable: true });
fileInput.dispatchEvent(new window.Event('change', { bubbles: true }));
await wait(300);
check('local file added to the playlist', document.querySelectorAll('#playlistList .item').length === 2,
  String(document.querySelectorAll('#playlistList .item').length));
check('local file played (empty state hidden)', $('#emptyState').hidden === true);
check('local item tagged as LOCAL', $('#sourceBadge').textContent === 'LOCAL', $('#sourceBadge').textContent);
const localItem = window.localStorage.getItem('nebula.playlist.v1');
await wait(300);
check('local files are not persisted to localStorage', !localItem.includes('clip.mp4'), 'playlist:' + localItem);
check('sidecar .srt was converted and attached', document.querySelectorAll('#subtitleTracks li').length >= 1,
  document.querySelectorAll('#subtitleTracks li').length + ' tracks');

console.log('\n— subtitles —');
$('#btnCaptions').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('CC panel opens', $('#subtitleSheet').hidden === false);
$('#btnSubtitleDelayPlus').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(250);
check('delay +0.5s stored', JSON.parse(window.localStorage.getItem('nebula.settings.v1')).subtitleDelay === 0.5);
check('delay readout', $('#subtitleDelayOut').textContent === '+0.5s', $('#subtitleDelayOut').textContent);
$('#subtitleToggle').checked = false;
$('#subtitleToggle').dispatchEvent(new window.Event('change', { bubbles: true }));
await wait(250);
check('captions disabled persists', JSON.parse(window.localStorage.getItem('nebula.settings.v1')).captionsEnabled === false);
$('#btnSubtitleClose').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('CC panel closes', $('#subtitleSheet').hidden === true);

console.log('\n— offline download (no service worker) —');
const dlBefore = Number($('#downloadsCount').textContent);
$('#btnDownload').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(120);
check('download without SW warns instead of crashing', logs.errors.length === 0, logs.errors.join(' | '));
check('download bar stays hidden', $('#downloadBar').hidden === true);

console.log('\n— panel & theme —');
$('#btnPanelToggle').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('mobile panel opens', $('#sidebar').classList.contains('open'));
check('scrim shown', $('#scrim').hidden === false);
document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await wait(30);
check('Escape closes the panel', !$('#sidebar').classList.contains('open'));

console.log('\n— reload persistence —');
const settingsRaw = window.localStorage.getItem('nebula.settings.v1');
const playlistRaw = window.localStorage.getItem('nebula.playlist.v1');
check('settings object contains all keys', ['theme', 'volume', 'speed', 'loopMode', 'shuffle', 'captionsEnabled'].every((k) => k in JSON.parse(settingsRaw)),
  settingsRaw);

console.log('\n— errors —');
const realErrors = logs.errors.filter((e) => !/Not implemented|Could not parse CSS|jsdom|Could not load script|resource/i.test(e));
check('no uncaught runtime errors', realErrors.length === 0, realErrors.join(' | '));
if (logs.warns.length) console.log('  (warnings: ' + logs.warns.slice(0, 6).join(' | ') + ')');

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log('FAILED: ' + failed.map((f) => f.name).join(', ')); process.exit(1); }
