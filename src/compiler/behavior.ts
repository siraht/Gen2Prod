/**
 * Lower the small, auditable subset of inline handlers that are equivalent to
 * native link navigation. Arbitrary executable code always returns undefined.
 */
export function nativeDestinationFromHandler(source: string): string | undefined {
  const patterns = [
    /(?:window\.)?location(?:\.href)?\s*=\s*(['"])(.*?)\1/i,
    /(?:window\.)?location\.assign\(\s*(['"])(.*?)\1\s*\)/i,
  ];
  let destination: string | undefined;
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match?.[2]) { destination = match[2].trim(); break; }
  }
  if (!destination) {
    const scrollTarget = source.match(/document\.getElementById\(\s*(['"])([-_a-zA-Z0-9:.]+)\1\s*\)\.scrollIntoView\s*\(/)?.[2];
    if (scrollTarget) destination = `#${scrollTarget}`;
  }
  if (!destination || /[\u0000-\u001f\u007f\s]/.test(destination)) return undefined;
  if (/^(?:https?:|mailto:|tel:|#|\/|\.\/|\.\.\/)/i.test(destination)) return destination;
  if (/^[a-z][a-z0-9+.-]*:/i.test(destination) || destination.startsWith("\\")) return undefined;
  return destination;
}
