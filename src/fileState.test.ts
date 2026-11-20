import { expect, test } from "vitest";
import {
  edited,
  loadingFile,
  received,
  resolveConflict,
  saved,
  type FileContent,
  type FileState,
} from "./fileState";

const text = (value: string): FileContent => ({ kind: "text", text: value });

/** Eine geladene Datei mit dem Inhalt `alt` ohne ungespeicherte Änderungen. */
const open = received(loadingFile, text("alt")).state;
/** Dieselbe Datei mit ungespeicherten Änderungen. */
const dirty = edited(open, true);

test("der erste gelesene Inhalt wird angezeigt", () => {
  const { state, load } = received(loadingFile, text("alt"));

  expect(load).toBe("alt");
  expect(state).toMatchObject({ phase: "text", dirty: false, deleted: false, conflict: null });
});

test("binäre und übergroße Dateien zeigen einen Hinweis statt Inhalt", () => {
  const binary = received(loadingFile, { kind: "binary" });
  const tooLarge = received(loadingFile, { kind: "tooLarge", size: 6_000_000 });

  expect(binary.load).toBeUndefined();
  expect(binary.state.phase).toBe("binary");
  expect(tooLarge.load).toBeUndefined();
  expect(tooLarge.state.phase).toBe("tooLarge");
});

test("ändert ein Agent die Datei, lädt die Ansicht ohne ungespeicherte Änderungen neu", () => {
  const { state, load } = received(open, text("neu"));

  expect(load).toBe("neu");
  expect(state).toMatchObject({ phase: "text", dirty: false, conflict: null });
});

test("ein unveränderter Inhalt lädt nichts neu", () => {
  const { state, load } = received(open, text("alt"));

  expect(load).toBeUndefined();
  expect(state).toBe(open);
});

test("ändert ein Agent eine Datei mit ungespeicherten Änderungen, entsteht ein Konflikt", () => {
  const { state, load } = received(dirty, text("vom Agenten"));

  expect(load).toBeUndefined();
  expect(state).toMatchObject({ dirty: true, conflict: "vom Agenten" });
});

test("im Konflikt lädt die neue Fassung den Inhalt des Agenten", () => {
  const conflict = received(dirty, text("vom Agenten")).state;

  const { state, load } = resolveConflict(conflict, "theirs");

  expect(load).toBe("vom Agenten");
  expect(state).toMatchObject({ dirty: false, conflict: null });
  // Derselbe Inhalt noch einmal gemeldet ändert nichts mehr.
  expect(received(state, text("vom Agenten")).load).toBeUndefined();
});

test("im Konflikt bleibt mit der eigenen Fassung der eigene Text ungespeichert stehen", () => {
  const conflict = received(dirty, text("vom Agenten")).state;

  const { state, load } = resolveConflict(conflict, "mine");

  expect(load).toBeUndefined();
  expect(state).toMatchObject({ dirty: true, conflict: null });
  // Der Stand des Agenten ist zur Kenntnis genommen und meldet sich nicht erneut.
  expect(received(state, text("vom Agenten")).state.conflict).toBeNull();
  // Eine weitere Änderung des Agenten schon.
  expect(received(state, text("noch neuer")).state.conflict).toBe("noch neuer");
});

test("nimmt der Agent seine Änderung zurück, löst sich der Konflikt auf", () => {
  const conflict = received(dirty, text("vom Agenten")).state;

  const { state } = received(conflict, text("alt"));

  expect(state).toMatchObject({ dirty: true, conflict: null });
});

test("das eigene Speichern löst kein Neuladen aus", () => {
  const afterSave = saved(dirty, "meins");

  expect(afterSave).toMatchObject({ dirty: false, conflict: null });
  const { state, load } = received(afterSave, text("meins"));
  expect(load).toBeUndefined();
  expect(state).toBe(afterSave);
});

test("wer während des Speicherns weitertippt, behält ungespeicherte Änderungen", () => {
  expect(saved(dirty, "meins", true).dirty).toBe(true);
});

test("eine gelöschte Datei bleibt lesbar und ist als gelöscht erkennbar", () => {
  const { state, load } = received(open, { kind: "missing" });

  expect(load).toBeUndefined();
  expect(state).toMatchObject({ phase: "text", deleted: true });
});

test("eine gelöschte Datei, die wieder auftaucht, ist nicht mehr gelöscht", () => {
  const deleted = received(open, { kind: "missing" }).state;

  const sameAgain = received(deleted, text("alt"));
  const different = received(deleted, text("neu"));

  expect(sameAgain.state.deleted).toBe(false);
  expect(sameAgain.load).toBeUndefined();
  expect(different.state.deleted).toBe(false);
  expect(different.load).toBe("neu");
});

test("ungespeicherte Änderungen einer gelöschten Datei bleiben erhalten; Speichern legt sie neu an", () => {
  const deleted = received(dirty, { kind: "missing" }).state;
  expect(deleted).toMatchObject({ dirty: true, deleted: true });

  expect(saved(deleted, "meins")).toMatchObject({ dirty: false, deleted: false });
});

test("eine Datei, die es beim Öffnen nicht gibt, zeigt das an", () => {
  const { state } = received(loadingFile, { kind: "missing" });

  expect(state.phase).toBe("missing");
  // Legt ein Agent sie an, erscheint ihr Inhalt.
  expect(received(state, text("da")).load).toBe("da");
});

test("wird aus einer Textdatei eine binäre, zeigt die Ansicht den Hinweis", () => {
  expect(received(open, { kind: "binary" }).state.phase).toBe("binary");
  // Eigene ungespeicherte Änderungen verdrängt das nicht.
  const kept: FileState = received(dirty, { kind: "binary" }).state;
  expect(kept).toBe(dirty);
});

test("aus einem Hinweis wird wieder Text, wenn die Datei lesbar wird", () => {
  const binary = received(loadingFile, { kind: "binary" }).state;

  const { state, load } = received(binary, text("jetzt Text"));

  expect(state.phase).toBe("text");
  expect(load).toBe("jetzt Text");
});

test("ein Lesefehler zeigt sich nur, solange nichts geladen ist", () => {
  expect(
    received(loadingFile, { kind: "error", message: "Zugriff verweigert" }).state,
  ).toMatchObject({
    phase: "error",
    error: "Zugriff verweigert",
  });
  expect(received(open, { kind: "error", message: "gesperrt" }).state).toBe(open);
});
