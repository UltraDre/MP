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
check('video requests eager preloading by default', $('#video').preload === 'auto', $('#video').preload);
check('empty state visible on first run', $('#emptyState').hidden === false);
check('no "continue where you left off" card on a first run', $('#resumePrompt').hidden === true);
check('the playlist toolbar offers an alphabetical sort', $('#btnSortPlaylist') !== null);
check('movie search replaced the scan-site controls', $('#btnEmptySearch') !== null && $('#btnSearchMovies') !== null
  && $('#btnEmptyScan') === null && $('#btnScanSite') === null);
check('buffering spinner is hidden on first run', $('#spinner').hidden === true);
check('center play button is hidden until media is loaded', $('#bigPlay').hidden === true);

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
check('play/pause overlay was removed from the markup', $('#gestureFlash') === null);
$('#btnPlay').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('play button works', video.paused === false);
$('#btnPlay').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('play button pauses', video.paused === true);
await wait(1300);
check('play/pause never shows an overlay icon', $('#gestureFlash') === null);
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

console.log('\n— screen rotation —');
const rotateBtn = $('#btnRotate');
const rotStage = $('#playerStage');
const orientation = new window.EventTarget();
orientation.type = 'portrait-primary';
const locks = [];
orientation.lock = async (target) => {
  locks.push(target);
  orientation.type = `${target}-primary`;
  window.dispatchEvent(new window.Event('resize'));
};
let unlocks = 0;
orientation.unlock = () => { unlocks++; };
Object.defineProperty(window.screen, 'orientation', { configurable: true, value: orientation });
const playerColumn = $('#playerColumn');
const oldRequest = playerColumn.requestFullscreen;
const oldExit = document.exitFullscreen;
playerColumn.requestFullscreen = async () => {
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: playerColumn });
  document.dispatchEvent(new window.Event('fullscreenchange'));
};
document.exitFullscreen = async () => {
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
  document.dispatchEvent(new window.Event('fullscreenchange'));
};
rotateBtn.click();
rotateBtn.click();
await wait(0);
check('rotates the screen to landscape and ignores duplicate requests', locks.join() === 'landscape');
check('fullscreen includes the controls', document.fullscreenElement === playerColumn);
check('never transforms only the picture', !rotStage.hasAttribute('data-rot'));
check('button offers portrait next', /portrait/.test(rotateBtn.getAttribute('aria-label')) && !rotateBtn.disabled);
key('R', { shiftKey: true });
await wait(0);
check('Shift+R returns to portrait', locks.join() === 'landscape,portrait');
await document.exitFullscreen();
check('exiting fullscreen restores auto-rotation', unlocks === 1);
const loopClassBefore = document.body.className.match(/loop-\w+/)?.[0];
key('r');
check('plain R still toggles the loop mode', document.body.className.match(/loop-\w+/)?.[0] !== loopClassBefore);
orientation.lock = async () => { throw new Error('Unsupported'); };
rotateBtn.click();
await wait(0);
check('rejected rotation rolls back fullscreen and enables button', !document.fullscreenElement && !rotateBtn.disabled);
delete orientation.lock;
rotateBtn.click();
await wait(0);
check('missing API does not enter fullscreen or transform video', !document.fullscreenElement && !rotStage.hasAttribute('data-rot'));
playerColumn.requestFullscreen = oldRequest;
document.exitFullscreen = oldExit;

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
const barBeforeDbl = $('#controlsBar').classList.contains('is-hidden');
dbl();
check('dblclick toggles play/pause', video.paused !== before, `${before} → ${video.paused}`);
check('dblclick shows no play/pause overlay', $('#gestureFlash') === null);
check('dblclick does not toggle the control bar', $('#controlsBar').classList.contains('is-hidden') === barBeforeDbl);

// double-click on a control must NOT toggle playback
const pausedNow = video.paused;
$('#controlsBar').dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
check('dblclick on the control bar is ignored', video.paused === pausedNow);

// single click toggles the bar
const barHiddenBefore = $('#controlsBar').classList.contains('is-hidden');
stage.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(400);
check('single click toggles the control bar', $('#controlsBar').classList.contains('is-hidden') !== barHiddenBefore);
stage.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(400);
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

// Directional swipes on the video seek horizontally and adjust volume vertically.
stage.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300 });
const swipeTouch = (type, x, y) => {
  const ev = new window.Event(type, { bubbles: true, cancelable: true });
  const t = { identifier: 1, clientX: x, clientY: y, target: stage };
  Object.defineProperty(ev, 'touches', { value: type === 'touchend' ? [] : [t] });
  Object.defineProperty(ev, 'changedTouches', { value: [t] });
  stage.dispatchEvent(ev);
};
const swipe = (x1, y1, x2, y2) => {
  swipeTouch('touchstart', x1, y1);
  swipeTouch('touchmove', x2, y2);
  swipeTouch('touchend', x2, y2);
};
video._duration = 200;
video.currentTime = 60;
swipe(100, 150, 200, 150);
check('swipe right seeks forward continuously', Math.abs(video.currentTime - 70) < 0.01, String(video.currentTime));
check('seek swipe shows live feedback', $('#gestureHud').hidden === false && $('#gestureHudLabel').textContent === '+10s', $('#gestureHudLabel').textContent);
swipe(200, 150, 150, 150);
check('swipe left seeks backward continuously', Math.abs(video.currentTime - 65) < 0.01, String(video.currentTime));
video.volume = 0.3;
swipe(200, 150, 200, 90);
check('swipe up raises volume', Math.abs(video.volume - 0.5) < 0.01, String(video.volume));
check('volume swipe shows the new percentage', $('#gestureHudLabel').textContent === '50%', $('#gestureHudLabel').textContent);
swipe(200, 90, 200, 150);
check('swipe down lowers volume', Math.abs(video.volume - 0.3) < 0.01, String(video.volume));

console.log('\n— buffered range —');
let bufferedEnd = 120;
Object.defineProperty(video, 'buffered', {
  configurable: true,
  get() {
    return bufferedEnd === null
      ? { length: 0 }
      : { length: 1, start: () => 0, end: () => bufferedEnd };
  },
});
video._duration = 200;
video.dispatchEvent(new window.Event('progress'));
await wait(280);
check('seek bar shows the loaded range at 60 percent', $('#seek').style.getPropertyValue('--buffered') === '60%',
  $('#seek').style.getPropertyValue('--buffered'));
bufferedEnd = null;
video.dispatchEvent(new window.Event('progress'));
await wait(280);
check('buffer indicator clears when no media is buffered', $('#seek').style.getPropertyValue('--buffered') === '0%',
  $('#seek').style.getPropertyValue('--buffered'));

console.log('\n— playlist —');
const urlInput = $('#urlInput');
function submitUrl(u) {
  urlInput.value = u;
  $('#urlForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}
window.Hls = { isSupported: () => false };   // simulate a browser without MSE
video.preload = 'metadata';                 // Player.load should opt stream sources back into auto-buffering
submitUrl('https://cdn.example.com/movies/sample.m3u8');
await wait(60);
check('online stream switches the video back to eager preloading', video.preload === 'auto', video.preload);
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
await wait(300);
const storedQueue = () => (JSON.parse(window.localStorage.getItem('nebula.playlist.v1')) || { items: [] }).items;
const savedLocal = storedQueue().find((i) => i.kind === 'file');
check('a local file is saved by identity, so its queue slot survives a restart',
  !!savedLocal && savedLocal.file?.name === 'clip.mp4' && savedLocal.file?.size === 8
  && Number(savedLocal.file?.lastModified) > 0,
  JSON.stringify(savedLocal));
check('…without storing the file itself (no blob URL, no bytes)',
  !/blob:/.test(window.localStorage.getItem('nebula.playlist.v1') || '')
  && !/data:/.test(window.localStorage.getItem('nebula.playlist.v1') || ''),
  String(window.localStorage.getItem('nebula.playlist.v1')).slice(0, 220));
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

console.log('\n— online subtitle search —');
const srtOnline = '1\n00:00:01,000 --> 00:00:03,000\nHello from the internet\n\n'
  + '2\n00:00:04,000 --> 00:00:06,000\nSecond line\n';
const osRows = [
  {
    IDSubtitle: '1', IDSubtitleFile: '111', SubFileName: 'clip.en.srt', SubLanguageID: 'eng',
    LanguageName: 'English', SubFormat: 'srt', SubDownloadsCnt: '1200', SubRating: '4.2',
    ISO639: 'en', SubEncoding: 'UTF-8', SubHD: '1', SeriesSeason: '0', SeriesEpisode: '0',
  },
  {
    IDSubtitle: '2', IDSubtitleFile: '222', SubFileName: 'clip.el.srt', SubLanguageID: 'ell',
    LanguageName: 'Greek', SubFormat: 'srt', SubDownloadsCnt: '30', SubRating: '0',
    ISO639: 'el', SubEncoding: 'CP1253', SeriesSeason: '0', SeriesEpisode: '0',
  },
];
const stremioRows = {
  subtitles: [{
    lang: 'eng', subtitleFileName: 'clip.stremio.en.srt', SubEncoding: 'UTF-8',
    url: 'https://subs5.strem.io/en/download/subencoding-stremio-utf8/src-api/file/333',
  }],
};
const imdbRows = { d: [{ id: 'tt1727587', l: 'clip', qid: 'movie', rank: 100 }] };
const subCalls = [];
const bodyResponse = (obj) => {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  const bytes = new window.TextEncoder().encode(body);
  return {
    ok: true, status: 200, url: '',
    arrayBuffer: async () => bytes.buffer,
    text: async () => body,
  };
};
window.fetch = async (url) => {
  const u = String(url);
  subCalls.push(u);
  if (u.startsWith('https://rest.opensubtitles.org/')) {
    return bodyResponse(u.includes('sublanguageid-eng') ? osRows.slice(0, 1) : osRows);
  }
  if (u.startsWith('https://v3.sg.media-imdb.com/')) return bodyResponse(imdbRows);
  if (u.startsWith('https://opensubtitles-v3.strem.io/')) return bodyResponse(stremioRows);
  if (u.startsWith('https://subs5.strem.io/')) return bodyResponse(srtOnline);
  return { ok: false, status: 404, url: u, arrayBuffer: async () => new ArrayBuffer(0), text: async () => '' };
};

$('#btnSubtitleOnline').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('CC panel opens the online search dialog', $('#subSearchDialog').open === true);
check('query is prefilled from the current video', $('#subSearchQuery').value === 'clip', $('#subSearchQuery').value);
check('language defaults to the browser language', $('#subSearchLang').value === 'en', $('#subSearchLang').value);
await wait(400);
check('results from both sources are listed',
  document.querySelectorAll('#subSearchResults .sub-result').length === 2,
  String(document.querySelectorAll('#subSearchResults .sub-result').length));
check('result rows carry language + quality tags',
  /English/.test($('#subSearchResults').textContent) && /HD/.test($('#subSearchResults').textContent),
  $('#subSearchResults').textContent.slice(0, 140));
check('status line reports the counts',
  /result/i.test($('#subSearchStatus').textContent), $('#subSearchStatus').textContent);
check('OpenSubtitles was asked for the prefilled name',
  subCalls.some((u) => u.includes('/search/query-clip')), JSON.stringify(subCalls.slice(0, 2)));

// "any language" lists everything, a filter narrows it down again
$('#subSearchLang').value = '';
const callsBeforeAny = subCalls.length;
$('#subSearchForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await wait(400);
check('“any language” searches without a language filter',
  !subCalls.slice(callsBeforeAny).some((u) => u.includes('sublanguageid-')), '');
check('every language is listed', /Greek/.test($('#subSearchResults').textContent),
  $('#subSearchResults').textContent.slice(0, 160));

$('#subSearchLang').value = 'en';
$('#subSearchLang').dispatchEvent(new window.Event('change', { bubbles: true }));
$('#subSearchForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await wait(400);
check('language filter reaches the provider', subCalls.some((u) => u.includes('sublanguageid-eng')), '');
check('other languages are filtered out', !/Greek/.test($('#subSearchResults').textContent),
  $('#subSearchResults').textContent.slice(0, 160));

// one click loads the subtitle
const tracksBefore = document.querySelectorAll('#subtitleTracks li').length;
$('#subSearchResults .sub-result .sub-result-main').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(400);
const tracksAfter = document.querySelectorAll('#subtitleTracks li').length;
check('clicking a result downloads and attaches the track', tracksAfter > tracksBefore, `${tracksBefore} → ${tracksAfter}`);
check('the search dialog closes after loading', $('#subSearchDialog').open === false);
check('the new track is tagged as an online source',
  /OpenSubtitles/.test($('#subtitleTracks').textContent), $('#subtitleTracks').textContent.slice(0, 200));

// saving a result to disk
const saved = [];
window.HTMLAnchorElement.prototype.click = function click() { saved.push(this.download); };
$('#subSearchResults .sub-result [data-action="save"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(400);
check('save button writes a .srt to the device', saved.some((n) => /\.srt$/.test(String(n))), JSON.stringify(saved));

// Shift+C opens the same dialog
key('C', { shiftKey: true });
check('Shift+C opens the online search', $('#subSearchDialog').open === true);
$('#btnSubSearchCancel').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('Close button hides the dialog', $('#subSearchDialog').open === false);

console.log('\n— offline download (no service worker) —');
const dlBefore = Number($('#downloadsCount').textContent);
$('#btnDownload').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(120);
check('download without SW warns instead of crashing', logs.errors.length === 0, logs.errors.join(' | '));
check('download bar stays hidden', $('#downloadBar').hidden === true);

console.log('\n— movie search —');
$('#btnEmptySearch').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('empty-state Search movies opens the movie dialog', $('#movieSearchDialog').open === true);
$('#btnMovieSearchCancel').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
urlInput.value = 'Public Domain Sample';
$('#btnSearchMovies').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('movie name from the online field prefills search', $('#movieSearchQuery').value === 'Public Domain Sample', $('#movieSearchQuery').value);
const movieSearchCalls = [];
window.fetch = async (url) => {
  const requestUrl = String(url);
  movieSearchCalls.push(requestUrl);
  if (requestUrl.startsWith('https://archive.org/advancedsearch.php?')) {
    return {
      ok: true,
      json: async () => ({ response: { docs: [
        { identifier: 'pd-sample', title: 'Public Domain Sample', year: '1920', mediatype: 'movies', licenseurl: 'http://creativecommons.org/publicdomain/mark/1.0/' },
        { identifier: 'unlicensed-sample', title: 'Unlicensed Sample', mediatype: 'movies', licenseurl: '' },
      ] } }),
    };
  }
  if (requestUrl === 'https://archive.org/metadata/pd-sample') {
    return {
      ok: true,
      json: async () => ({ metadata: {
        title: 'Public Domain Sample', year: '1920', creator: 'Example Studio', mediatype: 'movies',
        licenseurl: 'http://creativecommons.org/publicdomain/mark/1.0/',
      }, files: [
        { name: 'feature clip.mp4', size: '4096', format: 'MPEG4', source: 'derivative' },
        { name: 'captions.srt', size: '300', format: 'SubRip', source: 'original' },
      ] }),
    };
  }
  if (requestUrl === 'https://archive.org/metadata/unlicensed-sample') {
    return {
      ok: true,
      json: async () => ({ metadata: { title: 'Unlicensed Sample', mediatype: 'movies' }, files: [{ name: 'movie.mp4' }] }),
    };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};
$('#movieSearchForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await wait(100);
const archiveSearchUrl = new URL(movieSearchCalls.find((url) => url.includes('advancedsearch.php')));
check('movie search queries licensed Internet Archive movie titles', /mediatype:movies/.test(archiveSearchUrl.searchParams.get('q'))
  && /licenseurl:\*/.test(archiveSearchUrl.searchParams.get('q')) && /title:/.test(archiveSearchUrl.searchParams.get('q')),
  archiveSearchUrl.searchParams.get('q'));
check('only a record with a declared CC/public-domain license is shown', document.querySelectorAll('#movieSearchResults .movie-result').length === 1,
  String(document.querySelectorAll('#movieSearchResults .movie-result').length));
check('movie result exposes its uploader-declared license', /Public domain/.test($('#movieSearchResults .license').textContent));
check('movie result exposes a direct stream link', $('#movieSearchResults a[href^="https://archive.org/download/"]') !== null);
$('#movieSearchResults [data-action="queue"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(300);
const movieQueue = JSON.parse(window.localStorage.getItem('nebula.playlist.v1')).items;
check('queued movie uses the direct encoded Internet Archive video URL', movieQueue.some((item) =>
  item.title === 'Public Domain Sample' && item.url === 'https://archive.org/download/pd-sample/feature%20clip.mp4' && item.type === 'progressive'),
  JSON.stringify(movieQueue.map((item) => ({ title: item.title, url: item.url, type: item.type }))));
$('#btnMovieSearchCancel').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

// Multi-catalogue search: Commons + PeerTube rows carry their own source tag
// and their direct file URLs, and the catalogue picker narrows the queries.
const comboCalls = [];
window.fetch = async (url) => {
  const requestUrl = String(url);
  comboCalls.push(requestUrl);
  if (requestUrl.startsWith('https://archive.org/advancedsearch.php?')) {
    return { ok: true, json: async () => ({ response: { docs: [] } }) };
  }
  if (requestUrl.startsWith('https://commons.wikimedia.org/w/api.php?')) {
    return {
      ok: true,
      json: async () => ({
        query: {
          pages: {
            1: {
              pageid: 1, ns: 6, title: 'File:Open Film.webm',
              imageinfo: [{
                url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Open_Film.webm?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=original',
                descriptionurl: 'https://commons.wikimedia.org/wiki/File:Open_Film.webm',
                size: 1048576, mime: 'video/webm', duration: 321.5, user: 'Example',
                extmetadata: {
                  LicenseShortName: { value: 'CC BY-SA 4.0' },
                  LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0' },
                  Artist: { value: 'Some <b>Artist</b>' },
                  DateTimeOriginal: { value: '2019-04-02' },
                },
              }],
            },
          },
        },
      }),
    };
  }
  if (requestUrl.startsWith('https://sepiasearch.org/api/v1/search/videos?')) {
    return {
      ok: true,
      json: async () => ({
        data: [{
          uuid: 'abc-123', name: 'Federated Feature', url: 'https://tube.example.org/videos/watch/abc-123',
          publishedAt: '2021-06-01T10:00:00.000Z', duration: 600, isLive: false, privacy: { id: 1 },
          licence: { id: 2, label: 'Attribution - Share Alike' }, channel: { displayName: 'Open Channel' },
          account: { host: 'tube.example.org' },
        }],
      }),
    };
  }
  if (requestUrl === 'https://tube.example.org/api/v1/videos/abc-123') {
    return {
      ok: true,
      json: async () => ({
        privacy: { id: 1 }, licence: { id: 2, label: 'Attribution - Share Alike' },
        name: 'Federated Feature', duration: 600, publishedAt: '2021-06-01T10:00:00.000Z',
        url: 'https://tube.example.org/videos/watch/abc-123', channel: { displayName: 'Open Channel' },
        files: [
          { resolution: { id: 480 }, fileUrl: 'https://tube.example.org/static/web-videos/abc-123-480.mp4', size: 1000, hasVideo: true },
          { resolution: { id: 1080 }, fileUrl: 'https://tube.example.org/static/web-videos/abc-123-1080.mp4', size: 5000, hasVideo: true },
        ],
        streamingPlaylists: [],
      }),
    };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};
$('#movieSearchSource').value = 'all';
$('#movieSearchSource').dispatchEvent(new window.Event('change', { bubbles: true }));
urlInput.value = 'Open Feature';
$('#movieSearchForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await wait(150);
const comboRows = [...document.querySelectorAll('#movieSearchResults .movie-result')];
check('every selected catalogue is searched and listed together', comboRows.length === 2, String(comboRows.length));
check('Commons results are tagged and linked to the direct upload URL',
  /Wikimedia Commons/.test($('#movieSearchResults').textContent)
  && $('#movieSearchResults a[href="https://upload.wikimedia.org/wikipedia/commons/a/ab/Open_Film.webm"]') !== null,
  $('#movieSearchResults').textContent.slice(0, 220));
check('PeerTube results resolve to the instance’s own best-quality MP4',
  /PeerTube · tube\.example\.org/.test($('#movieSearchResults').textContent)
  && $('#movieSearchResults a[href="https://tube.example.org/static/web-videos/abc-123-1080.mp4"]') !== null,
  $('#movieSearchResults').textContent.slice(0, 220));
check('Commons uploader licences are shown', /CC BY-SA 4.0/.test($('#movieSearchResults').textContent));
check('HTML in Commons metadata is flattened',
  /Some Artist/.test($('#movieSearchResults').textContent) && !/<b>/.test($('#movieSearchResults').textContent));
check('the Commons duration/size are listed', /5:21/.test($('#movieSearchResults').textContent)
  && /1\.0 MB/.test($('#movieSearchResults').textContent), $('#movieSearchResults').textContent.slice(0, 220));

const callsBeforeFilter = comboCalls.length;
$('#movieSearchSource').value = 'commons';
$('#movieSearchSource').dispatchEvent(new window.Event('change', { bubbles: true }));
await wait(150);
const filteredCalls = comboCalls.slice(callsBeforeFilter);
check('picking one catalogue queries only that catalogue',
  filteredCalls.some((url) => url.includes('commons.wikimedia.org'))
  && !filteredCalls.some((url) => url.includes('archive.org') || url.includes('sepiasearch.org')),
  JSON.stringify(filteredCalls));
check('the filtered list only holds Commons rows',
  document.querySelectorAll('#movieSearchResults .movie-result').length === 1
  && /Wikimedia Commons/.test($('#movieSearchResults').textContent),
  $('#movieSearchResults').textContent.slice(0, 180));
$('#movieSearchSource').value = 'all';
$('#movieSearchSource').dispatchEvent(new window.Event('change', { bubbles: true }));
await wait(150);
$('#btnMovieSearchCancel').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

console.log('\n— page scanning —');
window.fetch = async (url) => ({
  ok: true,
  url: String(url),
  text: async () => '<!doctype html><html><head>'
    + '<meta property="og:video" content="/media/teaser.mp4">'
    + '</head><body>'
    + '<video src="https://cdn.example.com/movies/main-feature.mp4"></video>'
    + '<a href="/trailers/preview.webm">Preview trailer</a>'
    + '<a href="/about">About this site</a>'
    + '<script>window.cfg = {"hls": "https://stream.example.com/live/playlist.m3u8?token=abc"};</scr' + 'ipt>'
    + '</body></html>',
});
urlInput.value = 'https://site.example.com/watch/123';
$('#urlForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await wait(150);
const scanTitles = [...document.querySelectorAll('#playlistList .item-title')].map((n) => n.textContent);
check('page scan queued every video found on the page', document.querySelectorAll('#playlistList .item').length === 7,
  JSON.stringify(scanTitles));
await wait(300); // playlist save is debounced
const scanUrls = JSON.parse(window.localStorage.getItem('nebula.playlist.v1')).items.map((i) => i.url);
check('scan resolved relative URLs against the page', scanUrls.includes('https://site.example.com/media/teaser.mp4')
  && scanUrls.includes('https://site.example.com/trailers/preview.webm'), JSON.stringify(scanUrls));
check('scan picked up URLs injected via script text', scanUrls.some((u) => u.includes('playlist.m3u8')), JSON.stringify(scanUrls));
check('non-media links were ignored', !scanUrls.some((u) => /about/i.test(u)), JSON.stringify(scanUrls));

// direct media links must still play immediately — never fetched as a page
const fetchedUrls = [];
window.fetch = async (url) => { fetchedUrls.push(String(url)); return { ok: false, status: 404, text: async () => '' }; };
submitUrl('https://cdn.example.com/direct.mp4');
await wait(120);
check('direct media links skip the scan', !fetchedUrls.includes('https://cdn.example.com/direct.mp4'),
  JSON.stringify(fetchedUrls));
check('direct link was added to the playlist', document.querySelectorAll('#playlistList .item').length === 8,
  String(document.querySelectorAll('#playlistList .item').length));

// a scan that fails (site blocks CORS) must not crash or add anything
window.fetch = async () => { throw new TypeError('CORS blocked'); };
const countBeforeFail = document.querySelectorAll('#playlistList .item').length;
submitUrl('https://locked.example.com/watch');
await wait(120);
check('failed scan leaves the playlist untouched', document.querySelectorAll('#playlistList .item').length === countBeforeFail);

console.log('\n— subtitle name parsing (through the UI) —');
submitUrl('https://cdn.example.com/movies/The.Matrix.1999.1080p.BluRay.x264-GRP.mp4');
await wait(120);
$('#btnSubtitleOnline').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('release tags are stripped from the prefilled query', $('#subSearchQuery').value === 'The Matrix', $('#subSearchQuery').value);
submitUrl('https://cdn.example.com/shows/Show.Name.S02E04.1080p.WEB-DL.mp4');
await wait(120);
$('#btnSubtitleOnline').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('SxxEyy fills the TV fields', $('#subSearchSeason').value === '2' && $('#subSearchEpisode').value === '4',
  `${$('#subSearchSeason').value}/${$('#subSearchEpisode').value}`);
submitUrl('https://cdn.example.com/shows/Other.Show.1x02.HDTV.mp4');
await wait(120);
$('#btnSubtitleOnline').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
check('1x02 numbering fills the TV fields too', $('#subSearchSeason').value === '1' && $('#subSearchEpisode').value === '2',
  `${$('#subSearchSeason').value}/${$('#subSearchEpisode').value}`);
$('#btnSubSearchCancel').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

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

console.log('\n— resume positions —');
const resumeItem = 'https://cdn.example.com/resume-me.mp4';
submitUrl(resumeItem);
await wait(80);
video._duration = 600;
video.dispatchEvent(new window.Event('play'));   // mark the item as watched
video.currentTime = 240;
video.dispatchEvent(new window.Event('pause'));
await wait(500);                                 // position writes are debounced
const resumeRaw = JSON.parse(window.localStorage.getItem('nebula.resume.v1')) || { items: {} };
const storedMark = resumeRaw.items[`url:${resumeItem}`] || {};
check('pausing stores the position keyed by the media URL',
  Math.abs(storedMark.t - 240) < 0.01, JSON.stringify(resumeRaw.items).slice(0, 220));
check('the stored mark also carries the duration and a timestamp',
  Math.abs(storedMark.d - 600) < 0.01 && storedMark.at > 0, JSON.stringify(storedMark));

submitUrl('https://cdn.example.com/something-else.mp4');
await wait(80);
submitUrl(resumeItem);
await wait(80);
video.dispatchEvent(new window.Event('loadedmetadata'));
check('re-opening the item resumes where it stopped', Math.abs(video.currentTime - 240) < 0.01, String(video.currentTime));

video._duration = 600;
video.currentTime = 598;
video.dispatchEvent(new window.Event('pause'));
await wait(500);
const afterFinish = JSON.parse(window.localStorage.getItem('nebula.resume.v1')) || { items: {} };
check('watching an item to the end clears its resume mark', !(`url:${resumeItem}` in afterFinish.items),
  JSON.stringify(afterFinish.items).slice(0, 220));

console.log('\n— buffering ahead while paused —');
const hlsConfigs = [];
let hlsKicks = 0;
window.Hls = class FakeHls {
  constructor(config) {
    this.config = config;
    this.handlers = {};
    this.levels = [{}];        // as if the manifest had already been parsed
    hlsConfigs.push(config);
  }
  static isSupported() { return true; }
  on(evt, fn) { (this.handlers[evt] = this.handlers[evt] || []).push(fn); }
  once(evt, fn) { this.on(evt, fn); }
  emit(evt, data) { (this.handlers[evt] || []).slice().forEach((fn) => fn({ type: evt }, data)); }
  loadSource(url) { this.url = url; }
  attachMedia(el) { this.media = el; setTimeout(() => this.emit('manifest_parsed', { levels: [{}, {}] }), 0); }
  startLoad() { hlsKicks += 1; }
  destroy() {}
  get mainForwardBufferInfo() { return { len: 10, end: 12 }; }
};
window.Hls.Events = { ERROR: 'hlsError', MANIFEST_PARSED: 'manifest_parsed', LEVEL_LOADED: 'level_loaded' };
window.Hls.ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' };

submitUrl('https://cdn.example.com/stream/keeps-loading.m3u8');
await wait(150);
const hlsConfig = hlsConfigs[0] || {};
check('an attached hls stream starts with the lean forward buffer', hlsConfig.maxBufferLength === 60,
  String(hlsConfig.maxBufferLength));

video.dispatchEvent(new window.Event('pause'));
check('pausing expands the hls forward buffer so it keeps downloading ahead',
  hlsConfig.maxBufferLength === 300 && hlsConfig.maxMaxBufferLength === 3600 && hlsConfig.maxBufferSize === 300e6,
  JSON.stringify({ maxBufferLength: hlsConfig.maxBufferLength, maxBufferSize: hlsConfig.maxBufferSize }));
check('pausing nudges hls to keep loading', hlsKicks >= 1, String(hlsKicks));

video.dispatchEvent(new window.Event('play'));
check('resuming drops back to the lean window', hlsConfig.maxBufferLength === 60, String(hlsConfig.maxBufferLength));

/* The option turns the paused expansion off without touching normal playback. */
$('#optPrebuffer').checked = false;
$('#optPrebuffer').dispatchEvent(new window.Event('change', { bubbles: true }));
video.dispatchEvent(new window.Event('pause'));
check('the option can disable the paused expansion', hlsConfig.maxBufferLength === 60, String(hlsConfig.maxBufferLength));
$('#optPrebuffer').checked = true;
$('#optPrebuffer').dispatchEvent(new window.Event('change', { bubbles: true }));
video.dispatchEvent(new window.Event('play'));   // stops the keep-alive timer
await wait(300);                                 // settings writes are debounced
check('the option is stored in settings',
  JSON.parse(window.localStorage.getItem('nebula.settings.v1')).prebufferWhilePaused === true);

console.log('\n— playlist sorting —');
const rows = () => [...document.querySelectorAll('#playlistList .item')];
const titles = () => rows().map((li) => li.querySelector('.item-title').textContent);
// every row is persisted now (local files by identity), so saved order and the
// order on screen must match exactly — nothing may be dropped or re-sorted
const savedTitles = () => (JSON.parse(window.localStorage.getItem('nebula.playlist.v1')) || { items: [] }).items.map((i) => i.title);
const onDiskTitles = () => rows().map((li) => li.querySelector('.item-title').textContent);
const click = (sel) => $(sel).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const queueUrl = (u) => {
  urlInput.value = u;
  $('#btnQueueUrl').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
};
const added = ['Zebra.mp4', 'Episode 10.mp4', 'Apple.mp4', 'Episode 2.mp4'];
added.forEach((t) => queueUrl('https://cdn.example.com/' + encodeURIComponent(t)));
await wait(60);
check('items stay in the order they were added (sorting is opt-in)',
  titles().slice(-added.length).join('|') === added.join('|'), titles().slice(-added.length).join('|'));
click(`#playlistList .item:nth-child(${titles().indexOf('Apple.mp4') + 1}) .item-main`);   // make one row current
await wait(60);
click('#btnSortPlaylist');
await wait(60);
const sorted = titles();
const at = (t) => sorted.indexOf(t);
check('Sort A–Z puts the queue in alphabetical order',
  at('Apple.mp4') < at('Episode 10.mp4') && at('Episode 10.mp4') < at('Zebra.mp4'), sorted.join('|'));
check('numbered titles sort naturally, not character by character (2 before 10)',
  at('Episode 2.mp4') < at('Episode 10.mp4'), sorted.join('|'));
check('the playing row keeps its highlight through a sort',
  document.querySelector('#playlistList .item.is-current .item-title')?.textContent === 'Apple.mp4',
  String(document.querySelector('#playlistList .item.is-current .item-title')?.textContent));
await wait(300);
check('the sorted order is what gets saved', savedTitles().join('|') === onDiskTitles().join('|'),
  `${savedTitles().join('|')} vs ${onDiskTitles().join('|')}`);
const movedFrom = titles();
const appleRow = movedFrom.indexOf('Apple.mp4') + 1;
click(`#playlistList .item:nth-child(${appleRow}) [data-action="down"]`);
await wait(60);
const moved = titles();
check('manual reordering still works after a sort',
  moved[appleRow - 1 + 1] === 'Apple.mp4' && moved[appleRow - 1] === movedFrom[appleRow],
  `${movedFrom.join('|')} → ${moved.join('|')}`);
await wait(300);
check('the manual order is saved too — nothing re-sorts behind the user',
  savedTitles().join('|') === onDiskTitles().join('|'), `${savedTitles().join('|')} vs ${onDiskTitles().join('|')}`);
click('#btnSortPlaylist');
await wait(60);
check('pressing Sort A–Z again restores alphabetical order', titles().join('|') === sorted.join('|'), titles().join('|'));

console.log('\n— saving on close —');
urlInput.value = 'https://cdn.example.com/added-then-closed.mp4';
$('#urlForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));   // add + play
video._duration = 600;
video.currentTime = 333;                          // …and walk away mid-playback
check('the newest item is not on disk yet (its write is debounced)',
  !savedTitles().includes('added-then-closed.mp4'), savedTitles().join('|'));
window.dispatchEvent(new window.Event('pagehide'));   // no waiting for the debounce
const closed = JSON.parse(window.localStorage.getItem('nebula.playlist.v1'));
check('pagehide flushes the queued playlist write', closed.items.some((i) => i.title === 'added-then-closed.mp4'),
  JSON.stringify(closed.items.map((i) => i.title)));
check('pagehide also stores which title was open',
  closed.currentId === (closed.items.find((i) => i.title === 'added-then-closed.mp4') || {}).id,
  `${closed.currentId} vs ${JSON.stringify(closed.items.map((i) => [i.id, i.title]))}`);
const closedMarks = JSON.parse(window.localStorage.getItem('nebula.resume.v1')).items;
check('pagehide flushes the playback position',
  Math.abs((closedMarks['url:https://cdn.example.com/added-then-closed.mp4'] || {}).t - 333) < 0.01,
  JSON.stringify(closedMarks).slice(0, 240));

console.log('\n— errors —');
const realErrors = logs.errors.filter((e) => !/Not implemented|Could not parse CSS|jsdom|Could not load script|resource/i.test(e));
check('no uncaught runtime errors', realErrors.length === 0, realErrors.join(' | '));
if (logs.warns.length) console.log('  (warnings: ' + logs.warns.slice(0, 6).join(' | ') + ')');

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log('FAILED: ' + failed.map((f) => f.name).join(', ')); process.exit(1); }
