export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head|noscript|svg)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

/** No em or en dashes anywhere: ranges become hyphens, everything else a comma. */
export function noDashes(text: string): string {
  return text
    .replace(/(\d)\s*[\u2013\u2014]\s*(\d)/g, "$1-$2")
    .replace(/\s*[\u2013\u2014]\s*/g, ", ")
    .replace(/,\s*([.,!?])/g, "$1");
}

/** Drops tracking and affiliate tags (utm_*, tag, ref, fbclid, gclid) so links look like the real ones. */
export function cleanUrl(url: string): string {
  try {
    const u = new URL(url);
    // Amazon product links carry long tracking paths and parameters; the product's own address is just /dp/<id>.
    const asin = /(^|\.)amazon\.[a-z.]+$/.test(u.hostname) && /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/.exec(u.pathname)?.[1];
    if (asin) return `${u.origin}/dp/${asin}`;
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_.*|tag|ref|ref_src|fbclid|gclid|mc_[a-z]+|aff.*)$/i.test(key)) u.searchParams.delete(key);
    }
    return u.toString().replace(/\?$/, "");
  } catch {
    return url;
  }
}

/** GPT writes Markdown out of habit; WhatsApp has its own, smaller set of formatting. */
export function toWhatsApp(text: string): string {
  return noDashes(text)
    // Models sometimes copy the "[timestamp]" prefix from the messages they're given.
    .replace(/^\s*\[[^\]\n]{1,60}\]\s*/gm, "")
    .replace(/^\s*\d{1,2}:\d{2}\s+(?=\S)/, "")
    // Web search adds citations like "([bbc.co.uk](https://...))"; drop them to keep replies short.
    .replace(/\s*\(\[[^\]]+\]\(https?:\/\/[^)\s]+\)\)/g, "")
    // ...or raw markers in private-use characters ("\ue200cite\ue202turn0search18\ue201"), which WhatsApp shows as junk.
    .replace(/\s*\ue200[^\ue201]*\ue201/g, "")
    // (one cut off before its closing character still has "cite" and the turn ids to take out)
    .replace(/\s*\ue200[a-z]*(?:\ue202[\w-]*)+/gi, "")
    .replace(/[\ue200-\ue2ff]/g, "")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label: string, url: string) => {
      const clean = url.replace(/[?&]utm_source=openai$/, "").replace(/\?utm_source=openai&/, "?");
      return label === clean || clean.includes(label) ? clean : `${label} (${clean})`;
    })
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/__(.+?)__/g, "_$1_")
    .replace(/^(\s*)[*•]\s+/gm, "$1- ")
    // Web search tags links with ?utm_source=openai; drop it so links look like the real ones.
    .replace(/https?:\/\/[^\s)]+/g, cleanUrl)
    .trim();
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[cut: ${text.length - max} more characters]`;
}

/** Splits a reply into separate WhatsApp messages at blank lines, like a person sending a few texts. */
export function bubbles(text: string, max = 5): string[] {
  const parts = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return parts.length <= max ? parts : [...parts.slice(0, max - 1), parts.slice(max - 1).join("\n\n")];
}
