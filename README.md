# Nebula

> **Notes that think. Nothing leaves your device.**

[![Deploy to GitHub Pages](https://github.com/thienzz/Nebula/actions/workflows/deploy.yml/badge.svg)](https://github.com/thienzz/Nebula/actions/workflows/deploy.yml)
[![Live demo](https://img.shields.io/badge/%E2%96%B6_live_demo-thienzz.github.io%2FNebula-7c5cff)](https://thienzz.github.io/Nebula/)
[![tests](https://img.shields.io/badge/tests-430+_passing-3fb950)](#under-the-hood)
[![backend](https://img.shields.io/badge/backend-none-555)](#under-the-hood)

**[▶ Open the live demo →](https://thienzz.github.io/Nebula/)** — no install, no sign-up, nothing uploaded. It opens with a small demo vault so you can try everything in about a minute.

---

Nebula is a private notes app you can **talk to**. Write or drop in your notes, then ask questions in plain language and get real answers — with links back to the exact note each fact came from.

The catch? There is none. **Everything runs inside your browser tab.** Your notes, the search, and the AI all live on your own machine. No account. No server. No "your data trains our model." Close the tab and it's still just your files.

And your notes are never trapped: every note is a plain `.md` text file, and one click exports the whole thing as a folder of Markdown you can open anywhere.

## Why you'll like it

- 🔒 **Truly private.** Nothing leaves your device — not your notes, not your questions. Works on a plane, in a café, fully offline.
- 💬 **Ask, don't dig.** Instead of scrolling through files, just ask *"what did we decide about the budget?"* and get a straight answer with sources.
- 🕸 **It connects the dots.** Nebula learns who and what your notes are about — people, projects, clients — and pulls in related notes even when they don't share a single keyword.
- ✍️ **A real notes app too.** Markdown editor, `[[wikilinks]]`, backlinks, tabs, a ⌘K quick switcher, daily notes, templates, tags, folders.
- 📎 **Bring your files.** Drop in PDFs, CSVs, or text — Nebula reads them and keeps the original untouched.
- 🚪 **No lock-in.** Plain `.md` files in, plain `.md` files out. Your knowledge is always yours to take.

## What people use it for

### 🧠 A "company brain" your team can ask

Point it at your team's notes — people, projects, clients, incidents, decisions — and Nebula maps out who and what they're about, and how it all connects. Then ask a real question:

> *"What happened in the Atlas incident, who was involved, and what was the follow-up?"*

A plain search finds the two notes that mention "Atlas." Nebula adds the ones that *matter but don't say the word* — the people in the escalation, the project that caused it, the fix that followed — because it knows they're connected. The answer is pulled from all of them, with a source on every point.

Perfect for onboarding (*"who owns what?"*), incidents (*"who do I loop in?"*), and impact checks (*"everything that touches Acme Corp"*).

### 🤝 A deal war-room — from scattered notes to a game plan

This is exactly the vault the [live demo](https://thienzz.github.io/Nebula/) opens with, so you can follow along. You're closing a deal and your notes are scattered the way they really are — a status note, a budget note, a competitor note, and so on:

```
aurora-status.md       In final negotiation; signature expected this quarter.
aurora-budget.md       Priya, the client's CFO, hasn't approved the budget — the main risk.
aurora-competition.md  Helix undercut us on price.
aurora-poc.md          Orion ran the trial and validated performance.
aurora-champion.md     Sam, their VP, is pushing the deal internally.
```

Ask: *"How do we win this deal — what's blocking it and what should we do?"*

A keyword search only finds the status note; the budget and champion notes don't share any words with your question. Nebula pulls them in anyway — they're about the same deal and people — and answers with a cited plan:

> *Two things block the deal: CFO **Priya** hasn't cleared the budget [#1], and **Helix** undercut us on price [#3]. To close: (1) work Priya to unblock the budget; (2) counter Helix with **Orion's validated trial** [#4]; (3) get champion **Sam** pushing internally [#5].*

The blockers *and* the levers came from notes a keyword search would never surface.

### 🔒 A private research vault

Thousands of PDFs and notes you can't or won't upload — contracts, papers, source code. Ask in plain language and get cited answers, all offline. When you do want a frontier model like ChatGPT or Claude, Nebula hands it a tidy, redactable slice instead of the raw files.

### 🧑‍💼 One vault, many clients

Working across clients? Scope a question to a single folder or tag so answers never bleed from one client into another — then export a per-client slice to share, with nothing else leaking through.

## Try it on your machine

```bash
npm install
npm run dev          # then open http://localhost:1420
```

That's the whole setup — you're writing notes immediately. The first time you ask a question, Nebula downloads its AI models **once** into your browser (about 570 MB for search, plus whichever chat model you pick). After that it works offline.

**Search works on any modern browser**, no special hardware. The **chat** part uses your GPU, so it wants a recent Chrome, Edge, Arc, or Safari 18+ (Firefox support is rolling out) — on any OS, Mac included.

## Put it online

`npm run build` produces a plain static site in `build/` you can host anywhere. It needs two response headers (so the browser can use your GPU safely):

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

- **GitHub Pages — zero config (included):** push to `main` and the [bundled workflow](.github/workflows/deploy.yml) builds and publishes to `https://<you>.github.io/Nebula/`. One-time: **Settings → Pages → Source = "GitHub Actions."**
- **Cloudflare Pages / Netlify / Vercel:** add a `_headers` file with the two lines above.
- **Your data lives in your browser** and stays there. It survives refreshes but is tied to that browser — so **Export Vault** (a one-click `.zip` of your notes + original files) is both your backup and your way out. Nothing is ever locked in.

## Under the hood

For the curious — Nebula is a single-page app with **no backend at all**. Everything that would normally be a server (the search engine, the AI, the database) runs inside the browser tab:

- **Built with** SvelteKit, with the heavy lifting done by WebAssembly and your GPU.
- **Search** understands meaning, not just keywords (multilingual, including Vietnamese), and runs even without a GPU.
- **Chat** runs a real language model locally on your GPU — pick from tiny-and-fast to large-and-accurate, each showing its size before you download.
- **Your notes are the source of truth.** The search index is just a cache Nebula can rebuild any time; Export Vault always hands you the real `.md` files.

It's covered by **430+ automated tests**, run with:

```bash
npm run lint && npm run check     # formatting + types
npm run test:unit                 # core logic (fast, offline)
npm run test:int                  # real PDF + database, offline
npm run test:models               # real search models (downloads ~570 MB first run)
```

---

**[▶ Try Nebula now →](https://thienzz.github.io/Nebula/)** — your notes, finally answering back.
