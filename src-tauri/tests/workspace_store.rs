//! Tests des Aufteilungsspeichers für Workspaces über seine öffentliche
//! Schnittstelle, gegen echte Dateien in temporären Ordnern.

use std::path::{Path, PathBuf};

use kredr_lib::arrangement_store::{ArrangementStore, ProjectState, WorkspaceState};
use kredr_lib::window_geometry::WindowGeometry;
use serde_json::json;

/// Ein leerer Ordner unterhalb des temporären Verzeichnisses.
fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("kredr-test-workspace-{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("Testordner sollte anlegbar sein");
    dir
}

/// Legt unterhalb von `root` einen Ordner an, der als Projekt dient.
fn project(root: &Path, name: &str) -> PathBuf {
    let dir = root.join(name);
    std::fs::create_dir_all(&dir).expect("Projektordner sollte anlegbar sein");
    dir
}

fn arrangement(tab: &str) -> serde_json::Value {
    json!({
        "version": 1,
        "root": { "kind": "group", "id": "g2", "tabs": [{ "id": tab, "name": "Server" }], "activeTab": tab },
        "focusedGroup": "g2",
        "nextId": 3
    })
}

fn geometry(x: i32) -> WindowGeometry {
    WindowGeometry {
        x,
        y: 80,
        width: 1400,
        height: 900,
        maximized: false,
    }
}

fn workspace(name: &str, projects: &[&Path], tab: &str) -> WorkspaceState {
    WorkspaceState {
        name: name.to_string(),
        projects: projects.iter().map(|folder| folder.to_path_buf()).collect(),
        arrangement: Some(arrangement(tab)),
        window: Some(geometry(40)),
    }
}

#[test]
fn ein_workspace_uebersteht_samt_aufteilung_einen_neustart() {
    let root = temp_dir("neustart");
    let data = root.join("daten");
    let alpha = project(&root, "alpha");
    let beta = project(&root, "beta");
    let saved = workspace("Unbenannt", &[&alpha, &beta], "t1");

    ArrangementStore::new(&data)
        .save_workspace_state("ws-1", &saved)
        .unwrap();

    // Ein neuer Speicher über demselben Ordner entspricht einem Neustart von Kredr.
    let reopened = ArrangementStore::new(&data);
    assert_eq!(reopened.workspace_state("ws-1"), Some(saved));
    assert_eq!(reopened.workspace_state("ws-2"), None);
}

#[test]
fn jeder_workspace_hat_seine_eigene_aufteilung() {
    let root = temp_dir("je-workspace");
    let alpha = project(&root, "alpha");
    let beta = project(&root, "beta");
    let store = ArrangementStore::new(root.join("daten"));

    store
        .save_workspace_state("ws-1", &workspace("Eins", &[&alpha, &beta], "t1"))
        .unwrap();
    store
        .save_workspace_state("ws-2", &workspace("Zwei", &[&beta, &alpha], "t2"))
        .unwrap();
    store
        .save_workspace_state("ws-1", &workspace("Eins", &[&alpha, &beta], "t3"))
        .unwrap();

    assert_eq!(
        store.workspace_state("ws-1"),
        Some(workspace("Eins", &[&alpha, &beta], "t3"))
    );
    assert_eq!(
        store.workspace_state("ws-2"),
        Some(workspace("Zwei", &[&beta, &alpha], "t2"))
    );
}

#[test]
fn die_aufteilung_eines_projekts_bleibt_neben_seinem_workspace_unberuehrt() {
    let root = temp_dir("projekt-bleibt");
    let data = root.join("daten");
    let alpha = project(&root, "alpha");
    let beta = project(&root, "beta");
    let alone = ProjectState {
        arrangement: Some(arrangement("t7")),
        window: Some(geometry(10)),
    };
    let store = ArrangementStore::new(&data);
    store.remember_project(&alpha).unwrap();
    store.save_project_state(&alpha, &alone).unwrap();

    store
        .save_workspace_state("ws-1", &workspace("Unbenannt", &[&alpha, &beta], "t1"))
        .unwrap();

    let reopened = ArrangementStore::new(&data);
    assert_eq!(reopened.project_state(&alpha), alone);
    assert_eq!(reopened.project_state(&beta), ProjectState::default());
    assert_eq!(reopened.recent_projects().len(), 1);
}

#[test]
fn daten_aus_der_zeit_vor_workspaces_bleiben_lesbar() {
    let root = temp_dir("alt");
    let data = root.join("daten");
    let alpha = project(&root, "alpha");
    std::fs::create_dir_all(&data).unwrap();
    let path = alpha.to_str().unwrap().replace('\\', "\\\\");
    std::fs::write(
        data.join("projects.json"),
        format!("{{ \"version\": 1, \"projects\": [{{ \"path\": \"{path}\" }}] }}"),
    )
    .unwrap();

    let store = ArrangementStore::new(&data);

    assert_eq!(store.recent_projects().len(), 1);
    assert_eq!(store.workspace_state("ws-1"), None);
    assert_eq!(store.open_workspaces(), Vec::<String>::new());
}

#[test]
fn beschaedigte_workspace_datei_ergibt_keinen_workspace() {
    let root = temp_dir("beschaedigt");
    let data = root.join("daten");
    let alpha = project(&root, "alpha");
    let store = ArrangementStore::new(&data);
    store
        .save_workspace_state("ws-1", &workspace("Unbenannt", &[&alpha], "t1"))
        .unwrap();

    for entry in std::fs::read_dir(data.join("workspaces")).unwrap() {
        std::fs::write(entry.unwrap().path(), "{ \"version\": 1, \"na").unwrap();
    }

    assert_eq!(store.workspace_state("ws-1"), None);
}

#[test]
fn die_beim_beenden_offenen_workspaces_ueberstehen_einen_neustart() {
    let root = temp_dir("offen");
    let data = root.join("daten");
    let store = ArrangementStore::new(&data);
    assert_eq!(store.open_workspaces(), Vec::<String>::new());

    store
        .remember_open_workspaces(&["ws-2".to_string(), "ws-1".to_string()])
        .unwrap();

    assert_eq!(
        ArrangementStore::new(&data).open_workspaces(),
        vec!["ws-2".to_string(), "ws-1".to_string()]
    );
}
