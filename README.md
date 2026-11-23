# ARMMC Pharmacy Queuing System

A real-time, rotating-card pharmacy dispensing queue and TV announcement web application built with **Google Apps Script (V8)** for **Amang Rodriguez Memorial Medical Center — Pharmacy Dispensing Area**.

Designed for hospital clinics with 1–4 dispensing counters, waiting-area Smart TVs, and optional Google Sheets daily audit logging — with **zero external hosting or audio CDN dependencies**.

---

## Views & URL Routes

| Route | View | Purpose |
| :--- | :--- | :--- |
| `?view=hub` *(default)* | **Queue Launchpad** (`ViewHub.html`) | Central links, copy-URL buttons, live station presence (`TV`, `C1`–`C4`), and today's served summary. |
| `?view=display` | **Outside Display Monitor** (`ViewDisplay.html`) | Read-only TV screen with flashing **Now Calling** spotlight, dynamic 1–4 counter grid, QR Medicine Availability banner, missed numbers strip, scrolling advisory ticker, and hospital chime + voice announcements. |
| `?view=counter&id=1..4` | **Counter Workbench** (`ViewCounter.html`) | PIN-gated pharmacist station with **Call Next**, **Recall**, **No-Show**, **Done**, **Call Specific #**, Open/Close toggle, missed-ticket hold list, duplicate-tab alert, and keyboard shortcuts (`Space`/`Enter`, `R`, `N`, `D`). |
| `?view=admin` | **Admin Console** (`ViewAdmin.html`) | Admin-PIN console for daily KPIs, per-counter breakdown, card range & zero-padding, counter labels, display theme, audio/voice settings, polling mode, next-number override, daily queue reset, and CSV export. |

---

## Key Features

- **Rotating Physical Card Queue (`QueueEngine.js`)**
  - Cycles through a configurable numbered card pool (default `001`–`100`, up to `1`–`9999`) and skips numbers actively serving at other counters so two windows never double-call the same card.
  - Tracks `COMPLETED`, `NO_SHOW`, and `MISSED_RECALL` outcomes plus average service duration.
- **Smart-TV-Ready Embedded AI Audio (`ClientAudio.html`)**
  - Plays a synthesized 2-tone Web Audio hospital bell (`E5 → C5`) followed by **embedded base64 MP3 voice packs** — no browser `speechSynthesis` required on Smart TVs (Samsung Tizen, LG webOS, Android TV, etc.).
  - Uses Web Audio API (`decodeAudioData` + `AudioBufferSourceNode`) as primary playback and automatically falls back to a pre-unlocked HTML5 `<audio>` element.
  - Supports **4 embedded voice packs** switchable from Admin Console:
    - **Taglish / Filipino (`fil_ph`)**: Female (`AssetVoiceFil.html`) & Male (`AssetVoiceFilMale.html`)
    - **Philippine English (`en_ph`)**: Female (`AssetVoiceEn.html`) & Male (`AssetVoiceEnMale.html`)
  - Includes `en_us` browser TTS option for PC displays, falling back automatically to embedded voices on Smart TVs.
- **Multi-Display Sync & Dynamic TV Layout (`ViewDisplay.html`)**
  - Supports opening `?view=display` on multiple screens simultaneously (e.g., an outside Smart TV with sound unlocked + an inside counter monitor set to *Visual Only / Silent*).
  - Supports **Light Clinical** and **High-Contrast Dark TV** themes.
  - Uses 2D container-aware sizing (`cqi`/`cqh`), viewport fallbacks, and JS auto-fit (`fitCounterTileBody` / `fitHeroStage`) so counter numbers and labels never clip across 1–4 open counters.
  - Includes a viewfinder-styled **QR Medicine Availability** card (`May Stock Ba ang Gamot Mo?`) with pause-on-call animations and automatic compact layout.
- **Concurrency, Presence & Google Sheets Audit Logging (`Storage.js`)**
  - Serializes all state changes via `LockService.getScriptLock()`, stores authoritative state in `PropertiesService`, and serves fast version-checked polling (`apiPollState`) from `CacheService` with configurable **Standard** (`2.5s` Display / `6s` Counter) or **24/7 Eco** (`4s` Display / `12s` Counter) intervals.
  - Logs calls and daily formulas non-blockingly to `Call_Log` and `Daily_Summary` tabs when bound to a Google Spreadsheet, with RFC-4180 CSV export.

---

## Repository Structure

| File | Role |
| :--- | :--- |
| `Code.js` | Apps Script `doGet` router, Sheet menu (`onOpen`), PIN checks, and RPC endpoints. |
| `QueueEngine.js` | Pure queue state machine, settings validation, sanitization, and CSV formatter (Node-testable). |
| `Storage.js` | `PropertiesService` persistence, `CacheService` polling & station presence, `ScriptLock`, and Sheets logging. |
| `ViewHub.html` | Launchpad UI for all stations. |
| `ViewDisplay.html` | Waiting-area & monitoring TV display UI. |
| `ViewCounter.html` | Pharmacist Counter 1–4 workbench UI. |
| `ViewAdmin.html` | Supervisor settings, census, and activity log UI. |
| `StylesCommon.html` | Shared CSS variables/themes and `window.PharmacyUI` helpers. |
| `ClientAudio.html` | Web Audio chime + embedded MP3 sprite player + `<audio>` / `speechSynthesis` fallbacks. |
| `AssetLogo.html` | Embedded base64 ARMMC official seal (`window.applyHospitalLogo`). |
| `AssetVoiceFil.html` | Embedded Taglish Female MP3 voice pack (`fil_ph`). |
| `AssetVoiceFilMale.html` | Embedded Taglish Male MP3 voice pack (`fil_ph_male`). |
| `AssetVoiceEn.html` | Embedded Philippine English Female MP3 voice pack (`en_ph`). |
| `AssetVoiceEnMale.html` | Embedded Philippine English Male MP3 voice pack (`en_ph_male`). |
| `appsscript.json` | Apps Script manifest (`Asia/Manila`, V8 runtime, Web App config). |
| `.clasp.json` / `.claspignore` | `clasp` project configuration and push exclusions. |
| `scripts/generate_voice_packs.py` | Local Python generator for Microsoft Neural (`edge-tts`) embedded MP3 packs. |
| `scripts/generate_gemini_voice.py` | Local Python generator for 2-half natural Taglish Gemini TTS packs (`AssetVoiceFil*.html`). |

---

## Deployment (Google Apps Script)

1. Open a Google Spreadsheet (for `Call_Log` / `Daily_Summary` persistence) and go to **Extensions → Apps Script**, or push via [`clasp`](https://github.com/google/clasp):
   ```powershell
   clasp push
   ```
   *(If copying manually into the Apps Script editor, include all `.js` files, `appsscript.json`, and all `.html` files — do **not** upload `scripts/` or `.py` files.)*
2. If attached to a Google Sheet, reload the Sheet and run **ARMMC Pharmacy Queue → Initialize / Repair Log Sheets** to create `Call_Log` and `Daily_Summary`.
3. Click **Deploy → New deployment** (or **Manage deployments → Edit → New version → Deploy**) as a **Web app** (`Execute as: Me`, `Who has access: Anyone`).
4. Open the Web App URL (`?view=admin`), unlock with the default Admin PIN (**`2468`**; default Staff PIN is **`1234`**), and **immediately change both PINs** before live hospital use.
5. Open `?view=display` on the waiting-area Smart TV, click **Start Display & Enable Sound / Buksan ang Tunog**, and press **F11** (or Fullscreen).

---

## Regenerating Embedded Voice Packs (Optional)

The `.html` voice packs are already pre-generated in this repo. To customize or regenerate them locally:

- **Microsoft Neural Voices (`edge-tts`):**
  ```powershell
  pip install edge-tts
  python scripts/generate_voice_packs.py
  ```
- **Google Gemini TTS Natural Taglish (2-half phrase pack in 5 free API calls):**
  ```powershell
  pip install google-genai imageio-ffmpeg
  $env:GEMINI_API_KEY="YOUR_API_KEY"
  python scripts/generate_gemini_voice.py --voice Aoede
  # Or for male voice:
  python scripts/generate_gemini_voice.py --gender male --voice Charon
  ```
