//! Tests des Moduls Versionskontrolle über seine öffentliche Schnittstelle,
//! gegen echte, im Test angelegte Git-Repositories.

mod git_support;

use std::time::{Duration, Instant};

use kredr_lib::project_files::{FileContent, MAX_FILE_SIZE};
use kredr_lib::version_control::{
    ChangedFile, Diff, ErrorReason, FileStatus, GitOptions, VersionControl,
};

use git_support::TestProject;

fn change(path: &str, status: FileStatus, staged: bool) -> ChangedFile {
    ChangedFile {
        path: path.to_owned(),
        original_path: None,
        status,
        staged,
    }
}

#[test]
fn ein_frisches_repository_meldet_seinen_branch_und_keine_aenderungen() {
    let project = TestProject::with_repository();

    let state = project.version_control().state().unwrap();

    assert_eq!(state.branch.as_deref(), Some("main"));
    assert_eq!(state.commit, None);
    assert_eq!(state.files, vec![]);
}

#[test]
fn der_zustand_nennt_den_aktuellen_branch_und_commit() {
    let project = TestProject::with_commit(&[("README.md", "# Kredr\n")]);
    project.git(&["switch", "--create", "feature/diff"]);

    let state = project.version_control().state().unwrap();

    assert_eq!(state.branch.as_deref(), Some("feature/diff"));
    let head = project.git(&["rev-parse", "HEAD"]);
    assert_eq!(state.commit.as_deref(), Some(head.trim()));
}

#[test]
fn ohne_branch_meldet_der_zustand_nur_den_commit() {
    let project = TestProject::with_commit(&[("README.md", "# Kredr\n")]);
    project.git(&["switch", "--detach"]);

    let state = project.version_control().state().unwrap();

    assert_eq!(state.branch, None);
    let head = project.git(&["rev-parse", "HEAD"]);
    assert_eq!(state.commit.as_deref(), Some(head.trim()));
}

#[test]
fn geaenderte_neue_und_geloeschte_dateien_tragen_ihren_status() {
    let project = TestProject::with_commit(&[
        ("src/main.rs", "fn main() {}\n"),
        ("alt.txt", "weg damit\n"),
    ]);
    project.write("src/main.rs", "fn main() { run(); }\n");
    project.write("docs/neu ä.md", "# Neu\n");
    project.delete("alt.txt");

    let state = project.version_control().state().unwrap();

    assert_eq!(
        state.files,
        vec![
            change("alt.txt", FileStatus::Deleted, false),
            change("src/main.rs", FileStatus::Modified, false),
            change("docs/neu ä.md", FileStatus::Untracked, false),
        ]
    );
}

#[test]
fn ausgewaehlte_aenderungen_sind_von_nicht_ausgewaehlten_getrennt() {
    let project = TestProject::with_commit(&[("a.txt", "eins\n"), ("b.txt", "eins\n")]);
    project.write("a.txt", "zwei\n");
    project.write("neu.txt", "neu\n");
    project.git(&["add", "a.txt", "neu.txt"]);
    // Dieselbe Datei kann beides zugleich sein.
    project.write("a.txt", "drei\n");
    project.write("b.txt", "zwei\n");

    let state = project.version_control().state().unwrap();

    assert_eq!(
        state.files,
        vec![
            change("a.txt", FileStatus::Modified, true),
            change("a.txt", FileStatus::Modified, false),
            change("b.txt", FileStatus::Modified, false),
            change("neu.txt", FileStatus::Added, true),
        ]
    );
}

#[test]
fn eine_umbenannte_datei_nennt_ihren_frueheren_pfad() {
    let project = TestProject::with_commit(&[("alt/name.txt", "eins\nzwei\ndrei\n")]);
    project.git(&["mv", "alt/name.txt", "neuer name.txt"]);

    let state = project.version_control().state().unwrap();

    assert_eq!(
        state.files,
        vec![ChangedFile {
            path: "neuer name.txt".to_owned(),
            original_path: Some("alt/name.txt".to_owned()),
            status: FileStatus::Renamed,
            staged: true,
        }]
    );
}

#[test]
fn eine_datei_im_konflikt_ist_als_solche_markiert() {
    let project = TestProject::with_commit(&[("a.txt", "basis\n")]);
    project.git(&["switch", "--create", "andere"]);
    project.write("a.txt", "andere\n");
    project.commit_all("Andere Fassung");
    project.git(&["switch", "main"]);
    project.write("a.txt", "meine\n");
    project.commit_all("Meine Fassung");
    // Der Merge scheitert am Konflikt; genau den Zustand danach prüft der Test.
    project.git_unchecked(&["merge", "andere"]);

    let state = project.version_control().state().unwrap();

    assert_eq!(
        state.files,
        vec![change("a.txt", FileStatus::Conflicted, false)]
    );
}

#[test]
fn ein_branch_mit_remote_meldet_branch_und_aenderungen_wie_sonst() {
    let project = TestProject::with_commit(&[("a.txt", "eins\n")]);
    project.add_remote();
    project.write("a.txt", "zwei\n");

    let state = project.version_control().state().unwrap();

    assert_eq!(state.branch.as_deref(), Some("main"));
    assert_eq!(
        state.files,
        vec![change("a.txt", FileStatus::Modified, false)]
    );
}

#[test]
fn ein_unterordner_als_projekt_sieht_nur_seine_dateien_mit_pfaden_ab_dem_projektordner() {
    let project = TestProject::with_commit(&[("app/src/a.txt", "eins\n"), ("b.txt", "eins\n")]);
    project.write("app/src/a.txt", "zwei\n");
    project.write("app/neu.txt", "neu\n");
    project.write("b.txt", "zwei\n");

    let state = project.version_control_in("app").state().unwrap();

    assert_eq!(state.branch.as_deref(), Some("main"));
    assert_eq!(
        state.files,
        vec![
            change("src/a.txt", FileStatus::Modified, false),
            change("neu.txt", FileStatus::Untracked, false),
        ]
    );
}

#[test]
fn ein_ordner_ohne_repository_ist_kein_fehlschlag_sondern_ein_eigener_grund() {
    let project = TestProject::without_repository();

    let error = project.version_control().state().unwrap_err();

    assert_eq!(error.reason, ErrorReason::NotARepository);
}

#[test]
fn fehlt_git_meldet_das_modul_genau_das() {
    let project = TestProject::with_repository();
    let options = GitOptions {
        program: "kredr-test-git-gibt-es-nicht".into(),
        ..project.git_options()
    };

    let error = VersionControl::with_options(project.path(), options)
        .state()
        .unwrap_err();

    assert_eq!(error.reason, ErrorReason::GitMissing);
}

#[test]
fn ein_git_fehler_traegt_den_originaltext_von_git() {
    let project = TestProject::with_repository();
    // Ein zerstörtes Repository: Git erkennt den Ordner, kann ihn aber nicht lesen.
    std::fs::write(project.path().join(".git").join("config"), "[kaputt").unwrap();

    let error = project.version_control().state().unwrap_err();

    assert_eq!(error.reason, ErrorReason::Failed);
    assert!(
        error.details.contains("fatal:"),
        "Originaltext fehlt: {:?}",
        error.details
    );
}

/// Der Diff der Änderung mit diesem Pfad, ausgewählt oder nicht.
fn diff_of(project: &TestProject, path: &str, staged: bool) -> Diff {
    let version_control = project.version_control();
    let state = version_control.state().unwrap();
    let file = state
        .files
        .iter()
        .find(|file| file.path == path && file.staged == staged)
        .expect("Die Änderung sollte im Zustand stehen");
    version_control.diff(file).unwrap()
}

fn text(text: &str) -> FileContent {
    FileContent::Text {
        text: text.to_owned(),
    }
}

#[test]
fn der_diff_einer_geaenderten_datei_stellt_festgeschriebene_und_aktuelle_fassung_gegenueber() {
    let project = TestProject::with_commit(&[("src/a.txt", "eins\nzwei\n")]);
    project.write("src/a.txt", "eins\nzwei\ndrei\n");

    let diff = diff_of(&project, "src/a.txt", false);

    assert_eq!(diff.original, text("eins\nzwei\n"));
    assert_eq!(diff.modified, text("eins\nzwei\ndrei\n"));
}

#[test]
fn ausgewaehlter_und_nicht_ausgewaehlter_teil_haben_je_ihren_diff() {
    let project = TestProject::with_commit(&[("a.txt", "eins\n")]);
    project.write("a.txt", "zwei\n");
    project.git(&["add", "a.txt"]);
    project.write("a.txt", "drei\n");

    let staged = diff_of(&project, "a.txt", true);
    let unstaged = diff_of(&project, "a.txt", false);

    assert_eq!(staged.original, text("eins\n"));
    assert_eq!(staged.modified, text("zwei\n"));
    assert_eq!(unstaged.original, text("zwei\n"));
    assert_eq!(unstaged.modified, text("drei\n"));
}

#[test]
fn eine_neue_datei_hat_keine_fruehere_fassung() {
    let project = TestProject::with_repository();
    project.write("neu.txt", "neu\n");
    project.write("gewählt ä.txt", "auch neu\n");
    project.git(&["add", "gewählt ä.txt"]);

    let untracked = diff_of(&project, "neu.txt", false);
    let added = diff_of(&project, "gewählt ä.txt", true);

    assert_eq!(untracked.original, FileContent::Missing);
    assert_eq!(untracked.modified, text("neu\n"));
    assert_eq!(added.original, FileContent::Missing);
    assert_eq!(added.modified, text("auch neu\n"));
}

#[test]
fn eine_geloeschte_datei_hat_keine_aktuelle_fassung() {
    let project = TestProject::with_commit(&[("a.txt", "eins\n"), ("b.txt", "zwei\n")]);
    project.delete("a.txt");
    project.git(&["rm", "--quiet", "b.txt"]);

    let unstaged = diff_of(&project, "a.txt", false);
    let staged = diff_of(&project, "b.txt", true);

    assert_eq!(unstaged.original, text("eins\n"));
    assert_eq!(unstaged.modified, FileContent::Missing);
    assert_eq!(staged.original, text("zwei\n"));
    assert_eq!(staged.modified, FileContent::Missing);
}

#[test]
fn der_diff_einer_umbenannten_datei_vergleicht_mit_dem_frueheren_pfad() {
    let project = TestProject::with_commit(&[("alt.txt", "eins\nzwei\ndrei\nvier\n")]);
    project.git(&["mv", "alt.txt", "neu.txt"]);
    project.write("neu.txt", "eins\nzwei\ndrei\nfünf\n");
    project.git(&["add", "neu.txt"]);

    let diff = diff_of(&project, "neu.txt", true);

    assert_eq!(diff.original, text("eins\nzwei\ndrei\nvier\n"));
    assert_eq!(diff.modified, text("eins\nzwei\ndrei\nfünf\n"));
}

#[test]
fn binaere_und_uebergrosse_fassungen_werden_nicht_geliefert() {
    let project =
        TestProject::with_commit(&[("bild.png", "kein Bild\n"), ("gross.txt", "klein\n")]);
    project.write("bild.png", [0x89, b'P', b'N', b'G', 0, 1, 2, 3]);
    let size = MAX_FILE_SIZE as usize + 1;
    project.write("gross.txt", vec![b'a'; size]);
    project.git(&["add", "--all"]);

    let binary = diff_of(&project, "bild.png", true);
    let large = diff_of(&project, "gross.txt", true);

    assert_eq!(binary.original, text("kein Bild\n"));
    assert_eq!(binary.modified, FileContent::Binary);
    assert_eq!(large.original, text("klein\n"));
    assert_eq!(large.modified, FileContent::TooLarge { size: size as u64 });
}

#[test]
fn der_diff_im_konflikt_vergleicht_mit_dem_letzten_commit() {
    let project = TestProject::with_commit(&[("a.txt", "basis\n")]);
    project.git(&["switch", "--create", "andere"]);
    project.write("a.txt", "andere\n");
    project.commit_all("Andere Fassung");
    project.git(&["switch", "main"]);
    project.write("a.txt", "meine\n");
    project.commit_all("Meine Fassung");
    project.git_unchecked(&["merge", "andere"]);

    let diff = diff_of(&project, "a.txt", false);

    assert_eq!(diff.original, text("meine\n"));
    let FileContent::Text { text: merged } = diff.modified else {
        panic!("Die Fassung mit Konfliktmarken sollte Text sein");
    };
    assert!(merged.contains("<<<<<<<") && merged.contains("andere"));
}

#[test]
fn der_diff_in_einem_unterordner_als_projekt_findet_beide_fassungen() {
    let project = TestProject::with_commit(&[("app/src/a.txt", "eins\n")]);
    project.write("app/src/a.txt", "zwei\n");
    project.git(&["add", "--all"]);
    project.write("app/src/a.txt", "drei\n");
    let version_control = project.version_control_in("app");
    let state = version_control.state().unwrap();

    let staged = version_control.diff(&state.files[0]).unwrap();
    let unstaged = version_control.diff(&state.files[1]).unwrap();

    assert_eq!(staged.original, text("eins\n"));
    assert_eq!(staged.modified, text("zwei\n"));
    assert_eq!(unstaged.original, text("zwei\n"));
    assert_eq!(unstaged.modified, text("drei\n"));
}

#[test]
fn ein_git_aufruf_der_haengt_endet_an_der_zeitgrenze_samt_seinen_kindprozessen() {
    let project = TestProject::with_repository();
    // Ein „Git“, das nie antwortet und dafür selbst ein Programm startet.
    let hanging = project.path().with_file_name("haengt.cmd");
    std::fs::write(&hanging, "@ping -n 60 127.0.0.1 >nul\r\n").unwrap();
    let options = GitOptions {
        program: hanging.into(),
        timeout: Duration::from_millis(500),
        ..project.git_options()
    };
    let started = Instant::now();

    let error = VersionControl::with_options(project.path(), options)
        .state()
        .unwrap_err();

    assert_eq!(error.reason, ErrorReason::TimedOut);
    assert!(started.elapsed() < Duration::from_secs(20));
    // Läuft noch ein Kindprozess im Projektordner, lässt Windows ihn nicht löschen.
    let deadline = Instant::now() + Duration::from_secs(10);
    while std::fs::remove_dir_all(project.path()).is_err() {
        assert!(
            Instant::now() < deadline,
            "Im Projektordner läuft noch ein Prozess"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}
