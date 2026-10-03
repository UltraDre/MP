// Persistence test: boots the app in jsdom *on top of* a localStorage state left
// behind by an earlier session, and checks what comes back: the queue, its saved
// order, the title that was last open, and where that title was stopped.
//
// It also pins the "close the app at any moment" guarantee: the debounced
// localStorage writers are flushed by the pagehide/hidden handlers, so a change
// made a millisecond before the app disappears is still on disk — no debounce
// wait, no lost write.
//
//   node tests/persistence.test.mjs        (needs: npm install --no-save jsdom)
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
const script = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');

const PLAYLIST_KEY = 'nebula.playlist.v1';
const RESUME_KEY = 'nebula.resume.v1';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${cond ? '' : '  ' + extra}`);
};

/**
 * A fresh "second run" of the app: seed storage, then boot it.
 * `seed` keys are the raw localStorage payloads, so the app is tested against
 * exactly what a previous session would have written.
 */
function boot(seed = {}) {
  const logs = { errors: [], warns: [] };
  const vc = new VirtualConsole();
  vc.on('error', (...a) => logs.errors.push(a.map(String).join(' ')));
  const realErrors = () => logs.errors.filter((e) => !/Not implemented|Could not parse CSS|jsdom|Could not load script|resource/i.test(e));
  vc.on('warn', (...a) => logs.warns.push(a.map(String).join(' ')));

  const dom = new JSDOM(html, {
    url: 'https://example.com/app/index.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const { window } = dom;
  const { document } = window;

  /* ---------- the few browser APIs jsdom lacks (same set as ui-smoke) ---------- */
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
  Object.defineProperty(window.HTMLMediaElement.prototype, 'load', { configurable: true, value: function load() {} });
  Object.defineProperty(window.HTMLMediaElement.prototype, 'textTracks', { configurable: true, get() { return textTracks; } });
  Object.defineProperty(window.HTMLMediaElement.prototype, 'duration', { configurable: true, get() { return this._duration ?? NaN; } });
  window.HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
  window.HTMLDialogElement.prototype.close = function close(v) {
    this.open = false; this.returnValue = v ?? '';
    this.dispatchEvent(new window.Event('close'));
  };
  window.MediaMetadata = class MediaMetadata { constructor(o) { Object.assign(this, o); } };
  window.navigator.mediaSession = { setActionHandler() {}, playbackState: 'none' };
  window.navigator.storage = undefined;
  window.navigator.serviceWorker = undefined;
  window.matchMedia = (q) => ({
    matches: /max-width:\s*1079px/.test(q),
    media: q,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
  window.URL.createObjectURL = () => 'blob:https://example.com/' + Math.random().toString(36).slice(2);
  window.URL.revokeObjectURL = () => {};
  window.confirm = () => true;
  window.AbortSignal.timeout = (ms) => { const c = new window.AbortController(); setTimeout(() => c.abort(), ms); return c.signal; };

  for (const [key, value] of Object.entries(seed)) {
    window.localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  window.eval(script);
  return { window, document, logs, errors: realErrors, $: (s) => document.querySelector(s) };
};

/** The queue an earlier session left behind: two titles, "Zebra" was the open one. */
const zebraUrl = 'https://cdn.example.com/zebra.mp4';
const previousSession = {
  [PLAYLIST_KEY]: {
    version: 1,
    currentId: 'zebra',
    items: [
      { id: 'zebra', kind: 'remote', title: 'Zebra movie.mp4', url: zebraUrl, type: 'progressive', offline: false, addedAt: 1 },
      { id: 'apple', kind: 'remote', title: 'Apple movie.mp4', url: 'https://cdn.example.com/apple.mp4', type: 'progressive', offline: false, addedAt: 2 },
    ],
  },
  [RESUME_KEY]: {
    version: 1,
    items: { [`url:${zebraUrl}`]: { t: 123.4, d: 600, at: Date.now() } },
  },
};

/* =====================================================================
 * 1. Reopening the app picks up where it was closed
 * ===================================================================*/
console.log('\n— reopening where the app was left —');
{
  const { window, $, errors } = boot(previousSession);
  const doc = window.document;
  await wait(400);

  const rows = [...doc.querySelectorAll('#playlistList .item')];
  check('the saved queue is back', rows.length === 2, String(rows.length));
  check('the previously open title is still marked current', rows[0]?.classList.contains('is-current'),
    rows.map((r) => r.className).join(' | '));
  check('nothing was loaded or buffered just because a title was remembered',
    $('#video').getAttribute('src') === null && $('#emptyState').hidden === false);

  check('the empty state offers the last title back', $('#resumePrompt').hidden === false);
  check('the offer names the title', /Zebra movie\.mp4/.test($('#resumePromptText').textContent), $('#resumePromptText').textContent);
  check('the offer shows the stored position', /2:03/.test($('#resumePromptText').textContent), $('#resumePromptText').textContent);

  $('#btnResumePlay').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(60);
  const video = $('#video');
  check('Resume opens that title', String(video.getAttribute('src') || '').includes('zebra.mp4'), String(video.getAttribute('src')));
  video._duration = 600;
  video.dispatchEvent(new window.Event('loadedmetadata'));
  await wait(30);
  check('and it starts where the last session stopped', Math.abs(video.currentTime - 123.4) < 0.01, String(video.currentTime));
  check('the offer is gone once something is playing', $('#resumePrompt').hidden === true);

  check('no uncaught errors while restoring', errors().length === 0, errors().join(' | '));
}

/* =====================================================================
 * 2. "Start over" forgets the position instead of resuming
 * ===================================================================*/
console.log('\n— start over —');
{
  const { window, $ } = boot(previousSession);
  await wait(400);
  $('#btnResumeRestart').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(60);
  const video = $('#video');
  video._duration = 600;
  video.dispatchEvent(new window.Event('loadedmetadata'));
  await wait(30);
  check('Start over begins at 0', video.currentTime === 0, String(video.currentTime));
  await wait(500);
  const resume = JSON.parse(window.localStorage.getItem(RESUME_KEY) || '{}');
  check('Start over drops the saved position', !(resume.items || {})[`url:${zebraUrl}`], JSON.stringify(resume));
}

/* =====================================================================
 * 3. A change made right before the app is closed is still written
 * ===================================================================*/
console.log('\n— saving without waiting —');
{
  const { window, $ } = boot({});                       // first run: nothing stored yet
  const doc = window.document;
  await wait(400);
  const video = $('#video');
  const urlInput = $('#urlInput');
  const submit = (u) => {
    urlInput.value = u;
    $('#urlForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  };

  // The playlist save is debounced by 200 ms; this closes the app inside that window.
  submit('https://cdn.example.com/just-added.mp4');
  video._duration = 600;
  video.dispatchEvent(new window.Event('play'));         // playing when the app disappears
  video.currentTime = 321;
  check('a write is still in the debounce window (the test is meaningful)',
    !JSON.parse(window.localStorage.getItem(PLAYLIST_KEY) || '{"items":[]}').items.some((i) => i.url.includes('just-added')));

  window.dispatchEvent(new window.Event('pagehide'));
  const stored = JSON.parse(window.localStorage.getItem(PLAYLIST_KEY) || '{}');
  const items = stored.items || [];
  const mark = (key) => ((JSON.parse(window.localStorage.getItem(RESUME_KEY) || '{}').items || {})[key] || {});
  check('pagehide flushes a newly added item immediately',
    items.some((i) => i.url === 'https://cdn.example.com/just-added.mp4'), window.localStorage.getItem(PLAYLIST_KEY));
  check('pagehide also stores which title is open', !!items.length && stored.currentId === items[0].id,
    `${stored.currentId} vs ${(items[0] || {}).id}`);
  check('pagehide flushes the playback position immediately', Math.abs(mark('url:https://cdn.example.com/just-added.mp4').t - 321) < 0.01,
    JSON.stringify(mark('url:https://cdn.example.com/just-added.mp4')));

  // Backgrounding on a phone must save too — that is often the last event an app gets.
  submit('https://cdn.example.com/second-added.mp4');
  video.currentTime = 400;
  Object.defineProperty(doc, 'visibilityState', { configurable: true, get: () => 'hidden' });
  doc.dispatchEvent(new window.Event('visibilitychange'));
  const stored2 = JSON.parse(window.localStorage.getItem(PLAYLIST_KEY) || '{}');
  const marks2 = (JSON.parse(window.localStorage.getItem(RESUME_KEY) || '{}').items) || {};
  check('hiding the tab saves the queue as well', (stored2.items || []).length === 2, JSON.stringify((stored2.items || []).map((i) => i.title)));
  check('hiding the tab saves the position as well', Math.abs((marks2['url:https://cdn.example.com/second-added.mp4'] || {}).t - 400) < 0.01,
    JSON.stringify(marks2));

  // …and the next launch sees everything the closing one wrote.
  const bootSeed = {
    [PLAYLIST_KEY]: JSON.parse(window.localStorage.getItem(PLAYLIST_KEY) || 'null'),
    [RESUME_KEY]: JSON.parse(window.localStorage.getItem(RESUME_KEY) || 'null'),
  };
  const next = boot(bootSeed);
  await wait(400);
  check('the next launch restores both items', next.document.querySelectorAll('#playlistList .item').length === 2,
    String(next.document.querySelectorAll('#playlistList .item').length));
  const prompt = next.$('#resumePromptText').textContent;
  check('the next launch offers the second title back', /second-added\.mp4/.test(prompt), prompt);
  check('…at the position the close saved (6:40)', /6:40/.test(prompt), prompt);
}

/* =====================================================================
 * 4. A remembered title that no longer exists does not haunt the app
 * ===================================================================*/
console.log('\n— stale / broken storage —');
{
  const { window, $, errors } = boot({
    [PLAYLIST_KEY]: {
      version: 1,
      currentId: 'gone',
      items: [{ id: 'kept', kind: 'remote', title: 'Kept.mp4', url: 'https://cdn.example.com/kept.mp4', type: 'progressive' }],
    },
  });
  await wait(400);
  check('a current id that is not in the list is ignored', $('#resumePrompt').hidden === true);
  check('the rest of the playlist still loads', window.document.querySelectorAll('#playlistList .item').length === 1);

  const broken = boot({ [PLAYLIST_KEY]: '{not json', [RESUME_KEY]: '[]' });
  await wait(300);
  check('unreadable storage does not stop the app from booting',
    broken.$('#playlistList') !== null && broken.errors().length === 0, broken.errors().join(' | '));
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log('FAILED: ' + failed.map((f) => f.name).join(', ')); process.exit(1); }
