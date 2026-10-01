# QA Engineer Take-Home - CAPI Survey Builder + Offline Android App

Everything here was **executed** unless it says "strategy only". No APK was supplied, so the ADB / proxy / profiler sections (Scenarios C and D) are written as runnable procedures and helper scripts, not as results.

## 0. TL;DR - run it

```bash
npm install
npm run lint:schema:original   # shows the supplied schema is invalid JSON (BUG-001)
npm run lint:schema            # fixed copy: still reports the unreachable HFC (BUG-004)
npm run test:api               # 17 API tests, Node built-ins only, no install needed
npm run test:engine            # 38 unit tests: visibility + HFC engine (Scenario E)
npx playwright install chromium && npm run test:web   # 42 tests (21 x desktop + budget-phone viewport)
```

Last run: **api 17/17, engine 38/38, web 42/42 passed.** `api/postman/` has the same sync checks as a Postman/Newman collection (`npm run mock`, then `newman run api/postman/sync-survey.postman_collection.json`).

| Path | What it is |
|---|---|
| `api/mock-server`, `api/tests`, `api/postman` | **Scenario A** - mock `POST /sync-survey` implementing the contract I would demand from the real backend + automated tests |
| `web/app`, `web/tests` | **Scenario B** - schema-driven form harness + Playwright skip-logic tests |
| `engine/` | Reference visibility/HFC engine, schema linter, unit tests (**Scenario E**) |
| `test-cases/*.csv` | Test matrices: sync/offline (24), HFC (42), dynamic-form regression (17) |
| `scripts/*.sh` | ADB helpers for Scenarios A, C, D |
| `schema/` | Original supplied schema + fixed copy |
| `BUGS.md` | 8 defects found in the supplied documents |

> **Honest scope note.** The mock server and `engine.js` are *my reference implementation of the spec*, standing in for the real backend/app. The tests are written so they can be pointed at the real thing by changing `baseUrl` (API) or the harness target (web); the contract assertions are what matter, not the mock.

---

## Findings in the supplied files (read this first)
The reference schema is itself broken - see `BUGS.md`. Highlights: **(1)** invalid JSON (missing comma, line 158) so the app cannot load it; **(2)** key typo `questioID` vs spec `attr`; **(3)** `hfc_sleep_plausible` requires `q_2=Yes` but `q_3` is only visible when `q_2=No`, so **the rule can never fire**; **(4)** inconsistent `validationRules` shapes with string min/max; **(5)** `reask_once` (schema) vs `reask_and_flag` (assessment). I turned each into an automated check (`schema-lint`, unit test SCH-01, UI test `[BUG-004]`) so a builder export with the same defect is caught before release.

---

# Part 1

## Scenario A - Offline sync & data collision

### API automation (`api/tests/sync-survey.test.js`)
**Core principle: `localId` is only unique per device, so the server must never use it alone as a key.** The record identity is `(deviceId, localId)`; `serverId` is always generated server-side. The tests assert:

| Test | Assertion |
|---|---|
| 01 / 02 | Ankit and Pooja both send `School_1` (sequentially *and* in `Promise.all`) -> two records, distinct `serverId`, each GET returns its own answers. No overwrite, no lost write |
| 03 | Same payload retried after a lost response -> `200 duplicate_replayed`, same `serverId`, row count +1 only (idempotency) |
| 04 | Same device+localId, *different* payload -> `207 conflict`, original untouched |
| 05 | Same school name from two devices -> both kept, `possibleDuplicateOf` set (entity de-dup is a merge decision, never a silent overwrite) |
| 06 | Client-supplied `serverId` ignored (mass-assignment / IDOR) |
| 07 / 08 | Partial batch failure -> `207` with per-item status; good items saved |
| 09-13 | 400 / 401 / 413 / 415, malformed JSON doesn't kill the server, Hindi/Kannada/emoji round-trip |
| 14 | **Thundering herd:** 300 parallel devices all sending `School_1` -> 300 distinct rows, zero lost |
| 15 | **Backpressure:** over-limit -> `429` + `Retry-After`; clients back off and succeed |

**Design recommendations that come out of the tests** (raise with the backend team): make devices send a client-generated **UUID** per survey in addition to `localId`; require `schemaVersion`; return **per-item results** so a batch is never all-or-nothing; and on the client use **exponential back-off with random jitter** plus a WorkManager unique-work policy so 50k phones do not sync at 5:00 PM sharp (the "DDoS" is largely a *client* scheduling problem - add a random 0-15 min delay, spread by `deviceId` hash).
For real load (not covered by a mock): k6 script, 1 POST per virtual device, ramp to 50k, compare jitter on/off, watch p95, error rate, DB lock waits.

### Strategy - background sync on poor networks (e.g. drop at 99% of a photo upload)
**Goal:** prove three invariants under every failure: *no data loss, no duplicate, no false "Synced".*

**Tools:** Charles Proxy (or Proxyman/mitmproxy) on laptop with device on the same Wi-Fi and proxy set; Android emulator `adb emu network speed gsm|delay gprs`; `adb shell cmd connectivity airplane-mode`; `adb logcat`; Network Link Conditioner-style throttling in Charles (**Proxy -> Throttle Settings**: 50 kbps, 800 ms latency, 5% packet loss); the DB inspection steps in Scenario C; `scripts/adb-network-and-memory-chaos.sh`.

**Procedure for "network dies at 99% of a photo upload":**
1. Create a survey with a ~3 MB photo offline (Room row `PENDING`, file on disk). Snapshot the DB row + file hash.
2. Enable Charles throttling at ~50 kbps so the upload is slow enough to catch. Turn Wi-Fi on; sync starts.
3. Watch the request in Charles (*Overview -> Size*, *Request -> body progress*). At ~99% either (a) use a **Breakpoint** on the request and abort it, (b) **Repeat with delay**, or (c) run `adb shell cmd connectivity airplane-mode enable` / `adb shell svc wifi disable`. Do it at 10%, 50%, 99% and *after* the last byte but *before* the response (the nastiest one: server has it, client doesn't know).
4. **Verify client:** row still `PENDING` (never `SYNCED`), photo file still present and hash unchanged, retry scheduled (`adb shell dumpsys jobscheduler | grep <pkg>` shows a pending job; log shows `Result.retry()`), no crash, notification/UI still says "pending".
5. Restore network. **Verify:** sync completes on its own; **server has exactly one** record and one intact photo (compare SHA-256 with the phone's copy); no orphan half-file; row -> `SYNCED` only after a valid ack.
6. Repeat with: app force-stopped mid-upload, reboot, Doze/battery-saver, server 500, 200-with-truncated-body (Charles *Map Local*/*Rewrite*), 401 expired token, slow 2G. All are rows in `test-cases/sync-and-offline-test-cases.csv` (SYNC-13...19).

**What a good implementation looks like (so I know what to assert):** chunked/resumable upload (or at least server-side idempotency key + atomic finalize), photo uploaded *before* the survey row is marked done, `SYNCED` only after ack, back-off with jitter, unique work name so triggers do not stack.

---

## Scenario B - Dynamic form rendering & regression

### Web automation (`web/tests/skip-logic.spec.js`, Playwright)
- The brief's example: **"Do you have a hobby?" = Yes -> "What is your hobby?" visible** (+ No -> hidden, back to placeholder -> hidden).
- Extra behaviours that usually break: hiding **clears the stale answer**, hidden answers are **absent from the submitted payload**, required+hidden does not block submit, a second rule on the same form.
- **Data-driven schema regression:** the spec *loops over every enabled `equals` rule in every survey* of `schema.json` and exercises every option of the parent. Add a rule in the builder -> it is tested with zero new code. This is the main answer to "developers keep breaking existing logic".
- `page.route()` to inject an HFC rule the sample schema cannot express, then test the re-ask/confirm/flag flow, boundary (16 vs 17) and 0-24 validation.
- Runs on desktop and a 360x640 budget-phone viewport; touch target >= 48 px asserted.
- Uses `data-testid` + roles/labels rather than CSS paths, so styling changes do not break tests.

### Strategy - regression when screens are generated from JSON
Stop testing *screens*; test **(schema -> behaviour)**. Split it in layers, cheapest first:

1. **Schema contract (automate 100%).** Every builder export validated in CI: JSON-schema, unique ids, targets exist *and precede*, known operators/actions, no unreachable HFC (all found real bugs here - `engine/schema-lint.js`). Version the schema; keep **golden schemas from every released app version** and replay them against the new app (backward compat).
2. **Engine as a pure function (automate 100%, biggest ROI).** `(schema, answers) -> visible questions, errors, flags`. Table-driven unit tests for each condition/operator/type/boundary; property-based tests (random answer sequences: applying the same answers in any order gives the same visible set; hidden answers never leak to payload).
3. **Fixture-per-input-type render tests (automate).** One tiny schema per each of the 20 types x {required, readonly, hidden, sensitive}; Espresso/Compose test asserts it renders, accepts input, saves, restores after process death.
4. **Cross-platform parity (automate).** Feed the same fixture + answer script to web preview and Android and compare the *set of visible question ids* dumped after each step - this directly catches "new builder feature breaks the mobile render".
5. **Visual snapshot tests (partly).** Paparazzi/Shot on 3 screen sizes and font scale 1.3 - flags overlap/truncation, human reviews the diff.
6. **Manual/exploratory (do not automate):** odd combinations (skip logic on a Matrix row or inside a Roster; roster count shrunk from 5 to 2 after answering), interruptions (call, low battery, rotation), 100-question forms on a 4 GB phone, translations (Hindi/Marathi/Gujarati/Kannada text length), readability in sunlight, and *does the icon make sense to a real field worker*.

**Process hook:** every builder PR runs layers 1-2 (< 1 min); app PRs run 2-4; nightly full render suite; release = layers 5-6. The rule "**every bug found in production becomes a fixture in the golden set**" makes the suite grow where the risk is. Coverage gap to close: the sample schema has only 3 of 20 types and no Roster/Matrix - I would ask the builder team for export fixtures of each (BUG-008).

---

## Scenario C - Inspecting Room, forcing WorkManager, simulating a 500

Scripts: `scripts/adb-inspect-room-db.sh`, `scripts/adb-force-sync.sh`. Assume package `com.example.capi`.

### 1. Extract and inspect the Room DB from an unrooted device
`/data/data/<pkg>` is private on unrooted devices and a **release APK is not debuggable, so `adb run-as` is refused.** Options in order of preference:

1. **Ask dev for a `qa`/debuggable build variant** (same code, `debuggable true`, same schema, different applicationId suffix). Best practice - this is what QA should test with. Then: `adb shell run-as com.example.capi ls databases/` and `adb exec-out run-as com.example.capi cat databases/app_database > app_database`. **Also copy `-wal` and `-shm`** (Room uses WAL; recent rows may only be in the WAL). Open with `sqlite3`/DB Browser, or use **Android Studio -> App Inspection -> Database Inspector** live.
2. **No QA build available:** decompile the release APK (`apktool d app-release.apk`), set `android:debuggable="true"` in the manifest, `apktool b`, `zipalign`, sign with my own debug key, `adb install`. Works if there is no signature/integrity check (Play Integrity) - note this is a *repackaged* build, so it is for inspection only, not release sign-off.
3. **`allowBackup="true"` and targetSdk <= 30:** `adb backup -f app.ab com.example.capi` -> extract with `android-backup-extractor` (`java -jar abe.jar unpack app.ab app.tar`). Deprecated and blocked for newer target SDKs.
4. Emulator with a userdebug/Google APIs (non-Play) image: `adb root` then `adb pull /data/data/com.example.capi/databases/`.

**What I verify in the DB:** row exists in the survey table with `sync_status = PENDING`; `answers_json` contains all visible answers, **none** for hidden questions; ids/`schemaVersion`/`deviceId`/UUID present; timestamps in UTC; photo path exists in app storage and file size > 0; sensitive fields not stored in clear text if `isSensitive`; roster rows count = iteration number. Useful queries:
```sql
SELECT id, sync_status, retry_count, created_at, length(answers_json) FROM survey_response ORDER BY created_at DESC;
SELECT sync_status, COUNT(*) FROM survey_response GROUP BY sync_status;
```

### 2. Force the WorkManager job now
WorkManager runs on top of JobScheduler (API 23+), so:
```bash
adb shell dumpsys jobscheduler | grep -A12 com.example.capi      # find job id + constraints (NETWORK_CONNECTED...)
adb shell cmd jobscheduler run -f com.example.capi <JOB_ID>      # -f = force, ignore constraints
adb logcat -s WM-WorkerWrapper WM-SystemJobService               # watch the worker start/finish and the Result
```
Alternatives: toggle connectivity (`adb shell svc wifi enable`) to trigger the real constraint; on a debug build use `WorkManagerTestInitHelper`/`TestDriver.setAllConstraintsMet(id)` in instrumented tests; `adb shell am kill` + relaunch to test recovery. Inspect queue state via `dumpsys jobscheduler` or App Inspection -> **Background Task Inspector**.

### 3. Simulate a 500 and prove retry without data loss
1. Charles/Proxyman: install its CA on the phone (user CA works only if the build trusts user CAs - `networkSecurityConfig` in a debug/QA build; otherwise cert pinning must be disabled in QA build, another reason to have a QA variant). Set Wi-Fi proxy to the laptop.
2. **Map Local / Rewrite** (or Breakpoint -> edit response): `POST /sync-survey` -> `500 Internal Server Error`, empty or HTML body. Also test 502/503, 429 with `Retry-After`, timeout (no response), and `200` with garbage body.
3. Force the job (step 2) and check, in this order:
   - **Logcat:** worker returned `Result.retry()` (not `success`, not `failure` for a 5xx).
   - **DB:** row still `PENDING`, `retry_count` +1, `answers_json`/photo byte-identical to the pre-sync snapshot (compare `sha256sum` of the pulled DB row/file).
   - **JobScheduler:** a new pending job with a back-off (`dumpsys jobscheduler` shows earliest run time growing: 30 s, 60 s, 120 s if exponential).
   - **UI:** dashboard still says "N surveys pending sync" - never "Synced".
4. **Remove the rewrite**, force again (or wait for backoff) -> row becomes `SYNCED` and the server has exactly one record (no dup from the retry). 4xx (400/422) should be `failure`/quarantine with a visible error rather than infinite retries - test that the app does not retry a permanently-bad payload forever.

---

# Part 2

## Scenario D - ANR/crash after 3-4 offline videos on 4 GB phones

**Hypotheses to separate:** (a) memory: leaked `ExoPlayer/MediaPlayer` or `Bitmap`s across screens -> GC thrash -> LMK/OOM; (b) main-thread I/O or DB/JSON work while storage is nearly full; (c) storage full -> failed writes with unhandled exceptions; (d) thermal/CPU throttling on cheap SoC; (e) a decoder that only fails on that hardware. High-end phones hide all five.

**Reproduce (make the office devices look like the field):**
- Use a real low-end device (2-4 GB, Android Go if possible) or an emulator with `hw.ramSize=2048`, small heap, and **developer options -> "Don't keep activities"**, "Background process limit".
- Fill storage: `adb shell dd if=/dev/zero of=/sdcard/fill.bin bs=1M count=<n>` until <300 MB free (`adb shell df /data`); script in `scripts/`.
- Pressure memory: `adb shell am send-trim-memory <pkg> COMPLETE`, run a memory-hungry app in the background and `adb shell am kill-all` to force cold starts.
- Use the **same content**: the actual offline videos (size/bitrate/codec matter). Loop the flow: play video 1 -> quiz -> video 2 ... x4, then back to dashboard, rotate, background/foreground.
- Monkey for soak: `adb shell monkey -p <pkg> --throttle 300 -v 5000`.

**Debug and prove:**
1. `adb logcat -b crash -b events` and pull **ANR traces**: `adb bugreport` -> `/data/anr/traces.txt` (or `anr_*` in the bugreport). The main-thread stack in the trace tells **what the main thread was blocked on** (I/O, lock, `Bitmap.decode`, DB).
2. `adb shell dumpsys meminfo <pkg>` **after each video** and log Java heap / native heap / Graphics / Activities & Views counts. If numbers only go up and *Activities* > 1 after leaving the screen -> leak. Show as a table/graph.
3. **Android Studio Profiler:** Memory (heap dump after video 4 -> filter for `Activity`, `Player`, `Bitmap`; find the GC root path), CPU/System trace (main thread stalls > 5 s), Energy; **StrictMode** in the QA build (`detectDiskReads/Writes`, `detectLeakedClosableObjects`) - violations show the culprit line. **LeakCanary** in the QA build gives the retention path directly.
4. `adb shell dumpsys activity exit-info <pkg>` (API 30+) shows the *reason* the process ended (`REASON_ANR`, `REASON_LOW_MEMORY`, `REASON_CRASH_NATIVE`). Distinguishes ANR vs LMK kill instantly.
5. Prove: fix -> same script -> meminfo plateaus after video 2, no Activity leak, no trace. Attach the *before/after* heap numbers, the trace, and a 30 s screen recording to the ticket, plus the **exact repro** (device model, free storage, steps). A dev can only argue with numbers if they are wrong, so I give them numbers.
6. Guard: add the loop as a nightly instrumented soak test on a low-memory emulator profile; alert on `dumpsys meminfo` growth per iteration.

## Scenario E - HFC engine test plan
Executable version: `engine/tests/hfc-engine.test.js` (38 tests) + full matrix in `test-cases/hfc-engine-test-plan.csv` (42 cases). Summary:

| # | Type | Case | Expected |
|---|---|---|---|
| 1 | Positive | Age=12, Edu=College | `reask_and_flag` fires |
| 2 | Positive | Sleep Well=Yes, Hours=4 | fires |
| 3 | Negative | Age=30/College; Age=12/Primary; Sleep No + 4h | no fire (AND is really AND) |
| 4 | Boundary | Age 14 / 15; Hours 5.99 / 6 / 0 | strict `<`; **0 is a value, not blank** |
| 5 | Edge | Age unanswered / `''` / `'abc'` | **no fire**, no crash (missing != 0) |
| 6 | Edge | `'9'` vs 15; `' college '` | numeric compare; trimmed, case-insensitive |
| 7 | Edge | `match:any`, empty `logic[]` | OR works; empty rule never fires |
| 8 | Edge | Answer hidden by skip logic later | treated as unanswered - stale value cannot trigger a flag |
| 9 | Edge | Localized options | compare stored option *value*, not the translated label |
| 10 | Edge | Roster row 3 | evaluated per row; flag names the row |
| 11 | **Loop** | Same bad value 10x with `reask_and_flag` | re-asks <= N (3), then accepts and flags - never infinite |
| 12 | Loop | `reask_once` | exactly 1 re-ask, then accept + flag; corrected value -> no flag |
| 13 | Loop | `block` | after N attempts a supervisor override / "save as incomplete" is offered - no dead end |
| 14 | State | App killed on the re-ask screen; back button; rotation | state restored or safely reset; no double flag |
| 15 | Integration | Flag with `show_sup:1` submitted and synced | flag reaches the server/supervisor view |
| 16 | Schema | `questioID` typo, unknown op, unreachable rule | fail loud at load / lint, not silently at runtime |

**Key recommendation:** the spec does not define what happens when the enumerator *legitimately* keeps the same answer (e.g. a real 14-year-old college student). "Re-ask and flag" must end with **accept + flag**, hence my attempt cap of 3 - please confirm the number with product. `block` must always have an escape hatch.

---

# Part 3 - QA process & AI

## First 30 days (first QA hire, devs push straight to Play Store)
**Principle: add safety without adding a gate the team will route around.** Automate the gate, keep it under 10 minutes, and make it visible.

- **Week 1 - Learn and stop the bleeding.** Sit with 2 field workers/support: what breaks in the field? Read the last 3 months of Play Console crashes/ANRs, reviews, support tickets -> a ranked **risk list** (sync data loss, HFC, low-end devices). Get a QA build variant, test devices (one 2-3 GB Android Go, one mid, one high) and a **shared list of the 10 flows that must never break** (login/OTP, training unlock, fill+save offline, sync, skip logic, HFC). Write a 1-page **Definition of Done**. Quick win: a **smoke checklist** for the next release run by me.
- **Week 2 - Environments and pipeline.** `dev` -> **`staging`** (own backend/DB, seeded data, prod-like schema) -> prod. Nightly staging build via CI to **Firebase App Distribution/internal track**. Add cheap CI checks: lint, unit tests, the schema-lint + engine tests from this repo, and Crashlytics. **Play Console staged rollout** (1% -> 10% -> 50% -> 100%) with automatic halt on crash-free-users < 99% - the biggest safety net that costs the devs nothing.
- **Week 3 - Entry/exit criteria and automation.** 
  - *Entry* (dev -> QA): PR merged, unit tests green, build on staging, release notes + what changed, feature flag if risky, test data available.
  - *Exit* (QA -> release): 0 open P0/P1; all P0 flows pass; regression suite green (API + engine + smoke E2E); tested on the 3 device tiers; sync + offline matrix passed for anything touching sync/Room; no new ANR/crash in staged build; exploratory charter done for the new feature.
  - Automate first: API sync tests, engine/HFC tests, schema-lint (as in this repo) - lowest cost, highest risk. Then 10-15 E2E smoke tests.
- **Week 4 - Rhythm and metrics.** Bug template (steps, device, build, logs, video), severity definitions (data loss = P0), a 30-min **"three amigos"** before each feature, pair on test design, weekly quality dashboard: crash-free users, ANR rate, escaped defects, regression time, sync success rate. Retro: which bugs escaped and what test would have caught them -> add it.

**How not to slow devs down:** shift left (devs run my unit/API suites locally, I review testability of tickets), CI does the gating, exploratory testing runs *in parallel* with the next feature, use feature flags + staged rollout instead of long freezes, and hotfixes get a fast lane (smoke + targeted regression only).

## Leveraging AI
*(Personalize this section with your own tools/experience - I describe how I would use them.)* I use ChatGPT/Claude/Copilot as an accelerator, never as an oracle:
- **Test design:** generate boundary/equivalence tables and negative cases from a spec; then I *review and prune* - AI is good at breadth, bad at knowing which case is worthless.
- **Code:** Copilot for boilerplate Playwright/Espresso/Postman scripts and data builders; I read every line and run it.
- **Log/ANR analysis:** paste a stack trace or `dumpsys meminfo` diff and ask for hypotheses (I verify with the profiler).
- **Bug reports & release notes:** turn raw notes into clear repro steps.
- **Rules:** no production data or PII pasted into a public model (survey data is sensitive), verify every claim, keep prompts + outputs in the repo for review.

**Concrete example for Scenario B (complex dynamic schemas):** give the AI the builder's JSON Schema/capabilities doc and prompt: *"Generate 50 valid and 30 invalid survey JSONs that combine: skip logic chains of depth 3, a roster whose count comes from a Number question, a Matrix with Input mode, an HFC on a hidden question, and options in Hindi. For each, output the expected visible-question list for these answer scripts."* Then (1) run them through `schema-lint` and the engine to discard malformed ones, (2) use the expected lists as **oracles** in the data-driven tests, (3) feed the failures back as new fixtures. AI can also **mutate** a known-good golden schema (rename a targetQuestion, swap an operator, delete a question referenced elsewhere) to produce fuzz cases that should be rejected by the linter.

## Automate vs not automate - and tool choices
**Automate when:** repeated every build; deterministic oracle; high blast radius (data loss, sync); cheap to run at the unit/API level; painful or slow by hand (combinatorial: operators x types x boundaries). **Do not automate when:** a feature is changing daily; the oracle is human judgement (readability, icon clarity, "does this feel usable in sunlight"); one-off; exploratory; hardware-specific (battery, thermal, real 2G) or the setup cost exceeds the total number of future runs. Rule of thumb: **push tests down the pyramid** - engine/API first, few UI E2E.

**Tools I picked and why:**
- **Node `node:test` + fetch (API):** zero dependencies, readable by any dev, runs in CI in seconds; Postman collection added because non-coders (PMs, support) can run it with Newman. (RestAssured is a fine alternative if the backend team is JVM.)
- **Playwright (web):** auto-waiting (less flake than Selenium), built-in mobile emulation, `page.route()` to inject schemas, traces/screenshots in CI.
- **Pure-function engine tests:** fastest, most stable layer; the same rules can be ported to Kotlin JUnit.
- **ADB + Charles + Android Studio profilers (Android):** mature, free, and available on an unrooted phone; Espresso/Compose tests come after the QA build variant exists.
- **k6** for load on the sync endpoint (scriptable, cheap).

---

# Part 4 - UI/UX & user-centric QA: "Training Video Hub"

**Beyond functional testing** I test the screen *as a rural, low-literacy user in sunlight on a 5" 2 GB phone*: can they (1) understand what to do without reading, (2) do it with a dirty thumb and glare, (3) recover from a mistake, (4) on a slow/no connection, without the app misleading them.

### Issues I would flag (10)
1. **Three paragraphs of text** - too dense for low readers. Replace with an icon + <=1 short sentence + audio ("play description") and translate; keep <= 8-10 words per line.
2. **"Next" at the very bottom of a scroll** - some users never scroll; the primary action is hidden. Make it a **sticky, full-width, large (>= 48dp, better 56dp) button with icon + colour**, and disabled/visible state explained visually.
3. **Standard-size button/touch targets & controls** - < 48x48dp, too close together on a 5" screen -> mis-taps. Player controls (play/seek) must also be large with spacing >= 8dp.
4. **Contrast in sunlight** - text/icon contrast below WCAG AA (4.5:1 body, 3:1 large; aim for 7:1 outdoors); thin grey text on white disappears at high brightness; avoid colour as the *only* signal (colour-blind users) - pair colour with icon/shape.
5. **"Next" enabled before the video is finished / no completion feedback** - unclear whether the video was watched; needs progress + clear "done" state (tick, green, sound) and the app spec's quiz unlock.
6. **Standard video player on budget phones** - autoplay, buffering, 2G, no poster/thumbnail; offline file missing or corrupted; no visible loading or error state; heavy first-frame decode. Need a thumbnail, a size/"downloaded" indicator, resume position, retry.
7. **No offline/low-storage/low-battery state** - what happens when the file cannot play or storage is full? Needs a plain visual message ("no internet - video saved" / "not enough space") not an error code.
8. **Language/localisation** - Hindi/Marathi/Gujarati/Kannada strings longer than English overflow/truncate; system font scale 1.3-2.0 breaks layout; RTL not needed but check numerals.
9. **Interruptions & lifecycle** - rotate, phone call, notification, back button, split-screen: video restarts or position lost; audio keeps playing when screen off; mute/silent mode means no audio for someone who cannot read subtitles.
10. **Accessibility/semantics** - no `contentDescription` for icon-only buttons (TalkBack), focus order, no captions/subtitles, no haptic/sound feedback; also a leftover technical wording ("Error 500", "Buffering...").

### How I test systematically
- **Heuristic checklist per screen** (Nielsen + WCAG mobile + our own): text <= N words, target >= 48dp, primary action visible without scroll, contrast >= 4.5:1, colour+icon redundancy, feedback for every tap, error state present, offline state present. Stored as a reusable **"field-readiness" checklist** in the repo/Jira template so it is a requirement, not an opinion.
- **Tools:** Android **Accessibility Scanner** (touch target/contrast/label), Layout Inspector, `adb shell settings put system font_scale 1.5`, `adb shell wm size 720x1280` / `wm density` to emulate a small screen, developer option *Show layout bounds*, **Chrome/Firefox contrast checkers** for web, colour-blind simulation (Developer options -> *Simulate color space*), brightness at 100% **outdoors** with the actual devices, screenshots at 3 sizes/2 fonts (automate with Paparazzi), TalkBack pass, Battery Saver + 2G throttling for performance.
- **Real users beats opinion:** 5 field workers, 15-minute session, ask them to "watch the video and go to the next step" and observe - **no explaining**. Count hesitations/mis-taps/time to task; this is the **only** test that finds "they do not understand the icon". Do it every release for new screens, even with 3 people.
- **Automated guardrails:** Espresso `AccessibilityChecks.enable()` (fails on small targets/missing labels), lint rules for hard-coded sizes, snapshot tests at font scale 1.3.

### How I communicate non-functional bugs
Write them as **user impact with evidence, not taste**: *"On a 5" 720p phone at 100% brightness in sunlight the body text (#9E9E9E on white, contrast 2.7:1) is unreadable; 3 of 5 field testers could not find 'Next'."* Attach a screenshot/photo taken outdoors, a short video, the measured value (dp/contrast ratio) against the standard, severity by **user impact** (blocks a task = high), and a **suggested fix or 2 options** (sticky button / icon + audio). Add it to the ticket using the same template as functional bugs so it is not treated as "polish". Talk to design **before** the build (review wireframes with the checklist - cheaper than a bug), run a 15-minute joint review of the failing screenshots, and share user-test clips: seeing a real user struggle beats any argument. Celebrate the fixes.

---

## Assumptions & limitations
- No APK/backend were supplied: Scenarios C/D and the mobile half of A are strategies + scripts, not executed results.
- The mock API/engine encode *my reading* of the spec (loop cap 3, `(deviceId, localId)` identity, per-item `207` results) - each is listed as a question for the team.
- Web tests validate a harness renderer; on the real builder the selectors change but the structure (data-driven per schema) stays.
