//! Tests des Moduls Projektdateien über seine öffentliche Schnittstelle,
//! gegen echte temporäre Ordner.

use std::collections::BTreeSet;
use std::fs;
use std::sync::mpsc::{channel, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use kredr_lib::project_files::{
    list_folder, read_file, write_file, EntryKind, FileContent, ProjectChanges, ProjectWatcher,
    Subscription, MAX_FILE_SIZE,
};
use tempfile::TempDir;

const TIMEOUT: Duration = Duration::from_secs(30);

fn temp_project() -> TempDir {
    tempfile::Builder::new()
        .prefix("kredr-test-")
        .tempdir()
        .expect("Testordner sollte anlegbar sein")
}

#[test]
fn auflisten_liefert_ordner_und_dateien_mit_ihrer_art() {
    let project = temp_project();
    fs::create_dir(project.path().join("src")).unwrap();
    fs::write(project.path().join("src").join("tief.rs"), "").unwrap();
    fs::write(project.path().join("README.md"), "# Kredr").unwrap();
    fs::write(project.path().join(".gitignore"), "").unwrap();

    let entries = list_folder(project.path()).expect("Ordner sollte lesbar sein");

    let listed: BTreeSet<(String, EntryKind)> = entries
        .into_iter()
        .map(|entry| (entry.name, entry.kind))
        .collect();
    let expected = BTreeSet::from([
        (".gitignore".to_owned(), EntryKind::File),
        ("README.md".to_owned(), EntryKind::File),
        ("src".to_owned(), EntryKind::Folder),
    ]);
    assert_eq!(listed, expected);
}

#[test]
fn auflisten_eines_fehlenden_ordners_scheitert() {
    let project = temp_project();

    let result = list_folder(&project.path().join("gibt-es-nicht"));

    assert!(result.is_err());
}

/// Sammelt die Änderungsereignisse eines Abonnements.
struct Changes {
    events: Receiver<ProjectChanges>,
    /// Alle bisher gemeldeten Pfade.
    paths: BTreeSet<String>,
    rescan: bool,
    /// Anzahl der bisher empfangenen Ereignisse.
    count: usize,
    _subscription: Subscription,
}

impl Changes {
    fn subscribe(watcher: &ProjectWatcher) -> Changes {
        let (sender, events) = channel();
        let subscription = watcher.subscribe(move |changes| {
            let _ = sender.send(changes.clone());
        });
        Changes {
            events,
            paths: BTreeSet::new(),
            rescan: false,
            count: 0,
            _subscription: subscription,
        }
    }

    /// Nimmt Ereignisse entgegen, bis `condition` gilt.
    fn wait_until(&mut self, expectation: &str, condition: impl Fn(&Changes) -> bool) {
        let deadline = Instant::now() + TIMEOUT;
        while !condition(self) {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let Ok(changes) = self.events.recv_timeout(remaining) else {
                panic!("{expectation}. Bisher gemeldet: {:?}", self.paths);
            };
            self.count += 1;
            self.rescan |= changes.rescan;
            self.paths.extend(changes.paths);
        }
    }

    /// Verwirft das Abonnement und liefert, was bis dahin unverarbeitet ankam.
    fn unsubscribe(self) -> Receiver<ProjectChanges> {
        self.events
    }

    fn wait_for_path(&mut self, path: &str) {
        self.wait_until(&format!("{path} sollte gemeldet werden"), |changes| {
            changes.paths.contains(path)
        });
    }
}

fn watch(project: &TempDir) -> ProjectWatcher {
    ProjectWatcher::start(project.path()).expect("Projektordner sollte beobachtbar sein")
}

#[test]
fn von_aussen_angelegte_datei_wird_mit_projektbezogenem_pfad_gemeldet() {
    let project = temp_project();
    fs::create_dir_all(project.path().join("src").join("ui")).unwrap();
    let watcher = watch(&project);
    let mut changes = Changes::subscribe(&watcher);

    fs::write(project.path().join("src").join("ui").join("neu.ts"), "x").unwrap();

    changes.wait_for_path("src/ui/neu.ts");
}

#[test]
fn umbenennen_meldet_alten_und_neuen_pfad() {
    let project = temp_project();
    fs::write(project.path().join("alt.txt"), "x").unwrap();
    let watcher = watch(&project);
    let mut changes = Changes::subscribe(&watcher);

    fs::rename(
        project.path().join("alt.txt"),
        project.path().join("neu.txt"),
    )
    .unwrap();

    changes.wait_for_path("alt.txt");
    changes.wait_for_path("neu.txt");
}

#[test]
fn loeschen_von_datei_und_ordner_wird_gemeldet() {
    let project = temp_project();
    fs::create_dir(project.path().join("weg")).unwrap();
    fs::write(project.path().join("weg.txt"), "x").unwrap();
    let watcher = watch(&project);
    let mut changes = Changes::subscribe(&watcher);

    fs::remove_file(project.path().join("weg.txt")).unwrap();
    fs::remove_dir(project.path().join("weg")).unwrap();

    changes.wait_for_path("weg.txt");
    changes.wait_for_path("weg");
}

#[test]
fn hunderte_gleichzeitige_schreibvorgaenge_kommen_als_wenige_ereignisse_an() {
    const WRITERS: usize = 8;
    const FILES_PER_WRITER: usize = 100;
    let project = temp_project();
    let watcher = watch(&project);
    let mut changes = Changes::subscribe(&watcher);

    let writers: Vec<_> = (0..WRITERS)
        .map(|writer| {
            let folder = project.path().join(format!("agent-{writer}"));
            thread::spawn(move || {
                fs::create_dir(&folder).unwrap();
                for file in 0..FILES_PER_WRITER {
                    fs::write(folder.join(format!("datei-{file}.txt")), "inhalt").unwrap();
                }
            })
        })
        .collect();
    for writer in writers {
        writer.join().unwrap();
    }

    // Jede Datei ist gemeldet, oder der Strom verlangt ausdrücklich, alles neu zu lesen.
    let expected: Vec<String> = (0..WRITERS)
        .flat_map(|writer| {
            (0..FILES_PER_WRITER).map(move |file| format!("agent-{writer}/datei-{file}.txt"))
        })
        .collect();
    changes.wait_until("alle Dateien sollten gemeldet werden", |changes| {
        changes.rescan || expected.iter().all(|path| changes.paths.contains(path))
    });
    assert!(
        changes.count <= 40,
        "{} Ereignisse für {} Dateien sind nicht zusammengefasst",
        changes.count,
        expected.len()
    );
}

#[test]
fn mehrfach_geaenderte_datei_steht_nur_einmal_im_ereignis() {
    let project = temp_project();
    let watcher = watch(&project);
    let (sender, events) = channel();
    let _subscription = watcher.subscribe(move |changes| {
        let _ = sender.send(changes.clone());
    });

    for round in 0..20 {
        fs::write(project.path().join("oft.txt"), format!("{round}")).unwrap();
    }

    let changes = events
        .recv_timeout(TIMEOUT)
        .expect("Ereignis sollte kommen");
    let mentions = changes.paths.iter().filter(|path| *path == "oft.txt");
    assert_eq!(mentions.count(), 1);
}

#[test]
fn jeder_abonnent_erhaelt_die_ereignisse_bis_er_sein_abonnement_verwirft() {
    let project = temp_project();
    let watcher = watch(&project);
    let mut explorer = Changes::subscribe(&watcher);
    let mut version_control = Changes::subscribe(&watcher);

    fs::write(project.path().join("eins.txt"), "x").unwrap();
    explorer.wait_for_path("eins.txt");
    version_control.wait_for_path("eins.txt");

    let events = version_control.unsubscribe();
    fs::write(project.path().join("zwei.txt"), "x").unwrap();
    explorer.wait_for_path("zwei.txt");

    // Das Abonnement ist verworfen; sein Rückruf wurde nicht mehr aufgerufen.
    let late: Vec<ProjectChanges> = events.try_iter().collect();
    assert!(late
        .iter()
        .all(|changes| !changes.paths.contains(&"zwei.txt".to_owned())));
}

#[test]
fn lesen_liefert_den_text_einer_datei_unveraendert() {
    let project = temp_project();
    let path = project.path().join("notiz.md");
    fs::write(&path, "# Überschrift\r\nZeile zwei\n").unwrap();

    let content = read_file(&path).expect("Datei sollte lesbar sein");

    assert_eq!(
        content,
        FileContent::Text {
            text: "# Überschrift\r\nZeile zwei\n".to_owned()
        }
    );
}

#[test]
fn lesen_einer_leeren_datei_liefert_leeren_text() {
    let project = temp_project();
    let path = project.path().join("leer.txt");
    fs::write(&path, "").unwrap();

    assert_eq!(
        read_file(&path).unwrap(),
        FileContent::Text {
            text: String::new()
        }
    );
}

#[test]
fn lesen_erkennt_binaere_dateien() {
    let project = temp_project();
    let image = project.path().join("bild.png");
    fs::write(&image, [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x00, 0x01]).unwrap();
    // Kein NUL-Byte, aber auch kein gültiges UTF-8.
    let latin1 = project.path().join("alt.txt");
    fs::write(&latin1, [b'G', b'r', 0xfc, 0xdf, b'e']).unwrap();

    assert_eq!(read_file(&image).unwrap(), FileContent::Binary);
    assert_eq!(read_file(&latin1).unwrap(), FileContent::Binary);
}

#[test]
fn lesen_erkennt_uebergrosse_dateien_ohne_sie_zu_laden() {
    let project = temp_project();
    let path = project.path().join("riesig.log");
    let file = fs::File::create(&path).unwrap();
    file.set_len(MAX_FILE_SIZE + 1).unwrap();
    drop(file);
    let at_limit = project.path().join("grenze.log");
    fs::write(&at_limit, vec![b'a'; MAX_FILE_SIZE as usize]).unwrap();

    assert_eq!(
        read_file(&path).unwrap(),
        FileContent::TooLarge {
            size: MAX_FILE_SIZE + 1
        }
    );
    assert!(matches!(
        read_file(&at_limit).unwrap(),
        FileContent::Text { .. }
    ));
}

#[test]
fn lesen_einer_fehlenden_datei_meldet_dass_sie_fehlt() {
    let project = temp_project();

    assert_eq!(
        read_file(&project.path().join("geloescht.txt")).unwrap(),
        FileContent::Missing
    );
}

#[test]
fn lesen_eines_ordners_scheitert() {
    let project = temp_project();

    assert!(read_file(project.path()).is_err());
}

#[test]
fn schreiben_ersetzt_den_inhalt_und_lesen_liefert_ihn_zurueck() {
    let project = temp_project();
    let path = project.path().join("config.toml");
    fs::write(&path, "alt = true\n").unwrap();

    write_file(&path, "neu = \"ä\"\r\n").expect("Datei sollte schreibbar sein");

    assert_eq!(fs::read(&path).unwrap(), "neu = \"ä\"\r\n".as_bytes());
    assert_eq!(
        read_file(&path).unwrap(),
        FileContent::Text {
            text: "neu = \"ä\"\r\n".to_owned()
        }
    );
}

#[test]
fn schreiben_legt_eine_geloeschte_datei_wieder_an() {
    let project = temp_project();
    let path = project.path().join("wieder-da.txt");

    write_file(&path, "inhalt").unwrap();

    assert_eq!(fs::read_to_string(&path).unwrap(), "inhalt");
}

#[test]
fn schreiben_in_einen_fehlenden_ordner_scheitert() {
    let project = temp_project();

    let result = write_file(&project.path().join("fehlt").join("datei.txt"), "x");

    assert!(result.is_err());
}

#[test]
fn schreiben_wird_ueber_den_ereignisstrom_gemeldet() {
    let project = temp_project();
    let path = project.path().join("offen.txt");
    fs::write(&path, "alt").unwrap();
    let watcher = watch(&project);
    let mut changes = Changes::subscribe(&watcher);

    write_file(&path, "neu").unwrap();

    changes.wait_for_path("offen.txt");
}
