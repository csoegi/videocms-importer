/**
 * VideoCMS rejects names longer than 128 characters. Use Unicode code points
 * rather than String.length so surrogate-pair characters (for example emoji)
 * are not split or counted as two characters.
 */
export function fitVideoCMSName(value, maxLength = 128) {
  const original = String(value ?? '').trim();
  const limit = Number.isFinite(maxLength) ? Math.max(1, Math.floor(maxLength)) : 128;
  return Array.from(original).slice(0, limit).join('').trimEnd();
}
