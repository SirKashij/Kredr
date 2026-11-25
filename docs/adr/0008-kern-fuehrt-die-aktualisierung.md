# Der Kern führt die Aktualisierung, den Dialog zeigt das fragende Fenster

Den Ablauf von „Jetzt aktualisieren“ führt der Kern als eine Phasenmaschine: Rundfrage nach den Anlässen, Rückfrage, Download, erneute Rundfrage, Rückfrage bei einem neuen Anlass, Rundfrage „Aufteilung speichern“, Installer. Die Oberfläche löst ihn mit einem einzigen Befehl aus (`app_update_now`) und rendert danach nur den Zustand.

Braucht der Kern eine Entscheidung der Person, steht er in der Phase `confirm` mit den zusammengezählten Anlässen im Zustand. Den nativen Dialog zeigt dann das fragende Fenster: Es schreibt den Text in seiner Sprache (`updateQuestion`), öffnet den Dialog als sein eigener, also mit sich als Eltern-Fenster, und schickt die Antwort per Befehl zurück (`app_update_answer`). Alle anderen Fenster zeigen die Rückfrage ohne Aktionen.

## Erwogene Alternativen

- **Der Kern zeigt den Dialog selbst** (`tauri-plugin-dialog` aus Rust): Verworfen. Rust hat keine Übersetzungen; der Text käme in einer festen Sprache statt in der des Fensters. Und ein Dialog ohne Eltern-Fenster würde von `close_orphaned_dialogs` abgebrochen, sobald sich irgendein Fenster schließt, denn ohne Besitzer gilt er als verwaist.
- **Der Ablauf bleibt im fragenden Fenster** (wie bis 0.7): Verworfen. Die Reihenfolge stand dann in TypeScript, die Phasen zusätzlich im Kern und in einer Simulation für die Tests. Die drei liefen auseinander, und jede Änderung berührte Dateien in beiden Sprachen.

## Folgen

- Die Reihenfolge des Ablaufs und die Regeln für Anlässe (Summe, stummes Fenster, neuer Anlass) stehen nur in Rust. Die Abläufe prüfen Rust-Tests mit dem vorgespielten Updater und Fake-Fenstern über die Mock-Runtime; TypeScript prüft nur die Darstellung.
- Die Rundfrage stellt der Kern als Ereignis `window-poll` an alle Fenster; jedes Fenster antwortet per Befehl `window_poll_answer` mit der Kennung der Rundfrage, und der Kern erkennt es am aufrufenden Fenster. Nach 3 s gilt ein Fenster ohne Antwort als stumm, ebenso eines, das `null` antwortet. Zuerst kam die Antwort wie zuvor zwischen Fenstern als Ereignis `window-poll-answer`. Das ging verloren: Tauri stellt ein Ereignis an Rust-Listener nicht sicher zu, wenn ein anderer Thread gerade eines sendet (`try_lock` in `tauri/src/event/listener.rs`), es bleibt dann in einer Warteschlange bis zum nächsten Ereignis mit Rust-Listenern. Das Fenster galt fälschlich als stumm. Ein Befehl geht an diesem Mechanismus vorbei. Ereignisse vom Kern an die Webviews betrifft das nicht.
- Schließt sich das fragende Fenster oder lädt es neu, endet die Rückfrage wie mit „Später“; wartet der Kern gerade auf den Dialog, verfällt die Antwort, und der Ablauf endet. Während des Downloads endet er spätestens mit dessen Ende.
- Scheitert der Dialog im Fenster, meldet das Fenster den Fehlschlag (`app_update_fail`); er gilt für alle Fenster.
