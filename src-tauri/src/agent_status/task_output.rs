//! Die Ausgabedateien der Hintergrundaufgaben von Claude Code (ADR 0005).
//!
//! Claude Code schreibt die Ausgabe jeder Hintergrundaufgabe nach
//! `%TEMP%\claude\<Projekt>\<Gespräch>\tasks\<Kennung>.output`. Bricht die
//! Person eine Aufgabe über `/tasks` ab, meldet Claude Code (2.1.330) kein
//! Ereignis, schließt die Datei aber mit einer Leerzeile und `[killed]` ab,
//! bei einer Shell wie bei einem Monitor. Das ist kein zugesichertes
//! Verhalten: Findet sich die Datei nicht oder endet sie anders, gilt weiter,
//! was das letzte `Stop` meldete.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Weak;
use std::thread;
use std::time::{Duration, Instant};

use super::Registrations;

/// Womit Claude Code die Ausgabe einer abgebrochenen Aufgabe abschließt.
const KILLED: &[u8] = b"\n[killed]\n";
/// So oft sieht Kredr nach, ob eine Hintergrundaufgabe abgebrochen wurde.
const INTERVAL: Duration = Duration::from_millis(500);
/// So lange wartet Kredr, bis es eine nicht gefundene Ausgabedatei erneut sucht.
const SEARCH_AGAIN_AFTER: Duration = Duration::from_secs(5);

/// Eine laufende Hintergrundaufgabe im Terminal `terminal`.
#[derive(Clone, PartialEq, Eq, Hash)]
struct RunningTask {
    terminal: u32,
    task: String,
}

/// Was Kredr über die Ausgabedatei einer Aufgabe weiß.
struct Output {
    path: Option<PathBuf>,
    searched: Instant,
}

/// Beobachtet die Ausgabedateien der laufenden Hintergrundaufgaben aller
/// Terminals, bis der Empfänger endet. Ist eine Aufgabe vorbei, ohne dass
/// Claude Code es meldet, fällt sie aus der Liste ihres Agenten. Die
/// Beobachtung einer Aufgabe endet, sobald sie nicht mehr in der Liste steht,
/// also auch mit `SessionEnd`, `/clear` und dem Ende des Terminals.
/// `claude_temp` ist der Ordner `%TEMP%\claude`.
pub(super) fn watch(registrations: &Weak<Registrations>, claude_temp: &Path) {
    let mut outputs: HashMap<RunningTask, Output> = HashMap::new();
    loop {
        thread::sleep(INTERVAL);
        let Some(registrations) = registrations.upgrade() else {
            return;
        };
        // Gesucht und gelesen wird ohne Sperre, damit keine Meldung wartet.
        let running: Vec<(RunningTask, Option<String>)> = {
            let Ok(registrations) = registrations.lock() else {
                return;
            };
            registrations
                .iter()
                .flat_map(|(terminal, registration)| {
                    let agent = &registration.agent;
                    agent.background_tasks().iter().map(|task| {
                        let running = RunningTask {
                            terminal: *terminal,
                            task: task.id.clone(),
                        };
                        (running, agent.conversation().map(str::to_owned))
                    })
                })
                .collect()
        };
        outputs.retain(|watched, _| running.iter().any(|(task, _)| task == watched));
        let mut ended = Vec::new();
        for (running, conversation) in running {
            let search = || find(claude_temp, conversation.as_deref(), &running.task);
            let output = outputs.entry(running.clone()).or_insert_with(|| Output {
                path: search(),
                searched: Instant::now(),
            });
            if output.path.is_none() && output.searched.elapsed() >= SEARCH_AGAIN_AFTER {
                output.path = search();
                output.searched = Instant::now();
            }
            if output.path.as_deref().is_some_and(has_ended) {
                ended.push(running);
            }
        }
        if ended.is_empty() {
            continue;
        }
        let Ok(mut registrations) = registrations.lock() else {
            return;
        };
        for running in ended {
            if let Some(registration) = registrations.get_mut(&running.terminal) {
                let update = registration.agent.end_background_task(&running.task);
                registration.tell(update);
            }
        }
    }
}

/// Die Ausgabedatei der Aufgabe `task` unter `claude_temp`. Den Ordner des
/// Projekts kennt Kredr nicht. Der Gesprächsordner heißt nach dem Gespräch,
/// mit dem Claude Code startete; nach `/clear` ist das nicht mehr
/// `conversation`. Darum zuerst dort, dann in allen Gesprächsordnern.
fn find(claude_temp: &Path, conversation: Option<&str>, task: &str) -> Option<PathBuf> {
    let name = format!("{task}.output");
    let projects = || {
        std::fs::read_dir(claude_temp)
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.path())
    };
    if let Some(conversation) = conversation {
        let found = projects()
            .map(|project| project.join(conversation).join("tasks").join(&name))
            .find(|path| path.is_file());
        if found.is_some() {
            return found;
        }
    }
    projects()
        .flat_map(|project| std::fs::read_dir(project).into_iter().flatten().flatten())
        .map(|folder| folder.path().join("tasks").join(&name))
        .find(|path| path.is_file())
}

/// Ob die Aufgabe mit der Ausgabedatei `output` vorbei ist: Die Datei endet
/// auf `[killed]` oder ist verschwunden. Lässt sie sich nicht lesen, läuft
/// die Aufgabe weiter.
fn has_ended(output: &Path) -> bool {
    let mut file = match File::open(output) {
        Ok(file) => file,
        Err(error) => return error.kind() == std::io::ErrorKind::NotFound,
    };
    let Ok(length) = file.seek(SeekFrom::End(0)) else {
        return false;
    };
    let Some(start) = length.checked_sub(KILLED.len() as u64) else {
        return false;
    };
    let mut end = Vec::with_capacity(KILLED.len());
    file.seek(SeekFrom::Start(start)).is_ok() && file.read_to_end(&mut end).is_ok() && end == KILLED
}
