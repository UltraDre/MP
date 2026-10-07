// Runtime test: the press-and-hold fast-forward (2×) and the "up next" card.
//
// Boots index.html + script.js in jsdom, seeds a two-item playlist, and drives
// both features through the same events a browser would fire.
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
const SETTINGS_KEY = 'nebula.settings.v1';

let problems = 0;
const check = (name, cond, extra = '') => {
  if (!cond) problems++;
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${cond ? '' : '  ' + extra}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Boot the app with a seeded queue and return handles for driving it. */
function boot(seed = {}) {
  const logs = { errors: [] };
  const vc = new VirtualConsole();
  vc.on('error', (...a) => logs.errors.push(a.map(String).join(' ')));
  vc.on('jsdomError', (e) => logs.errors.push(String(e && e.message || e)));

  const dom = new JSDOM(html, {
    url: 'https://example.com/app/index.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const { window } = dom;
  const { document } = window;

  /* ---------- media element behaviour jsdom lacks ---------- */
  Object.defineProperty(window.HTMLMediaElement.prototype, 'paused', {
    configurable: true,
    get() { return this._paused !== false; },
    set(v) { this._paused = !!v; },
  });
  Object.defineProperty(window.HTMLMediaElement.prototype, 'duration', {
    configurable: true,
    get() { return this._duration ?? NaN; },
  });
  Object.defineProperty(window.HTMLMediaElement.prototype, 'currentTime', {
    configurable: true,
    get() { return this._currentTime ?? 0; },
    set(v) {
      this._currentTime = Number(v) || 0;
      this.dispatchEvent(new window.Event('timeupdate'));
    },
  });
  window.HTMLMediaElement.prototype.play = function play() {
    this._paused = false;
    this.dispatchEvent(new window.Event('play'));
    return Promise.resolve();
  };
  window.HTMLMediaElement.prototype.pause = function pause() {
    this._paused = true;
    this.dispatchEvent(new window.Event('pause'));
  };
  window.HTMLMediaElement.prototype.load = function load() { /* noop */ };
  Object.defineProperty(window.HTMLMediaElement.prototype, 'buffered', {
    configurable: true, get() { return { length: 0, start: () => 0, end: () => 0 }; },
  });
  Object.defineProperty(window.HTMLMediaElement.prototype, 'textTracks', {
    configurable: true, get() { return { length: 0, addEventListener() {}, removeEventListener() {} }; },
  });
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
    media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
  window.URL.createObjectURL = () => 'blob:https://example.com/' + Math.random().toString(36).slice(2);
  window.URL.revokeObjectURL = () => {};
  window.confirm = () => true;
  window.AbortSignal.timeout = (ms) => {
    const c = new window.AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
  };

  for (const [key, value] of Object.entries(seed)) {
    window.localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  // Top-level `const`s in an eval'd script live in that eval's own lexical
  // scope, so hand the module objects out explicitly.
  window.eval(`${script}\n;window.__app = { Player, Playlist, UpNext, Gestures, Settings, Controls };`);
  const app = window.__app;

  return {
    window,
    document,
    logs,
    $: (s) => document.querySelector(s),
    /** Run an expression against the app's modules (Player, Playlist, UpNext…). */
    run: (expr) => window.eval(`(() => { const { Player, Playlist, UpNext, Gestures, Settings, Controls } = window.__app; return (${expr}); })()`),
  };
}

const TWO_ITEMS = {
  version: 1,
  currentId: 'ep1',
  items: [
    { id: 'ep1', kind: 'remote', title: 'Episode 1 — Pilot', url: 'https://cdn.example.com/ep1.mp4', type: 'progressive', addedAt: 1 },
    { id: 'ep2', kind: 'remote', title: 'Episode 2 — The Door', url: 'https://cdn.example.com/ep2.mp4', type: 'progressive', addedAt: 2 },
  ],
};

/* =====================================================================
 * Press and hold = 2× speed
 * ===================================================================*/
console.log('\n— hold anywhere for 2× speed —');
{
  const { window, document, logs, $, run } = boot({ [PLAYLIST_KEY]: TWO_ITEMS });
  await wait(400);

  run('Playlist.play("ep1")');
  await wait(50);
  const video = $('#video');
  video._duration = 600;
  video.currentTime = 100;
  video._paused = false;                 // "playing"

  const stage = $('#playerStage');
  const pointer = (type, props = {}) => {
    const { node = stage, ...rest } = props;
    const ev = new window.Event(type, { bubbles: true, cancelable: true });
    // `target` is read-only (set by dispatchEvent), so only the pointer fields
    // are copied on: jsdom has no PointerEvent initialiser for them.
    Object.assign(ev, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 300, clientY: 300 }, rest);
    node.dispatchEvent(ev);
    return ev;
  };

  check('the item is playing before the test starts', video.paused === false && run('!!Player.current'));

  // 1. A short press is a press, not a hold.
  pointer('pointerdown');
  await wait(120);
  pointer('pointerup');
  check('a quick press does not change the speed', video.playbackRate === 1, String(video.playbackRate));

  // 2. Hold past the threshold → 2×.
  pointer('pointerdown');
  await wait(430);
  check('holding bumps playback to 2×', video.playbackRate === 2, String(video.playbackRate));
  check('the gesture HUD shows the hold speed', $('#gestureHud').hidden === false
    && $('#gestureHudLabel').textContent === '2×', $('#gestureHudLabel').textContent);
  check('the forced speed is not written to settings', run('Number(Settings.get("speed"))') === 1,
    String(run('Settings.get("speed")')));

  // 3. Release → straight back to the user's speed.
  pointer('pointerup');
  check('releasing restores the previous speed', video.playbackRate === 1, String(video.playbackRate));
  await wait(220);
  check('the HUD clears after the release', $('#gestureHud').hidden === true);

  // 4. A released hold must not also toggle the control bar.
  const barHiddenBefore = $('#controlsBar').classList.contains('is-hidden');
  stage.dispatchEvent(new window.MouseEvent('click', { bubbles: true, clientX: 300, clientY: 300 }));
  await wait(420);
  check('the click that ends a hold does not toggle the controls',
    $('#controlsBar').classList.contains('is-hidden') === barHiddenBefore);

  // 5. Dragging before the threshold cancels the pending hold.
  await wait(800);   // let the holdConsumed window lapse
  pointer('pointerdown');
  pointer('pointermove', { clientX: 380, clientY: 300 });
  await wait(430);
  check('a drag never fast-forwards', video.playbackRate === 1, String(video.playbackRate));
  pointer('pointerup');

  // 6. No fast-forward while paused.
  video._paused = true;
  pointer('pointerdown');
  await wait(430);
  check('holding while paused does nothing', video.playbackRate === 1, String(video.playbackRate));
  pointer('pointerup');
  video._paused = false;

  // 7. A hold keeps a user-chosen speed instead of clobbering it.
  run('Player.setSpeed(1.5)');
  pointer('pointerdown');
  await wait(430);
  check('holding overrides a custom speed too', video.playbackRate === 2, String(video.playbackRate));
  pointer('pointerup');
  check('the custom speed survives the hold', video.playbackRate === 1.5, String(video.playbackRate));
  run('Player.setSpeed(1)');

  // 8. Switching items mid-hold releases the override.
  pointer('pointerdown');
  await wait(430);
  check('override engaged before the switch', video.playbackRate === 2, String(video.playbackRate));
  run('Playlist.play("ep2")');
  await wait(60);
  check('loading another item cancels the hold', run('Player._speedOverride') === null);
  pointer('pointerup');

  check('no uncaught errors while holding', logs.errors.length === 0, logs.errors.join(' | '));
  document.defaultView.close();
}

/* =====================================================================
 * Up next card
 * ===================================================================*/
console.log('\n— up next card —');
{
  const { window, document, logs, $, run } = boot({ [PLAYLIST_KEY]: TWO_ITEMS });
  await wait(400);

  const video = $('#video');
  const card = () => $('#upNext');

  run('Playlist.play("ep1")');
  await wait(60);
  video._duration = 600;
  video._paused = false;
  video.currentTime = 100;

  check('the card is hidden while there is plenty left', card().hidden === true);

  // 1. Too early: 100s left, default lead is 60s.
  video.currentTime = 500;
  check('the card stays away outside the window', card().hidden === true);

  // 2. Inside the default 60-second window.
  video.currentTime = 555;
  await wait(30);
  check('the card appears in the last minute', card().hidden === false);
  check('the card names the next item', $('#upNextTitle').textContent === 'Episode 2 — The Door',
    $('#upNextTitle').textContent);
  check('the card counts down the remaining time', $('#upNextCount').textContent === 'Starts in 0:45',
    $('#upNextCount').textContent);
  check('the card is exposed to assistive tech', card().getAttribute('aria-hidden') === 'false');

  // 3. Rewinding out of the window hides it again.
  video.currentTime = 300;
  await wait(300);
  check('rewinding dismisses the card', card().hidden === true);

  // 4. "Continue" drops the card and leaves the item to finish normally.
  video.currentTime = 570;
  await wait(30);
  check('the card is back near the end', card().hidden === false);
  $('#btnUpNextContinue').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(300);
  check('Continue hides the card', card().hidden === true);
  video.currentTime = 580;
  await wait(60);
  check('Continue keeps it away for the rest of the item', card().hidden === true);
  video.currentTime = 599;
  await wait(60);
  check('…right up to the end', card().hidden === true);

  // 5. Opening another item earns a fresh offer.
  run('Playlist.play("ep2")');
  await wait(80);
  video.currentTime = 590;
  await wait(60);
  check('the last item still offers nothing', card().hidden === true);
  run('Playlist.play("ep1")');
  await wait(80);
  video.currentTime = 590;
  await wait(60);
  check('coming back to the first item offers the card again', card().hidden === false);

  // 6. "Play next" jumps to the advertised item.
  $('#btnUpNextPlay').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(120);
  check('Play next loads the advertised item', run('Player.current && Player.current.id') === 'ep2',
    String(run('Player.current && Player.current.id')));
  check('the card is gone after jumping', run('UpNext.visible') === false);
  await wait(300);
  check('…and removed from the layout', card().hidden === true);

  check('no uncaught errors around the card', logs.errors.length === 0, logs.errors.join(' | '));
  document.defaultView.close();
}

/* =====================================================================
 * The settings: on/off + lead time
 * ===================================================================*/
console.log('\n— up next settings —');
{
  const { window, document, logs, $, run } = boot({
    [PLAYLIST_KEY]: TWO_ITEMS,
    [SETTINGS_KEY]: { upNextEnabled: true, upNextSeconds: 60, speed: 1 },
  });
  await wait(400);

  const video = $('#video');
  const set = (sel, value, type) => {
    const node = $(sel);
    node.value = value;
    node.checked = value === 'on' ? true : (value === 'off' ? false : node.checked);
    node.dispatchEvent(new window.Event(type, { bubbles: true }));
  };

  run('Playlist.play("ep1")');
  await wait(60);
  video._duration = 600;
  video._paused = false;

  check('the switch reflects the stored setting', $('#optUpNext').checked === true);
  check('the slider reflects the stored lead time', $('#upNextSeconds').value === '60', $('#upNextSeconds').value);
  check('the readout shows the lead time', $('#upNextSecondsOut').textContent === '60');

  // A shorter window: 30s → the card only appears in the last half minute.
  set('#upNextSeconds', '30', 'change');
  check('the lead time is stored', run('Settings.get("upNextSeconds")') === 30,
    String(run('Settings.get("upNextSeconds")')));
  video.currentTime = 555;
  await wait(60);
  check('a 30s window keeps the card away at 45s left', $('#upNext').hidden === true);
  video.currentTime = 585;
  await wait(60);
  check('…and shows it at 15s left', $('#upNext').hidden === false);

  // Turning it off removes the card and disables the slider.
  set('#optUpNext', 'off', 'change');
  await wait(300);
  check('turning it off hides the card', $('#upNext').hidden === true);
  check('turning it off disables the slider', $('#upNextSeconds').disabled === true);
  check('the slider row is dimmed while off', $('#upNextSecondsField').classList.contains('is-off'));
  video.currentTime = 595;
  await wait(60);
  check('a disabled card never appears', $('#upNext').hidden === true);

  // …and back on.
  set('#optUpNext', 'on', 'change');
  check('turning it back on re-enables the slider', $('#upNextSeconds').disabled === false);
  video.currentTime = 590;
  await wait(60);
  check('turning it back on shows the card again', $('#upNext').hidden === false);

  // The countdown follows the clock.
  video.currentTime = 596;
  await wait(30);
  check('the countdown ticks down with playback', $('#upNextCount').textContent === 'Starts in 0:04',
    $('#upNextCount').textContent);

  // Ending the item clears it.
  video.dispatchEvent(new window.Event('ended'));
  await wait(300);
  check('the card clears when the item ends', $('#upNext').hidden === true);

  check('no uncaught errors around the settings', logs.errors.length === 0, logs.errors.join(' | '));
  document.defaultView.close();
}

/* =====================================================================
 * Nothing to offer → no card
 * ===================================================================*/
console.log('\n— when there is nothing next —');
{
  const single = { version: 1, currentId: 'only', items: [TWO_ITEMS.items[0]] };
  const { window, document, logs, $, run } = boot({ [PLAYLIST_KEY]: single });
  await wait(400);

  const video = $('#video');
  run('Playlist.play("ep1")');
  await wait(60);
  video._duration = 600;
  video._paused = false;
  video.currentTime = 590;

  check('a one-item queue offers nothing', $('#upNext').hidden === true);

  // Last item of the queue with looping off = nothing next either.
  run('Playlist.add({ id: "ep2", kind: "remote", title: "Episode 2", url: "https://cdn.example.com/ep2.mp4", type: "progressive" })');
  run('Playlist.play("ep2")');
  await wait(60);
  video.currentTime = 590;
  await wait(60);
  check('the last item offers nothing with looping off', $('#upNext').hidden === true);

  run('Settings.set("loopMode", "all")');
  video.currentTime = 591;
  await wait(60);
  check('loop-all offers the first item instead', $('#upNext').hidden === false
    && $('#upNextTitle').textContent === 'Episode 1 — Pilot', $('#upNextTitle').textContent);

  check('no uncaught errors on the empty paths', logs.errors.length === 0, logs.errors.join(' | '));
  document.defaultView.close();
}

/* =====================================================================
 * Shuffle: the card names the item that actually plays
 * ===================================================================*/
console.log('\n— shuffle honesty —');
{
  const three = {
    version: 1,
    currentId: 'a',
    items: [
      { id: 'a', kind: 'remote', title: 'A', url: 'https://cdn.example.com/a.mp4', type: 'progressive', addedAt: 1 },
      { id: 'b', kind: 'remote', title: 'B', url: 'https://cdn.example.com/b.mp4', type: 'progressive', addedAt: 2 },
      { id: 'c', kind: 'remote', title: 'C', url: 'https://cdn.example.com/c.mp4', type: 'progressive', addedAt: 3 },
    ],
  };
  const { window, document, logs, $, run } = boot({
    [PLAYLIST_KEY]: three,
    [SETTINGS_KEY]: { shuffle: true, upNextEnabled: true, upNextSeconds: 60 },
  });
  await wait(400);

  const video = $('#video');
  run('Playlist.play("a")');
  await wait(60);
  video._duration = 600;
  video._paused = false;
  video.currentTime = 570;
  await wait(60);

  check('shuffle still offers a card', $('#upNext').hidden === false);
  const advertised = $('#upNextTitle').textContent;
  check('the advertised title differs from the current one', advertised !== 'A', advertised);
  const picked = run('UpNext.item && UpNext.item.id');
  check('the same pick is returned while the card is up',
    run('Playlist.previewNext() && Playlist.previewNext().id') === picked, String(picked));

  // The auto-advance that follows the end of the item must honour the advert.
  run('Playlist.advance(1, { auto: true })');
  await wait(80);
  check('the item that plays is the one the card named',
    run('Player.current && Player.current.title') === advertised,
    `${run('Player.current && Player.current.title')} vs ${advertised}`);

  check('no uncaught errors with shuffle on', logs.errors.length === 0, logs.errors.join(' | '));
  document.defaultView.close();
}

console.log(problems === 0 ? '\nAll up-next / hold-to-speed checks passed' : `\n${problems} check(s) failed`);
process.exit(problems === 0 ? 0 : 1);
