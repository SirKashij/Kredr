import { expect, test } from "vitest";
import { errorMessage, relativePath, renameSelectionLength } from "./fileOperations";
import { fullPath } from "./filePath";
import { translate } from "./i18n/i18n";

test("der volle Pfad eines Eintrags ist ein Windows-Pfad unterhalb des Projektordners", () => {
  expect(fullPath("C:\\Projekte\\Kredr", "src/ui/App.tsx")).toBe(
    "C:\\Projekte\\Kredr\\src\\ui\\App.tsx",
  );
  expect(fullPath("C:\\", "README.md")).toBe("C:\\README.md");
});

test("der leere Pfad ist der Projektordner selbst", () => {
  expect(fullPath("C:\\Projekte\\Kredr", "")).toBe("C:\\Projekte\\Kredr");
});

test("der relative Pfad wird in Windows-Schreibweise kopiert", () => {
  expect(relativePath("src/ui/App.tsx")).toBe("src\\ui\\App.tsx");
  expect(relativePath("README.md")).toBe("README.md");
});

test("beim Umbenennen einer Datei ist der Name ohne Endung vorausgewählt", () => {
  expect(renameSelectionLength("App.test.tsx", "file")).toBe("App.test".length);
  expect(renameSelectionLength("Makefile", "file")).toBe("Makefile".length);
  expect(renameSelectionLength(".gitignore", "file")).toBe(".gitignore".length);
});

test("beim Umbenennen eines Ordners ist der ganze Name vorausgewählt", () => {
  expect(renameSelectionLength("v1.2", "folder")).toBe(4);
});

test("abgelehnte Namen bekommen eine verständliche Meldung", () => {
  const text = (error: unknown, name: string) => {
    const { key, values } = errorMessage(error, name);
    return translate("de", key, values);
  };

  expect(text({ kind: "invalidName" }, "a?b")).toBe(
    '„a?b“ ist kein gültiger Name. Nicht erlaubt sind \\ / : * ? " < > |, ein Punkt oder Leerzeichen am Ende und von Windows reservierte Namen wie CON oder NUL.',
  );
  expect(text({ kind: "alreadyExists" }, "README.md")).toBe(
    "In diesem Ordner gibt es „README.md“ bereits. Wähle einen anderen Namen.",
  );
  expect(text({ kind: "notFound" }, "weg.txt")).toBe(
    "„weg.txt“ gibt es nicht mehr; der Eintrag oder sein Ordner wurde inzwischen entfernt.",
  );
  expect(text({ kind: "failed", details: "Zugriff verweigert" }, "x")).toBe(
    "Das hat nicht geklappt: Zugriff verweigert",
  );
  expect(text("kaputt", "x")).toBe("Das hat nicht geklappt: kaputt");
});
