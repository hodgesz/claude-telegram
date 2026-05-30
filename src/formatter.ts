// Markdown → Telegram HTML converter with message splitting

const PLACEHOLDER_PREFIX = "\x00PH";
let placeholderCounter = 0;

function nextPlaceholder(): string {
  return `${PLACEHOLDER_PREFIX}${placeholderCounter++}\x00`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function claudeToTelegram(markdown: string): string {
  placeholderCounter = 0;
  const stash: Map<string, string> = new Map();

  let text = markdown;

  // Phase 1: Extract fenced code blocks
  text = text.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_match, lang: string, code: string) => {
      const escaped = escapeHtml(code.replace(/\n$/, ""));
      const langAttr = lang ? ` class="language-${lang}"` : "";
      const html = `<pre><code${langAttr}>${escaped}</code></pre>`;
      const ph = nextPlaceholder();
      stash.set(ph, html);
      return ph;
    }
  );

  // Phase 2: Extract block elements
  // Headings
  text = text.replace(
    /^(#{1,6})\s+(.+)$/gm,
    (_match, _hashes, content: string) => {
      const ph = nextPlaceholder();
      stash.set(ph, `<b>${content.trim()}</b>`);
      return ph;
    }
  );

  // Blockquotes
  text = text.replace(/^>\s+(.+)$/gm, (_match, content: string) => {
    const ph = nextPlaceholder();
    stash.set(ph, `<blockquote>${content.trim()}</blockquote>`);
    return ph;
  });

  // Phase 3: Extract inline code
  text = text.replace(/`([^`]+)`/g, (_match, code: string) => {
    const ph = nextPlaceholder();
    stash.set(ph, `<code>${escapeHtml(code)}</code>`);
    return ph;
  });

  // Phase 4: Escape remaining HTML and apply inline formatting
  // Split on placeholders to only escape non-placeholder text.
  // The \x00 sentinels are intentional placeholder delimiters.
  // eslint-disable-next-line no-control-regex
  const parts = text.split(/((?:\x00PH\d+\x00))/);
  text = parts
    .map((part) => {
      if (stash.has(part)) return part;
      let escaped = escapeHtml(part);
      // Bold: **text** or __text__
      escaped = escaped.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
      escaped = escaped.replace(/__(.+?)__/g, "<b>$1</b>");
      // Strikethrough: ~~text~~
      escaped = escaped.replace(/~~(.+?)~~/g, "<s>$1</s>");
      // Italic: *text* or _text_
      escaped = escaped.replace(/(?<!\w)\*(.+?)\*(?!\w)/g, "<i>$1</i>");
      escaped = escaped.replace(/(?<!\w)_(.+?)_(?!\w)/g, "<i>$1</i>");
      // Links: [text](url)
      escaped = escaped.replace(
        /\[([^\]]+)\]\(([^)]+)\)/g,
        '<a href="$2">$1</a>'
      );
      return escaped;
    })
    .join("");

  // Phase 5: Restore placeholders
  for (const [ph, html] of stash) {
    text = text.replace(ph, html);
  }

  return text.trim();
}

const TAG_WHITELIST = new Set([
  "b",
  "i",
  "s",
  "u",
  "code",
  "pre",
  "blockquote",
  "a",
]);

export function splitMessage(text: string, limit = 4096): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt < limit * 0.3) {
      splitAt = remaining.lastIndexOf(" ", limit);
    }
    if (splitAt < limit * 0.3) {
      splitAt = limit;
    }

    // Don't split inside an HTML tag
    const lastOpenBracket = remaining.lastIndexOf("<", splitAt);
    const lastCloseBracket = remaining.lastIndexOf(">", splitAt);
    if (lastOpenBracket > lastCloseBracket) {
      splitAt = lastOpenBracket;
    }

    let chunk = remaining.slice(0, splitAt);
    remaining = remaining.slice(splitAt);

    // Track open tags and close them at end of chunk
    const openTags: string[] = [];
    const tagRegex = /<\/?([a-z]+)[^>]*>/gi;
    let match: RegExpExecArray | null;
    while ((match = tagRegex.exec(chunk)) !== null) {
      const tagName = match[1].toLowerCase();
      if (!TAG_WHITELIST.has(tagName)) continue;
      if (match[0].startsWith("</")) {
        const idx = openTags.lastIndexOf(tagName);
        if (idx !== -1) openTags.splice(idx, 1);
      } else {
        openTags.push(tagName);
      }
    }

    // Close open tags at end of chunk
    const closingTags = [...openTags]
      .reverse()
      .map((t) => `</${t}>`)
      .join("");
    chunk += closingTags;

    // Reopen tags at start of next chunk
    const openingTags = openTags.map((t) => `<${t}>`).join("");
    remaining = openingTags + remaining;

    chunks.push(chunk);
  }

  return chunks;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
}

export function formatToolCall(
  toolName: string,
  input: Record<string, unknown>
): string {
  switch (toolName) {
    case "Bash":
      return `🔧 <b>Bash</b>\n<pre>${escapeHtml(
        truncate(String(input.command ?? ""), 300)
      )}</pre>`;
    case "Edit":
      return `🔧 <b>Edit</b> ${escapeHtml(String(input.file_path ?? ""))}\n<pre>${escapeHtml(
        truncate(String(input.old_string ?? ""), 150)
      )}</pre>\n→\n<pre>${escapeHtml(
        truncate(String(input.new_string ?? ""), 150)
      )}</pre>`;
    case "Write":
      return `🔧 <b>Write</b> ${escapeHtml(String(input.file_path ?? ""))}\n<pre>${escapeHtml(
        truncate(String(input.content ?? ""), 500)
      )}</pre>`;
    case "Read":
      return `🔧 <b>Read</b> ${escapeHtml(String(input.file_path ?? ""))}`;
    default:
      return `🔧 <b>${escapeHtml(toolName)}</b>\n<pre>${escapeHtml(
        truncate(JSON.stringify(input, null, 2), 500)
      )}</pre>`;
  }
}
