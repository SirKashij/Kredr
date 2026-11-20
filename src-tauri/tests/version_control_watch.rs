//! Tests des abonnierbaren Zustands der Versionskontrolle: Er folgt echten
//! Änderungen im Projektordner und im Repository von selbst.

mod git_support;

use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

use kredr_lib::project_files::ProjectWatcher;
use kredr_lib::version_control::{
    ErrorReason, FileStatus, RepositoryState, StateResult, StateSubscription, StateWatch,
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
    while states.try_recv().is_ok() {}

    drop(subscription);
    project.write("a.txt", "zwei\n");
    other.wait_for_files("die Änderung", &["a.txt"]);

    assert!(states.try_recv().is_err());
}
