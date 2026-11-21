//! Tests der Commit-Liste des Moduls Versionskontrolle über seine öffentliche
//! Schnittstelle, gegen echte, im Test angelegte Git-Repositories. „Gepusht“
//! bezieht sich auf ein lokales „Remote“-Repository im Testordner.

mod git_support;

use kredr_lib::project_files::FileContent;
use kredr_lib::version_control::{Commit, CommitFile, Diff, ErrorReason, FileStatus};

use git_support::TestProject;

/// Schreibt eine Datei und schreibt sie mit dieser Nachricht fest.
fn commit(project: &TestProject, path: &str, text: &str, message: &str) {
    project.write(path, text);
    project.commit_all(message);
}

fn messages(commits: &[Commit]) -> Vec<&str> {
    commits.iter().map(|c| c.message.as_str()).collect()
}

fn file(path: &str, status: FileStatus) -> CommitFile {
    CommitFile {
        path: path.to_owned(),
        original_path: None,
        status,
    }
}

fn text(text: &str) -> FileContent {
    FileContent::Text {
        text: text.to_owned(),
    }
}

#[test]
fn die_liste_nennt_nachricht_autor_und_zeitpunkt_der_letzten_commits() {
    let project = TestProject::with_commit(&[("a.txt", "eins\n")]);
    project.write("a.txt", "zwei\n");
    project.git(&["add", "--all"]);
    project.git(&[
        "commit",
        "--message",
        "Zweiter Commit",
        "--author",
        "Agent Backend <backend@kredr.invalid>",
        "--date",
        "@1700000000 +0100",
    ]);

    let commits = project.version_control().commits(0, 50).unwrap();

    assert_eq!(messages(&commits), ["Zweiter Commit", "Erster Commit"]);
    assert_eq!(commits[0].author, "Agent Backend");
    assert_eq!(commits[0].time, 1_700_000_000);
    assert_eq!(commits[1].author, "Kredr Test");
    let head = project.git(&["rev-parse", "HEAD"]);
    assert_eq!(commits[0].id, head.trim());
}

#[test]
fn aeltere_commits_lassen_sich_seitenweise_nachladen() {
    let project = TestProject::with_commit(&[("a.txt", "1\n")]);
    for number in 2..=5 {
        commit(
            &project,
            "a.txt",
            &format!("{number}\n"),
            &format!("Commit {number}"),
        );
    }
    let vc = project.version_control();

    assert_eq!(
        messages(&vc.commits(0, 2).unwrap()),
        ["Commit 5", "Commit 4"]
    );
    assert_eq!(
        messages(&vc.commits(2, 2).unwrap()),
        ["Commit 3", "Commit 2"]
    );
    // Weniger als verlangt: Es gibt keine älteren mehr.
    assert_eq!(messages(&vc.commits(4, 2).unwrap()), ["Erster Commit"]);
    assert_eq!(vc.commits(5, 2).unwrap(), vec![]);
}

#[test]
fn vor_dem_ersten_commit_ist_die_liste_leer() {
    let project = TestProject::with_repository();

    assert_eq!(project.version_control().commits(0, 50).unwrap(), vec![]);
}

#[test]
fn ohne_repository_scheitert_die_liste_mit_dem_grund() {
    let project = TestProject::without_repository();

    let error = project.version_control().commits(0, 50).unwrap_err();

    assert_eq!(error.reason, ErrorReason::NotARepository);
}

#[test]
fn eine_mehrzeilige_nachricht_bleibt_vollstaendig() {
    let project = TestProject::with_commit(&[("a.txt", "eins\n")]);
    let message =
        "Verlauf: Commit-Liste\n\nErster Absatz über\nzwei Zeilen.\n\n- Punkt mit „Umlauten“ äöü";
    commit(&project, "a.txt", "zwei\n", message);

    let commits = project.version_control().commits(0, 1).unwrap();

    assert_eq!(commits[0].message, message);
}

#[test]
fn nur_commits_die_dem_remote_fehlen_gelten_als_nicht_gepusht() {
    let project = TestProject::with_commit(&[("a.txt", "1\n")]);
    commit(&project, "a.txt", "2\n", "Gepusht");
    project.add_remote();
    commit(&project, "a.txt", "3\n", "Lokal eins");
    commit(&project, "a.txt", "4\n", "Lokal zwei");
    let vc = project.version_control();

    let pushed: Vec<(String, bool)> = vc
        .commits(0, 50)
        .unwrap()
        .into_iter()
        .map(|commit| (commit.message, commit.pushed))
        .collect();

    assert_eq!(
        pushed,
        [
            ("Lokal zwei".to_owned(), false),
            ("Lokal eins".to_owned(), false),
            ("Gepusht".to_owned(), true),
            ("Erster Commit".to_owned(), true),
        ]
    );
}

#[test]
fn nach_dem_push_gilt_kein_commit_mehr_als_nicht_gepusht() {
    let project = TestProject::with_commit(&[("a.txt", "1\n")]);
    project.add_remote();
    commit(&project, "a.txt", "2\n", "Lokal");
    let vc = project.version_control();
    assert!(!vc.commits(0, 50).unwrap()[0].pushed);

    project.git(&["push"]);

    assert!(vc
        .commits(0, 50)
        .unwrap()
        .iter()
        .all(|commit| commit.pushed));
}

#[test]
fn auf_einem_neuen_branch_ohne_gegenstueck_sind_nur_dessen_commits_nicht_gepusht() {
    let project = TestProject::with_commit(&[("a.txt", "1\n")]);
    project.add_remote();
    project.git(&["switch", "--create", "feature/verlauf"]);
    commit(&project, "a.txt", "2\n", "Auf dem neuen Branch");

    let commits = project.version_control().commits(0, 50).unwrap();

    assert_eq!(
        messages(&commits),
        ["Auf dem neuen Branch", "Erster Commit"]
    );
    assert!(!commits[0].pushed);
    assert!(commits[1].pushed);
}

#[test]
fn ohne_remote_ist_kein_commit_als_nicht_gepusht_markiert() {
    let project = TestProject::with_commit(&[("a.txt", "1\n")]);

    let commits = project.version_control().commits(0, 50).unwrap();

    assert!(commits[0].pushed);
}

#[test]
fn ein_commit_nennt_seine_geaenderten_neuen_geloeschten_und_umbenannten_dateien() {
    let project = TestProject::with_commit(&[
        ("src/main.rs", "fn main() {}\n"),
        ("alt.txt", "weg damit\n"),
        (
            "docs/lang.md",
            "Eine Zeile.\nNoch eine Zeile.\nUnd eine dritte.\n",
        ),
        ("bleibt.txt", "unberührt\n"),
    ]);
    project.write("src/main.rs", "fn main() { run(); }\n");
    project.write("docs/neu ä.md", "# Neu\n");
    project.delete("alt.txt");
    project.git(&["mv", "docs/lang.md", "docs/umbenannt.md"]);
    project.commit_all("Vier Änderungen");
    let vc = project.version_control();
    let head = &vc.commits(0, 1).unwrap()[0].id;

    let files = vc.commit_files(head).unwrap();

    assert_eq!(
        files,
        vec![
            file("alt.txt", FileStatus::Deleted),
            file("docs/neu ä.md", FileStatus::Added),
            CommitFile {
                original_path: Some("docs/lang.md".to_owned()),
                ..file("docs/umbenannt.md", FileStatus::Renamed)
            },
            file("src/main.rs", FileStatus::Modified),
        ]
    );
}

#[test]
fn im_ersten_commit_sind_alle_dateien_neu() {
    let project = TestProject::with_commit(&[("a.txt", "eins\n"), ("b/c.txt", "zwei\n")]);
    let vc = project.version_control();
    let first = &vc.commits(0, 1).unwrap()[0].id;

    assert_eq!(
        vc.commit_files(first).unwrap(),
        vec![
            file("a.txt", FileStatus::Added),
            file("b/c.txt", FileStatus::Added)
        ]
    );
    assert_eq!(
        vc.commit_diff(first, &file("a.txt", FileStatus::Added))
            .unwrap(),
        Diff {
            original: FileContent::Missing,
            modified: text("eins\n"),
        }
    );
}

#[test]
fn eine_zusammenfuehrung_zeigt_was_sie_in_den_branch_gebracht_hat() {
    let project = TestProject::with_commit(&[("a.txt", "eins\n")]);
    project.git(&["switch", "--create", "andere"]);
    commit(
        &project,
        "b.txt",
        "vom anderen Branch\n",
        "Auf dem anderen Branch",
    );
    project.git(&["switch", "main"]);
    commit(&project, "c.txt", "von main\n", "Auf main");
    project.git(&["merge", "--no-ff", "--message", "Zusammenführung", "andere"]);
    let vc = project.version_control();
    let merge = &vc.commits(0, 1).unwrap()[0];
    assert_eq!(merge.message, "Zusammenführung");

    assert_eq!(
        vc.commit_files(&merge.id).unwrap(),
        vec![file("b.txt", FileStatus::Added)]
    );
    assert_eq!(
        vc.commit_diff(&merge.id, &file("b.txt", FileStatus::Added))
            .unwrap(),
        Diff {
            original: FileContent::Missing,
            modified: text("vom anderen Branch\n"),
        }
    );
}

#[test]
fn der_diff_eines_commits_stellt_vorgaenger_und_commit_gegenueber() {
    let project = TestProject::with_commit(&[
        ("a.txt", "eins\n"),
        ("alt.txt", "weg damit\n"),
        (
            "lang.md",
            "Eine Zeile.\nNoch eine Zeile.\nUnd eine dritte.\n",
        ),
    ]);
    project.write("a.txt", "zwei\n");
    project.delete("alt.txt");
    project.git(&["mv", "lang.md", "neu.md"]);
    project.write(
        "neu.md",
        "Eine Zeile.\nNoch eine Zeile.\nUnd eine vierte.\n",
    );
    project.commit_all("Geprüfter Commit");
    // Was danach geschieht, ändert den Diff des Commits nicht.
    commit(&project, "a.txt", "drei\n", "Späterer Commit");
    project.write("a.txt", "vier\n");
    let vc = project.version_control();
    let checked = &vc.commits(1, 1).unwrap()[0].id;

    assert_eq!(
        vc.commit_diff(checked, &file("a.txt", FileStatus::Modified))
            .unwrap(),
        Diff {
            original: text("eins\n"),
            modified: text("zwei\n"),
        }
    );
    assert_eq!(
        vc.commit_diff(checked, &file("alt.txt", FileStatus::Deleted))
            .unwrap(),
        Diff {
            original: text("weg damit\n"),
            modified: FileContent::Missing,
        }
    );
    let renamed = vc
        .commit_files(checked)
        .unwrap()
        .into_iter()
        .find(|file| file.path == "neu.md")
        .unwrap();
    assert_eq!(renamed.original_path.as_deref(), Some("lang.md"));
    assert_eq!(
        vc.commit_diff(checked, &renamed).unwrap(),
        Diff {
            original: text("Eine Zeile.\nNoch eine Zeile.\nUnd eine dritte.\n"),
            modified: text("Eine Zeile.\nNoch eine Zeile.\nUnd eine vierte.\n"),
        }
    );
}

#[test]
fn eine_binaere_datei_eines_commits_wird_nicht_als_text_geliefert() {
    let project = TestProject::with_commit(&[("a.txt", "eins\n")]);
    project.write("bild.bin", [0u8, 159, 146, 150, 0, 1]);
    project.commit_all("Binärdatei");
    let vc = project.version_control();
    let head = &vc.commits(0, 1).unwrap()[0].id;

    let diff = vc
        .commit_diff(head, &file("bild.bin", FileStatus::Added))
        .unwrap();

    assert_eq!(diff.modified, FileContent::Binary);
}

#[test]
fn ein_unterordner_als_projekt_sieht_nur_seine_dateien_eines_commits() {
    let project = TestProject::with_commit(&[("app/a.txt", "eins\n"), ("README.md", "# Kredr\n")]);
    project.write("app/a.txt", "zwei\n");
    project.write("README.md", "# Kredr 2\n");
    project.commit_all("Innen und außen");
    let vc = project.version_control_in("app");
    let commits = vc.commits(0, 50).unwrap();
    assert_eq!(messages(&commits), ["Innen und außen", "Erster Commit"]);

    let files = vc.commit_files(&commits[0].id).unwrap();

    assert_eq!(files, vec![file("a.txt", FileStatus::Modified)]);
    assert_eq!(
        vc.commit_diff(&commits[0].id, &files[0]).unwrap(),
        Diff {
            original: text("eins\n"),
            modified: text("zwei\n"),
        }
    );
}

#[test]
fn als_commit_gilt_nur_eine_kennung() {
    let project = TestProject::with_commit(&[("a.txt", "eins\n")]);
    let vc = project.version_control();

    for commit in ["--output=fremd.txt", "HEAD", "", "main:a.txt"] {
        let error = vc.commit_files(commit).unwrap_err();
        assert_eq!(error.reason, ErrorReason::Failed, "{commit:?}");
        let error = vc
            .commit_diff(commit, &file("a.txt", FileStatus::Modified))
            .unwrap_err();
        assert_eq!(error.reason, ErrorReason::Failed, "{commit:?}");
    }
    assert!(!project.path().join("fremd.txt").exists());
}
