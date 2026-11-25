# Tickets parallel umsetzen und zusammenführen

Gilt, wenn mehrere Tickets in eigenen Worktrees entstehen und nacheinander in einen Integrationszweig kommen (etwa mit `/implement-spec`). Gib die Abschnitte an Implementer und Merger weiter.

## Worktrees

- Alle Worktrees teilen einen Build-Cache: `CARGO_TARGET_DIR` für jeden `cargo`-Aufruf auf denselben Ordner außerhalb der Worktrees setzen, z. B. `<Elternordner>\Kredr-wt\_target`. „Blocking waiting for file lock on build directory“ heißt nur warten.
- In jedem Worktree einmal `npm.cmd ci`.
- Grün heißt `npm.cmd run check` ohne `ROT`.

## Nach jedem Merge in den Integrationszweig

1. Pushen. CI läuft nur für Pull Requests und `main`: Gibt es für den Integrationszweig noch keinen PR, jetzt den Entwurfs-PR öffnen.
2. Auf den CI-Lauf dieses Pushs warten: `gh pr checks <pr> --watch --fail-fast`.
3. Grün: Der Merge gilt als fertig, der nächste darf beginnen.
4. Rot: Keine weiteren Merges. Den fehlgeschlagenen Schritt lesen (`gh run view <id> --log-failed`) und die Ursache klären, bevor es weitergeht. Ein Test, der lokal grün und in CI rot ist, zeigt meist einen echten Fehler unter Last, keinen Zufall.

## Gestapelte PRs

Verlangt ein Spec mehrere PRs nacheinander, bekommt jeder Schritt einen eigenen Integrationszweig. Der Zweig von Schritt 2 zweigt vom Zweig von Schritt 1 ab, und sein PR zielt auf ihn.

Ist PR 1 per Squash in `main`, haben die Commits von Schritt 1 dort eine neue Kennung. Zweig 2 deshalb umsetzen, bevor PR 2 gemergt wird:

1. `git rebase --onto origin/main <letzter Commit von Schritt 1> <zweig 2>`. Danach muss `git diff <alter Stand von zweig 2> HEAD` leer sein.
2. `git push --force-with-lease=<zweig 2>:<alter Stand> origin HEAD:<zweig 2>`
3. `gh pr edit <pr 2> --base main`, dann auf CI warten wie oben.
