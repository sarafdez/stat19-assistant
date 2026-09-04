/** Stable colour per register / wiki section, so the eye can group them. */
export function hueFor(key: string): { fg: string; bg: string } {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) % 997;
  const slot = hash % 8;
  return { fg: `var(--hue-${slot})`, bg: `var(--hue-${slot}-soft)` };
}
