//! Branches: Liste, Wechsel und Anlage.

use serde::{Deserialize, Serialize};

use super::{ErrorReason, VersionControl, VersionControlError};

/// Ein Branch, zu dem sich wechseln lässt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    /// Der Name ohne das Remote davor, etwa `feature/x`.
    pub name: String,
    /// Das Remote (in der Regel `origin`, also GitHub), wenn es den Branch
    /// nur dort gibt; fehlt bei einem lokalen Branch.
    pub remote: Option<String>,
    /// Ob dies der aktuelle Branch ist.
    pub current: bool,
}

/// Branches: Liste, Wechsel und Anlage.
impl VersionControl {
    /// Alle lokalen Branches und danach die der Remotes, die es lokal noch
    /// nicht gibt; jeweils der mit dem jüngsten Commit zuerst. Gelesen wird,
    /// was das Repository vom Remote zuletzt geholt hat; der Aufruf selbst
    /// geht nicht ins Netz.
    pub fn branches(&self) -> Result<Vec<Branch>, VersionControlError> {
        let output = self.git(
            &[
                "for-each-ref",
                "--format=%(refname)%00%(HEAD)%00%(symref)",
                "--sort=refname",
                "--sort=-committerdate",
                "refs/heads",
                "refs/remotes",
            ],
            None,
        )?;
        let output = String::from_utf8_lossy(&output);
        let mut local = Vec::new();
        let mut remote = Vec::new();
        for line in output.lines() {
            let fields: Vec<&str> = line.split('\0').collect();
            // Ein Verweis auf einen anderen Branch (`origin/HEAD`) ist kein eigener.
            let [refname, head, ""] = fields[..] else {
                continue;
            };
            if let Some(name) = refname.strip_prefix("refs/heads/") {
                local.push(Branch {
                    name: name.to_owned(),
                    remote: None,
                    current: head == "*",
                });
            } else if let Some((origin, name)) = refname
                .strip_prefix("refs/remotes/")
                .and_then(|name| name.split_once('/'))
            {
                remote.push(Branch {
                    name: name.to_owned(),
                    remote: Some(origin.to_owned()),
                    current: false,
                });
            }
        }
        remote.retain(|branch| local.iter().all(|local| local.name != branch.name));
        local.append(&mut remote);
        Ok(local)
    }

    /// Wechselt zu einem Branch aus [`VersionControl::branches`]. Einen
    /// Branch des Remotes legt der Wechsel lokal an; er folgt dann dem des
    /// Remotes. Lokale Änderungen kommen mit. Würde der Wechsel welche
    /// überschreiben, scheitert er mit `LocalChangesBlockSwitch`, ohne etwas
    /// zu verändern.
    pub fn switch_branch(&self, branch: &Branch) -> Result<(), VersionControlError> {
        let target = match &branch.remote {
            Some(remote) => format!("{remote}/{}", branch.name),
            None => branch.name.clone(),
        };
        // Was wie ein Schalter aussieht, ist kein Branch.
        if target.starts_with('-') {
            return Err(invalid_branch_name(&target));
        }
        let args: &[&str] = match branch.remote {
            Some(_) => &["switch", "--track", &target],
            // Nur genau dieser Branch, kein gleichnamiger eines Remotes.
            None => &["switch", "--no-guess", &target],
        };
        self.git(args, None).map_err(blocked_switch)?;
        Ok(())
    }

    /// Legt vom aktuellen Stand aus einen Branch an und wechselt zu ihm;
    /// lokale Änderungen kommen mit.
    pub fn create_branch(&self, name: &str) -> Result<(), VersionControlError> {
        self.git(&["check-ref-format", "--branch", name], None)
            .map_err(|error| match error.reason {
                ErrorReason::Failed => invalid_branch_name(name),
                _ => error,
            })?;
        self.git(&["switch", "--create", name], None)
            .map_err(|error| match error.reason {
                ErrorReason::Failed if error.details.contains("already exists") => {
                    VersionControlError {
                        reason: ErrorReason::BranchExists,
                        ..error
                    }
                }
                _ => error,
            })?;
        Ok(())
    }
}

fn invalid_branch_name(name: &str) -> VersionControlError {
    VersionControlError {
        reason: ErrorReason::InvalidBranchName,
        details: format!("'{name}' is not a valid branch name"),
    }
}

/// Erkennt den Wechsel, den Git zum Schutz lokaler Änderungen verweigert hat
/// (geänderte ebenso wie Git noch unbekannte Dateien).
fn blocked_switch(error: VersionControlError) -> VersionControlError {
    if error.reason == ErrorReason::Failed
        && error.details.contains("would be overwritten by checkout")
    {
        return VersionControlError {
            reason: ErrorReason::LocalChangesBlockSwitch,
            ..error
        };
    }
    error
}
