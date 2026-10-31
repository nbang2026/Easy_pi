export const normalizeFileText = (text: string): string => text.replace(/\r\n?/g, "\n");

// Textareas expose LF only. Keep the native separators outside the changed span,
// reuse replaced separators in order, and use the file's prevalent ending for new lines.
// Applying this on each input keeps separate edits from rewriting mixed-ending regions.
export function preserveFileLineEndings(previous: string, value: string): string {
  const before = normalizeFileText(previous);
  const next = normalizeFileText(value);
  if (before === next) return previous;
  const endings = previous.match(/\r\n|\r|\n/g) || [];
  let prefix = 0;
  while (prefix < before.length && prefix < next.length && before[prefix] === next[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < next.length - prefix
    && before[before.length - suffix - 1] === next[next.length - suffix - 1]) suffix++;
  const prefixLines = (before.slice(0, prefix).match(/\n/g) || []).length;
  const suffixLines = (before.slice(before.length - suffix).match(/\n/g) || []).length;
  const replaced = endings.slice(prefixLines, endings.length - suffixLines);
  const addedLines = (next.slice(prefix, next.length - suffix).match(/\n/g) || []).length;
  const counts = new Map<string, number>();
  let preferred = "\n";
  for (const ending of endings) {
    counts.set(ending, (counts.get(ending) || 0) + 1);
    if (counts.get(ending)! > (counts.get(preferred) || 0)) preferred = ending;
  }
  const nextEndings = [
    ...endings.slice(0, prefixLines),
    ...Array.from({ length: addedLines }, (_, index) => replaced[index] || preferred),
    ...endings.slice(endings.length - suffixLines),
  ];
  let index = 0;
  return next.replace(/\n/g, () => nextEndings[index++] || preferred);
}
