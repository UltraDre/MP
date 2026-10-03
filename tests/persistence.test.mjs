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
function boot(seed = {}, pageHtml = html) {
  const logs = { errors: [], warns: [] };
  const vc = new VirtualConsole();
  vc.on('error', (...a) => logs.errors.push(a.map(String).join(' ')));
  const realErrors = () => logs.errors.filter((e) => !/Not implemented|Could not parse CSS|jsdom|Could not load script|resource/i.test(e));
  vc.on('warn', (...a) => logs.warns.push(a.map(String).join(' ')));

  const dom = new JSDOM(pageHtml, {
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

/* =====================================================================
 * 5. A whole session, end to end: import → watch → close → reopen
 *    (nothing here is hand-seeded — run 2 boots on exactly what run 1 wrote)
 * ===================================================================*/
console.log('\n— a real session, start to finish —');
{
  const carry = (win) => ({
    [PLAYLIST_KEY]: JSON.parse(win.localStorage.getItem(PLAYLIST_KEY) || 'null'),
    [RESUME_KEY]: JSON.parse(win.localStorage.getItem(RESUME_KEY) || 'null'),
  });
  const mkFile = (win, name, payload) => {
    const f = new win.File([payload], name, { type: 'application/json' });
    Object.defineProperty(f, 'text', { value: async () => payload, configurable: true });
    return f;
  };

  const run1 = boot({});                                 // a first run, on empty storage
  await wait(400);

  // The user imports a playlist through the Import button.
  const input = run1.$('#playlistInput');
  const payload = JSON.stringify({
    version: 1,
    items: [
      { kind: 'remote', title: 'Big Buck Bunny.mp4', url: 'https://cdn.example.com/bbb.mp4', type: 'progressive' },
      { kind: 'remote', title: 'Sintel.mp4', url: 'https://cdn.example.com/sintel.mp4', type: 'progressive' },
    ],
  });
  Object.defineProperty(input, 'files', { configurable: true, get: () => [mkFile(run1.window, 'playlist.json', payload)] });
  run1.$('#btnImportPlaylist').dispatchEvent(new run1.window.MouseEvent('click', { bubbles: true }));
  input.dispatchEvent(new run1.window.Event('change', { bubbles: true }));
  await wait(300);
  check('the imported queue is on screen', run1.document.querySelectorAll('#playlistList .item').length === 2,
    String(run1.document.querySelectorAll('#playlistList .item').length));

  // …watches the first title and stops 90 s in.
  run1.document.querySelector('#playlistList .item .item-main')
    .dispatchEvent(new run1.window.MouseEvent('click', { bubbles: true }));
  await wait(120);
  const v1 = run1.$('#video');
  v1._duration = 600;
  v1.dispatchEvent(new run1.window.Event('loadedmetadata'));
  v1.currentTime = 90;
  v1.dispatchEvent(new run1.window.Event('pause'));      // pausing stores the position
  await wait(400);                                       // let the debounced writes land

  const afterPlay = JSON.parse(run1.window.localStorage.getItem(PLAYLIST_KEY) || '{}');
  check('the title that is playing is written to storage (not only kept in memory)',
    !!afterPlay.currentId && afterPlay.currentId === afterPlay.items[0].id,
    `${afterPlay.currentId} vs ${(afterPlay.items[0] || {}).id}`);

  // Close the app.
  run1.window.dispatchEvent(new run1.window.Event('pagehide'));
  const seed = carry(run1.window);
  run1.window.close();

  // Reopen it on exactly that storage.
  const run2 = boot(seed);
  await wait(400);
  const rows2 = [...run2.document.querySelectorAll('#playlistList .item')];
  check('the imported queue comes back after a close', rows2.length === 2, String(rows2.length));
  check('the watched title is highlighted', rows2[0]?.classList.contains('is-current'),
    rows2.map((r) => r.className).join(' | '));
  check('nothing started playing by itself', run2.$('#video').getAttribute('src') === null);

  check('a pop-up asks whether to resume', run2.$('#resumeDialog').open === true);
  check('the pop-up names the title', /Big Buck Bunny\.mp4/.test(run2.$('#resumeDialogText').textContent),
    run2.$('#resumeDialogText').textContent);
  check('the pop-up shows where it stopped', /1:30/.test(run2.$('#resumeDialogText').textContent)
    && /Resume at 1:30/.test(run2.$('#resumeDialogPlayLabel').textContent),
    run2.$('#resumeDialogText').textContent + ' | ' + run2.$('#resumeDialogPlayLabel').textContent);

  run2.$('#btnResumeDialogPlay').dispatchEvent(new run2.window.MouseEvent('click', { bubbles: true }));
  await wait(120);
  const v2 = run2.$('#video');
  check('Resume closes the pop-up and opens that title',
    run2.$('#resumeDialog').open === false && String(v2.getAttribute('src') || '').includes('bbb.mp4'),
    String(v2.getAttribute('src')));
  v2._duration = 600;
  v2.dispatchEvent(new run2.window.Event('loadedmetadata'));
  await wait(60);
  check('…and it starts where the last session stopped', Math.abs(v2.currentTime - 90) < 0.01, String(v2.currentTime));
  check('no uncaught errors across the round trip', run2.errors().length === 0, run2.errors().join(' | '));
  run2.window.close();
}

/* =====================================================================
 * 6. Local files keep their place in the queue
 * ===================================================================*/
console.log('\n— a queue of local files —');
{
  const run1 = boot({});
  await wait(400);
  const pick = (names) => {
    const files = names.map(([name, size]) => {
      const f = new run1.window.File([new Uint8Array(size)], name, { type: 'video/mp4', lastModified: 1700000000000 });
      Object.defineProperty(f, 'lastModified', { value: 1700000000000, configurable: true });
      return f;
    });
    const input = run1.$('#fileInput');
    Object.defineProperty(input, 'files', { configurable: true, get: () => files });
    input.dispatchEvent(new run1.window.Event('change', { bubbles: true }));
  };
  pick([['Holiday.mp4', 111], ['Trip.mp4', 222]]);
  await wait(300);
  check('both local files are queued', run1.document.querySelectorAll('#playlistList .item').length === 2);

  run1.window.dispatchEvent(new run1.window.Event('pagehide'));
  const stored = JSON.parse(run1.window.localStorage.getItem(PLAYLIST_KEY) || '{}');
  check('the queue is saved instead of being thrown away', (stored.items || []).length === 2,
    run1.window.localStorage.getItem(PLAYLIST_KEY));
  check('each file is saved by name / size / modified date',
    (stored.items || []).every((i) => i.kind === 'file' && i.file?.name && i.file?.size && i.file?.lastModified),
    JSON.stringify(stored.items));
  check('no file bytes or blob URLs end up in storage',
    !/blob:|data:/.test(run1.window.localStorage.getItem(PLAYLIST_KEY) || ''));
  const seed = { [PLAYLIST_KEY]: stored, [RESUME_KEY]: JSON.parse(run1.window.localStorage.getItem(RESUME_KEY) || 'null') };
  run1.window.close();

  const run2 = boot(seed);
  await wait(400);
  const rows = [...run2.document.querySelectorAll('#playlistList .item')];
  check('both local files come back after a close', rows.length === 2, String(rows.length));
  check('…in the same order', rows.map((r) => r.querySelector('.item-title').textContent).join('|') === 'Holiday.mp4|Trip.mp4',
    rows.map((r) => r.querySelector('.item-title').textContent).join('|'));
  check('they are marked as waiting for their file',
    rows.every((r) => r.classList.contains('is-missing')) && run2.$('#playlistReconnectHint').hidden === false,
    rows.map((r) => r.className).join(' | '));
  check('the previously open file is still the highlighted one', rows[0].classList.contains('is-current'));

  // One pick of the same files brings the queue back to life.
  const again = [['Holiday.mp4', 111], ['Trip.mp4', 222]].map(([name, size]) => {
    const f = new run2.window.File([new Uint8Array(size)], name, { type: 'video/mp4' });
    Object.defineProperty(f, 'lastModified', { value: 1700000000000, configurable: true });
    return f;
  });
  const reconnect = run2.$('#reconnectInput');
  Object.defineProperty(reconnect, 'files', { configurable: true, get: () => again });
  run2.document.querySelector('#playlistList .item .item-main')
    .dispatchEvent(new run2.window.MouseEvent('click', { bubbles: true }));   // asks for the file
  reconnect.dispatchEvent(new run2.window.Event('change', { bubbles: true }));
  await wait(200);
  const rowsAfter = [...run2.document.querySelectorAll('#playlistList .item')];
  check('picking the files again reconnects them (no duplicates)', rowsAfter.length === 2,
    String(rowsAfter.length));
  check('they are playable again', rowsAfter.every((r) => !r.classList.contains('is-missing'))
    && run2.$('#playlistReconnectHint').hidden === true,
    rowsAfter.map((r) => r.className).join(' | '));
  check('the clicked title starts playing once its file is back',
    String(run2.$('#video').getAttribute('src') || '').startsWith('blob:'), String(run2.$('#video').getAttribute('src')));
  check('no uncaught errors while reconnecting', run2.errors().length === 0, run2.errors().join(' | '));
  run2.window.close();
}

/* =====================================================================
 * 7. The pop-up asks once, and the offer stays reachable after it
 * ===================================================================*/
console.log('\n— the resume pop-up —');
{
  const { window, $ } = boot(previousSession);
  await wait(400);
  check('it opens on a reopened app', $('#resumeDialog').open === true);

  // A playlist edit must not slam the dialog back in the user's face.
  $('#resumeDialog [data-close-dialog]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  check('the pop-up can be dismissed', $('#resumeDialog').open === false);
  const urlInput = $('#urlInput');
  urlInput.value = 'https://cdn.example.com/another.mp4';
  $('#btnQueueUrl').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(120);
  check('editing the playlist does not re-open it', $('#resumeDialog').open === false);

  // The empty-state card keeps the offer one click away.
  check('the offer stays on the empty state after the pop-up is dismissed', $('#resumePrompt').hidden === false,
    $('#resumePromptText').textContent);

  // "Start over" forgets the mark instead of resuming.
  const fresh = boot(previousSession);
  await wait(400);
  fresh.$('#btnResumeDialogRestart').dispatchEvent(new fresh.window.MouseEvent('click', { bubbles: true }));
  await wait(120);
  const video = fresh.$('#video');
  check('Start over opens the title', String(video.getAttribute('src') || '').includes('zebra.mp4'),
    String(video.getAttribute('src')));
  video._duration = 600;
  video.dispatchEvent(new fresh.window.Event('loadedmetadata'));
  await wait(60);
  check('Start over begins at 0', video.currentTime === 0, String(video.currentTime));
  await wait(500);
  const marks = (JSON.parse(fresh.window.localStorage.getItem(RESUME_KEY) || '{}').items) || {};
  check('Start over drops the saved position', !marks[`url:${zebraUrl}`], JSON.stringify(marks));
}

/* =====================================================================
 * 8. A page and a script that are one update apart must still work
 *    (the service worker serves the shell stale-while-revalidate, so an old
 *    index.html can be paired with a new script.js for one load)
 * ===================================================================*/
console.log('\n— an older page with the new script —');
{
  const oldPage = html
    .replace(/<dialog class="dialog resume-dialog"[\s\S]*?<\/dialog>/, '')
    .replace(/<input[^>]*id="reconnectInput"[^>]*>/, '')
    .replace(/<p[^>]*id="playlistReconnectHint"[^>]*><\/p>/, '');
  const { window, $, errors } = boot(previousSession, oldPage);
  await wait(400);
  check('the playlist still renders without the new elements',
    window.document.querySelectorAll('#playlistList .item').length === 2,
    String(window.document.querySelectorAll('#playlistList .item').length));
  check('the saved title is still highlighted', !!window.document.querySelector('#playlistList .item.is-current'));
  check('nothing threw while booting', errors().length === 0, errors().join(' | '));
  check('the app simply skips the pop-up', $('#resumeDialog') === null);
  window.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log('FAILED: ' + failed.map((f) => f.name).join(', ')); process.exit(1); }
