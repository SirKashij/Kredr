//! Agent-Start: der Befehl, der in einem Terminal einen Agenten startet, und
//! die Prüfung, ob sein Programm installiert ist. Kredr gibt dem Agenten
//! nur die Konfiguration für den Agentenstatus mit und fasst keine
//! Einstellungen von Claude Code an.

use std::ffi::OsStr;
use std::path::Path;

use crate::agent_status::TerminalHooks;
use crate::paths;
use crate::terminal::Shell;

/// Startet Claude Code, solange die Einstellungen nichts anderes sagen.
pub const DEFAULT_START_COMMAND: &str = "claude";

/// Endungen, unter denen PowerShell ein Programm ohne Angabe der Endung findet.
const EXTENSIONS: [&str; 5] = ["exe", "cmd", "bat", "com", "ps1"];

/// Der Name des Programms, das `command` aufruft, wenn es in keinem Ordner
/// von `search_path` (im Format der Umgebungsvariable `PATH`) liegt.
///
/// Geprüft wird nur ein schlichter Programmname am Anfang des Befehls. Ein
/// Pfad, ein Aufruf mit `&` oder eine Variable gilt nie als fehlend; das
/// entscheidet die Shell. Ebenso wenig erkennt die Prüfung Aliase und
/// Funktionen aus dem Profil der Shell: Wer `claude` nur so bereitstellt,
/// bekommt den Hinweis zu Unrecht. Der Aufrufer führt den Befehl deshalb
/// trotzdem aus und zeigt den Hinweis nur dazu.
pub fn missing_program(command: &str, search_path: &OsStr) -> Option<String> {
    let program = command.split_whitespace().next()?;
    let plain = program
        .chars()
        .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if !plain {
        return None;
    }
    let mut names = vec![program.to_owned()];
    names.extend(EXTENSIONS.map(|extension| format!("{program}.{extension}")));
    let found = paths::find_programs(search_path, &names).next().is_some();
    (!found).then(|| program.to_owned())
}

/// Der Startbefehl `command`, ergänzt um die Konfigurationsdatei `settings`
/// für den Agentenstatus. Sie gilt nur für diese eine Sitzung von Claude
/// Code und kommt zu dessen eigenen Einstellungen hinzu.
///
/// Ergänzt wird nur, wenn der Befehl mit dem Programm `claude` beginnt, als
/// Name oder als Pfad ohne Leerzeichen. Jeder andere Befehl bleibt, wie er
/// ist; sein Agent hat dann keinen Agentenstatus.
///
/// Der Pfad ist so zitiert, wie `shell` es verlangt, damit er auch mit
/// Leerzeichen oder Apostroph als ein Argument ankommt.
pub fn with_status_settings(command: &str, settings: &Path, shell: Shell) -> String {
    let Some((program, rest)) = claude_program(command) else {
        return command.to_owned();
    };
    format!("{program} --settings {}{rest}", quoted(settings, shell))
}

/// Der Befehl, mit dem die Shell eines Terminals startet; `None`, wenn sie
/// ohne Befehl startet. `hooks` sagt, worüber der Agent des Terminals seinen
/// Status meldet, `agent_command` ist der Startbefehl seines Agenten.
///
/// Der Befehl legt nach dem Profil der Person (PowerShell) bzw. nach ihrer
/// `.bashrc` (Git Bash) eine Funktion `claude` an. Sie ruft immer das
/// installierte Programm `claude` mit der Konfigurationsdatei auf, so dass
/// auch ein von Hand gestartetes `claude` seinen Agentenstatus meldet (ADR
/// 0006). Kehrt das Programm zurück, meldet sie das, auch nach einem Absturz
/// oder Strg+C. Ein Alias oder eine Funktion `claude` aus dem Profil ist dann
/// wirkungslos. Ein Agent, den Kredr mit `claude` startet, läuft über
/// dieselbe Funktion; ein Startbefehl mit einem Pfad zu `claude` meldet seine
/// Rückkehr ebenso.
pub fn shell_start_command(
    shell: Shell,
    hooks: Option<&TerminalHooks>,
    agent_command: Option<&str>,
) -> Option<String> {
    let Some(hooks) = hooks else {
        return agent_command.map(str::to_owned);
    };
    let (function, separator) = match shell {
        Shell::Powershell => (powershell_claude_function(hooks), "; "),
        Shell::GitBash => (bash_claude_function(hooks), "\n"),
    };
    let agent_command = match agent_command {
        None => return Some(function),
        Some(command) if calls_claude_function(command, shell) => command.to_owned(),
        Some(command) if claude_program(command).is_some() => reporting_exit(
            shell,
            &with_status_settings(command, &hooks.settings, shell),
            &hooks.exited_url,
        ),
        Some(command) => command.to_owned(),
    };
    Some(format!("{function}{separator}{agent_command}"))
}

/// `command`, gefolgt von der Meldung an `url`, dass er zurückgekehrt ist;
/// auch nach einem Absturz oder Strg+C.
fn reporting_exit(shell: Shell, command: &str, url: &str) -> String {
    match shell {
        Shell::Powershell => format!(
            "try {{ {command} }} finally {{ {} }}",
            powershell_exit_report(url)
        ),
        // Der `trap` der Subshell läuft auch, wenn ein Signal sie beendet.
        Shell::GitBash => format!("( trap '{}' EXIT; {command} )", bash_exit_report(url)),
    }
}

/// Bash-Befehle, die per POST an `url` melden, dass `claude` zurückgekehrt
/// ist. Sie gehen über die Netzwerk-Umleitung von Bash und brauchen kein
/// weiteres Programm. Was dabei schiefgeht, bleibt still; ist Kredr fort,
/// lehnt der Rechner die Verbindung sofort ab. Enthält keine Apostrophe,
/// damit es in einen `trap` passt.
fn bash_exit_report(url: &str) -> String {
    // Die Adresse stammt vom Empfänger: `http://<host>:<port>/<pfad>`.
    let Some((host, port, path)) = url.strip_prefix("http://").and_then(|rest| {
        let (authority, path) = rest.split_once('/')?;
        let (host, port) = authority.rsplit_once(':')?;
        Some((host, port, path))
    }) else {
        return ":".to_owned();
    };
    format!(
        "{{ exec 3<>/dev/tcp/{host}/{port} && \
         printf \"POST /{path} HTTP/1.0\\r\\nContent-Length: 0\\r\\n\\r\\n\" >&3 && \
         read -r -t 3 <&3; exec 3>&-; }} 2>/dev/null"
    )
}

/// Die Bash-Funktion `claude`, das Gegenstück zu
/// `powershell_claude_function`. Ein Alias hätte in Bash Vorrang vor jeder
/// Funktion und wird deshalb entfernt; `command` überspringt Funktionen und
/// ruft das Programm aus dem Suchpfad. Gibt es keines, meldet Bash selbst,
/// dass `claude` nicht gefunden wurde, und es gibt keine Rückkehr zu melden.
fn bash_claude_function(hooks: &TerminalHooks) -> String {
    let settings = quoted(&hooks.settings, Shell::GitBash);
    let sessionless_options = SESSIONLESS_OPTIONS.join("|");
    let session = reporting_exit(
        Shell::GitBash,
        &format!("command claude --settings {settings} \"$@\""),
        &hooks.exited_url,
    );
    format!(
        "unalias claude 2>/dev/null\n\
         function claude {{\n\
         if [[ $# -gt 0 && $1 =~ {SUBCOMMAND_PATTERN} ]] || ! type -P claude >/dev/null; then command claude \"$@\"; return; fi\n\
         local arg; for arg in \"$@\"; do case $arg in {sessionless_options}) command claude \"$@\"; return;; esac; done\n\
         {session}\n\
         }}"
    )
}

/// PowerShell-Befehle, die per POST an `url` melden, dass `claude`
/// zurückgekehrt ist. Was dabei schiefgeht, bleibt still; ist Kredr fort,
/// lehnt der Rechner die Verbindung sofort ab.
fn powershell_exit_report(url: &str) -> String {
    format!(
        "try {{ $request = [Net.HttpWebRequest]::Create('{url}'); \
         $request.Method = 'POST'; $request.Proxy = $null; $request.Timeout = 3000; \
         $request.ContentLength = 0; $request.GetResponse().Close() }} catch {{}}"
    )
}

/// Die PowerShell-Funktion `claude`, die das installierte Programm mit der
/// Konfigurationsdatei `settings` aufruft. Ein Alias hätte in PowerShell
/// Vorrang vor jeder Funktion und wird deshalb entfernt. Das Programm kommt
/// aus dem Suchpfad: zuerst eine ausführbare Datei (`claude.exe`,
/// `claude.cmd`), sonst ein Skript (`claude.ps1`). Gibt es keines, endet
/// der Aufruf mit dem Fehler von `Get-Command`, dass `claude` nicht gefunden
/// wurde.
///
/// Aufrufe ohne Sitzung (siehe `SESSIONLESS_OPTIONS` und
/// `SUBCOMMAND_PATTERN`) bekommen die Konfigurationsdatei nicht, damit sie
/// das Terminal nicht zum Agenten machen. Nach jedem Aufruf mit Sitzung
/// meldet die Funktion die Rückkehr des Programms an `exited_url`, in
/// `finally`, damit das auch bei Strg+C geschieht.
fn powershell_claude_function(hooks: &TerminalHooks) -> String {
    let settings = quoted(&hooks.settings, Shell::Powershell);
    let exit_report = powershell_exit_report(&hooks.exited_url);
    let programs_of_kind = |kind: &str| {
        format!("@(Get-Command claude -CommandType {kind} -ErrorAction SilentlyContinue)")
    };
    let sessionless_options = SESSIONLESS_OPTIONS
        .map(|option| format!("'{option}'"))
        .join(",");
    // Eingabe aus der Pipeline (`… | claude -p`) reicht die Funktion weiter.
    // Optionen von Claude Code unterscheiden Groß- und Kleinschreibung,
    // deshalb `-cmatch` und `-cin`.
    format!(
        "Remove-Item Alias:claude -Force -ErrorAction SilentlyContinue; \
         function global:claude {{ \
         $program = {} + {} | Select-Object -First 1; \
         if (-not $program) {{ $program = Get-Command claude -CommandType Application -ErrorAction Stop }}; \
         $sessionless = ($args.Count -gt 0 -and \"$($args[0])\" -cmatch '{SUBCOMMAND_PATTERN}') \
         -or @($args | Where-Object {{ \"$_\" -cin {sessionless_options} }}).Count -gt 0; \
         $settingsArgs = @(); if (-not $sessionless) {{ $settingsArgs = '--settings', {settings} }}; \
         try {{ if ($MyInvocation.ExpectingInput) {{ $input | & $program @settingsArgs @args }} \
         else {{ & $program @settingsArgs @args }} }} \
         finally {{ if (-not $sessionless) {{ {exit_report} }} }} }}",
        programs_of_kind("Application"),
        programs_of_kind("ExternalScript"),
    )
}

/// Optionen, mit denen `claude` keine interaktive Sitzung startet, gleich an
/// welcher Stelle sie stehen.
const SESSIONLESS_OPTIONS: [&str; 6] = ["-p", "--print", "-v", "--version", "-h", "--help"];

/// Ein erstes Argument, das so aussieht, ist ein Unterbefehl wie `mcp` oder
/// `update` und startet keine Sitzung. Ein Prompt als erstes Argument
/// (`claude "erkläre das"`) enthält meist ein Leerzeichen und startet weiter
/// eine Sitzung; nur ein Prompt aus einem einzigen kleingeschriebenen Wort
/// gilt fälschlich als Unterbefehl.
const SUBCOMMAND_PATTERN: &str = "^[a-z][a-z-]*$";

/// Ob `command` das Programm schlicht beim Namen `claude` aufruft und damit
/// bei der Funktion aus `powershell_claude_function` bzw.
/// `bash_claude_function` landet.
///
/// PowerShell unterscheidet bei Namen von Funktionen nicht zwischen Groß-
/// und Kleinschreibung, Bash schon: Dort findet `Claude` das Programm
/// direkt, und der Befehl bekommt die Konfigurationsdatei wie ein Pfad.
fn calls_claude_function(command: &str, shell: Shell) -> bool {
    claude_program(command).is_some_and(|(program, _)| match shell {
        Shell::Powershell => program.eq_ignore_ascii_case("claude"),
        Shell::GitBash => program == "claude",
    })
}

/// Der Pfad in einfachen Anführungszeichen, wie `shell` ihn verlangt.
fn quoted(path: &Path, shell: Shell) -> String {
    shell.quote(&path.to_string_lossy())
}

/// Der Startbefehl `command`, ergänzt um das Fortsetzen des Gesprächs
/// `conversation`. `None`, wenn der Befehl nicht wie bei
/// `with_status_settings` mit `claude` beginnt oder die Kennung keine von
/// Claude Code sein kann: Dann startet kein Agent, schon gar kein frischer
/// an Stelle des gespeicherten.
pub fn resuming(command: &str, conversation: &str) -> Option<String> {
    let (program, rest) = claude_program(command)?;
    // Claude Code vergibt UUIDs; alles andere käme ungeprüft in die Shell.
    let valid = !conversation.is_empty()
        && conversation
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-');
    valid.then(|| format!("{program} --resume {conversation}{rest}"))
}

/// Programm und Rest des Befehls, wenn er mit dem Programm `claude` beginnt,
/// als Name oder als Pfad ohne Leerzeichen und ohne Zeichen, die die Shell
/// auswertet.
fn claude_program(command: &str) -> Option<(&str, &str)> {
    let trimmed = command.trim_start();
    let program = trimmed.split_whitespace().next()?;
    let is_claude = Path::new(program)
        .file_stem()
        .and_then(OsStr::to_str)
        .is_some_and(|stem| stem.eq_ignore_ascii_case("claude"));
    let plain = !program.contains(['"', '\'', '$', '&', ';', '|']);
    (is_claude && plain).then(|| (program, &trimmed[program.len()..]))
}
