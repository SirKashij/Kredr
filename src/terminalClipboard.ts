import type { KeyStroke } from "./keybindings";

export type ClipboardCommand = "copy" | "paste";

/** Virtuelle Tastencodes von Windows. */
const Key = { Insert: 45, C: 67, V: 86 };

/**
 * Ob ein Tastendruck im Terminal kopiert oder einfügt, statt an die Shell zu
 * gehen. Strg+C kopiert nur, wenn Text markiert ist (`hasSelection`); sonst
 * bleibt es das Abbruchsignal für das laufende Programm.
 */
export function clipboardCommand(key: KeyStroke, hasSelection: boolean): ClipboardCommand | null {
  const { keyCode, ctrlKey, shiftKey, altKey } = key;
  // Strg+Alt ist AltGr und gehört den Sonderzeichen der Tastatur.
  if (altKey) return null;
  if (keyCode === Key.Insert) {
    if (shiftKey && !ctrlKey) return "paste";
    return ctrlKey && !shiftKey && hasSelection ? "copy" : null;
  }
  if (!ctrlKey) return null;
  if (keyCode === Key.V) return "paste";
  // Mit Umschalt nie als Abbruchsignal: Wer so kopieren will, soll nichts beenden.
  if (keyCode === Key.C) return hasSelection || shiftKey ? "copy" : null;
  return null;
}
