<p align="center">
  <strong>English</strong> | <a href="./README.md">中文文档</a> | <a href="./README_JA.md">日本語</a>
</p>

<p align="center">
  <img src="./assets/readme/hero-en.svg" width="100%" alt="Etch turns English video URLs into reviewable bilingual releases, with optional Bilibili publishing from main">
</p>

<p align="center">
  <strong>URL in. Reviewable bilingual video out. Once verified, it can also be published to Bilibili from your Mac.</strong><br>
  Etch organizes subtitle retrieval or local transcription, Agent CLI translation, terminology audit, human review, and FFmpeg rendering into one recoverable local pipeline. Bilibili publishing runs independently as an optional sidecar after the final video is verified.
</p>

<p align="center">
  <a href="https://github.com/bingjiang0611/Etch/releases/latest"><strong>Download the v0.1.1 DMG</strong></a>
  ·
  <a href="#4-publish-to-bilibili">Bilibili publishing</a>
  ·
  <a href="#capabilities-and-limits">Capabilities and limits</a>
  ·
  <a href="#verification-levels">Verification levels</a>
</p>

<p align="center">
  <img src="./assets/readme/bilibili-publish.png" width="100%" alt="Etch Bilibili publication dialog with title, category, tags, copyright, source, description, and cover fields">
</p>

> The image above shows the real Electron UI from the current `main` branch using a hermetic fixture and no personal account data. It proves the UI contract; it does not claim that a real-account, end-to-end Bilibili publication has passed.

## Current status

- Current version: `0.1.1`. The public DMG **does not include Bilibili publishing**.
- Main branch: Bilibili publishing is implemented and can be tried from source. It will ship in the next DMG release.
- Current input: **HTTP(S) URLs only**; local file import is still planned.
- Current distribution: an Apple Silicon DMG is available from GitHub Releases.
- Current platform: Apple Silicon Mac running macOS 13.5 or later.

## From URL to final video, then publication

```text
Video URL
  → Fetch video and English subtitles
  → Fall back to local mlx_whisper transcription when needed
  → Translate in batches through an Agent CLI
  → Apply historical terminology constraints and run a global term audit
  → Review cues manually and apply terminology changes globally
  → Generate a bilingual SRT
  → Burn subtitles with FFmpeg and verify with ffprobe
  → [optional] Confirm publication metadata → connect directly to Bilibili → save a verifiable receipt
```

Etch does not hide these steps behind an opaque “AI generation” button. Every task keeps ten-stage state, failure reasons, the Provider session, immutable candidate artifacts, and recoverable checkpoints. Human review is a first-class pipeline stage. Bilibili publication state is independent of the ten-stage video pipeline, so a publication failure never rolls back a verified final video.

## Why Etch

- **Local-first**: downloading, transcription, file management, subtitle generation, and rendering run on your Mac. Whether translation data leaves the device depends on the Agent CLI you select.
- **Recoverable**: interrupted work resumes from `task.json`, the durable run registry, and committed stage artifacts instead of trusting exit code `0`.
- **Terminology-aware**: new tasks use historical video glossaries; term edits can be previewed against affected cues and applied to the translation in one operation.
- **Provider-flexible**: Claude, Codex, Qoder, and OpenCode local CLIs are supported without requiring one fixed SDK or resident server.
- **Human-controlled**: side-by-side English and Chinese cues, video seeking, autosave, review checkpoints, and SRT/video regeneration.
- **Direct Bilibili publishing (`main`)**: completed tasks can be published manually or automatically from a template. Credentials are encrypted locally, and the Mac connects directly to Bilibili without an Etch-hosted cloud service.
- **Explicit deletion semantics**: hide only the task record, or move the Etch-managed task directory and artifacts to the macOS Trash.

## Quick start

### 1. Install

1. Download `Etch-0.1.1-arm64.dmg` from [GitHub Releases](https://github.com/bingjiang0611/Etch/releases/latest).
2. Open the DMG and drag `Etch.app` into `Applications`.
3. If Gatekeeper blocks the first launch, right-click Etch in Finder and choose **Open**. If it is still blocked, use **System Settings → Privacy & Security → Open Anyway**.

The current DMG is not notarized by Apple. It uses an ad-hoc signature rather than an Apple Developer ID. A DMG is only an installation container and does not bypass Gatekeeper.

> `v0.1.1` predates Bilibili publishing. To try publication, run the current `main` branch from source; do not confuse public-DMG capabilities with main-branch capabilities.

### 2. Check local tools

Etch automatically checks executables, versions, required capabilities, and login state at startup. Before starting a task, you need:

- Apple Silicon Mac running macOS 13.5+
- `yt-dlp`
- `ffmpeg` with `libass`, plus the matching `ffprobe`
- Python 3.12 and `mlx_whisper`
- At least one installed and authenticated CLI: `claude`, `codex`, `qodercli`, or `opencode`

If a tool is not available on the normal `PATH`, set its absolute executable path on the Settings screen.

### 3. Create a task

Enter one or more HTTP(S) video URLs in the task queue, choose a Provider, and optionally describe the translation style. New tasks start automatically. A running task can be stopped and later resumed from its last committed stage.

### 4. Publish to Bilibili

This capability is currently available only on `main`. First, open **Settings → Bilibili publishing**, scan the QR code with a Bilibili account that has publication access, and configure the default category, tags, and description template. The description supports `{title}` and `{source_url}` placeholders. You can then:

- Enable **Publish to Bilibili when complete** while creating a task. The option remains disabled until an account is connected and the template is complete.
- Click **Publish to Bilibili** from the Workbench for a completed task, then confirm the title, category, tags, description, copyright type, source, and cover. After the task is successfully added to the local publication queue, Etch remembers the category, tags, and copyright type for the next manual publication without modifying the automatic-publication template.
- Stop during the upload phase and start the publication again from Etch. If the process entered the submission phase without producing a verifiable receipt, Etch marks the result as **unknown** and asks you to check Bilibili Creator Center before trying anything else, preventing duplicate submissions.

Etch does not require you to configure a Bilibili Open Platform application. The publication path does not pass through an Etch-hosted cloud or relay service. V1 supports one account and one concurrent publication; it does not support scheduling, multiple accounts, review-status polling, or editing or deleting submitted posts.

## Capabilities and limits

| Status | Capability | Current boundary |
| --- | --- | --- |
| Implemented | URL task queue | Create 1–50 URL tasks at once; pause the queue, stop or resume tasks, and configure stage concurrency. |
| Implemented | Subtitle retrieval and local transcription | Prefer English subtitles; fall back to `mlx_whisper`, with windowed caching and timeline merging for long media. |
| Implemented | Four Agent CLIs | Detection, translation, session resume, and structured-output validation for Claude, Codex, Qoder, and OpenCode. |
| Implemented | Translation quality workflow | Batch translation, English source audit, historical terminology prompts, global terminology audit, cue editing, and targeted repair. |
| Implemented | Bilingual subtitles and hard-subtitle output | Generate bilingual SRT files, apply compact/standard/large presets, render with FFmpeg, and verify with ffprobe. |
| Implemented | Recoverable task state | `task.json` is authoritative; artifact commits are guarded by lease, revision, and fingerprint checks. |
| Implemented on `main` | Direct Bilibili publishing | Single-account QR login, manual/automatic publication, one concurrent publication, restarting after a stopped upload, and verifiable receipts. No review polling, scheduling, multiple accounts, or post management. Not included in the v0.1.1 DMG. |
| Partial | Provider compatibility | Automated tests cover all four adapter protocols; real accounts, CLI versions, and current server behavior still require verification on each machine. |
| Partial | Long-media resource management | Deterministic segmentation and resume are implemented; silence-aware splitting, a global disk budget, and automatic cache cleanup are not. |
| Partial | Public distribution | v0.1.1 provides an arm64 DMG and SHA-256 but does not include Bilibili publishing. Developer ID signing, notarization, auto-update, and a CI release gate are not available. |
| Planned | Local file import | The schema reserves this input type, but the UI, APFS clone/copy, space checks, and recovery path are not implemented. URLs only for now. |

## Run from source

The verified development environment uses Node.js `22.22.1`:

```bash
git clone https://github.com/bingjiang0611/Etch.git
cd Etch
nvm use
npm ci
npm run dev
```

Build and verify the Apple Silicon `.app` directory:

```bash
npm run pack
```

Output: `dist/mac-arm64/Etch.app`

Build, mount, and verify the DMG:

```bash
npm run dist:mac
```

Output: `dist/Etch-0.1.1-arm64.dmg`

DMG verification checks the mounted-volume allowlist and validates the bundled app signature, entitlements, arm64 architecture, version, minimum macOS version, and the pinned `biliup` sidecar's architecture, version, executable permissions, and SHA-256.

## Verification levels

| Level | Command or path | What it proves |
| --- | --- | --- |
| L1 | `npm run verify:l1`, `npm run pack`, `git diff --check` | Types, lint, Vitest, renderer/main builds, and the packaged app directory. |
| Development E2E | `npm run e2e:hermetic` | UI, task-state, and process contracts under an isolated HOME/PATH with deterministic fake tools. It does not prove real Provider or network availability. |
| Bilibili UI E2E | `npm run build && npx playwright test e2e/bilibili.spec.ts` | QR-login guidance, the publication form, automatic-publication gating, stop/restart behavior, and receipt states using a hermetic fixture. It does not prove publication to the real platform. |
| L2 | Install `/Applications/Etch.app`, then run `npm run smoke:installed` | Packaged preload, menus, durable IPC, task recovery, and affected real tool paths. |
| L3 | Real URLs and media with all four authenticated Providers; Bilibili requires a real account and a submission receipt | The complete user path. Do not claim full MVP or real-platform publication coverage unless each path has actually been run. |

## Data and privacy

- Media, subtitles, logs, manifests, and rendered videos are stored in the configured workspace, which defaults to `~/Movies/Bilingual Subs`.
- Settings, location and run registries, hidden task records, and the global glossary live in Electron's `userData` directory.
- Bilibili cookies and tokens are encrypted with Electron `safeStorage` and stored separately. They are not written to settings, task manifests, or logs. During publication they are decrypted only into a temporary `0600` file, which is deleted as soon as the sidecar exits.
- Etch currently has no first-party telemetry or Etch-hosted cloud service.
- Translation, audit, and repair send the required subtitle text, style instructions, and terminology context to the Agent CLI you select. Whether that content leaves the device and how long it is retained depend on that CLI and its backend.
- Child processes receive an allowlisted environment by default. Diagnostics record environment variable names, not values.
- **Delete all artifacts** moves the registered task directory to the macOS Trash. **Remove record only** hides the task in Etch and leaves the directory intact.
- Deleting a local task does not delete a submitted Bilibili post. Etch does not automatically resubmit a post whose success has already been confirmed.

## Troubleshooting

<details>
<summary><strong>A tool is reported as unhealthy</strong></summary>

Check the executable, version, authentication, or `libass` diagnostic shown on the Settings screen, then fix `PATH` or configure an absolute executable override.

</details>

<details>
<summary><strong>A task is paused after an abnormal exit</strong></summary>

Etch checks the durable run registry before recovery so an old Provider process cannot write concurrently with the resumed task. Review the recovery summary before continuing.

</details>

<details>
<summary><strong>A task is missing from the queue</strong></summary>

Check startup diagnostics for an invalid manifest or duplicate task ID. The queue index is rebuilt from readable `task.json` files at every launch.

</details>

<details>
<summary><strong>A Provider fails</strong></summary>

Confirm that the matching CLI is authenticated and compatible. Hermetic E2E cannot prove that a real account, network, or Provider service is currently available.

</details>

<details>
<summary><strong>A Bilibili publication result is unknown</strong></summary>

Check Bilibili Creator Center to determine whether the post was submitted. To prevent duplicates, Etch does not automatically retry a publication whose result is marked **unknown**.

</details>

## Project documents

- [`CLAUDE.md`](./CLAUDE.md): stable architecture rules and the project verification profile.
- [`electron-builder.yml`](./electron-builder.yml): macOS arm64 packaging configuration.
- [`scripts/verify-macos-dmg.mjs`](./scripts/verify-macos-dmg.mjs): DMG and bundled-app verification.

## License

This repository currently declares no open-source license. Publicly visible source code does not grant permission to copy, modify, or redistribute it.
