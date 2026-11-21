//! Tests für Festschreiben und Abgleichen: Auswählen, Verwerfen, Commit,
//! Push, Pull, „Commit & Push“ und „Erst holen, dann pushen“ gegen echte
//! Repositories mit einem lokalen „Remote“ im Testordner. Kein Test berührt
//! ein Netzwerk-Remote oder die Anmeldung des Rechners.

mod git_support;

use std::path::Path;
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

use kredr_lib::project_files::ProjectWatcher;
use kredr_lib::version_control::{
    ChangedFile, ErrorReason, FileStatus, GitOptions, RepositoryState, StateResult, VersionControl,
};

use git_support::TestProject;

/// Die Änderung an `path` im Abschnitt „ausgewählt“ bzw. „nicht ausgewählt“.
fn change(project: &TestProject, path: &str, staged: bool) -> ChangedFile {
    let state = project.version_control().state().unwrap();
    state
        .files
        .into_iter()
        .find(|file| file.path == path && file.staged == staged)
        .unwrap_or_else(|| panic!("Keine Änderung an {path} (ausgewählt: {staged})"))
}

/// Die Änderungen als (Pfad, ausgewählt), wie sie die Liste trennt.
fn listed(project: &TestProject) -> Vec<(String, bool)> {
    let state = project.version_control().state().unwrap();
    state
        .files
        .into_iter()
        .map(|file| (file.path, file.staged))
        .collect()
}

fn state(project: &TestProject) -> RepositoryState {
    project.version_control().state().unwrap()
}

fn read(project: &TestProject, path: &str) -> String {
    std::fs::read_to_string(project.path().join(path)).unwrap()
}

/// Der Commit, auf dem ein Branch des „Remote“ steht.
fn remote_commit(project: &TestProject, remote: &Path, branch: &str) -> String {
    project
        .git_at(remote, &["rev-parse", branch])
        .trim()
        .to_owned()
}

fn head(project: &TestProject) -> String {
    project.git(&["rev-parse", "HEAD"]).trim().to_owned()
}

/// Ein Projekt mit einem Commit, der bereits im „Remote“ liegt.
fn pushed_project() -> (TestProject, std::path::PathBuf) {
    let project = TestProject::with_commit(&[("a.txt", "eins\n")]);
    let remote = project.add_remote();
    (project, remote)
}

// Auswählen und Abwählen

#[test]
fn eine_einzelne_datei_laesst_sich_auswaehlen_und_wieder_abwaehlen() {
    let project = TestProject::with_commit(&[("a.txt", "eins\n"), ("b.txt", "eins\n")]);
    project.write("a.txt", "zwei\n");
    project.write("b.txt", "zwei\n");
    let vc = project.version_control();

    vc.stage(&[change(&project, "a.txt", false)]).unwrap();

    assert_eq!(
        listed(&project),
        [("a.txt".to_owned(), true), ("b.txt".to_owned(), false)]
    );

    vc.unstage(&[change(&project, "a.txt", true)]).unwrap();

    assert_eq!(
        listed(&project),
        [("a.txt".to_owned(), false), ("b.txt".to_owned(), false)]
    );
    assert_eq!(read(&project, "a.txt"), "zwei\n");
}

#[test]
fn alle_aenderungen_lassen_sich_auswaehlen_und_wieder_abwaehlen() {
    let project = TestProject::with_commit(&[("a.txt", "eins\n"), ("weg.txt", "eins\n")]);
    project.write("a.txt", "zwei\n");
    project.write("src/neu.txt", "neu\n");
    project.delete("weg.txt");
    let vc = project.version_control();

    vc.stage_all().unwrap();

    let files = state(&project).files;
    assert_eq!(files.len(), 3);
    assert!(files.iter().all(|file| file.staged));

    vc.unstage_all().unwrap();

    let files = state(&project).files;
    assert_eq!(files.len(), 3);
    assert!(files.iter().all(|file| !file.staged));
}

#[test]
fn neue_und_geloeschte_dateien_lassen_sich_einzeln_auswaehlen() {
    let project = TestProject::with_commit(&[("weg.txt", "eins\n")]);
    project.write("neu.txt", "neu\n");
    project.delete("weg.txt");
    let vc = project.version_control();

    vc.stage(&[
        change(&project, "neu.txt", false),
        change(&project, "weg.txt", false),
    ])
    .unwrap();

    let files = state(&project).files;
    assert_eq!(files.len(), 2);
    assert_eq!(files[0].status, FileStatus::Added);
    assert_eq!(files[1].status, FileStatus::Deleted);
    assert!(files.iter().all(|file| file.staged));
}

#[test]
fn ein_pfad_mit_musterzeichen_meint_nur_genau_diese_datei() {
    let project = TestProject::with_commit(&[("a.txt", "eins\n"), ("[a].txt", "eins\n")]);
    project.write("a.txt", "zwei\n");
    project.write("[a].txt", "zwei\n");

    project
        .version_control()
        .stage(&[change(&project, "[a].txt", false)])
        .unwrap();

    assert_eq!(
        listed(&project),
        [("[a].txt".to_owned(), true), ("a.txt".to_owned(), false)]
    );
}

#[test]
fn eine_ausgewaehlte_umbenennung_laesst_sich_abwaehlen() {
    let project = TestProject::with_commit(&[("alt.txt", "ein langer Inhalt\n")]);
    project.git(&["mv", "alt.txt", "neu.txt"]);
    let renamed = change(&project, "neu.txt", true);
    assert_eq!(renamed.status, FileStatus::Renamed);

    project.version_control().unstage(&[renamed]).unwrap();

    assert!(state(&project).files.iter().all(|file| !file.staged));
}

#[test]
fn vor_dem_ersten_commit_laesst_sich_auswaehlen_und_abwaehlen() {
    let project = TestProject::with_repository();
    project.write("a.txt", "eins\n");
    let vc = project.version_control();

    vc.stage_all().unwrap();
    assert_eq!(listed(&project), [("a.txt".to_owned(), true)]);

    vc.unstage(&[change(&project, "a.txt", true)]).unwrap();
    assert_eq!(listed(&project), [("a.txt".to_owned(), false)]);
}

// Verwerfen

#[test]
fn verwerfen_stellt_eine_geaenderte_datei_wieder_her_und_laesst_andere_in_ruhe() {
    let project = TestProject::with_commit(&[("a.txt", "eins\n"), ("b.txt", "eins\n")]);
    project.write("a.txt", "zwei\n");
    project.write("b.txt", "zwei\n");

    project
        .version_control()
        .discard(&change(&project, "a.txt", false))
        .unwrap();

    assert_eq!(read(&project, "a.txt"), "eins\n");
    assert_eq!(listed(&project), [("b.txt".to_owned(), false)]);
    assert_eq!(read(&project, "b.txt"), "zwei\n");
}

#[test]
fn verwerfen_holt_eine_geloeschte_datei_zurueck() {
    let project = TestProject::with_commit(&[("a.txt", "eins\n")]);
    project.delete("a.txt");

    project
        .version_control()
        .discard(&change(&project, "a.txt", false))
        .unwrap();

    assert_eq!(read(&project, "a.txt"), "eins\n");
    assert_eq!(state(&project).files, vec![]);
}

#[test]
fn verwerfen_entfernt_eine_datei_die_git_noch_nicht_kennt() {
    let project = TestProject::with_commit(&[("a.txt", "eins\n")]);
    project.write("neu.txt", "neu\n");

    project
        .version_control()
        .discard(&change(&project, "neu.txt", false))
        .unwrap();

    assert!(!project.path().join("neu.txt").exists());
    assert_eq!(state(&project).files, vec![]);
}

#[test]
fn verwerfen_laesst_den_ausgewaehlten_teil_einer_datei_bestehen() {
    let project = TestProject::with_commit(&[("a.txt", "eins\n")]);
    project.write("a.txt", "zwei\n");
    project.git(&["add", "a.txt"]);
    project.write("a.txt", "drei\n");

    project
        .version_control()
        .discard(&change(&project, "a.txt", false))
        .unwrap();

    assert_eq!(read(&project, "a.txt"), "zwei\n");
    assert_eq!(listed(&project), [("a.txt".to_owned(), true)]);
}

// Commit

#[test]
fn ohne_auswahl_schreibt_ein_commit_alle_aenderungen_fest() {
    let project = TestProject::with_commit(&[("a.txt", "eins\n"), ("weg.txt", "eins\n")]);
    project.write("a.txt", "zwei\n");
    project.write("src/neu.txt", "neu\n");
    project.delete("weg.txt");
    let before = head(&project);

    project.version_control().commit("Alles").unwrap();

    assert_eq!(state(&project).files, vec![]);
    assert_ne!(head(&project), before);
    let committed = project.git(&["show", "--name-only", "--format=", "HEAD"]);
    let mut committed: Vec<&str> = committed.lines().collect();
    committed.sort();
    assert_eq!(committed, ["a.txt", "src/neu.txt", "weg.txt"]);
}

#[test]
fn mit_auswahl_schreibt_ein_commit_nur_die_ausgewaehlten_aenderungen_fest() {
    let project = TestProject::with_commit(&[("a.txt", "eins\n"), ("b.txt", "eins\n")]);
    project.write("a.txt", "zwei\n");
    project.write("b.txt", "zwei\n");
    let vc = project.version_control();
    vc.stage(&[change(&project, "a.txt", false)]).unwrap();

    vc.commit("Nur a").unwrap();

    assert_eq!(listed(&project), [("b.txt".to_owned(), false)]);
    let committed = project.git(&["show", "--name-only", "--format=", "HEAD"]);
    assert_eq!(committed.trim(), "a.txt");
}

#[test]
fn der_commit_traegt_die_eingegebene_nachricht() {
    let project = TestProject::with_commit(&[("a.txt", "eins\n")]);
    project.write("a.txt", "zwei\n");

    project
        .version_control()
        .commit("Änderung an „a“\n\nMit einer zweiten Zeile.")
        .unwrap();

    let message = project.git(&["log", "-1", "--format=%B"]);
    assert_eq!(
        message.trim(),
        "Änderung an „a“\n\nMit einer zweiten Zeile."
    );
}

#[test]
fn lehnt_ein_hook_den_commit_ab_nennt_der_fehler_dessen_meldung() {
    let project = TestProject::with_commit(&[("a.txt", "eins\n")]);
    project.write("a.txt", "zwei\n");
    let hook = project.path().join(".git/hooks/pre-commit");
    std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
    std::fs::write(hook, "#!/bin/sh\necho Pruefung gescheitert\nexit 1\n").unwrap();
    let before = head(&project);

    let error = project.version_control().commit("Abgelehnt").unwrap_err();

    assert_eq!(error.reason, ErrorReason::Failed);
    assert!(
        error.details.contains("Pruefung gescheitert"),
        "{}",
        error.details
    );
    assert_eq!(head(&project), before);
}

// Vorsprung und Rückstand

#[test]
fn der_zustand_nennt_vorsprung_und_rueckstand_gegenueber_dem_gegenstueck() {
    let (project, _remote) = pushed_project();
    let vc = project.version_control();
    let state = vc.state().unwrap();
    assert_eq!(state.upstream.as_deref(), Some("origin/main"));
    assert_eq!((state.ahead, state.behind), (0, 0));

    project.write("a.txt", "zwei\n");
    project.commit_all("Lokal 1");
    project.write("a.txt", "drei\n");
    project.commit_all("Lokal 2");
    project.push_from_elsewhere("b.txt", "anderswo\n");
    // Den Rückstand kennt Git erst nach dem Abfragen.
    assert_eq!(vc.state().unwrap().behind, 0);
    vc.fetch().unwrap();

    let state = vc.state().unwrap();
    assert_eq!((state.ahead, state.behind), (2, 1));
    // Abfragen verändert weder Branch noch Dateien.
    assert!(!project.path().join("b.txt").exists());
}

#[test]
fn ein_branch_ohne_gegenstueck_hat_weder_vorsprung_noch_rueckstand() {
    let project = TestProject::with_commit(&[("a.txt", "eins\n")]);

    let state = state(&project);

    assert_eq!(state.upstream, None);
    assert_eq!((state.ahead, state.behind), (0, 0));
}

// Push und Pull

#[test]
fn push_bringt_die_commits_zum_gegenstueck() {
    let (project, remote) = pushed_project();
    project.write("a.txt", "zwei\n");
    project.commit_all("Lokal");
    assert_eq!(state(&project).ahead, 1);

    project.version_control().push().unwrap();

    assert_eq!(remote_commit(&project, &remote, "main"), head(&project));
    assert_eq!(state(&project).ahead, 0);
}

#[test]
fn der_erste_push_legt_den_branch_beim_gegenstueck_an() {
    let (project, remote) = pushed_project();
    project.git(&["switch", "--create", "feature/neu"]);
    project.write("a.txt", "zwei\n");
    project.commit_all("Auf dem neuen Branch");
    assert_eq!(state(&project).upstream, None);

    project.version_control().push().unwrap();

    assert_eq!(
        remote_commit(&project, &remote, "feature/neu"),
        head(&project)
    );
    let state = state(&project);
    assert_eq!(state.upstream.as_deref(), Some("origin/feature/neu"));
    assert_eq!((state.ahead, state.behind), (0, 0));
}

#[test]
fn ohne_gegenstueck_scheitert_der_push_mit_genau_diesem_grund() {
    let project = TestProject::with_commit(&[("a.txt", "eins\n")]);

    let error = project.version_control().push().unwrap_err();

    assert_eq!(error.reason, ErrorReason::NoRemote);
}

#[test]
fn ein_nicht_erreichbares_gegenstueck_wird_als_solches_gemeldet() {
    let (project, remote) = pushed_project();
    std::fs::remove_dir_all(&remote).unwrap();
    project.write("a.txt", "zwei\n");
    project.commit_all("Lokal");
    let vc = project.version_control();

    assert_eq!(vc.push().unwrap_err().reason, ErrorReason::Unreachable);
    assert_eq!(vc.fetch().unwrap_err().reason, ErrorReason::Unreachable);
}

#[test]
fn hat_das_gegenstueck_neuere_commits_wird_der_push_abgelehnt() {
    let (project, remote) = pushed_project();
    project.push_from_elsewhere("b.txt", "anderswo\n");
    let theirs = remote_commit(&project, &remote, "main");
    project.write("a.txt", "zwei\n");
    project.commit_all("Lokal");

    let error = project.version_control().push().unwrap_err();

    assert_eq!(error.reason, ErrorReason::PushRejected);
    assert!(error.details.contains("rejected"), "{}", error.details);
    assert_eq!(remote_commit(&project, &remote, "main"), theirs);
}

#[test]
fn pull_holt_die_neueren_commits_in_den_projektordner() {
    let (project, _remote) = pushed_project();
    project.push_from_elsewhere("b.txt", "anderswo\n");

    project.version_control().pull().unwrap();

    assert_eq!(read(&project, "b.txt"), "anderswo\n");
    let state = state(&project);
    assert_eq!((state.ahead, state.behind), (0, 0));
    assert_eq!(state.files, vec![]);
}

#[test]
fn pull_fuehrt_auseinandergelaufene_branches_zusammen() {
    let (project, _remote) = pushed_project();
    project.push_from_elsewhere("b.txt", "anderswo\n");
    project.write("a.txt", "zwei\n");
    project.commit_all("Lokal");

    project.version_control().pull().unwrap();

    assert_eq!(read(&project, "a.txt"), "zwei\n");
    assert_eq!(read(&project, "b.txt"), "anderswo\n");
    let state = state(&project);
    assert_eq!(state.behind, 0);
    assert_eq!(state.files, vec![]);
}

#[test]
fn pull_haelt_sich_an_die_festlegung_des_nutzers() {
    let (project, _remote) = pushed_project();
    project.git(&["config", "pull.rebase", "true"]);
    project.push_from_elsewhere("b.txt", "anderswo\n");
    project.write("a.txt", "zwei\n");
    project.commit_all("Lokal");

    project.version_control().pull().unwrap();

    // Umgesetzt statt zusammengeführt: Der letzte Commit hat einen Vorgänger.
    let parents = project.git(&["log", "-1", "--format=%P"]);
    assert_eq!(parents.split_whitespace().count(), 1);
    assert_eq!(read(&project, "b.txt"), "anderswo\n");
    assert_eq!(state(&project).ahead, 1);
}

#[test]
fn ein_pull_mit_konflikt_meldet_den_konflikt_und_die_betroffene_datei() {
    let (project, _remote) = pushed_project();
    project.push_from_elsewhere("a.txt", "anderswo\n");
    project.write("a.txt", "lokal\n");
    project.commit_all("Lokal");

    let error = project.version_control().pull().unwrap_err();

    assert_eq!(error.reason, ErrorReason::Conflict);
    assert!(error.details.contains("a.txt"), "{}", error.details);
    let files = state(&project).files;
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].status, FileStatus::Conflicted);
}

// „Commit & Push“ und „Erst holen, dann pushen“

#[test]
fn commit_und_push_schreibt_fest_und_pusht_in_einem_schritt() {
    let (project, remote) = pushed_project();
    project.write("a.txt", "zwei\n");
    project.write("neu.txt", "neu\n");
    let before = head(&project);

    let committed = project.version_control().commit_and_push("Beides").unwrap();

    assert_eq!(committed.push_error, None);
    assert_ne!(head(&project), before);
    assert_eq!(remote_commit(&project, &remote, "main"), head(&project));
    let state = state(&project);
    assert_eq!(state.files, vec![]);
    assert_eq!(state.ahead, 0);
}

#[test]
fn commit_und_push_legt_einen_neuen_branch_beim_gegenstueck_an() {
    let (project, remote) = pushed_project();
    project.git(&["switch", "--create", "feature"]);
    project.write("a.txt", "zwei\n");

    let committed = project.version_control().commit_and_push("Neu").unwrap();

    assert_eq!(committed.push_error, None);
    assert_eq!(remote_commit(&project, &remote, "feature"), head(&project));
}

#[test]
fn wird_der_push_abgelehnt_bleibt_der_commit_und_das_ergebnis_nennt_den_grund() {
    let (project, remote) = pushed_project();
    project.push_from_elsewhere("b.txt", "anderswo\n");
    let theirs = remote_commit(&project, &remote, "main");
    project.write("a.txt", "zwei\n");

    let committed = project.version_control().commit_and_push("Lokal").unwrap();

    let error = committed.push_error.expect("Der Push sollte scheitern");
    assert_eq!(error.reason, ErrorReason::PushRejected);
    assert_eq!(remote_commit(&project, &remote, "main"), theirs);
    let state = state(&project);
    assert_eq!(state.files, vec![]);
    assert_eq!(state.ahead, 1);
}

#[test]
fn scheitert_der_commit_wird_nicht_gepusht() {
    let (project, remote) = pushed_project();
    // Ein früherer Commit wartet noch auf den Push; jetzt gibt es nichts festzuschreiben.
    project.write("a.txt", "zwei\n");
    project.commit_all("Lokal");
    let before = remote_commit(&project, &remote, "main");

    let error = project
        .version_control()
        .commit_and_push("Nichts")
        .unwrap_err();

    assert_eq!(error.reason, ErrorReason::Failed);
    assert!(
        error.details.contains("nothing to commit"),
        "{}",
        error.details
    );
    assert_eq!(remote_commit(&project, &remote, "main"), before);
}

#[test]
fn erst_holen_dann_pushen_loest_den_abgelehnten_push() {
    let (project, remote) = pushed_project();
    project.push_from_elsewhere("b.txt", "anderswo\n");
    let theirs = remote_commit(&project, &remote, "main");
    project.write("a.txt", "zwei\n");
    let vc = project.version_control();
    let rejected = vc.commit_and_push("Lokal").unwrap().push_error;
    assert_eq!(
        rejected.map(|error| error.reason),
        Some(ErrorReason::PushRejected)
    );

    vc.pull_and_push().unwrap();

    assert_eq!(remote_commit(&project, &remote, "main"), head(&project));
    let state = state(&project);
    assert_eq!((state.ahead, state.behind), (0, 0));
    // Beide Seiten sind enthalten: der fremde Commit und die eigene Änderung.
    project.git(&["merge-base", "--is-ancestor", &theirs, "HEAD"]);
    assert_eq!(read(&project, "a.txt"), "zwei\n");
    assert_eq!(read(&project, "b.txt"), "anderswo\n");
}

#[test]
fn erst_holen_dann_pushen_pusht_nicht_wenn_das_holen_im_konflikt_endet() {
    let (project, remote) = pushed_project();
    project.push_from_elsewhere("a.txt", "anderswo\n");
    let theirs = remote_commit(&project, &remote, "main");
    project.write("a.txt", "lokal\n");
    project.commit_all("Lokal");

    let error = project.version_control().pull_and_push().unwrap_err();

    assert_eq!(error.reason, ErrorReason::Conflict);
    assert_eq!(remote_commit(&project, &remote, "main"), theirs);
}

// Keine Rückfragen, längere Zeitgrenze

/// Ein „Git“, das den Befehl `befehl` erst nach `seconds` Sekunden an das
/// echte Git weiterreicht und alle anderen sofort.
fn git_with_slow(project: &TestProject, command: &str, seconds: u32) -> std::ffi::OsString {
    let wrapper = project.path().with_file_name("langsam.cmd");
    let script = format!(
        "@if \"%1\"==\"{command}\" ping -n {} 127.0.0.1 >nul\r\n@git %*\r\n",
        seconds + 1
    );
    std::fs::write(&wrapper, script).unwrap();
    wrapper.into()
}

#[test]
fn der_abgleich_darf_laenger_dauern_als_ein_lesender_aufruf() {
    let (project, _remote) = pushed_project();
    project.push_from_elsewhere("b.txt", "anderswo\n");
    let options = GitOptions {
        program: git_with_slow(&project, "fetch", 6),
        timeout: Duration::from_secs(3),
        long_timeout: Duration::from_secs(60),
        ..project.git_options()
    };
    let vc = VersionControl::with_options(project.path(), options);

    vc.fetch().unwrap();

    assert_eq!(vc.state().unwrap().behind, 1);
}

#[test]
fn ein_abgleich_der_haengt_endet_an_seiner_zeitgrenze() {
    let (project, _remote) = pushed_project();
    let options = GitOptions {
        program: git_with_slow(&project, "fetch", 60),
        long_timeout: Duration::from_millis(500),
        ..project.git_options()
    };
    let started = Instant::now();

    let error = VersionControl::with_options(project.path(), options)
        .fetch()
        .unwrap_err();

    assert_eq!(error.reason, ErrorReason::TimedOut);
    assert!(started.elapsed() < Duration::from_secs(20));
}

#[test]
fn braucht_der_abgleich_eine_anmeldung_scheitert_er_ohne_rueckfrage() {
    // Ein „Server“ auf diesem Rechner, der für alles eine Anmeldung verlangt.
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            let header = "WWW-Authenticate: Basic realm=\"kredr-test\""
                .parse::<tiny_http::Header>()
                .unwrap();
            let response = tiny_http::Response::empty(401).with_header(header);
            let _ = request.respond(response);
        }
    });
    let project = TestProject::with_commit(&[("a.txt", "eins\n")]);
    let url = format!("http://127.0.0.1:{port}/repo.git");
    project.git(&["remote", "add", "origin", &url]);
    // Ein Abfrageprogramm, wie es Git und SSH für Rückfragen starten würden.
    let asked = project.path().with_file_name("gefragt.txt");
    let askpass = project.path().with_file_name("askpass");
    let script = format!(
        "#!/bin/sh\necho gefragt > '{}'\necho geheim\n",
        asked.to_string_lossy().replace('\\', "/")
    );
    std::fs::write(&askpass, script).unwrap();
    let askpass = askpass.to_string_lossy().replace('\\', "/");
    project.git(&["config", "core.askPass", &askpass]);
    let mut options = project.git_options();
    options.env.push(("SSH_ASKPASS".into(), askpass.into()));
    options.env.push(("NO_PROXY".into(), "127.0.0.1".into()));
    let vc = VersionControl::with_options(project.path(), options);
    let started = Instant::now();

    let fetch = vc.fetch().unwrap_err();
    let push = vc.push().unwrap_err();

    assert_eq!(fetch.reason, ErrorReason::AuthenticationRequired, "{fetch}");
    assert_eq!(push.reason, ErrorReason::AuthenticationRequired, "{push}");
    assert!(!asked.exists(), "Git hat nach Zugangsdaten gefragt");
    assert!(started.elapsed() < Duration::from_secs(20));
}

// Regelmäßiges Abfragen im Hintergrund

/// Sammelt die Zustände, die ein Abonnent erhält.
fn subscribe(
    watch: &kredr_lib::version_control::StateWatch,
) -> (
    Receiver<StateResult>,
    kredr_lib::version_control::StateSubscription,
) {
    let (sender, states) = channel();
    let subscription = watch.subscribe(move |state| {
        let _ = sender.send(state.clone());
    });
    (states, subscription)
}

fn wait_for(states: &Receiver<StateResult>, what: &str, wanted: impl Fn(&RepositoryState) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match states.recv_timeout(remaining) {
            Ok(Ok(state)) if wanted(&state) => return,
            Ok(Ok(_)) => {}
            Ok(Err(error)) => panic!("Der Zustand meldet einen Fehler: {error}"),
            Err(_) => panic!("Kein Zustand gemeldet: {what}"),
        }
    }
}

#[test]
fn das_abfragen_im_hintergrund_macht_neuere_commits_von_selbst_sichtbar() {
    let (project, _remote) = pushed_project();
    let watcher = ProjectWatcher::start(project.path()).unwrap();
    let watch = project.version_control().watch(&watcher);
    let (states, _subscription) = subscribe(&watch);
    wait_for(&states, "der erste Zustand", |state| state.behind == 0);
    let _fetching = project
        .version_control()
        .fetch_regularly(Duration::from_millis(300));

    project.push_from_elsewhere("b.txt", "anderswo\n");

    wait_for(&states, "der Rückstand", |state| state.behind == 1);
}

#[test]
fn das_abfragen_im_hintergrund_loest_sich_nicht_selbst_erneut_aus() {
    let (project, _remote) = pushed_project();
    project.push_from_elsewhere("b.txt", "anderswo\n");
    // Ein „Git“, das jedes Abfragen des Gegenstücks mitschreibt.
    let log = project.path().with_file_name("abfragen.txt");
    let wrapper = project.path().with_file_name("zaehlt.cmd");
    let script = format!(
        "@if \"%1\"==\"fetch\" echo fetch>>\"{}\"\r\n@git %*\r\n",
        log.display()
    );
    std::fs::write(&wrapper, script).unwrap();
    let options = GitOptions {
        program: wrapper.into(),
        ..project.git_options()
    };
    let vc = VersionControl::with_options(project.path(), options);
    let watcher = ProjectWatcher::start(project.path()).unwrap();
    let watch = vc.clone().watch(&watcher);
    let (states, _subscription) = subscribe(&watch);

    let _fetching = vc.fetch_regularly(Duration::from_secs(3600));

    // Das Abfragen schreibt ins Repository, der Zustand liest daraufhin neu …
    wait_for(&states, "der Rückstand", |state| state.behind == 1);
    std::thread::sleep(Duration::from_secs(2));
    // … aber das Lesen stößt kein weiteres Abfragen an.
    let fetches = std::fs::read_to_string(&log).unwrap();
    assert_eq!(fetches.lines().count(), 1);
}

#[test]
fn scheitert_das_abfragen_im_hintergrund_bleibt_der_zustand_ohne_fehler() {
    let (project, remote) = pushed_project();
    std::fs::remove_dir_all(&remote).unwrap();
    let watcher = ProjectWatcher::start(project.path()).unwrap();
    let watch = project.version_control().watch(&watcher);
    let (states, _subscription) = subscribe(&watch);
    let _fetching = project
        .version_control()
        .fetch_regularly(Duration::from_millis(200));

    std::thread::sleep(Duration::from_secs(2));
    project.write("a.txt", "zwei\n");

    // Der Zustand folgt weiter dem Projekt und meldet keinen Fehler.
    wait_for(&states, "die Änderung", |state| state.files.len() == 1);
    let later: Vec<StateResult> = states.try_iter().collect();
    assert!(later.iter().all(|state| state.is_ok()));
}
