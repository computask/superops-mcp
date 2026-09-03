const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  bull: "•",
  copy: "©",
  emsp: " ",
  ensp: " ",
  hellip: "…",
  ldquo: "“",
  lt: "<",
  mdash: "—",
  nbsp: " ",
  ndash: "–",
  quot: '"',
  rdquo: "”",
  reg: "®",
  rsquo: "’",
  thinsp: " ",
  trade: "™",
  gt: ">",
  middot: "·",
};

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, (entity, body: string) => {
    const lower = body.toLowerCase();
    if (lower.startsWith("#")) {
      const codePoint = lower.startsWith("#x")
        ? Number.parseInt(lower.slice(2), 16)
        : Number.parseInt(lower.slice(1), 10);
      if (
        Number.isInteger(codePoint) &&
        codePoint >= 0 &&
        codePoint <= 0x10ffff &&
        !(codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        return String.fromCodePoint(codePoint);
      }
      return entity;
    }
    return HTML_ENTITIES[lower] ?? entity;
  });
}

function removeOuterHtmlWrappers(value: string): string {
  let text = value;
  for (let pass = 0; pass < 4; pass += 1) {
    const withoutOpeningWrapper = text.replace(/^\s*<(?:html|body)\b[^>]*>/i, "");
    const withoutClosingWrapper = withoutOpeningWrapper.replace(/<\/(?:html|body)>\s*$/i, "");
    if (withoutClosingWrapper === text) return text;
    text = withoutClosingWrapper;
  }
  return text;
}

/**
 * Convert either submitted note HTML or a SuperOps-rendered note into the
 * exact semantic text used for note comparison and fingerprinting.
 */
export function canonicalizeNoteText(value: string | undefined): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;

  const text = removeOuterHtmlWrappers(value.normalize("NFKC"))
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(
      /<(?:script|style|iframe|object|embed|svg|form|input|button)\b[\s\S]*?<\/(?:script|style|iframe|object|embed|svg|form|input|button)>/gi,
      ""
    )
    .replace(/<(?:br)\b[^>]*\/?>/gi, "\n")
    .replace(
      /<\/?(?:p|div|li|tr|h[1-6]|blockquote|section|article|pre|table|ul|ol)\b[^>]*>/gi,
      "\n"
    )
    // Formatting tags such as strong/b/em/span are presentation-only here.
    // Retain their text while removing the tags themselves.
    .replace(/<\/?[a-z][^>]*>/gi, "");

  const decoded = decodeHtmlEntities(text)
    .replace(/[\u00a0\u202f]/gu, " ")
    .replace(/\r\n?/g, "\n");
  const lines = decoded.split("\n").map((line) =>
    line.replace(/[^\S\r\n]+/gu, " ").trim()
  );
  const normalizedLines: string[] = [];
  for (const line of lines) {
    if (line.length === 0) {
      if (normalizedLines.length > 0 && normalizedLines[normalizedLines.length - 1] !== "") {
        normalizedLines.push("");
      }
      continue;
    }
    normalizedLines.push(line);
  }

  while (normalizedLines[0] === "") normalizedLines.shift();
  while (normalizedLines[normalizedLines.length - 1] === "") normalizedLines.pop();
  const canonical = normalizedLines.join("\n");
  return canonical || undefined;
}
