# Nebula Player

A modern, responsive, **offline-capable media player** built with plain HTML5, CSS3 and vanilla
JavaScript (ES6+). It plays progressive files (MP4/WebM/…), HLS (`.m3u8`) and DASH (`.mpd`) streams,
local files from your device, and videos you have **downloaded into the browser for offline playback**.

No frameworks, no build step, no bundler — open it from any static server and it runs.

<p align="center">
  <img src="icons/icon-192.png" width="96" alt="Nebula Player icon" />
</p>

---

## Table of contents

1. [Features](#features)
2. [Quick start](#quick-start)
3. [Project structure](#project-structure)
4. [Using the player](#using-the-player)
5. [Gestures](#gestures)
6. [Keyboard shortcuts](#keyboard-shortcuts)
7. [Offline downloads — how it works](#offline-downloads--how-it-works)
8. [Streaming libraries (hls.js / dash.js)](#streaming-libraries-hlsjs--dashjs)
9. [Browser support](#browser-support)
10. [Limitations & known constraints](#limitations--known-constraints)
11. [Troubleshooting](#troubleshooting)
12. [Customising](#customising)
13. [Development & tests](#development--tests)

---

## Features

**Playback**

- Play/pause, seek bar with hover tooltip + light-gray buffered range, volume/mute with a 0–200% software-gain range, fullscreen, picture-in-picture,
  playback speed (0.25×–3×, pitch preserved), loop (off / all / one) and shuffle.
- **Edge-to-edge picture with overlaid controls**: the video fills the whole window, and the control
  bar floats on top of it. The app starts with the controls hidden for a clean picture — **tap / click
  the player area—even when the no-media screen is showing—** to bring them up, and tap again to hide
  them. The title bar and the playlist toggle follow the same show/hide so nothing shrinks or obscures
  the media.
- **Rotate the screen** with the ↻ button or <kbd>Shift</kbd>+<kbd>R</kbd>: switch between portrait
  and landscape with the video, controls and overlays together (supported mobile browsers).
- Online progressive, HLS and DASH sources request ahead buffering to help reduce stalls. **Pausing does
  not stop the download**: while playback is paused the forward-buffer targets are raised so the stream
  keeps filling ahead (up to the browser/SourceBuffer quota and the host's limits), and hls.js is nudged
  if it stops growing. The *Keep downloading ahead while paused* switch in the shortcut dialog can turn
  the background data usage off.
- Media Session integration (lock-screen / hardware media keys where supported).
- Loading spinner, friendly error cards with retry, and **resume positions**: every item remembers where
  you stopped and re-opens there (a title you watched to the end starts over). Marks are keyed by the
  media URL in `localStorage`, so they survive reloads, playlist re-imports and switching between the
  streaming and downloaded copy of the same video; local files are keyed by name + size + modified date,
  so they survive a restart as well and are still there once the file is reconnected.
  The position is refreshed every ~10 s while playing and saved again on pause, on seek and when the app
  is hidden or closed, so quitting mid-playback costs at most a few seconds of progress.

**Sources**

- **Online**: paste a URL — the format is detected automatically.
  - `.m3u8` → `hls.js` (or native HLS on Safari/iOS)
  - `.mpd` → `dash.js`
  - MP4/WebM/M4V/MOV/OGG/MP3/M4A/… → played directly by the `<video>` element
  - **Anything else** (a normal web page) → the page is fetched and scanned
    automatically (`<video>`/`<source>` tags, `og:video` metadata, media links
    and URLs embedded in the page's scripts) and every video found is added
    to the playlist
- **Movie & series search**: look a title up in several catalogues of openly licensed video at once —
  **Internet Archive** (public-domain / CC movie records), **Wikimedia Commons** (free media, direct
  `upload.wikimedia.org` files) and the federated **PeerTube** network via SepiaSearch (resolved to the
  instance's own MP4/HLS URL). The *Catalogue* picker narrows the search to a single source. Results can
  be played or queued. Only records with an uploader-declared public-domain / Creative Commons licence and
  a directly playable file are listed — this is not a search of commercial streaming services or the whole
  web, and the licence claims come from uploaders, so open the record and verify the rights before
  streaming.
- **Anime search & direct streaming**: dedicated search across major open anime catalogues —
  **Internet Archive Anime Archives** (over 130,000+ anime titles, complete multi-episode series, films, and OVAs with direct MP4/video files),
  **Kitsu Anime DB** (comprehensive anime database with official synopsis, Japanese & English titles, ratings, episode counts, and trailer streams),
  **Wikimedia Commons** (pioneering Japanese animations and CC-licensed anime shorts), and **PeerTube** (federated anime streams and AMVs).
  For multi-episode anime series (e.g. *Death Note*, *Cowboy Bebop*, *Naruto*, *Dragon Ball*, *Serial Experiments Lain*),
  the player provides individual episode selection, direct playback of any episode, and a one-click **Queue all episodes** action.
- **Local**: file picker, folder picker (sidecar `.vtt`/`.srt` subtitles are matched by filename),
  drag-and-drop onto the page, plus `Ctrl/Cmd+V` to paste a URL from the clipboard.
- **Offline**: one click stores the current video (or every HLS/DASH segment) in the browser cache so it
  plays with no network at all.

**Playlist**

- Add online URLs and local files, switch between items, reorder (drag-and-drop or ↑/↓ buttons),
  remove items, clear the list, import/export as JSON, or press **Sort A–Z** to order the whole queue
  by title (naturally, so *Episode 2* comes before *Episode 10*). The sort is a one-off: the result is
  saved like any other edit and manual reordering still works afterwards.
- **Everything is saved automatically, and stays until you delete it.** The queue, its order and the
  item you are watching are written to `localStorage` as you change them, and every pending write is
  flushed the moment the tab is hidden or the app is closed — adding something and immediately quitting
  does not lose it, and closing the app never empties the playlist.
- **Local files stay in the queue too.** A browser will not hand a file back to a page that did not just
  open it, so a local file is saved by *identity* (name, size, last-modified) instead of being dropped:
  after a restart its row, its order and its resume position are all still there, marked
  **“saved — tap to reconnect”**. One pick of the file (or of its folder) re-links every matching row.
  The file's contents are never copied into storage.
- Selecting an item always resumes the position where you last stopped watching it, including after a
  reload of the app. Reopening the app shows a **“Continue watching?” pop-up** naming the title you closed
  on and where you stopped: **Resume** picks it up there, **Start over** plays it from 0 and forgets the
  mark, and dismissing it leaves the same offer on the empty state as a **“Last open” card**.

**Subtitles**

- Load external `.vtt` or `.srt` files (SRT is converted to WebVTT on the fly), auto-discover sidecar
  subtitles for local folders and remote URLs, select between multiple tracks, toggle on/off and shift
  the timing (±0.5 s steps, `[` / `]`).
- **Search online** (`Shift`+`C` or the CC panel) — the name of the current video is cleaned up
  (`Show.S02E04.1080p.WEB-DL.mkv` → *Show*, season 2, episode 4) and searched on OpenSubtitles
  (legacy REST + the IMDb-based Stremio addon, plus the official OpenSubtitles.com API when you add a
  free API key). Results are language-tagged, ranked and can be loaded with one click or saved as
  `.srt`. You can also search any name you type, paste a subtitle link, or open a local file.
- In-band/embedded text tracks (e.g. HLS captions) also appear in the list.
- The **Subtitle appearance** section adjusts cue size, text color, background color/opacity and vertical position; these preferences are saved on the device.

**App / PWA**

- Installable (manifest + service worker), works offline for the UI itself, dark/light theme,
  responsive layout (sidebar becomes a bottom sheet on phones), toasts, keyboard-shortcut dialog,
  and localStorage persistence for theme, volume, speed, loop/shuffle, subtitle preferences, the playlist,
  the last open title and every resume position. Writes are debounced and flushed on `pagehide` / when the
  tab is hidden, so closing the app never loses the change you just made.

---

## Quick start

Service workers (and therefore offline downloads and install) require a **secure context**:
`https://` or `http://localhost`. Opening `index.html` directly from the file system (`file://`) will
show a warning banner and disable the PWA features.

```bash
# 1. clone
git clone https://github.com/UltraDre/MP.git
cd MP

# 2. serve it (pick any one of these)
python3 -m http.server 8080          # Python 3
npx serve -l 8080                    # Node
php -S localhost:8080                # PHP
```

Then open <http://localhost:8080>.

> **Testing on your phone?** `http://localhost` is secure, but `http://192.168.x.x` is **not**, so the
> service worker will not register. Use a tunnel (`ngrok http 8080`, `cloudflared tunnel --url …`) or
> host the folder on any static HTTPS host (GitHub Pages, Netlify, Cloudflare Pages, …).

**No install or build step is required.** Everything is plain static files.

---

## Project structure

```
MP/
├── index.html          # Markup, inline SVG icon sprite, dialogs, panels
├── styles.css          # Design tokens (dark/light), layout, components, responsive rules
├── script.js           # Application logic (ES module, ~20 sections, heavily commented)
├── service-worker.js   # App-shell caching + offline video storage + range serving
├── manifest.json       # PWA manifest (installable, shortcuts, maskable icon)
├── icons/              # App icons (192/512, maskable, apple-touch, favicon)
├── vendor/
│   ├── hls.min.js      # hls.js 1.7.3 (local copy so HLS works offline)
│   └── dash.all.min.js # dash.js 5.2.1 (local copy so DASH works offline)
├── tests/              # optional Node harnesses (not needed to run the app)
│   ├── static-checks.mjs
│   ├── service-worker.test.mjs
│   ├── ui-smoke.test.mjs
│   └── persistence.test.mjs   # boots the app on top of a saved state
└── README.md
```

### Where things live in `script.js`

The file is split into numbered sections so you can jump straight to what you need:

| § | Section | Responsibility |
|---|---------|----------------|
| 01–04 | Utilities, Settings, Toasts, Media helpers | formatting, localStorage (+ `flushPersisted()`), dialogs, format detection |
| 05 | `StreamEngine` | loads hls.js/dash.js on demand and attaches streams |
| 06 | `Player` + `Resume` | the core playback controller (`load()`, seeking, volume, errors) and the persistent resume-position store |
| 07 | `MediaSession` | OS media keys / lock-screen metadata |
| 08–09 | `Controls`, `Menus` | control bar binding (incl. screen rotation), speed menu, popups |
| 10–11 | `Gestures`, `Keyboard` | double-tap/double-click gestures & shortcuts |
| 12 | `Playlist` | queue, reordering, alphabetical sort, persistence, reconnecting saved local files, import/export |
| 13 | `Offline` | talking to the service worker, downloads UI |
| 14 | `Subtitles` | VTT/SRT tracks, delay, embedded tracks |
| 15 | `SubtitleSearch` | online search (OpenSubtitles/Stremio), `Net` fetch helper, proxies |
| 16 | `Sources`, `MovieSearch` | URL/local files, page scanning and the movie/series catalogues (Internet Archive, Wikimedia Commons, PeerTube) |
| 17–18 | `Theme`, `Shell` | theme, network state, panels, dialogs, install |
| 19–20 | `UI`, `App` | view helpers and boot sequence |

---

## Using the player

### 1. Play an online video

1. Paste a direct media URL into **Online video** and press **Play** (or **Queue** to add it without playing).
2. To look up a movie, series or episode by name, choose **Search movies**, enter its title and press
   **Play** on a result (or **Queue** it). The search runs against every catalogue selected in the
   **Catalogue** picker — Internet Archive, Wikimedia Commons and the federated PeerTube network — and
   only lists items with an uploader-declared public-domain/Creative Commons licence and a direct video
   file or stream. It does **not** search the whole internet, commercial streaming services or paid
   offers; licence labels are supplied by uploaders, so open the record and verify rights before
   streaming. Wikimedia Commons videos are usually WebM/Ogg (browser codec support varies) and PeerTube
   items are served from the hosting instance, so the first connection can take a moment.
3. Formats are detected from the URL. Progressive MP4/WebM files play without CORS.
   HLS/DASH playlists need CORS — see [Limitations](#limitations--known-constraints).
4. Links that are **not** direct media files (ordinary web pages) are scanned automatically when
   submitted in the Online video field: the app fetches the page, extracts every video it references
   (`<video>`/`<source>` tags, `og:video` metadata, media links and URLs embedded in the page's scripts)
   and adds them to the playlist — pressing **Play** starts the first one found. Scanning needs the
   page's host to allow cross-origin reads (CORS); watch pages that don't (YouTube, Vimeo, …) still
   require a direct file/stream URL.

You can also deep-link a video: `index.html?url=https://example.com/video.m3u8`.

### 2. Search and stream anime directly

1. Click **Search anime** in the sidebar (or on the empty player screen, or press <kbd>Shift</kbd>+<kbd>A</kbd>).
   Typing an anime title into the *Online video* field beforehand prefills the search automatically.
2. Enter an anime title (e.g. *Cowboy Bebop*, *Death Note*, *Naruto*, *Sailor Moon*, *Serial Experiments Lain*).
   The search queries major open catalogues simultaneously:
   - **Internet Archive Anime Collection**: Over 130,000+ anime titles, series compilations, movies, and OVAs with direct browser-playable MP4 video streams.
   - **Kitsu Anime DB**: Rich anime metadata, Japanese and English titles, synopsis, ratings, episode counts, and official trailer video links.
   - **Wikimedia Commons**: Free and public-domain classic Japanese animations and CC-licensed anime shorts.
   - **PeerTube**: Federated Fediverse instances with anime video streams.
3. For **multi-episode anime series**:
   - The card displays the number of episodes available.
   - Click **Play Ep 1** to stream the first episode immediately.
   - Click **Show all episodes** to expand the full episode drawer and view titles, runtimes, and file sizes.
   - Click **Play** or **Queue** on any individual episode.
   - Click **Queue all (N)** to add the entire series to your playlist in a single click.
4. For **single anime films and videos**:
   - Click **Play** to start playback or **Queue** to add to your queue.
   - Click **Open direct video** to access the raw `.mp4` file or **View record** for full archive details.
5. All streams support HTTP Range requests, meaning seeking, prebuffering while paused, and offline browser downloads work seamlessly.

### 3. Play local files

- **Add video(s)** for files, **Add folder** to add a directory (videos + matching `.vtt`/`.srt`).
- Or drag files anywhere onto the player / drop zone.
- Local files never leave your device: they are opened as `blob:` URLs from memory.

### 4. Download for offline

1. Play (or queue and play) an online video.
2. Click the ⬇ button in the control bar (or press <kbd>D</kbd>).
3. For HLS/DASH the app first analyses the stream, shows an estimated size and asks for confirmation for
   large downloads, then stores every manifest and segment.
4. When it finishes, the video appears under **Available offline** and plays with the network disabled.

### 5. Playlist

Items are numbered; the current item is highlighted. Use the ↑/↓ buttons (or drag the row) to reorder,
✕ to remove, the header buttons to sort/import/export/clear. **Export** writes a JSON file you can share;
**Import** merges a JSON playlist back in.

**Sort A–Z** (the ↓-of-bars button in the playlist header) orders the whole queue by title once — case
insensitive and natural, so `Episode 2.mp4` sorts before `Episode 10.mp4`. It does not lock the order: the
sorted result is saved and ↑/↓ or dragging still rearrange rows afterwards; press the button again to
re-alphabetise.

Everything you do here is saved for you. Additions, moves, sorts and removals are written to `localStorage`
within a few hundred milliseconds, and any write still in that window is flushed when the tab is hidden or
the app is closed — so you can queue a URL and quit immediately. (Local files are the exception: browsers
will not remember a file handle between sessions.)

Clicking an item re-opens it **where you left off** (a “Resumed at …” toast confirms the position). That
works for streamed, downloaded and local files, across app reloads, and a title that was watched to the
end starts from the beginning next time. Playing a fifth of a video or longer is what creates the mark.
Nothing is fetched or played on boot; instead the empty state shows the **last open** title with its stored
position, with **Resume** / **Start over** / dismiss buttons.

### 6. Rotate the screen

The ↻ button (or <kbd>Shift</kbd>+<kbd>R</kbd>) switches between portrait and landscape using the
browser's Screen Orientation API, just like rotating your phone. The whole player, controls,
subtitles and overlays follow the screen; the video itself is not transformed.
The player enters fullscreen when available because mobile browsers commonly require it to lock
orientation. Exiting fullscreen releases the lock so physical auto-rotation works again.
Browsers that cannot lock orientation show a message asking you to rotate your phone with
auto-rotate enabled instead. This includes browsers that expose the API but reject locking.

### 7. Subtitles — local files and online search

- **Load .vtt / .srt file** adds tracks by hand; dropped subtitle files and sidecar files next to a
  local video are picked up automatically. SRT is converted to WebVTT in memory.
- Expand **Subtitle appearance** in the CC panel to change subtitle size, text color, background
  color and opacity, and height above the bottom edge. The controls apply to external and embedded cues,
  and **Reset appearance** restores the defaults.
- **Search online…** (also <kbd>Shift</kbd>+<kbd>C</kbd>) opens the search dialog:
  1. The name of the current video is prefilled — for a file like `Show.S02E04.1080p.WEB-DL.mkv` the
     query becomes *Show* with season 2 / episode 4 filled in. You can type any other name instead.
  2. Pick a language (defaults to your browser language; *Any language* searches everything) and press
     **Search**. Results from every source are merged, ranked and tagged with language, downloads,
     rating, HD and hearing-impaired flags.
  3. **Click a result** to download it and attach it as a track (the CC panel shows it as
     `· OpenSubtitles`). The ⤓ button next to a result saves the file to disk instead.
- **More options** holds a paste-a-link field, a *File…* button, the CORS-proxy toggle and the optional
  OpenSubtitles.com API key (free keys at <https://www.opensubtitles.com/en/consumers>) — with a key,
  the official API is searched as a third source.

> **Why a proxy toggle?** Browsers only allow cross-origin reads when the host sends CORS headers.
> The subtitle sites often don't, so by default blocked requests are retried through a public CORS
> proxy (`allorigins`, `codetabs`, `corsproxy.io`). Turn it off to keep every request direct — some
> sources will then report “blocked by CORS”. You can also point the option at your own proxy from the
> console: `localStorage` key `nebula.settings.v1` → `subSearchProxyUrl` (a prefix or a template
> containing `{url}`).

---

## Gestures

| Gesture | Action |
|---------|--------|
| **Swipe left / right** across the video (mobile) | Seek backward / forward continuously (about 0.1 s per horizontal pixel) |
| **Swipe up / down** across the video (mobile) | Raise / lower volume (a full stage-height swipe spans 0–200%) |
| **Double-tap** the video area (mobile) | Play / pause (completely silent — no icon or text is shown) |
| **Double-click** the video area (desktop) | Play / pause (completely silent — no icon or text is shown) |
| **Single tap / click** the video area | Show / hide the control bar |
| Optional (off by default, see *Keyboard shortcuts* dialog) | Double-tap the left/right third to seek −10 s / +10 s |
| Drag a file over the player | Shows the drop overlay; drop to add |

Notes on the implementation:

- Touch double-taps are detected from `touchend` timestamps: two taps within **300 ms** and within 60 px
  count as a double-tap (the same thresholds used by most mobile players).
- A touch moving at least **36 px** locks to its dominant axis: horizontal movement seeks at about
  **0.1 seconds per pixel**, while vertical movement changes volume relative to the player height.
  A small on-video HUD shows the current seek offset or volume; swipes never trigger the tap actions.
- Desktop uses the native `dblclick` event.
- Every handler checks `event.target` first: taps on the control bar, buttons, sliders, playlist,
  URL input, dialogs or any `.card`/`.item` are **never** treated as gestures.
- Page zoom is disabled everywhere (`maximum-scale=1, user-scalable=no` viewport, touch-action
  restrictions on the page and player stage, plus JS guards against pinch / Ctrl+wheel / iOS gesture events), so taps never zoom —
  including while typing in the URL field. The single-tap action is delayed by ~320 ms on touch so a
  second tap can cancel it.
- Play/pause is completely silent — no overlay icon or text is shown; only seeks flash a "10s"
  ripple on the corresponding side.

---

## Keyboard shortcuts

Press <kbd>?</kbd> inside the app for this list.

| Key | Action | Key | Action |
|-----|--------|-----|--------|
| <kbd>Space</kbd> / <kbd>K</kbd> | Play / pause | <kbd>M</kbd> | Mute |
| <kbd>←</kbd> / <kbd>→</kbd> | Seek −5 s / +5 s | <kbd>C</kbd> / <kbd>Shift</kbd>+<kbd>C</kbd> | Subtitles on/off · search online |
| <kbd>J</kbd> / <kbd>L</kbd> | Seek −10 s / +10 s | <kbd>S</kbd> | Shuffle |
| <kbd>↑</kbd> / <kbd>↓</kbd> | Volume ±5 % | <kbd>R</kbd> | Loop off → all → one |
| <kbd>0</kbd>–<kbd>9</kbd> | Jump to 0–90 % | <kbd>T</kbd> | Toggle theme |
| <kbd>Home</kbd> / <kbd>End</kbd> | Start / end | <kbd>D</kbd> | Download for offline |
| <kbd>F</kbd> | Fullscreen | <kbd>N</kbd> / <kbd>Shift</kbd>+<kbd>P</kbd> | Next / previous item |
| <kbd>P</kbd> | Picture-in-picture | <kbd>[</kbd> / <kbd>]</kbd> | Subtitle delay ∓0.5 s |
| <kbd>Shift</kbd>+<kbd>R</kbd> | Switch portrait / landscape | <kbd>Shift</kbd>+<kbd>C</kbd> | Search subtitles online |
| <kbd>Shift</kbd>+<kbd>A</kbd> | Search anime to stream | <kbd>Shift</kbd>+<kbd>&gt;</kbd> / <kbd>&lt;</kbd> | Speed ±0.25× |
| <kbd>,</kbd> / <kbd>.</kbd> | Frame step (paused) | <kbd>?</kbd> | Shortcut help |
| <kbd>Esc</kbd> | Exit fullscreen / close dialogs | | |

Shortcuts are ignored while you are typing in a field, and <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> combinations
are left to the browser.

---

## Offline downloads — how it works

Everything offline-related lives in `service-worker.js`.

### Storage layout (Cache API)

| Cache | Contents |
|-------|----------|
| `nebula-shell-<version>` | `index.html`, `styles.css`, `script.js`, manifest, icons (app boots offline) |
| `nebula-media-<version>` | The actual video data: whole files, or every HLS/DASH manifest + segment |
| `nebula-index-<version>` | `__nebula__/index.json` — metadata for the “Available offline” list |

Internal URL space (never linked from the UI):

```
<scope>__nebula__/index.json     ← download index (title, size, type, resource paths)
<scope>__nebula__/<id>/stream    ← synthetic URL of a stored progressive file
```

HLS/DASH resources are stored under **their real network URLs**, so the streaming library can keep
requesting them normally and the service worker answers from the cache.

### Download pipeline

1. The page posts `analyze` to the service worker.
   - HLS: the master playlist is parsed (variants, `EXT-X-MAP` init segments, keys) and each media
     playlist’s segment list is collected. Live streams (no `EXT-X-ENDLIST`) are rejected.
   - DASH: the MPD is parsed by a dependency-free XML scanner — **service workers do not have
     `DOMParser`**. The highest-bandwidth video and audio representations are selected, and
     `SegmentTemplate` (`$Number$`, `$Time$`, `SegmentTimeline`), `SegmentList` and `BaseURL`
     inheritance are supported.
   - Progressive: `Content-Length` (or a `Range: bytes=0-0` probe) gives the size.
   - A byte estimate is produced by sampling up to 12 segment sizes and extrapolating.
2. The page confirms downloads larger than 200 MB.
3. The page posts `download`; the service worker streams each resource with 4-way concurrency into the
   cache and broadcasts `download-progress` messages (`received`, `total`, `filesDone`, `filesTotal`).
4. On completion it writes the index and broadcasts `download-complete`. The page refreshes the list.

### Playing offline (and seeking)

When a request matches a stored resource the service worker serves it from the cache. For stored single
files it fully implements **HTTP range requests**: `Range: bytes=…` returns a `206 Partial Content`
with a correct `Content-Range` sliced out of the cached blob (`Blob.slice`, so no extra memory is used).
That is what makes the seek bar work while offline.

### Notes

- `navigator.storage.persist()` is requested so the browser is less likely to evict downloads.
  The storage quota is shown in the footer and in the offline panel.
- If the host does not send CORS headers, the app retries with `mode: 'no-cors'`. The video is still
  stored, but progress is unknown and **seeking is limited** (an opaque response cannot be read/sliced).
  The list marks these entries normally — check the browser console for details.
- Deleting a download removes the cached manifests/segments (a single cache walk matches them by path).

---

## Streaming libraries (hls.js / dash.js)

`vendor/hls.min.js` (hls.js 1.7.3) and `vendor/dash.all.min.js` (dash.js 5.2.1) are committed so that
**downloaded streams can be played back with no network at all** — a CDN-only setup breaks precisely
when you need it most.

`StreamEngine.ensureLibrary()` loads them on demand and falls back to jsDelivr/unpkg if the local copy is
missing, so HLS/DASH also work if you delete `vendor/`:

```js
hls  → vendor/hls.min.js  → cdn.jsdelivr.net/npm/hls.js@1.7.3  → unpkg.com/hls.js@1.7.3
dash → vendor/dash.all.min.js → cdn.jsdelivr.net/npm/dashjs@5.2.1 → cdn.dashjs.org/v5.2.1
```

To upgrade, replace the two files (or delete them and let the CDN versions load).

### Buffer policy while playing and paused

`StreamEngine.BUFFER_TARGETS` holds two sets of forward-buffer targets:

| State | hls.js | dash.js |
|-------|--------|---------|
| playing | `maxBufferLength: 60s`, `maxMaxBufferLength: 900s`, `maxBufferSize: 60 MB` | `bufferTimeDefault: 30s`, `bufferTimeAtTopQuality: 60s`, `bufferTimeAtTopQualityLongForm: 90s` |
| paused | `maxBufferLength: 300s`, `maxMaxBufferLength: 3600s`, `maxBufferSize: 300 MB` | `bufferTimeDefault: 300s`, `bufferTimeAtTopQuality: 600s`, `bufferTimeAtTopQualityLongForm: 900s` |

`applyBufferPolicy()` re-applies these on every play/pause (hls.js re-reads `hls.config`, dash.js gets a
runtime `updateSettings()`), so a paused video keeps downloading ahead. hls.js can have stopped its
scheduling loop after filling the old target, so a small keep-alive (every 2.5 s, max 6 nudges) calls
`hls.startLoad()` whenever the buffered end has not moved for ~5 s. Browsers will still stop a
progressive MP4/WebM download at their own internal limit — that part is not scriptable.

---

## Browser support

| Browser | Playback | PWA / offline |
|---------|----------|---------------|
| Chrome / Edge 90+ | ✅ | ✅ install + Cache API |
| Firefox 90+ | ✅ | ✅ (no install prompt, but offline works) |
| Safari 15.4+ / iOS 15.4+ | ✅ (native HLS) | ✅ (Add to Home Screen) |
| Samsung Internet / Opera | ✅ | ✅ |

The UI itself needs modern CSS (`aspect-ratio`, `dvh`, `backdrop-filter`) and ES2020 JavaScript. Old
browsers still play video but may lose some layout polish.

Codec support comes from the browser: H.264/AAC/MP4 and WebM/VP9 are broadly supported; HEVC, AV1,
MKV and AC-3 depend on the platform.

---

## Limitations & known constraints

These are inherent to a browser-based player (no backend, no DRM):

1. **CORS** — the `<video>` element can play progressive MP4/WebM without CORS (the service worker
   does not intercept those requests). HLS/DASH playlists, offline **downloads** and the automatic
   **page scan** still need `Access-Control-Allow-Origin`. Downloading cross-origin without CORS
   falls back to an opaque cache entry with limited seeking. Watch pages (YouTube, Vimeo, social)
   are not direct files, and their hosts block cross-origin reads, so the page scan cannot
   extract their videos either — paste a direct file/stream URL. Movie/series search queries the public
   APIs of Internet Archive, Wikimedia Commons and SepiaSearch (the PeerTube index); it does not search
   commercial streaming services, torrent sites or the whole web. Licence labels are uploader-provided
   and are not independently verified.
2. **DRM / EME** — Widevine/PlayReady/FairPlay protected streams are not supported.
3. **Live streams** — HLS/DASH live playlists can be played but not downloaded (there is no end).
4. **DASH coverage** — `SegmentTemplate`, `SegmentTimeline`, `SegmentList` and `BaseURL` chains are
   supported. `SegmentBase`/single-file MPDs and multi-period manifests are not (the app tells you and
   suggests downloading the MP4 instead). Only the highest video + audio representation is stored, so an
   offline DASH item is pinned — adaptive switching to uncached renditions is not possible.
5. **HLS byte-range playlists** (`EXT-X-BYTERANGE`) download whole segment files; segments that are
   addressed purely by byte ranges inside one big file are stored as the full file, which can be large.
6. **Storage quota** — browsers cap Cache API storage (typically ~60 % of free disk per origin). Very
   long videos may fail to download; the app reports the error.
7. **Autoplay policies** — a video cannot start with sound before the user interacts with the page.
   The app asks you to press play instead of failing silently.
8. **iOS specifics** — background playback, PiP and fullscreen behaviour are controlled by iOS;
   `webkitEnterFullscreen` is used as a fallback. Picture-in-picture may be unavailable.
9. **Local files must be reconnected once per visit** — the *queue entry* is saved (name, size, modified
   date, order and resume position), but a browser will not hand the file itself back to a page that did
   not just open it, so playing it after a restart needs one pick of the file or its folder. Renaming,
   moving or re-encoding the file breaks the match. Downloads are persisted normally and play with no
   re-picking at all.
10. **Subtitle delay** is applied by shifting cue times in memory; it is not re-encoded into the file.
11. **Cross-origin subtitles** are only auto-discovered when the host allows it; otherwise use the
    “Load .vtt / .srt file” button or the online search.
12. **Online subtitle search** depends on third-party sites and their CORS policy. When a host refuses
    browser reads, the request is retried through a public CORS proxy (the toggle in *More options*);
    searches themselves are only queries — nothing about the video file leaves your device.
13. **OpenSubtitles legacy results** are downloaded from the Stremio mirror (plain UTF-8 `.srt`) with
    the original `.gz` file as a fallback; browsers without `DecompressionStream` cannot unpack the
    fallback, so those users should use the ⤓ save button and open the file manually.
14. **Buffering ahead is best-effort** — browsers cap how much media they keep for a `<video>` element
    and SourceBuffers have their own quota, so “download the rest of the film in the background” cannot
    be guaranteed for progressive files. Streams (HLS/DASH) get much larger targets while paused; live
    streams keep their normal live window. Background buffering uses bandwidth, hence the switch in the
    shortcut dialog.
15. **Resume positions live in this browser** (`localStorage`, max 300 entries/6 months, pruned
    automatically). Clearing site data or using private windows starts everything from the beginning.
    A title you watched to within ~2 % of its end (at least 5 s, at most 30 s) is treated as finished.
    A position is written on pause, on seek, roughly every 10 s during playback and when the app is
    hidden or closed — so a browser that is killed outright (no `pagehide` at all) can lose the last few
    seconds of a *playing* video; the queue itself is written within 200 ms of the change.
16. **Screen rotation depends on browser support** — unsupported browsers require physical phone
    rotation with auto-rotate enabled. It does not modify downloaded videos or PiP windows.
17. **Volume above 100% uses Web Audio gain** — browser security only permits processing local or
    same-origin media in this player. Cross-origin streams stay at 100% (the player leaves their native
    audio path untouched). Web pages cannot change the phone's OS/hardware volume; use the device buttons
    for that.

---

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| “Open this app over https:// or http://localhost” banner | You opened `file://`. Start a local server (see [Quick start](#quick-start)). |
| Video loads but never plays, error card appears | Use a **direct** MP4/WebM/HLS/DASH URL (not a YouTube/Vimeo page). Progressive files play without CORS; HLS/DASH need CORS. Try the **Sample** button to verify a known-good stream. |
| HLS/DASH says the library could not be loaded | You are offline **and** `vendor/` is missing. Restore the two vendored files. |
| Download button does nothing | No service worker: the page must be on https/localhost and the SW must be registered (footer shows “Service worker: active”). |
| Download fails with “This server does not allow cross-origin downloads” | Add `Access-Control-Allow-Origin` on the media host, or download from the same origin. |
| Seeking jumps/stutters on a downloaded file | It was stored as an opaque (no-CORS) response; re-download from a CORS-enabled source. |
| Playback stutters for 4K files | The browser decodes in software; try a lower resolution or close other tabs. |
| Nothing is stored after a while | The browser evicted the cache (storage pressure). Grant persistent storage when prompted and keep free disk space. |
| Subtitles do not appear | Enable them in the CC panel; check the file is a valid `.vtt`/`.srt` (SRT is converted automatically). |
| Movie search finds nothing | The search covers Internet Archive, Wikimedia Commons and PeerTube — not commercial streaming services, torrent sites or the whole web. Try the title's original spelling (or just the series name), switch the *Catalogue* picker to *All catalogues*, or browse a record for alternative names. Only records with a declared Creative Commons/public-domain licence and a direct video file are shown — a title whose upload has no licence or no playable file is skipped on purpose. |
| Movie search cannot connect | Check the connection and retry; the status line names which catalogue failed. The search reads the catalogues' public JSON APIs directly, so browser extensions, DNS filters or offline mode can block individual sources — the others still deliver results. |
| A search returns “PeerTube … could not be reached” | Some PeerTube instances are offline or block cross-origin reads. PeerTube rows need one extra request (the instance's API) to find the direct file; simply retry, or narrow the picker to another catalogue. |
| Video starts again from the beginning instead of resuming | The video is shorter than 5 s, it was watched to the end (then starting over is intentional), it is a live stream, or the site data was cleared. A local file also has to be reconnected first (see below). |
| The playlist is there but a local file will not play | Browsers never keep a local file open between visits, so the row comes back as **“saved — tap to reconnect”**. Click it (or the link icon) and pick the file or its folder again — rows are matched by name, size and modified date, so one pick can reconnect the whole queue. Renaming or re-encoding the file breaks the match; remove the row and add it again. |
| Nothing is downloaded while the video is paused | Progressive MP4/WebM playback is buffered by the browser itself, which stops after its own internal limit regardless of the page. HLS/DASH streams are expanded while paused — check *Keep downloading ahead while paused* is on (shortcut dialog) and that the host is not rate-limiting. |
| Online subtitle search finds nothing | The name must match a release on OpenSubtitles — try a shorter title, clear the language filter or switch it to *Any language*. The status line names the source that failed and why. |
| Search says “blocked by CORS” | The host refused the browser request. Enable **Retry blocked requests** in *More options* (uses a public proxy), or paste a direct subtitle link / load the file manually. |
| OpenSubtitles.com (API key) returns “API key rejected” | The key is wrong or rate-limited. Remove it from *More options* to fall back to the free sources. |

---

## Customising

- **Theme** — all colours live in the `:root` / `:root[data-theme="light"]` custom properties at the top
  of `styles.css` (`--accent`, `--accent-2`, surfaces, radii, spacing).
- **Default settings** — edit the `Settings.data` defaults in `script.js` §02
  (`prebufferWhilePaused`, `movieSearchSource`, …).
- **Buffer policy** — `StreamEngine.BUFFER_TARGETS` (see
  [Streaming libraries](#streaming-libraries-hlsjs--dashjs)).
- **Speed presets** — the `speeds` array in `Menus.init()`.
- **Sample streams** — `Sources.SAMPLES`.
- **Cache versions** — bump `VERSION` in `service-worker.js` to refresh the app shell after changes. Keep `DATA_VERSION` unchanged for shell-only releases so stored offline videos survive; bump it only when the offline media/index format changes.

### Adding a search catalogue

The movie/series search is provider-based: every entry in `MovieSearch.sources` is an object of the shape

```js
{
  id: 'archive',                       // value used by the picker and stored in settings
  label: 'Internet Archive',           // shown in the picker and on every result row
  async search(query, { signal }) {    // → array of result objects (may be empty)
    return [{
      title: 'Some Film', year: '1929', creator: 'Studio',
      license: { url: 'https://creativecommons.org/…', label: 'CC BY · uploader-declared' },
      url: 'https://example.org/film.mp4',   // direct file or stream URL
      type: detectType(url, 'progressive'),
      fileName: 'film.mp4', fileSize: 0, duration: 0,
      detailsUrl: 'https://example.org/record/1',
    }];
  },
}
```

Push it into `MovieSearch.sources` and the picker, the status line and the source tags pick it up
automatically. Follow the same licence rules as the built-in catalogues: only surface records with an
uploader-declared public-domain/Creative Commons licence *and* a directly playable URL, use `credentials:
'omit'` + `referrerPolicy: 'no-referrer'` for the requests (see `MovieNet`), and never scrape a watch
page or bypass a paywall/DRM.

### Service worker updates

`VERSION` changes create new caches and delete old ones on `activate`. The service worker calls
`skipWaiting()` + `clients.claim()`, so a new build takes over immediately (no need to close every tab).

---

## Development & tests

The app itself needs **no build step and no dependencies**. Three optional harnesses live in `tests/`
(Node 18+), handy when you change something:

```bash
node tests/static-checks.mjs          # ids, sprite references, asset paths, manifest, syntax sanity
node tests/service-worker.test.mjs    # 50 checks: caching, HLS/DASH parsing, ranges, downloads
npm install --no-save jsdom           # only for the UI test
node tests/ui-smoke.test.mjs          # boots the real DOM and drives keyboard/gestures/playlist/sorting/movie-search/page-scan/subtitle-search
node tests/persistence.test.mjs       # close/reopen round trips: queue, order, highlight, resume pop-up, saved local files, save-on-close
```

- `static-checks.mjs` cross-references every `$('#id')` in `script.js` with `index.html` — the fastest
  way to catch a typo after renaming an element.
- `service-worker.test.mjs` runs `service-worker.js` inside a `node:vm` sandbox with a fake Cache API,
  a fake network and fake clients. It verifies HLS/DASH URL collection, byte accounting, range
  responses (`206` + `Content-Range`), aliasing, cancellation and cache cleanup.
- `ui-smoke.test.mjs` boots `index.html` + `script.js` in jsdom with media-element stubs and exercises
  shortcuts, gestures (including the touch double-tap timing), screen rotation, playlist reordering, movie/series search
  (mocked Internet Archive, Wikimedia Commons and SepiaSearch/PeerTube backends, licence filtering,
  direct-URL resolution and the catalogue picker), subtitles, the online subtitle search (with a mocked
  OpenSubtitles/Stremio backend, language filters and one-click loading), resume-position persistence
  across item switches, the alphabetical playlist sort and the paused forward-buffer policy (through a fake
  hls.js instance) plus localStorage persistence.
- `persistence.test.mjs` boots the app *on top of* a `localStorage` state from a previous session and checks
  what comes back (queue, saved order, highlighted last title, resume position, the “continue where you
  left off” card) and that `pagehide` / hiding the tab flushes debounced writes instead of losing them.
  It also runs whole sessions end to end — import a playlist, watch it, close the app, boot again on
  exactly the storage that session wrote — and asserts the queue, the highlight on the watched title, the
  “Continue watching?” pop-up and its Resume/Start-over buttons, that a queue of local files survives by
  identity and reconnects with one pick, and that the app still boots when the service worker serves an
  older `index.html` alongside a newer `script.js`.

---

## Credits

- [hls.js](https://github.com/video-dev/hls.js) — HLS playback (Apache-2.0)
- [dash.js](https://github.com/Dash-Industry-Forum/dash.js) — MPEG-DASH playback (BSD-3-Clause)
- Movie/series search uses Internet Archive's public [Advanced Search](https://archive.org/developers/search.html)
  and [Metadata](https://archive.org/developers/md-read.html) APIs, the
  [Wikimedia Commons MediaWiki API](https://commons.wikimedia.org/w/api.php) (direct files are served by
  [`upload.wikimedia.org`](https://upload.wikimedia.org)) and the
  [SepiaSearch](https://sepiasearch.org) index of the federated [PeerTube](https://joinpeertube.org)
  network (each result is then resolved against its hosting instance's API). Video files and metadata
  remain hosted by their uploaders / the respective platforms.
- Sample streams referenced in the app belong to their respective owners (W3C, Google, Apple, DASH-IF).
- Online subtitle search talks to third-party services: [OpenSubtitles](https://www.opensubtitles.org)
  (legacy REST API and the official [opensubtitles.com](https://www.opensubtitles.com) API),
  [Stremio](https://www.strem.io)'s OpenSubtitles add-on and Cinemeta catalogue, and IMDb's public
  suggestion endpoint for title lookup. Subtitles remain the property of their uploaders; the app only
  queries those services from your browser and never proxies media.

Icons and artwork are generated for this project, no third-party assets are bundled.
