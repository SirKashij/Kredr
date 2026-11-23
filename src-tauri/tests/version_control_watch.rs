//! Tests des abonnierbaren Zustands der Versionskontrolle: Er folgt echten
//! Änderungen im Projektordner und im Repository von selbst.

mod git_support;

use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

use kredr_lib::project_files::ProjectWatcher;
use kredr_lib::version_control::{
    ErrorReason, FileStatus, RepositoryState, StateResult, StateSubscription, StateWatch,
    VersionControl,
};

use git_support::TestProject;

const TIMEOUT: Duration = Duration::from_secs(30);

/// Ein Abonnent des Zustands, der auf einen bestimmten Zustand warten kann.
struct Subscriber {
    states: Receiver<StateResult>,
    _subscription: StateSubscription,
}

impl Subscriber {
    fn of(watch: &StateWatch) -> Subscriber {
        let (sender, states) = channel();
        let subscription = watch.subscribe(move |state| {
            let _ = sender.send(state.clone());
        });
        Subscriber {
            states,
            _subscription: subscription,
        }
    }

    /// Wartet auf den nächsten gemeldeten Zustand, der `wanted` erfüllt.
    fn wait_for(&self, what: &str, wanted: impl Fn(&StateResult) -> bool) {
        let _ = self.next_matching(what, wanted);
    }

    fn next_matching(&self, what: &str, wanted: impl Fn(&StateResult) -> bool) -> StateResult {
        let deadline = Instant::now() + TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match self.states.recv_timeout(remaining) {
                Ok(state) if wanted(&state) => return state,
                Ok(_) => {}
                Err(_) => panic!("Kein Zustand gemeldet: {what}"),
            }
        }
    }

    fn wait_for_files(&self, what: &str, paths: &[&str]) -> RepositoryState {
        self.next_matching(what, |state| {
            state
                .as_ref()
                .is_ok_and(|state| state.files.iter().map(|file| &file.path).eq(paths.iter()))
        })
        .unwrap()
    }
}

/// Der beobachtete Zustand eines Testprojekts samt dem Beobachter, an dem er hängt.
fn watch(project: &TestProject) -> (ProjectWatcher, StateWatch) {
    let watcher = ProjectWatcher::start(project.path()).expect("Beobachter sollte starten");
    let watch = project.version_control().watch(&watcher);
    (watcher, watch)
}

#[test]
fn der_zustand_folgt_von_selbst_aenderungen_an_dateien_und_commits_im_terminal() {
    let project = TestProject::with_commit(&[("a.txt", "eins\n")]);
    let (_watcher, watch) = watch(&project);
    let subscriber = Subscriber::of(&watch);
    subscriber.wait_for_files("der erste Zustand ohne Änderungen", &[]);

    // Ein Agent ändert eine Datei und legt eine neue an.
    project.write("a.txt", "zwei\n");
    project.write("src/neu.txt", "neu\n");
    let state = subscriber.wait_for_files("beide Änderungen", &["a.txt", "src/neu.txt"]);
    assert_eq!(state.files[0].status, FileStatus::Modified);
    assert_eq!(state.files[1].status, FileStatus::Untracked);

    // Im Terminal wird ausgewählt …
    project.git(&["add", "a.txt"]);
    subscriber.wait_for("die ausgewählte Änderung", |state| {
        state.as_ref().is_ok_and(|state| state.files[0].staged)
    });

    // … und festgeschrieben.
    project.commit_all("Zweiter Commit");
    let state = subscriber.wait_for_files("keine Änderungen nach dem Commit", &[]);
    let head = project.git(&["rev-parse", "HEAD"]);
    assert_eq!(state.commit.as_deref(), Some(head.trim()));
}

#[test]
fn der_zustand_folgt_einem_branch_wechsel() {
    let project = TestProject::with_commit(&[("a.txt", "eins\n")]);
    let (_watcher, watch) = watch(&project);
    let subscriber = Subscriber::of(&watch);

    project.git(&["switch", "--create", "feature"]);

    subscriber.wait_for("der neue Branch", |state| {
        state
            .as_ref()
            .is_ok_and(|state| state.branch.as_deref() == Some("feature"))
    });
}

#[test]
fn ein_spaeterer_abonnent_erhaelt_sofort_den_aktuellen_zustand() {
    let project = TestProject::with_commit(&[("a.txt", "eins\n")]);
    project.write("a.txt", "zwei\n");
    let (_watcher, watch) = watch(&project);
    Subscriber::of(&watch).wait_for_files("der erste Zustand", &["a.txt"]);

    // Etwa der Explorer, der erst später dazukommt.
    let late = Subscriber::of(&watch);

    let state = late
        .states
        .try_recv()
        .expect("Der Zustand sollte schon da sein");
    assert_eq!(state.unwrap().files[0].path, "a.txt");
}

#[test]
fn wird_aus_dem_ordner_ein_repository_folgt_der_zustand() {
    let project = TestProject::without_repository();
    let (_watcher, watch) = watch(&project);
    let subscriber = Subscriber::of(&watch);
    subscriber.wait_for("kein Repository", |state| {
        state
            .as_ref()
            .is_err_and(|error| error.reason == ErrorReason::NotARepository)
    });

    project.git(&["init"]);

    subscriber.wait_for("das neue Repository", |state| {
        state
            .as_ref()
            .is_ok_and(|state| state.branch.as_deref() == Some("main"))
    });
}

/// Ein Unterordner eines Repositorys als Projekt: `.git` liegt über dem
/// Projektordner und damit außerhalb dessen, was sein Beobachter sieht.
fn watch_subfolder(project: &TestProject) -> (ProjectWatcher, StateWatch) {
    let folder = project.path().join("teil");
    let watcher = ProjectWatcher::start(&folder).expect("Beobachter sollte starten");
    let watch = project.version_control_in("teil").watch(&watcher);
    (watcher, watch)
}

#[test]
fn in_einem_unterordner_als_projekt_folgt_der_zustand_den_eigenen_operationen() {
    let project = TestProject::with_commit(&[("teil/a.txt", "eins\n")]);
    project.add_remote();
    let (_watcher, watch) = watch_subfolder(&project);
    let subscriber = Subscriber::of(&watch);
    project.write("teil/a.txt", "zwei\n");
    let state = subscriber.wait_for_files("die Änderung", &["a.txt"]);
    let vc = project.version_control_in("teil");

    vc.stage(&state.files).unwrap();
    let state = subscriber
        .next_matching("die ausgewählte Änderung", |state| {
            state.as_ref().is_ok_and(|state| state.files[0].staged)
        })
        .unwrap();

    vc.unstage(&state.files).unwrap();
    subscriber.wait_for("die abgewählte Änderung", |state| {
        state.as_ref().is_ok_and(|state| !state.files[0].staged)
    });

    vc.commit("Zweiter Commit").unwrap();
    subscriber.wait_for("der Commit, noch nicht gepusht", |state| {
        state
            .as_ref()
            .is_ok_and(|state| state.files.is_empty() && state.ahead == 1)
    });

    vc.push().unwrap();
    subscriber.wait_for("der Push", |state| {
        state.as_ref().is_ok_and(|state| state.ahead == 0)
    });

    project.push_from_elsewhere("teil/fremd.txt", "von anderswo\n");
    vc.fetch().unwrap();
    subscriber.wait_for("der Rückstand nach dem Fetch", |state| {
        state.as_ref().is_ok_and(|state| state.behind == 1)
    });

    vc.pull().unwrap();
    subscriber.wait_for("der Pull", |state| {
        state.as_ref().is_ok_and(|state| state.behind == 0)
    });

    vc.create_branch("feature").unwrap();
    subscriber.wait_for("der neue Branch", |state| {
        state
            .as_ref()
            .is_ok_and(|state| state.branch.as_deref() == Some("feature"))
    });
}

#[test]
fn in_einem_unterordner_als_projekt_folgt_der_zustand_git_im_terminal() {
    let project = TestProject::with_commit(&[("teil/a.txt", "eins\n")]);
    let (_watcher, watch) = watch_subfolder(&project);
    let subscriber = Subscriber::of(&watch);
    subscriber.wait_for_files("der erste Zustand ohne Änderungen", &[]);

    // Ein Agent schreibt im Terminal fest, ohne eine Datei des Projekts zu ändern.
    project.git(&["commit", "--allow-empty", "--message", "Leerer Commit"]);

    let head = project.git(&["rev-parse", "HEAD"]);
    subscriber.wait_for("der neue Commit", |state| {
        state
            .as_ref()
            .is_ok_and(|state| state.commit.as_deref() == Some(head.trim()))
    });
}

#[test]
fn in_einem_weiteren_arbeitsordner_folgt_der_zustand_der_auswahl() {
    let project = TestProject::with_commit(&[("a.txt", "eins\n")]);
    // Der Stand eines weiteren Arbeitsordners liegt im Repository des ersten.
    project.git(&["worktree", "add", "../zweiter", "-b", "zweiter"]);
    let folder = project.path().parent().unwrap().join("zweiter");
    let watcher = ProjectWatcher::start(&folder).expect("Beobachter sollte starten");
    let vc = VersionControl::with_options(&folder, project.git_options());
    let watch = vc.clone().watch(&watcher);
    let subscriber = Subscriber::of(&watch);
    std::fs::write(folder.join("a.txt"), "zwei\n").unwrap();
    let state = subscriber.wait_for_files("die Änderung", &["a.txt"]);

    vc.stage(&state.files).unwrap();

    subscriber.wait_for("die ausgewählte Änderung", |state| {
        state.as_ref().is_ok_and(|state| state.files[0].staged)
    });
}

#[test]
fn der_ereignisstrom_meldet_git_ueber_dem_projektordner_wie_eines_darin() {
    let project = TestProject::with_commit(&[("teil/a.txt", "eins\n")]);
    let (watcher, _watch) = watch_subfolder(&project);
    let (sender, changes) = channel();
    let _subscription = watcher.subscribe(move |changes| {
        let _ = sender.send(changes.clone());
    });

    project.git(&["switch", "--create", "feature"]);

    // Diff und Verlauf der Oberfläche lesen neu, sobald sich `.git/` ändert.
    let deadline = Instant::now() + TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let changes = changes
            .recv_timeout(remaining)
            .expect("Die Änderung in Git sollte gemeldet werden");
        assert!(!changes.rescan, "Git ist kein Anlass, alles neu zu lesen");
        if changes.paths.contains(&".git/HEAD".to_owned()) {
            break;
        }
    }
}

#[test]
fn nach_dem_ende_des_abonnements_kommt_nichts_mehr() {
    let project = TestProject::with_commit(&[("a.txt", "eins\n")]);
    let (_watcher, watch) = watch(&project);
    let Subscriber {
        states,
        _subscription: subscription,
    } = Subscriber::of(&watch);
    // Ein zweiter Abonnent zeigt, wann die Änderung verarbeitet ist.
    let other = Subscriber::of(&watch);
    other.wait_for_files("der erste Zustand", &[]);

    drop(subscription);
    // Die Abonnenten werden in keiner festen Reihenfolge benachrichtigt: Der
    // erste Zustand kann hier noch nach `other` eintreffen. Nach dem Ende des
    // Abonnements ist alles Frühere zugestellt.
    while states.try_recv().is_ok() {}
    project.write("a.txt", "zwei\n");
    other.wait_for_files("die Änderung", &["a.txt"]);
    // Ein weiteres Abonnieren wartet, bis alle Abonnenten die Änderung haben.
    drop(watch.subscribe(|_| {}));

    assert!(states.try_recv().is_err());
}
