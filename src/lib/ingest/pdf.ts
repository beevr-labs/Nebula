// PDF text extraction — FR-ING-001/002 (parse off the main thread). Uses pdfjs-dist's
// legacy build, which runs headless in Node/Workers (no DOM needed for text content).
// Produces per-page text + char offsets so the chunker can map a chunk back to its page
// (pageForOffset → FR-CHAT-003 citation scroll/highlight).
//
// PDF parsing works fully IN THE BROWSER (no desktop/Tauri needed, ADR-028) — pdfjs just needs its
// worker URL set. We do that lazily and browser-only; Node falls back to pdfjs's built-in fake
// worker (so the integration tests run without any worker file).

import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';

let workerInit = false;
async function ensureWorker(): Promise<void> {
  if (workerInit || typeof window === 'undefined') return; // Node: fake worker is fine
  if (!GlobalWorkerOptions.workerSrc) {
    GlobalWorkerOptions.workerSrc = (
      await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')
    ).default;
  }
  workerInit = true;
}

export interface PdfPage {
  page: number;
  text: string;
  charStart: number;
  charEnd: number;
}

export interface PdfExtract {
  text: string;
  pages: PdfPage[];
  pageForOffset(charStart: number): number | undefined;
}

const PAGE_SEPARATOR = '\n\n';

/** Extract text + page boundaries from a PDF byte buffer. */
export async function extractPdf(data: Uint8Array): Promise<PdfExtract> {
  await ensureWorker();
  const doc = await getDocument({
    // COPY: pdfjs transfers the data buffer to its worker, which DETACHES the caller's array. The
    // app reuses those same bytes to persist the original (sources-db) — so hand pdfjs a copy and
    // leave the caller's buffer intact (ADR-028). The copy is freed once parsing completes.
    data: data.slice(),
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0
  }).promise;

  const pages: PdfPage[] = [];
  let full = '';

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (p > 1) full += PAGE_SEPARATOR;
    const charStart = full.length;
    full += pageText;
    pages.push({ page: p, text: pageText, charStart, charEnd: full.length });
  }

  return {
    text: full,
    pages,
    pageForOffset: (offset: number) =>
      pages.find((pg) => offset >= pg.charStart && offset < pg.charEnd)?.page
  };
}
