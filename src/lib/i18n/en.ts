// English UI strings — the source of truth and the fallback for every other locale (i18n.svelte.ts).
// Keys are dot-grouped by surface. `{name}` placeholders are filled by t(key, { name }).

import type { Dict } from './i18n.svelte';

export const en: Dict = {
  // ── Topbar ───────────────────────────────────────────────────────────────
  'topbar.search': 'Search or ask your notes…',
  'topbar.model': 'Model',
  'topbar.modelTip': 'On-device AI assistant',
  'topbar.modelLoadingTip': 'Model is loading — please wait until it finishes before switching',
  'topbar.reading': 'Reading notes…',
  'topbar.readingTip': 'Getting your notes ready to search',
  'topbar.connecting': 'Connecting notes…',
  'topbar.connectingTip': 'Your notes are searchable; still linking related ones in the background',
  'topbar.ready': 'Ready',
  'topbar.readyTip': 'Your notes are ready to search',
  'topbar.slower': 'Slower mode',
  'topbar.slowerTip':
    'This device is running Nebula in a slower mode. For best speed, use Chrome or Edge with hardware acceleration enabled.',
  'topbar.tour': 'Take a quick tour',
  'topbar.github': 'View source on GitHub',
  'topbar.export': 'Export vault',
  'topbar.importVault': 'Import vault — restore from a .zip backup',
  'topbar.reset': 'Reset all data — recover from a stuck model or a broken note',
  'topbar.advancedOn': 'Advanced mode on — showing technical details',
  'topbar.advancedOff': 'Advanced mode — show technical details',
  'topbar.theme': 'Toggle theme',
  'topbar.language': 'Language',

  // ── Model banner ─────────────────────────────────────────────────────────
  'banner.loading': 'Getting your assistant ready',
  'banner.searchNow': 'You can search your notes already — no waiting',

  // ── Data-safety warnings ───────────────────────────────────────────────────
  'warn.ephemeral':
    "Your notes won't be saved — this browser is blocking local storage (often a private window or a full disk). Use a normal window and free up space, or anything you write here will vanish when you close the tab. Export your vault to keep a copy.",
  'warn.quota':
    'Storage is full — a recent note could not be saved. Export your vault, then free up disk space (or remove some notes/files) and try again.',
  'warn.quota.flash': '⚠ storage full — that note was not saved',
  'warn.multiTab':
    'Nebula is open in another tab. Editing in two tabs at once can clash and corrupt the vault — keep just one open.',
  'warn.dismiss': 'Dismiss',

  // ── Vault import (restore) ─────────────────────────────────────────────────
  'import.restoring': 'Restoring vault…',
  'import.done': '✓ restored {n} notes',
  'import.bad': "⚠ couldn't read that file — pick a Nebula vault .zip (from Export vault)",
  'import.skipped': '{n} compressed files skipped — re-export from Nebula',

  // ── Sidebar ──────────────────────────────────────────────────────────────
  'side.vault': 'Vault',
  'side.newNote': 'New note / folder',
  'side.entities': 'People, places & topics',
  'side.connect': 'Connect my notes',
  'side.connecting': 'connecting…',
  'side.seeConnections': 'See connections',
  'side.updateConnections': 'Update connections — new notes pending',
  'side.updateConnectionsTip': "New notes aren't connected yet — update to include them",
  'side.showAll': 'Show all {n}',
  'side.showFewer': 'Show fewer',
  'side.tags': 'Tags',
  'side.clear': 'clear',
  'side.searchIn': 'Search in',
  'side.allNotes': 'all notes',
  'side.searchInTip': 'Limit questions and sharing to one folder or tag',

  // ── Ask rail ─────────────────────────────────────────────────────────────
  'ask.title': 'Ask',
  'ask.searching': 'searching',
  'ask.scopeAll': 'all notes',
  'ask.new': 'New',
  'ask.newTip': 'Start a new conversation',
  'ask.newConfirm': 'Start a new conversation? The current questions and answers will be cleared.',
  'ask.toggle': 'Toggle the Ask panel',
  'ask.resize': 'Drag to resize',
  'ask.idle':
    'Ask anything about your notes. Answers come only from what you’ve written, and link back to where each fact came from.',
  'ask.try': 'Try',
  'ask.try1': 'What did we decide and why?',
  'ask.try2': 'Who owns what — and how does it connect?',
  'ask.try3': 'Summarize the open risks',
  'ask.thinking': 'Thinking…',
  'ask.thoughts': 'Thoughts',
  'ask.used': 'used {count}/{total}',
  'ask.sources': 'Sources',
  'ask.match': 'match',
  'ask.vector': 'vector',
  'ask.howFound': 'How this answer was found',
  'ask.subgraph': 'Retrieval sub-graph',
  'ask.share': 'Share with another AI',
  'ask.placeholder': 'Ask a question about your notes…',
  'ask.send': 'Ask',
  'ask.runsLocal': 'Runs on your device',
  'ask.noResults': "I couldn't find anything about that in your notes.",
  'ask.emptyAnswer':
    "I found relevant notes but couldn't compose an answer this time — see the sources below, or try rephrasing the question.",

  // mode chips (plain labels by default; technical names in advanced mode)
  'mode.reason': 'Think it through',
  'mode.reasonAdv': 'Reason',
  'mode.reasonTip': 'Let the assistant reason over your notes and give advice',
  'mode.grounded': 'Just quote my notes',
  'mode.groundedAdv': 'Grounded',
  'mode.groundedTip': 'Stick strictly to what your notes actually say',
  'mode.graph': 'Connect ideas',
  'mode.graphAdv': 'GraphRAG',
  'mode.graphTip': 'Also pull in related notes that share the same people, places or topics',

  // ── Graph lens ───────────────────────────────────────────────────────────
  'lens.connections': 'Connections',
  'lens.graphLens': 'Graph lens',
  'lens.topics': 'topics',
  'lens.entities': 'entities',
  'lens.links': 'links',
  'lens.relations': 'relations',
  'lens.ready': 'ready',
  'lens.close': 'Close',
  'lens.pickOne': 'Pick one to see how it connects across your notes.',
  'lens.mentions': 'Notes mentioning {name}',
  'lens.nothing': 'Nothing connected to {name} yet.',
  'lens.retry': '↻ Try connecting again',
  'lens.hint': 'Click any node to re-center · drag to pan · scroll to zoom',
  'lens.extracting': 'Extracting entities & relations…',

  // ── Model gate ───────────────────────────────────────────────────────────
  'gate.title': 'Your private AI assistant',
  'gate.language': 'Language',
  'gate.desc':
    'Runs entirely on your computer — downloaded once, then works offline. No account, and nothing ever leaves your device.',
  'gate.recommended': '★ Recommended — {label}',
  'gate.bestFit': 'best fit for your device · {size}',
  'gate.cached': '✓ ready',
  'gate.multilingual': 'multilingual',
  'gate.removeTip': 'Remove from this browser',
  'gate.skip': 'Skip for now — search and notes still work',
  'gate.startBlank': 'Start with a blank vault',
  'gate.noWebgpu':
    '⚠ This device can’t run the AI assistant, but searching and writing notes still work fully. For the assistant, try Chrome or Edge on a computer with a graphics card.',
  'gate.continue': 'Continue',
  'gate.brokenHint': 'Something broken — a stuck model or a note that won’t load?',
  'gate.resetLink': 'Reset all data…',

  // ── Reset dialog ─────────────────────────────────────────────────────────
  'reset.title': '⚠ Reset all data?',
  'reset.lead':
    'This permanently erases everything Nebula stored on this device and cannot be undone:',
  'reset.item.notes': 'All your notes — they live only here, not as files',
  'reset.item.index': 'the search index & the knowledge graph',
  'reset.item.models': 'downloaded AI models (you’ll re-download next time)',
  'reset.item.settings': 'settings, theme, and the tour state',
  'reset.tip': 'Want to keep your notes?',
  'reset.exportFirst': 'Export your vault first',
  'reset.thenBack': '— then come back.',
  'reset.typeToConfirm': 'Type {word} to confirm:',
  'reset.cancel': 'Cancel',
  'reset.erase': 'Erase everything',
  'reset.erasing': 'Erasing…',

  // ── Guided tour (coach-marks) ────────────────────────────────────────────
  'tour.welcome.title': '👋 Welcome to Nebula',
  'tour.welcome.body':
    'Nebula turns your notes into something you can ask questions about — and everything runs right here on your device. Nothing is ever uploaded. Here are the four things worth knowing.',
  'tour.ask.title': 'Ask your notes anything',
  'tour.ask.body':
    'Type a question here — like “What do Maya, Leo and Priya each want to do in Japan?” — and Nebula answers using your own notes, with links back to where it found each fact. Press ⌘J to jump here anytime.',
  'tour.modes.title': 'Two ways to answer',
  'tour.modes.body':
    '“Just quote my notes” sticks strictly to what you wrote. “Think it through” lets the assistant reason and give advice. Pick whichever fits your question.',
  'tour.graph.title': 'See how your notes connect',
  'tour.graph.body':
    'Nebula automatically links notes that share the same people, places and topics — even when they don’t share any words. Open one to see everything related to it.',
  'tour.new.title': 'Make it your own',
  'tour.new.body':
    'Add your own notes with the + button, or just drag in a PDF or spreadsheet — it becomes searchable too. When you’re ready, you can delete the example notes.',
  'tour.done.title': '✨ You’re all set',
  'tour.done.body':
    'Try asking a question in the panel on the right. You can replay this tour anytime from the “?” button at the top.',
  'tour.step': 'Step {n} of {total}',
  'tour.skip': 'Skip',
  'tour.back': 'Back',
  'tour.next': 'Next',
  'tour.done': 'Done',

  // ── Note view / editor ───────────────────────────────────────────────────
  'note.edit': 'Edit',
  'note.newNote': 'New note',
  'note.title': 'Note title',
  'note.folder': 'folder — blank = vault root',
  'note.body': 'Write in Markdown… type [[ to link a note',
  'note.empty': 'Select a note from the sidebar, or',
  'note.writeNew': 'write a new one',
  'note.emptyHint':
    'Right-click the tree to add · rename · move · delete. Drag a note onto a folder to move it.',
  'note.today': 'Today',
  'note.import': 'Import files',

  // ── Templates ──────────────────────────────────────────────────────────────
  'template.overwriteConfirm':
    "Replace the current note content with this template? This can't be undone."
};
