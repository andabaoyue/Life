# Life v1.8.0 — Chulan

> **English entry point.** The full documentation (architecture, invariants, memory model,
> experiment layer, complete test inventory) is maintained in [README.md](README.md) (Chinese).
> This page covers what you need to run, understand, and contribute to Life.

![Chulan — 64×80 pixel sprite, default outfit](assets/character/stand/chulan_chibi_stand_64x80.png)

Life is a **desktop digital-being experimental platform** built on Electron. It connects to
LLM providers (DeepSeek and any OpenAI-compatible endpoint) and gives a persistent character —
**Chulan (初澜)** — long-term memory dynamics, a growth ledger, streaming conversation, and a
layered wardrobe system.

It is an *experiment*, not a chatbot skin: the substrate (the model), the runtime host
(Electron / your OS), and the subject (Chulan) are kept strictly separate in the architecture.

---

## Requirements

- **To play (no toolchain needed):** download a build from
  [Releases](https://github.com/andabaoyue/Life/releases) and run `Life.exe`.
- **From source:** **Node.js >= 18** (tested on Node 22). Python >= 3.10 is only needed for the
  UI test suite (Playwright).

## Run from source

```bash
git clone https://github.com/andabaoyue/Life.git
cd Life
npm install
npm start
```

**First-time setup:** right-click the character → **设置 / Settings** → paste your provider
API key (e.g. a DeepSeek key). The key is stored encrypted through the OS keychain
(`safeStorage`); if that is unavailable the app degrades to plaintext **and says so** — it
never pretends to be encrypted.

## Build

```bash
npm run build:dir        # Windows unpacked directory build
npm run build:win        # Windows portable / NSIS / zip
npm run build:dir:linux  # Linux unpacked directory (used by CI for closure checks)
```

Build tools are pinned in `devDependencies` / `package-lock.json`; `npm ci` is enough.

## Tests and gates

This project is unusually strict about honesty in its own test suite: every claim in the
Chinese README's test block is verified against the real assertion count, and the release
pipeline asserts the *packaged artifact*, not just the working tree.

```bash
npm test                        # full suite (node tests + real-browser UI test)
node tools/check.js             # syntax check across all JS files (cross-platform)
node tools/release-check.js     # release integrity + builder whitelist closure
npm run build:dir:linux && node tools/asar-check.js   # assert runtime closure inside app.asar
```

CI runs on every push and pull request (`.github/workflows/ci.yml`); a separate
`package-closure` job builds the app and asserts that every runtime entry point
(`preload.js`, `pet.js`, `chat.html`, `chat.js`, the `ui-*.js` modules …) actually made it
into `app.asar`. That check exists because a whitelist omission once shipped a build whose
window could not start.

## Bring your own character

Life ships with Chulan's 64×80 pixel sprite, so it runs out of the box. You can replace her:

- **Style:** retro chibi **pixel art** sprite.
- **Native size:** **64 × 80 px**, 32-bit RGBA PNG.
- **Alpha:** strictly 1-bit (0 or 255) — no semi-transparent fringes (they produce dark edges
  on a desktop).
- **Drop-in path:** replace `assets/pet.png` (the single-image fallback). Other sizes and any
  transparent PNG also work; the app scales and centers them.
- The character's visual identity is **not** hardcoded into the personality layer — see
  `src/persona.js` and the wardrobe rules in `src/wardrobe.js`.

## Architecture at a glance

| Path | Role |
|---|---|
| `main.js` | Electron main process: windows, IPC, wardrobe instance, tray |
| `preload.js` | contextBridge surface (exposed as `window.deskpet`) — the only renderer API |
| `index.html` / `style.css` / `pet.js` | desktop-pet window (sprite, bubbles, wardrobe, panels) |
| `chat.html` / `chat.js` / `ui-*.js` | standalone chat window (streaming, i18n, chat store/render) |
| `src/brain.js` | orchestration: conversations, window closing, memory merge, costume proposals |
| `src/memory.js` | three-layer memory: conversation window / window summaries / long-term memory |
| `src/subject-state.js` | deterministic state vector + provenance verification + offline replay |
| `src/experiences-archive.js` | append-only raw evidence base (`experiences.jsonl`) |
| `src/wardrobe.js` | layered wardrobe: slots, catalog, presets, validation, persistence |
| `src/*provider*`, `src/adapters/` | provider abstraction (DeepSeek / OpenAI-compatible / local / custom) |
| `tools/` | `tools/check.js`, `tools/release-check.js`, `tools/asar-check.js`, `tools/chroma.py` (green-screen cutout) |
| `test/` | node test suites + `test/ui_test.py` (real browser, 171 checks) |

A few invariants the codebase takes seriously (all enforced by tests):

1. **Prefix-cache stability** — the system prompt is byte-stable within a conversation window;
   dynamic data only ever appends to the user turn.
2. **Model Substrate ≠ Runtime Host ≠ Chulan Subject** — the LLM is a computational substrate,
   not the character's identity.
3. **Data is never fabricated** — evidence is `RECORDED` / `NOT_RECORDED` / `UNRESOLVED`;
   missing metadata is reported as missing, never back-filled.
4. **Atomic writes** — all persistent user assets go through `src/atomic.js`.
5. **Costume ≠ personality** — the wardrobe changes pixels only.

## Privacy

**This repository contains no personal data.** Runtime state (memory, experiences, subject
state, ledger, credentials) lives **outside the repo**, under `%APPDATA%/Life` on Windows, and
is listed in `.gitignore`. The public repository contains the software and its tests only —
never a real subject's memories, archive, or API keys.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) (Chinese). Please keep the existing invariants intact,
keep diffs minimal, and make sure the gates above pass. If your build is modified, label it
clearly as unofficial — see [BRANDING.md](BRANDING.md).

## License

[PolyForm Noncommercial License 1.0.0](LICENSE) — **source-available, not OSI open source**.

- **Permitted:** personal study, academic research, teaching, noncommercial experiments,
  personal modifications, noncommercial discussion.
- **Required:** modified versions must be clearly marked as modified and stay under this license.
- **Not permitted:** any commercial use without written authorization (selling builds, paid
  services / commercial SaaS, commercial redistribution under a renamed product).
- **Commercial licensing:** contact the rights holder via an issue or
  [@andabaoyue](https://github.com/andabaoyue).

Life — Chulan · Copyright © 2026 andabaoyue · All rights reserved.
