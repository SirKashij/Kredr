//! Tests der Fenster für den Neustart nach einer Aktualisierung über die
//! öffentliche Schnittstelle des Aufteilungsspeichers, gegen echte Dateien.

use std::path::PathBuf;

use kredr_lib::arrangement_store::{ArrangementStore, RestartWindow};

/// Ein leerer Ordner unterhalb des temporären Verzeichnisses.
fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("kredr-test-neustart-{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("Testordner sollte anlegbar sein");
    dir
}

#[test]
fn gemerkte_fenster_kommen_genau_einmal_zurueck() {
    let data = temp_dir("einmal");
    let windows = vec![
        RestartWindow::Project(PathBuf::from(r"C:\Projekte\alpha")),
        RestartWindow::Workspace("ws-1".to_string()),
        RestartWindow::Project(PathBuf::from(r"C:\Projekte\beta")),
    ];
    ArrangementStore::new(&data)
        .remember_restart_windows(&windows)
        .unwrap();

    let store = ArrangementStore::new(&data);
    assert_eq!(store.take_restart_windows(), windows);
    assert_eq!(store.take_restart_windows(), Vec::new());
    assert_eq!(
        ArrangementStore::new(&data).take_restart_windows(),
        Vec::new()
    );
}

#[test]
fn ohne_notiz_kommt_kein_fenster_und_die_offenen_workspaces_bleiben() {
    let data = temp_dir("ohne");
    let store = ArrangementStore::new(&data);
    store
        .remember_open_workspaces(&["ws-1".to_string()])
        .unwrap();

    assert_eq!(store.take_restart_windows(), Vec::new());
    assert_eq!(store.open_workspaces(), vec!["ws-1".to_string()]);
}

#[test]
fn kaputte_oder_veraltete_notiz_ergibt_keine_fenster() {
    for (name, content) in [
        ("kaputt", "{ \"version\": 1, \"win"),
        (
            "veraltet",
            r#"{ "version": 99, "windows": [{ "workspace": "ws-1" }] }"#,
        ),
    ] {
        let data = temp_dir(name);
        let store = ArrangementStore::new(&data);
        store
            .remember_restart_windows(&[RestartWindow::Workspace("ws-1".to_string())])
            .unwrap();
        std::fs::write(data.join("restart-windows.json"), content).unwrap();

        assert_eq!(store.take_restart_windows(), Vec::new(), "{name}");
        assert!(!data.join("restart-windows.json").exists(), "{name}");
    }
}
