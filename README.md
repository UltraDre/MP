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

- Play/pause, seek bar with hover tooltip + buffered range, volume/mute, fullscreen, picture-in-picture,
  playback speed (0.25×–3×, pitch preserved), loop (off / all / one) and shuffle.
- Media Session integration (lock-screen / hardware media keys where supported).
- Loading spinner, buffered-range indicator, resume position, friendly error cards with retry.

**Sources**

- **Online**: paste a URL — the format is detected automatically.
  - `.m3u8` → `hls.js` (or native HLS on Safari/iOS)
  - `.mpd` → `dash.js`
  - MP4/WebM/M4V/MOV/OGG/MP3/M4A/… → played directly by the `<video>` element
  - **Anything else** (a normal web page) → the page is fetched and scanned
    automatically (`<video>`/`<source>` tags, `og:video` metadata, media links
    and URLs embedded in the page's scripts) and every video found is added
    to the playlist
- **Movie search**: search Internet Archive by title for direct video files whose records declare a
  public-domain or Creative Commons license. Results can be played or queued. This is a focused catalog
  search, not a search of the whole web; license claims come from uploaders and should be verified.
- **Local**: file picker, folder picker (sidecar `.vtt`/`.srt` subtitles are matched by filename),
  drag-and-drop onto the page, plus `Ctrl/Cmd+V` to paste a URL from the clipboard.
- **Offline**: one click stores the current video (or every HLS/DASH segment) in the browser cache so it
  plays with no network at all.

**Playlist**

- Add online URLs and local files, switch between items, reorder (drag-and-drop or ↑/↓ buttons),
  remove items, clear the list, import/export as JSON. The playlist survives reloads (local files are
  intentionally not persisted — browsers do not allow it — but they stay available for the session).

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

**App / PWA**

- Installable (manifest + service worker), works offline for the UI itself, dark/light theme,
  responsive layout (sidebar becomes a bottom sheet on phones), toasts, keyboard-shortcut dialog,
  and localStorage persistence for theme, volume, speed, loop/shuffle, subtitle preferences and playlist.

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
│   └── ui-smoke.test.mjs
└── README.md
```

### Where things live in `script.js`

The file is split into numbered sections so you can jump straight to what you need:

| § | Section | Responsibility |
|---|---------|----------------|
| 01–04 | Utilities, Settings, Toasts, Media helpers | formatting, localStorage, dialogs, format detection |
| 05 | `StreamEngine` | loads hls.js/dash.js on demand and attaches streams |
| 06 | `Player` | the core playback controller (`load()`, seeking, volume, errors) |
| 07 | `MediaSession` | OS media keys / lock-screen metadata |
| 08–09 | `Controls`, `Menus` | control bar binding, speed menu, popups |
| 10–11 | `Gestures`, `Keyboard` | double-tap/double-click gestures & shortcuts |
| 12 | `Playlist` | queue, reordering, persistence, import/export |
| 13 | `Offline` | talking to the service worker, downloads UI |
| 14 | `Subtitles` | VTT/SRT tracks, delay, embedded tracks |
| 15 | `SubtitleSearch` | online search (OpenSubtitles/Stremio), `Net` fetch helper, proxies |
| 16 | `Sources`, `MovieSearch` | URL/local files, page scanning and Internet Archive movie search |
| 17–18 | `Theme`, `Shell` | theme, network state, panels, dialogs, install |
| 19–20 | `UI`, `App` | view helpers and boot sequence |

---

## Using the player

### 1. Play an online video

1. Paste a direct media URL into **Online video** and press **Play** (or **Queue** to add it without playing).
2. To look up a movie by name, choose **Search movies**, enter its title, then press **Play** on a result
   (or **Queue** it). This searches Internet Archive's movie catalog for items marked public domain or
   Creative Commons and offering a direct video file. It does **not** search the whole internet or
   third-party subscription services. License labels are supplied by uploaders; open the record to
   verify rights before streaming.
3. Formats are detected from the URL. Progressive MP4/WebM files play without CORS.
   HLS/DASH playlists need CORS — see [Limitations](#limitations--known-constraints).
4. Links that are **not** direct media files (ordinary web pages) are scanned automatically when
   submitted in the Online video field: the app fetches the page, extracts every video it references
   (`<video>`/`<source>` tags, `og:video` metadata, media links and URLs embedded in the page's scripts)
   and adds them to the playlist — pressing **Play** starts the first one found. Scanning needs the
   page's host to allow cross-origin reads (CORS); watch pages that don't (YouTube, Vimeo, …) still
   require a direct file/stream URL.

You can also deep-link a video: `index.html?url=https://example.com/video.m3u8`.

### 2. Play local files

- **Add video(s)** for files, **Add folder** to add a directory (videos + matching `.vtt`/`.srt`).
- Or drag files anywhere onto the player / drop zone.
- Local files never leave your device: they are opened as `blob:` URLs from memory.

### 3. Download for offline

1. Play (or queue and play) an online video.
2. Click the ⬇ button in the control bar (or press <kbd>D</kbd>).
3. For HLS/DASH the app first analyses the stream, shows an estimated size and asks for confirmation for
   large downloads, then stores every manifest and segment.
4. When it finishes, the video appears under **Available offline** and plays with the network disabled.

### 4. Playlist

Items are numbered; the current item is highlighted. Use the ↑/↓ buttons (or drag the row) to reorder,
✕ to remove, the header buttons to import/export/clear. **Export** writes a JSON file you can share;
**Import** merges a JSON playlist back in.

### 5. Subtitles — local files and online search

- **Load .vtt / .srt file** adds tracks by hand; dropped subtitle files and sidecar files next to a
  local video are picked up automatically. SRT is converted to WebVTT in memory.
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
| **Swipe up / down** across the video (mobile) | Raise / lower volume (a full stage-height swipe spans the volume range) |
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
| <kbd>,</kbd> / <kbd>.</kbd> | Frame step (paused) | <kbd>Shift</kbd>+<kbd>&gt;</kbd> / <kbd>&lt;</kbd> | Speed ±0.25× |
| <kbd>Esc</kbd> | Exit fullscreen / close dialogs | <kbd>?</kbd> | Shortcut help |

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
   extract their videos either — paste a direct file/stream URL. Movie-title search uses Internet
   Archive's public catalog APIs only; it does not search commercial streaming services or the whole web.
   Its license labels are uploader-provided and are not independently verified.
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
9. **Local files are session-only** — a `File` cannot be re-opened after a reload (the browser will not
   hand back the handle without the File System Access API). Downloads are persisted normally.
10. **Subtitle delay** is applied by shifting cue times in memory; it is not re-encoded into the file.
11. **Cross-origin subtitles** are only auto-discovered when the host allows it; otherwise use the
    “Load .vtt / .srt file” button or the online search.
12. **Online subtitle search** depends on third-party sites and their CORS policy. When a host refuses
    browser reads, the request is retried through a public CORS proxy (the toggle in *More options*);
    searches themselves are only queries — nothing about the video file leaves your device.
13. **OpenSubtitles legacy results** are downloaded from the Stremio mirror (plain UTF-8 `.srt`) with
    the original `.gz` file as a fallback; browsers without `DecompressionStream` cannot unpack the
    fallback, so those users should use the ⤓ save button and open the file manually.

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
| Movie search finds nothing | The search covers Internet Archive's movie catalog, not commercial streaming services or the whole web. Try the title's original spelling, or browse the Archive record for alternative names. Only records with a declared Creative Commons/public-domain license and a direct video file are shown. |
| Movie search cannot connect | Check the connection and retry. The search reads Internet Archive's public JSON APIs directly; browser extensions or network filters may block those requests. |
| Online subtitle search finds nothing | The name must match a release on OpenSubtitles — try a shorter title, clear the language filter or switch it to *Any language*. The status line names the source that failed and why. |
| Search says “blocked by CORS” | The host refused the browser request. Enable **Retry blocked requests** in *More options* (uses a public proxy), or paste a direct subtitle link / load the file manually. |
| OpenSubtitles.com (API key) returns “API key rejected” | The key is wrong or rate-limited. Remove it from *More options* to fall back to the free sources. |

---

## Customising

- **Theme** — all colours live in the `:root` / `:root[data-theme="light"]` custom properties at the top
  of `styles.css` (`--accent`, `--accent-2`, surfaces, radii, spacing).
- **Default settings** — edit the `Settings.data` defaults in `script.js` §02.
- **Speed presets** — the `speeds` array in `Menus.init()`.
- **Sample streams** — `Sources.SAMPLES`.
- **Cache version** — bump `VERSION` in `service-worker.js` to invalidate the app shell after changes.

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
node tests/ui-smoke.test.mjs          # boots the real DOM and drives keyboard/gestures/playlist/movie-search/page-scan/subtitle-search
```

- `static-checks.mjs` cross-references every `$('#id')` in `script.js` with `index.html` — the fastest
  way to catch a typo after renaming an element.
- `service-worker.test.mjs` runs `service-worker.js` inside a `node:vm` sandbox with a fake Cache API,
  a fake network and fake clients. It verifies HLS/DASH URL collection, byte accounting, range
  responses (`206` + `Content-Range`), aliasing, cancellation and cache cleanup.
- `ui-smoke.test.mjs` boots `index.html` + `script.js` in jsdom with media-element stubs and exercises
  shortcuts, gestures (including the touch double-tap timing), playlist reordering, movie search
  (with mocked Internet Archive search/metadata and license filtering), subtitles, the online subtitle
  search (with a mocked OpenSubtitles/Stremio backend, language filters and one-click loading) and
  localStorage persistence.

---

## Credits

- [hls.js](https://github.com/video-dev/hls.js) — HLS playback (Apache-2.0)
- [dash.js](https://github.com/Dash-Industry-Forum/dash.js) — MPEG-DASH playback (BSD-3-Clause)
- Movie title search uses Internet Archive's public [Advanced Search](https://archive.org/developers/search.html) and [Metadata](https://archive.org/developers/md-read.html) APIs. Movie files and item metadata remain hosted by their uploaders / the Archive.
- Sample streams referenced in the app belong to their respective owners (W3C, Google, Apple, DASH-IF).
- Online subtitle search talks to third-party services: [OpenSubtitles](https://www.opensubtitles.org)
  (legacy REST API and the official [opensubtitles.com](https://www.opensubtitles.com) API),
  [Stremio](https://www.strem.io)'s OpenSubtitles add-on and Cinemeta catalogue, and IMDb's public
  suggestion endpoint for title lookup. Subtitles remain the property of their uploaders; the app only
  queries those services from your browser and never proxies media.

Icons and artwork are generated for this project, no third-party assets are bundled.
