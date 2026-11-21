//! Tests der Branches in der Versionskontrolle gegen echte Repositories:
//! Liste der lokalen und der GitHub-Branches, Wechsel und Anlage. „GitHub“
//! ist hier ein lokales „Remote“-Repository im Testordner.

mod git_support;

use std::sync::mpsc::channel;
use std::time::{Duration, Instant};

use kredr_lib::project_files::ProjectWatcher;
use kredr_lib::version_control::{Branch, ErrorReason};

use git_support::TestProject;

const TIMEOUT: Duration = Duration::from_secs(30);

fn local(name: &str, current: bool) -> Branch {
    Branch {
        name: name.to_owned(),
        remote: None,
        current,
    }
}

fn on_remote(name: &str) -> Branch {
    Branch {
        name: name.to_owned(),
        remote: Some("origin".to_owned()),
        current: false,
    }
}

/// Legt einen Branch an, den es nur auf dem „Remote“ gibt, mit der Datei
/// `file` als eigenem Commit.
fn add_remote_branch(project: &TestProject, name: &str, file: &str) {
    project.git(&["switch", "--create", name]);
    project.write(file, "vom Remote\n");
    project.commit_all("Commit auf dem Remote");
    project.git(&["push", "origin", name]);
    project.git(&["switch", "main"]);
    project.git(&["branch", "--delete", "--force", name]);
}

#[test]
fn die_liste_nennt_lokale_branches_und_die_des_remotes() {
    let project = TestProject::with_commit(&[("a.txt", "eins\n")]);
    project.add_remote();
    project.git(&["branch", "feature/lokal"]);
    add_remote_branch(&project, "nur-remote", "remote.txt");

    let branches = project.version_control().branches().unwrap();

    // Lokale zuerst; `origin/main` fehlt, weil es `main` lokal gibt.
    assert_eq!(
        branches,
        [
            local("feature/lokal", false),
            local("main", true),
            on_remote("nur-remote"),
        ]
    );
}

#[test]
fn der_wechsel_zu_einem_lokalen_branch_tauscht_die_dateien_im_projektordner() {
    let project = TestProject::with_commit(&[("a.txt", "eins\n")]);
    project.git(&["switch", "--create", "andere"]);
    project.write("nur-dort.txt", "dort\n");
    project.commit_all("Commit auf dem anderen Branch");
    project.git(&["switch", "main"]);
    let vc = project.version_control();

    vc.switch_branch(&local("andere", false)).unwrap();

    assert_eq!(vc.state().unwrap().branch.as_deref(), Some("andere"));
    assert!(project.path().join("nur-dort.txt").exists());
    assert_eq!(
        vc.branches().unwrap(),
        [local("andere", true), local("main", false)]
    );
}

#[test]
fn der_wechsel_zu_einem_branch_des_remotes_legt_ihn_lokal_an_und_folgt_ihm() {
    let project = TestProject::with_commit(&[("a.txt", "eins\n")]);
    project.add_remote();
    add_remote_branch(&project, "nur-remote", "remote.txt");
    let vc = project.version_control();

    vc.switch_branch(&on_remote("nur-remote")).unwrap();

    assert_eq!(vc.state().unwrap().branch.as_deref(), Some("nur-remote"));
    assert!(project.path().join("remote.txt").exists());
    let upstream = project.git(&["rev-parse", "--abbrev-ref", "nur-remote@{upstream}"]);
    assert_eq!(upstream.trim(), "origin/nur-remote");
    // Jetzt gibt es ihn lokal; der des Remotes steht nicht mehr eigens da.
    assert_eq!(
        vc.branches().unwrap(),
        [local("nur-remote", true), local("main", false)]
    );
}

#[test]
fn ein_neuer_branch_entsteht_vom_aktuellen_stand_und_ist_sofort_aktiv() {
    let project = TestProject::with_commit(&[("a.txt", "eins\n")]);
    // Noch nicht festgeschriebene Arbeit kommt mit auf den neuen Branch.
    project.write("a.txt", "zwei\n");
    let commit = project.git(&["rev-parse", "HEAD"]);
    let vc = project.version_control();

    vc.create_branch("feature/neu").unwrap();

    let state = vc.state().unwrap();
    assert_eq!(state.branch.as_deref(), Some("feature/neu"));
    assert_eq!(state.commit.as_deref(), Some(commit.trim()));
    assert_eq!(state.files.len(), 1);
    assert_eq!(
        std::fs::read_to_string(project.path().join("a.txt")).unwrap(),
        "zwei\n"
    );
}

#[test]
fn ein_vergebener_oder_ungueltiger_name_legt_keinen_branch_an() {
    let project = TestProject::with_commit(&[("a.txt", "eins\n")]);
    project.git(&["branch", "vorhanden"]);
    let vc = project.version_control();

    let exists = vc.create_branch("vorhanden").unwrap_err();
    assert_eq!(exists.reason, ErrorReason::BranchExists);

    for name in ["mit leerzeichen", "-option", "", "doppel..punkt"] {
        let invalid = vc.create_branch(name).unwrap_err();
        assert_eq!(invalid.reason, ErrorReason::InvalidBranchName, "{name:?}");
    }
    assert_eq!(vc.state().unwrap().branch.as_deref(), Some("main"));
    assert_eq!(vc.branches().unwrap().len(), 2);
}

#[test]
fn lokale_aenderungen_die_der_wechsel_ueberschriebe_verhindern_ihn_und_bleiben_erhalten() {
    let project = TestProject::with_commit(&[("a.txt", "eins\n")]);
    project.git(&["switch", "--create", "andere"]);
    project.write("a.txt", "auf dem anderen Branch\n");
    project.write("neu.txt", "festgeschrieben\n");
    project.commit_all("Commit auf dem anderen Branch");
    project.git(&["switch", "main"]);
    let vc = project.version_control();

    // Eine geänderte Datei, die sich auf dem Ziel unterscheidet.
    project.write("a.txt", "meine Arbeit\n");
    let error = vc.switch_branch(&local("andere", false)).unwrap_err();
    assert_eq!(error.reason, ErrorReason::LocalChangesBlockSwitch);
    assert!(error.details.contains("a.txt"), "{}", error.details);
    assert_eq!(vc.state().unwrap().branch.as_deref(), Some("main"));
    assert_eq!(
        std::fs::read_to_string(project.path().join("a.txt")).unwrap(),
        "meine Arbeit\n"
    );

    // Eine Git unbekannte Datei, die es auf dem Ziel gibt.
    project.git(&["restore", "a.txt"]);
    project.write("neu.txt", "meine neue Datei\n");
    let error = vc.switch_branch(&local("andere", false)).unwrap_err();
    assert_eq!(error.reason, ErrorReason::LocalChangesBlockSwitch);
    assert_eq!(vc.state().unwrap().branch.as_deref(), Some("main"));
    assert_eq!(
        std::fs::read_to_string(project.path().join("neu.txt")).unwrap(),
        "meine neue Datei\n"
    );
}

#[test]
fn lokale_aenderungen_die_den_wechsel_nicht_stoeren_kommen_mit() {
    let project = TestProject::with_commit(&[("a.txt", "eins\n"), ("b.txt", "b\n")]);
    project.git(&["branch", "andere"]);
    project.write("b.txt", "meine Arbeit\n");
    let vc = project.version_control();

    vc.switch_branch(&local("andere", false)).unwrap();

    let state = vc.state().unwrap();
    assert_eq!(state.branch.as_deref(), Some("andere"));
    assert_eq!(state.files.len(), 1);
}

#[test]
fn der_abonnierte_zustand_und_die_projektdateien_folgen_dem_wechsel() {
    let project = TestProject::with_commit(&[("a.txt", "eins\n")]);
    project.git(&["switch", "--create", "andere"]);
    project.write("nur-dort.txt", "dort\n");
    project.commit_all("Commit auf dem anderen Branch");
    project.git(&["switch", "main"]);

    let watcher = ProjectWatcher::start(project.path()).expect("Beobachter sollte starten");
    let (sender, changes) = channel();
    let _changes = watcher.subscribe(move |_| {
        let _ = sender.send(());
    });
    let watch = project.version_control().watch(&watcher);
    let (sender, states) = channel();
    let _states = watch.subscribe(move |state| {
        let _ = sender.send(state.clone());
    });

    project
        .version_control()
        .switch_branch(&local("andere", false))
        .unwrap();

    // Der Explorer und die Dateiansichten hängen am Ereignisstrom der Projektdateien.
    changes
        .recv_timeout(TIMEOUT)
        .expect("Der Wechsel sollte Änderungen an Projektdateien melden");
    let deadline = Instant::now() + TIMEOUT;
    loop {
        let state = states
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("Der Zustand sollte den neuen Branch melden");
        if state.is_ok_and(|state| state.branch.as_deref() == Some("andere")) {
            break;
        }
    }
}
