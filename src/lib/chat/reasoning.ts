// Reasoning-block extraction (FR-CHAT) — split a model answer into its hidden reasoning and the
// user-facing content. Reasoning models (DeepSeek-R1, Qwen) emit a `<think>…</think>` block before
// the actual answer. We surface that reasoning in a separate collapsible "Thinking" panel instead
// of dumping the raw tags into the rendered answer (the renderer is escape-first, so otherwise the
// literal `<think>` text leaks into the prose). Pure + deterministic.

export interface SplitAnswer {
  /** Concatenated `<think>` content. May be partial while the answer is still streaming. */
  reasoning: string;
  /** The answer with every reasoning block removed — what gets rendered as Markdown. */
  content: string;
}

// Match a closed reasoning block. Tolerates `<think>` and `<thinking>` (different model families).
const THINK_BLOCK = /<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi;
const THINK_OPEN = /<think(?:ing)?>/i;

/**
 * Separate `<think>…</think>` reasoning from the user-facing answer. Handles multiple closed blocks
 * AND a single unterminated `<think>` (the streaming case, before the closing tag has arrived) —
 * everything after an open-but-unclosed tag is treated as still-streaming reasoning.
 */
export function splitReasoning(text: string): SplitAnswer {
  if (!text) return { reasoning: '', content: '' };
  let reasoning = '';
  // 1. closed <think>…</think> blocks → collect their content, strip them from the answer.
  let content = text.replace(THINK_BLOCK, (_m, inner: string) => {
    reasoning += inner;
    return '';
  });
  // 2. an unterminated <think> (still streaming) → everything past the open tag is reasoning.
  const open = content.search(THINK_OPEN);
  if (open !== -1) {
    reasoning += content.slice(open).replace(THINK_OPEN, '');
    content = content.slice(0, open);
  }
  return { reasoning: reasoning.trim(), content: content.trim() };
}
