//! Gemeinsame Testhilfen für alle Tests der Versionskontrolle: ein Projekt in
//! einem temporären Ordner mit echtem Git, abgeschirmt von der Git-Konfiguration
//! des Rechners.
//!
//! Einbinden mit `mod git_support;` in der Testdatei.

// Nicht jede Testdatei braucht jede Hilfe.
#![allow(dead_code)]

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use kredr_lib::version_control::{GitOptions, VersionControl};
use tempfile::TempDir;

/// Die Git-Konfiguration aller Tests. Sie ersetzt die globale und die
/// systemweite Konfiguration, damit jeder Rechner dasselbe Ergebnis liefert.
const GIT_CONFIG: &str = "\
[user]
	name = Kredr Test
	email = test@kredr.invalid
[init]
	defaultBranch = main
[core]
	autocrlf = false
[commit]
	gpgsign = false
[protocol \"file\"]
	allow = always
";

/// Ein Projektordner für einen Test. Der temporäre Ordner enthält daneben die
/// Git-Konfiguration und bei Bedarf ein lokales „Remote“-Repository; alles
/// verschwindet mit dem Wert.
pub struct TestProject {
    root: TempDir,
    project: PathBuf,
}

impl TestProject {
    /// Ein leerer Projektordner ohne Git-Repository.
    pub fn without_repository() -> TestProject {
        let root = tempfile::Builder::new()
            .prefix("kredr-test-")
            .tempdir()
            .expect("Testordner sollte anlegbar sein");
        fs::write(root.path().join("gitconfig"), GIT_CONFIG).unwrap();
        let project = root.path().join("project");
        fs::create_dir(&project).unwrap();
        TestProject { root, project }
    }

    /// Ein Projektordner mit frischem Git-Repository auf dem Branch `main`,
    /// noch ohne Commit.
    pub fn with_repository() -> TestProject {
        let project = TestProject::without_repository();
        project.git(&["init"]);
        project
    }

    /// Ein Repository, in dem die Dateien `files` (Pfad, Inhalt) bereits
    /// festgeschrieben sind.
    pub fn with_commit(files: &[(&str, &str)]) -> TestProject {
        let project = TestProject::with_repository();
        for (path, text) in files {
            project.write(path, text);
        }
        project.commit_all("Erster Commit");
        project
    }

    /// Der Projektordner.
    pub fn path(&self) -> &Path {
        &self.project
    }

    /// Die Umgebung, die Git von der Konfiguration des Rechners abschirmt.
    pub fn git_env(&self) -> Vec<(OsString, OsString)> {
        vec![
            (
                "GIT_CONFIG_GLOBAL".into(),
                self.root.path().join("gitconfig").into(),
            ),
            ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
            ("GIT_TERMINAL_PROMPT".into(), "0".into()),
        ]
    }

    /// Wie das Modul Versionskontrolle Git in diesem Test aufruft.
    pub fn git_options(&self) -> GitOptions {
        GitOptions {
            env: self.git_env(),
            ..GitOptions::default()
        }
    }

    /// Das Modul Versionskontrolle für den Projektordner.
    pub fn version_control(&self) -> VersionControl {
        self.version_control_in("")
    }

    /// Das Modul Versionskontrolle für einen Unterordner als Projekt.
    pub fn version_control_in(&self, folder: &str) -> VersionControl {
        VersionControl::with_options(&self.project.join(folder), self.git_options())
    }

    /// Führt Git im Projektordner aus, so wie es ein Agent im Terminal täte,
    /// und liefert die Ausgabe. Scheitert der Aufruf, scheitert der Test.
    pub fn git(&self, args: &[&str]) -> String {
        self.git_in(&self.project, args)
    }

    /// Wie `git`, aber ein Scheitern ist erlaubt (etwa ein Merge mit Konflikt).
    pub fn git_unchecked(&self, args: &[&str]) {
        let _ = self.run_git(&self.project, args);
    }

    fn run_git(&self, folder: &Path, args: &[&str]) -> std::process::Output {
        Command::new("git")
            .current_dir(folder)
            .args(args)
            .envs(self.git_env())
            .output()
            .expect("Git sollte installiert sein")
    }

    fn git_in(&self, folder: &Path, args: &[&str]) -> String {
        let output = self.run_git(folder, args);
        assert!(
            output.status.success(),
            "git {args:?} ist gescheitert: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    /// Schreibt eine Datei des Projekts (Pfad mit `/`) und legt ihre Ordner an.
    pub fn write(&self, path: &str, content: impl AsRef<[u8]>) {
        let file = self.project.join(path);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, content).unwrap();
    }

    pub fn delete(&self, path: &str) {
        fs::remove_file(self.project.join(path)).unwrap();
    }

    /// Schreibt alle Änderungen fest.
    pub fn commit_all(&self, message: &str) {
        self.git(&["add", "--all"]);
        self.git(&["commit", "--message", message]);
    }

    /// Legt neben dem Projekt ein leeres „Remote“-Repository an, trägt es als
    /// `origin` ein und schiebt den aktuellen Branch dorthin. Liefert seinen Ordner.
    pub fn add_remote(&self) -> PathBuf {
        let remote = self.root.path().join("remote.git");
        self.git_in(self.root.path(), &["init", "--bare", "remote.git"]);
        self.git(&["remote", "add", "origin", &remote.to_string_lossy()]);
        self.git(&["push", "--set-upstream", "origin", "HEAD"]);
        remote
    }

    /// Führt Git in einem beliebigen Ordner des Tests aus, etwa im „Remote“.
    pub fn git_at(&self, folder: &Path, args: &[&str]) -> String {
        self.git_in(folder, args)
    }

    /// Jemand anderes schreibt die Datei fest und pusht sie auf den Branch
    /// `main` des „Remote“ (`add_remote` muss vorher gelaufen sein): aus
    /// einem zweiten Arbeitsordner neben dem Projekt, wie ein Kollege oder
    /// ein anderer Rechner.
    pub fn push_from_elsewhere(&self, path: &str, content: &str) {
        let elsewhere = self.root.path().join("elsewhere");
        if !elsewhere.exists() {
            self.git_in(self.root.path(), &["clone", "remote.git", "elsewhere"]);
        }
        self.git_in(&elsewhere, &["pull", "--ff-only", "origin", "main"]);
        let file = elsewhere.join(path);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, content).unwrap();
        self.git_in(&elsewhere, &["add", "--all"]);
        self.git_in(&elsewhere, &["commit", "--message", "Commit von anderswo"]);
        self.git_in(&elsewhere, &["push", "origin", "HEAD:main"]);
    }
}
