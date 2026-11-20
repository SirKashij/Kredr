import type { Side } from "./arrangement";

/** Ein Befehl, der sich per Tastenkürzel auslösen lässt. */
export type Command =
  | {
      kind:
        | "newTerminal"
        | "newAgent"
        | "splitRight"
        | "splitDown"
        | "focusNextGroup"
        | "focusPreviousGroup"
        | "nextTab"
        | "previousTab"
        | "closeTab"
        | "openSettings";
    }
  | { kind: "focusGroupAt"; index: number }
  | { kind: "focusGroupToward"; side: Side };

export interface KeyStroke {
  keyCode: number;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * Virtuelle Tastencodes von Windows. Wie VS Code richten sich die Kürzel nach
 * ihnen und nicht nach dem erzeugten Zeichen: `Oem3` ist auf einer deutschen
 * Tastatur „Ö“ und auf einer amerikanischen „`“, `Oem5` ist „^“ bzw. „\“.
 */
const Key = {
  Shift: 16,
  Control: 17,
  Alt: 18,
  WindowsLeft: 91,
  WindowsRight: 92,
  PageUp: 33,
  PageDown: 34,
  Left: 37,
  Up: 38,
  Right: 39,
  Down: 40,
  Digit1: 49,
  Digit5: 53,
  Digit8: 56,
  A: 65,
  K: 75,
  F4: 115,
  Comma: 188,
  Oem3: 192,
  Oem5: 220,
};

const modifierKeys = [Key.Shift, Key.Control, Key.Alt, Key.WindowsLeft, Key.WindowsRight];

/** Ob die Taste nur andere Tasten abwandelt (Strg, Umschalt, Alt, Windows-Taste). */
export function isModifierKey(keyCode: number): boolean {
  return modifierKeys.includes(keyCode);
}

/**
 * Ordnet einem Tastendruck seinen Befehl zu; die Kürzel entsprechen den
 * Standardkürzeln von VS Code für Windows. `"chord"` heißt: Strg+K wurde
 * gedrückt, die nächste Taste vervollständigt das Kürzel. `chord` gibt an,
 * ob dieser Tastendruck eine solche zweite Taste ist.
 */
export function resolveKey(key: KeyStroke, chord: boolean): Command | "chord" | null {
  const { keyCode, ctrlKey, shiftKey, altKey } = key;

  if (chord) {
    if (!ctrlKey || shiftKey || altKey) return null;
    if (keyCode === Key.Oem5) return { kind: "splitDown" };
    if (keyCode === Key.Left) return { kind: "focusGroupToward", side: "left" };
    if (keyCode === Key.Right) return { kind: "focusGroupToward", side: "right" };
    if (keyCode === Key.Up) return { kind: "focusGroupToward", side: "up" };
    if (keyCode === Key.Down) return { kind: "focusGroupToward", side: "down" };
    return null;
  }

  if (altKey && !ctrlKey && !shiftKey) {
    if (keyCode === Key.Right || keyCode === Key.Down) return { kind: "focusNextGroup" };
    if (keyCode === Key.Left || keyCode === Key.Up) return { kind: "focusPreviousGroup" };
    return null;
  }

  // Strg+Alt ist AltGr und gehört den Sonderzeichen der Tastatur.
  if (!ctrlKey || altKey) return null;

  if (shiftKey) {
    if (keyCode === Key.Oem3) return { kind: "newTerminal" };
    // VS Code kennt keinen Agenten; dieses Kürzel ist dort unter Windows frei.
    if (keyCode === Key.A) return { kind: "newAgent" };
    if (keyCode === Key.Digit5) return { kind: "splitRight" };
    return null;
  }

  if (keyCode === Key.K) return "chord";
  if (keyCode === Key.Oem5) return { kind: "splitRight" };
  if (keyCode === Key.PageDown) return { kind: "nextTab" };
  if (keyCode === Key.PageUp) return { kind: "previousTab" };
  if (keyCode === Key.F4) return { kind: "closeTab" };
  if (keyCode === Key.Comma) return { kind: "openSettings" };
  if (keyCode >= Key.Digit1 && keyCode <= Key.Digit8) {
    return { kind: "focusGroupAt", index: keyCode - Key.Digit1 };
  }
  return null;
}
