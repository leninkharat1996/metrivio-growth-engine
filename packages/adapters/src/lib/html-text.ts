/**
 * Minimal HTML-to-visible-text stripper, hand-written for Stage 5.
 *
 * `opentechalyzer` (already a dependency, used by
 * `OpenTechAnalyzerAdapter`) exports an equivalent `visibleText()` function
 * from its enrichment module, but that module is not reachable: the
 * package's own `package.json` `exports` map only exposes the package root
 * (`"."`), so a subpath import like `opentechalyzer/dist/enrich/extract.js`
 * is blocked by Node's package-exports enforcement. Reusing it would
 * require either a new dependency or reaching around the package boundary
 * (both against this stage's zero-new-dependency preference and the
 * existing "adapters around everything fragile" discipline) — a small,
 * local, purpose-built stripper is the smallest correct alternative.
 *
 * Deliberately not a general HTML parser: no DOM, no tag-nesting model,
 * just enough to turn marketing/about/press page markup into plain text a
 * regex-based classifier can search.
 */

const REMOVE_ENTIRELY = /<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/gi;
const TAG = /<[^>]*>/g;
const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&mdash;': '—',
  '&ndash;': '–',
  '&rsquo;': '’',
  '&lsquo;': '‘',
  '&rdquo;': '”',
  '&ldquo;': '“',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match) => {
    if (ENTITIES[match]) return ENTITIES[match];
    const numeric = /^&#(\d+);$/.exec(match);
    if (numeric?.[1]) return String.fromCodePoint(Number.parseInt(numeric[1], 10));
    const hex = /^&#x([0-9a-f]+);$/i.exec(match);
    if (hex?.[1]) return String.fromCodePoint(Number.parseInt(hex[1], 16));
    return match;
  });
}

/** Maximum characters returned — a hard bound so one oversized page can never cause unbounded memory growth in a caller that concatenates text across pages. */
export const MAX_EXTRACTED_TEXT_LENGTH = 100_000;

export function extractVisibleText(html: string): string {
  const withoutHiddenBlocks = html.replace(REMOVE_ENTIRELY, ' ');
  const withoutTags = withoutHiddenBlocks.replace(TAG, ' ');
  const decoded = decodeEntities(withoutTags);
  const collapsed = decoded.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_EXTRACTED_TEXT_LENGTH ? collapsed.slice(0, MAX_EXTRACTED_TEXT_LENGTH) : collapsed;
}
