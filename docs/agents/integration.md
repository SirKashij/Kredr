# Tickets parallel umsetzen und zusammenführen

Gilt, wenn mehrere Tickets in eigenen Worktrees entstehen und nacheinander in einen Integrationszweig kommen (etwa mit `/implement-spec`). Gib die Abschnitte an Implementer und Merger weiter.

## Worktrees

- Alle Worktrees teilen einen Build-Cache: `CARGO_TARGET_DIR` für jeden `cargo`-Aufruf auf denselben Ordner außerhalb der Worktrees setzen, z. B. `<Elternordner>\Kredr-wt\_target`. „Blocking waiting for file lock on build directory“ heißt nur warten.
- In jedem Worktree einmal `npm.cmd ci`.
- Grün heißt `npm.cmd run check` ohne `ROT`.

## Nach jedem Merge in den Integrationszweig

1. Pushen.
2. Auf den CI-Lauf dieses Pushs warten: `gh pr checks <pr> --watch --fail-fast`. Gibt es noch keinen PR, `gh run watch` mit der ID aus `gh run list --branch <zweig> --limit 1`.
3. Grün: Der Merge gilt als fertig, der nächste darf beginnen.
4. Rot: Keine weiteren Merges. Den fehlgeschlagenen Schritt lesen (`gh run view <id> --log-failed`) und die Ursache klären, bevor es weitergeht. Ein Test, der lokal grün und in CI rot ist, zeigt meist einen echten Fehler unter Last, keinen Zufall.
