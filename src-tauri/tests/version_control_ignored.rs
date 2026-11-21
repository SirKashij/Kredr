//! Tests der ignorierten Dateien im Zustand der Versionskontrolle: Der
//! Explorer zeichnet sie ausgegraut. Echtes Git in temporären Ordnern.

mod git_support;

use std::sync::mpsc::channel;
use std::time::Duration;

use kredr_lib::project_files::ProjectWatcher;

use git_support::TestProject;

#[test]
fn ignorierte_dateien_und_ordner_stehen_getrennt_von_den_aenderungen_im_zustand() {
    let project = TestProject::with_commit(&[
        (".gitignore", "node_modules/\n*.log\n"),
        ("a.txt", "eins\n"),
    ]);
    project.write("neu.txt", "neu\n");
    project.write("lauf.log", "protokoll\n");
    project.write("src/tief/lauf.log", "protokoll\n");
    project.write("node_modules/paket/index.js", "export {};\n");
    project.write("node_modules/paket/lib/tief.js", "export {};\n");

    let state = project.version_control().state().unwrap();

    // Ein ignorierter Ordner steht einmal da, nicht mit jeder Datei darin.
    assert_eq!(
        state.ignored,
        ["lauf.log", "node_modules", "src/tief/lauf.log"]
    );
    let changed: Vec<&str> = state.files.iter().map(|file| file.path.as_str()).collect();
    assert_eq!(changed, ["neu.txt"]);
}

#[test]
fn ohne_ignorierte_dateien_ist_die_liste_leer() {
    let project = TestProject::with_commit(&[("a.txt", "eins\n")]);

    let state = project.version_control().state().unwrap();

    assert!(state.ignored.is_empty());
}

#[test]
fn in_einem_unterordner_als_projekt_gelten_die_pfade_ab_dem_projektordner() {
    let project =
        TestProject::with_commit(&[(".gitignore", "*.log\nbuild/\n"), ("app/a.txt", "eins\n")]);
    project.write("aussen.log", "protokoll\n");
    project.write("app/innen.log", "protokoll\n");
    project.write("app/build/ergebnis.bin", "x");

    let state = project.version_control_in("app").state().unwrap();

    assert_eq!(state.ignored, ["build", "innen.log"]);
}

#[test]
fn liegt_das_ganze_projekt_in_einem_ignorierten_ordner_ist_der_projektordner_ignoriert() {
    let project = TestProject::with_commit(&[(".gitignore", "erzeugt/\n"), ("a.txt", "eins\n")]);
    project.write("erzeugt/app/src/a.txt", "x");

    let folder = project.version_control_in("erzeugt").state().unwrap();
    let below = project.version_control_in("erzeugt/app").state().unwrap();

    // Der leere Pfad ist der Projektordner selbst.
    assert_eq!(folder.ignored, [""]);
    assert_eq!(below.ignored, [""]);
}

#[test]
fn der_beobachtete_zustand_folgt_einer_neuen_ignorier_regel() {
    let project = TestProject::with_commit(&[("a.txt", "eins\n")]);
    project.write("lauf.log", "protokoll\n");
    let watcher = ProjectWatcher::start(project.path()).expect("Beobachter sollte starten");
    let watch = project.version_control().watch(&watcher);
    let (sender, states) = channel();
    let _subscription = watch.subscribe(move |state| {
        let _ = sender.send(state.clone());
    });

    project.write(".gitignore", "*.log\n");

    loop {
        let state = states
            .recv_timeout(Duration::from_secs(30))
            .expect("Die ignorierte Datei sollte gemeldet werden")
            .unwrap();
        if state.ignored == ["lauf.log"] {
            break;
        }
    }
}
