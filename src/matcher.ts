export const KEYWORD_MIN_LEN = 2;
export const KEYWORD_MAX_LEN = 64;
export const KEYWORD_LIMIT = 50;

const UK_ENDING = /[аеуиіоюяєїьй]$/;

export function normalizeKeyword(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ").toLocaleLowerCase("uk");
}

export function prepareKeyword(raw: string): string {
  return raw.split(/\s+/).filter(Boolean).join(" ");
}

export function validateKeyword(raw: string): string | null {
  if (raw.includes("\n") || raw.includes("\r")) {
    return "Ключ має бути від 2 до 64 символів, без розриву рядка.";
  }
  const prepared = prepareKeyword(raw);
  if (prepared.length < KEYWORD_MIN_LEN || prepared.length > KEYWORD_MAX_LEN) {
    return "Ключ має бути від 2 до 64 символів, без розриву рядка.";
  }
  return null;
}

/** Nominative plus a one-letter stem so «Буча» also hits «Бучі» / «Бучу». */
export function matchVariants(normalized: string): string[] {
  const variants = [normalized];
  if (normalized.length >= 3 && UK_ENDING.test(normalized)) {
    const stem = normalized.slice(0, -1);
    if (stem.length >= KEYWORD_MIN_LEN) {
      variants.push(stem);
    }
  }
  return variants;
}

/** keywords: [normalized, display] */
export function matchKeywords(
  text: string,
  keywords: Array<[string, string]>,
): string[] {
  const folded = text.toLocaleLowerCase("uk");
  const hits: string[] = [];
  const seen = new Set<string>();
  for (const [normalized, display] of keywords) {
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    if (matchVariants(normalized).some((variant) => folded.includes(variant))) {
      hits.push(display);
      seen.add(normalized);
    }
  }
  return hits;
}

export function shouldAlert(
  matchedDisplay: string[],
  previousNormalized: string[] | null,
): boolean {
  if (matchedDisplay.length === 0) {
    return false;
  }
  if (previousNormalized === null) {
    return true;
  }
  const prev = new Set(previousNormalized);
  return matchedDisplay.some((item) => !prev.has(normalizeKeyword(item)));
}
