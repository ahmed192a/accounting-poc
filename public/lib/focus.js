// Pure helper for focus traps and listbox navigation: next index with wrap-around.
export function nextIndex(current, length, backwards = false) {
  if (!length) return -1;
  if (current < 0 || current >= length) return backwards ? length - 1 : 0;
  return backwards ? (current - 1 + length) % length : (current + 1) % length;
}
