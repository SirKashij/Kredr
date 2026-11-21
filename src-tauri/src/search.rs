//! Das Modul Suche: Textsuche über die Dateien eines Projekts mit den
//! Bibliotheken der ripgrep-Engine. Die Treffer kommen je Datei als Strom,
//! sobald sie gefunden sind, und die Suche lässt sich jederzeit abbrechen.

use std::collections::HashMap;
use std::fmt;
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use grep_matcher::LineTerminator;
use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkMatch};
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::{WalkBuilder, WalkState};
use serde::{Deserialize, Serialize};

/// So viele Funde liefert eine Suche höchstens; danach endet sie.
pub const MAX_MATCHES: usize = 10_000;

/// So lang ist der Text einer Trefferzeile höchstens (in UTF-16-Einheiten).
const PREVIEW_LENGTH: u32 = 300;
/// So viel Text bleibt in einer gekürzten Trefferzeile vor dem ersten Fund stehen.
const PREVIEW_BEFORE: u32 = 20;

/// Wonach und wo gesucht wird.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TextQuery {
    /// Der gesuchte Text; mit `regex` ein regulärer Ausdruck.
    pub text: String,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub regex: bool,
    /// Ordner und Dateimuster, auf die sich die Suche beschränkt; leer heißt
    /// überall. Schreibweise wie in `.gitignore`: `src/ui` gilt ab dem
    /// Projektordner, `*.ts` oder ein bloßer Name in jeder Tiefe.
    pub include: Vec<String>,
    /// Ordner und Dateimuster, die nicht durchsucht werden; geht vor `include`.
    pub exclude: Vec<String>,
}

/// Die Treffer einer Datei.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMatches {
    /// Relativ zum Projektordner, mit `/` getrennt.
    pub path: String,
    /// Die Trefferzeilen in der Reihenfolge der Datei.
    pub lines: Vec<LineMatches>,
}

/// Eine Trefferzeile mit ihren Funden.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineMatches {
    /// Die Zeilennummer, ab 1.
    pub line: u64,
    /// Der Text der Zeile ohne Einrückung; eine sehr lange Zeile ist auf einen
    /// Ausschnitt um den ersten Fund gekürzt.
    pub text: String,
    /// Wo `text` in der Zeile beginnt (in UTF-16-Einheiten ab dem Zeilenanfang).
    pub text_start: u32,
    pub matches: Vec<MatchRange>,
}

/// Die Stelle eines Fundes in seiner Zeile: Anfang und Ende in
/// UTF-16-Einheiten ab dem Zeilenanfang, wie Oberfläche und Dateiansicht zählen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct MatchRange {
    pub start: u32,
    pub end: u32,
}

/// Wie eine Suche geendet hat.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOutcome {
    /// Die Suche wurde abgebrochen; es fehlen Treffer.
    pub cancelled: bool,
    /// Die Suche endete bei [`MAX_MATCHES`] Funden; es gibt vermutlich mehr.
    pub limit_reached: bool,
}

/// Warum eine Suche nicht starten konnte. Die Oberfläche macht daraus einen
/// Hinweis in der Sprache des Nutzers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "details", rename_all = "camelCase")]
pub enum SearchError {
    /// Der reguläre Ausdruck ist ungültig; mit der Begründung.
    InvalidPattern(String),
    /// Ein Dateimuster ist ungültig; mit der Begründung.
    InvalidGlob(String),
}

impl fmt::Display for SearchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SearchError::InvalidPattern(details) => write!(f, "invalid pattern: {details}"),
            SearchError::InvalidGlob(details) => write!(f, "invalid glob: {details}"),
        }
    }
}

impl std::error::Error for SearchError {}

/// Bricht eine laufende Suche ab. Kopien teilen sich denselben Zustand.
#[derive(Debug, Clone, Default)]
pub struct Cancellation(Arc<AtomicBool>);

impl Cancellation {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Relaxed);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

/// Durchsucht die Dateien des Projekts nach dem Text und ruft `on_file` für
/// jede Datei mit Treffern auf, sobald sie durchsucht ist; die Reihenfolge der
/// Dateien ist beliebig, und `on_file` läuft in mehreren Threads. Kehrt
/// zurück, wenn die Suche fertig, abgebrochen oder an der Obergrenze ist.
///
/// Was `.gitignore` ausnimmt, wird nicht durchsucht (auch ohne
/// Git-Repository), ebenso wenig Binärdateien und das Innere von `.git`.
pub fn search_text(
    project: &Path,
    query: &TextQuery,
    cancellation: &Cancellation,
    on_file: impl Fn(FileMatches) + Sync,
) -> Result<SearchOutcome, SearchError> {
    let matcher = RegexMatcherBuilder::new()
        .case_insensitive(!query.case_sensitive)
        .word(query.whole_word)
        .fixed_strings(!query.regex)
        // Gesucht wird zeilenweise; `$` gilt auch vor einem Windows-Zeilenende.
        .crlf(true)
        .build(&query.text)
        .map_err(|e| SearchError::InvalidPattern(e.to_string()))?;
    let include = patterns(project, &query.include)?;
    let exclude = patterns(project, &query.exclude)?;

    let mut walker = WalkBuilder::new(project);
    let root = project.to_path_buf();
    walker
        // Versteckte Dateien wie `.github` gehören zum Projekt.
        .hidden(false)
        .require_git(false)
        .filter_entry(move |entry| {
            if entry.file_name() == ".git" {
                return false;
            }
            let is_dir = entry.file_type().is_some_and(|kind| kind.is_dir());
            let path = entry.path().strip_prefix(&root).unwrap_or(entry.path());
            // Ein ausgeschlossener Ordner wird gar nicht erst betreten.
            !exclude.matched(path, is_dir).is_ignore()
        });

    let found = AtomicUsize::new(0);
    let done = || cancellation.is_cancelled() || found.load(Ordering::Relaxed) >= MAX_MATCHES;
    walker.build_parallel().run(|| {
        let mut searcher = SearcherBuilder::new()
            .binary_detection(BinaryDetection::quit(0))
            // UTF-16 gilt wie in der Dateiansicht als binär.
            .bom_sniffing(false)
            .line_terminator(LineTerminator::crlf())
            .line_number(true)
            .build();
        let (matcher, include, found, on_file, done) =
            (&matcher, &include, &found, &on_file, &done);
        Box::new(move |entry| {
            if done() {
                return WalkState::Quit;
            }
            let Ok(entry) = entry else {
                return WalkState::Continue;
            };
            if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                return WalkState::Continue;
            }
            let path = entry.path().strip_prefix(project).unwrap_or(entry.path());
            if !include.is_empty() && !include.matched_path_or_any_parents(path, false).is_ignore()
            {
                return WalkState::Continue;
            }
            let mut sink = FileSink {
                matcher,
                done,
                lines: Vec::new(),
                count: 0,
                binary: false,
            };
            // Eine Datei, die sich nicht lesen lässt, hat keine Treffer.
            if searcher
                .search_path(matcher, entry.path(), &mut sink)
                .is_err()
                || sink.binary
            {
                return WalkState::Continue;
            }
            let lines = within_limit(sink.lines, sink.count, found);
            if !lines.is_empty() && !cancellation.is_cancelled() {
                on_file(FileMatches {
                    path: path.to_string_lossy().replace('\\', "/"),
                    lines,
                });
            }
            WalkState::Continue
        })
    });

    let cancelled = cancellation.is_cancelled();
    Ok(SearchOutcome {
        cancelled,
        limit_reached: !cancelled && found.load(Ordering::Relaxed) >= MAX_MATCHES,
    })
}

/// Übersetzt Ordner und Dateimuster in einen Abgleich nach den Regeln von
/// `.gitignore`; Groß- und Kleinschreibung zählt wie bei Windows-Pfaden nicht.
fn patterns(project: &Path, patterns: &[String]) -> Result<Gitignore, SearchError> {
    let mut builder = GitignoreBuilder::new(project);
    let invalid = |e: ignore::Error| SearchError::InvalidGlob(e.to_string());
    builder.case_insensitive(true).map_err(invalid)?;
    for pattern in patterns {
        let pattern = pattern.trim().replace('\\', "/");
        let pattern = pattern.strip_prefix("./").unwrap_or(&pattern);
        let pattern = pattern.trim_end_matches('/');
        if !pattern.is_empty() {
            builder.add_line(None, pattern).map_err(invalid)?;
        }
    }
    builder.build().map_err(invalid)
}

/// Zählt die Funde einer Datei auf die Summe der Suche und kürzt sie, sobald
/// die Obergrenze erreicht ist; so liefert die Suche nie mehr als [`MAX_MATCHES`].
fn within_limit(
    mut lines: Vec<LineMatches>,
    count: usize,
    found: &AtomicUsize,
) -> Vec<LineMatches> {
    let before = found.fetch_add(count, Ordering::Relaxed);
    let mut room = MAX_MATCHES.saturating_sub(before);
    if count <= room {
        return lines;
    }
    lines.retain_mut(|line| {
        line.matches.truncate(room);
        room -= line.matches.len();
        !line.matches.is_empty()
    });
    lines
}

/// Sammelt die Trefferzeilen einer Datei.
struct FileSink<'a, D: Fn() -> bool> {
    matcher: &'a RegexMatcher,
    /// Ob die Suche insgesamt enden soll.
    done: &'a D,
    lines: Vec<LineMatches>,
    /// Die Zahl der Funde in `lines`.
    count: usize,
    binary: bool,
}

impl<D: Fn() -> bool> Sink for FileSink<'_, D> {
    type Error = io::Error;

    fn matched(&mut self, _searcher: &Searcher, found: &SinkMatch<'_>) -> Result<bool, io::Error> {
        if (self.done)() {
            return Ok(false);
        }
        let line = found.bytes();
        let line = line.strip_suffix(b"\n").unwrap_or(line);
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        let mut ranges = Vec::new();
        self.matcher
            .find_iter(line, |range| {
                if !range.is_empty() {
                    ranges.push((range.start(), range.end()));
                }
                true
            })
            .map_err(io::Error::other)?;
        if !ranges.is_empty() {
            self.count += ranges.len();
            self.lines.push(line_matches(
                found.line_number().unwrap_or(1),
                line,
                &ranges,
            ));
        }
        Ok(self.count < MAX_MATCHES)
    }

    fn binary_data(&mut self, _searcher: &Searcher, _offset: u64) -> Result<bool, io::Error> {
        self.binary = true;
        Ok(false)
    }
}

/// Baut eine Trefferzeile: rechnet die Funde von Bytes in UTF-16-Einheiten um
/// und kürzt den Text auf das, was die Trefferliste zeigt.
fn line_matches(number: u64, line: &[u8], ranges: &[(usize, usize)]) -> LineMatches {
    let units = |bytes: &[u8]| String::from_utf8_lossy(bytes).encode_utf16().count() as u32;
    let mut matches = Vec::with_capacity(ranges.len());
    let (mut byte, mut unit) = (0, 0);
    for &(start, end) in ranges {
        let start_unit = unit + units(&line[byte..start]);
        unit = start_unit + units(&line[start..end]);
        byte = end;
        matches.push(MatchRange {
            start: start_unit,
            end: unit,
        });
    }

    let full = String::from_utf8_lossy(line);
    let first = matches[0].start;
    // Die Einrückung entfällt; vor einem Fund weit hinten bleibt nur ein Stück stehen.
    let indent: u32 = full
        .chars()
        .take_while(|c| c.is_whitespace())
        .map(|c| c.len_utf16() as u32)
        .sum();
    let from = indent.min(first).max(first.saturating_sub(PREVIEW_BEFORE));
    let mut text = String::new();
    let mut text_start = from;
    let mut position = 0;
    for c in full.chars() {
        if position >= from + PREVIEW_LENGTH {
            break;
        }
        if position >= from {
            if text.is_empty() {
                text_start = position;
            }
            text.push(c);
        }
        position += c.len_utf16() as u32;
    }
    LineMatches {
        line: number,
        text,
        text_start,
        matches,
    }
}

/// Die Textsuchen der Fenster. Je Fenster läuft höchstens eine: Eine neue
/// Suche bricht die vorige ab. Die Oberfläche zählt ihre Suchen je Fenster
/// aufsteigend durch, beginnend bei 1.
#[derive(Default)]
pub struct Searches(Mutex<HashMap<String, WindowSearches>>);

#[derive(Default)]
struct WindowSearches {
    /// Bis zu dieser Nummer sind alle Suchen abgebrochen, auch noch nicht begonnene.
    cancelled_up_to: u32,
    running: HashMap<u32, Cancellation>,
}

impl Searches {
    /// Meldet die Suche `id` des Fensters an und bricht dessen ältere Suchen
    /// ab. Liefert nichts, wenn die Suche schon vor ihrem Beginn abgebrochen
    /// oder von einer neueren abgelöst wurde.
    pub fn begin(&self, window: &str, id: u32) -> Option<Cancellation> {
        let mut windows = self.0.lock().ok()?;
        let searches = windows.entry(window.to_owned()).or_default();
        if id <= searches.cancelled_up_to {
            return None;
        }
        searches.cancelled_up_to = id - 1;
        searches.running.retain(|_, older| {
            older.cancel();
            false
        });
        let cancellation = Cancellation::default();
        searches.running.insert(id, cancellation.clone());
        Some(cancellation)
    }

    /// Bricht die Suche `id` des Fensters und alle älteren ab.
    pub fn cancel(&self, window: &str, id: u32) {
        let Ok(mut windows) = self.0.lock() else {
            return;
        };
        let searches = windows.entry(window.to_owned()).or_default();
        searches.cancelled_up_to = searches.cancelled_up_to.max(id);
        searches.running.retain(|&running, cancellation| {
            if running <= id {
                cancellation.cancel();
            }
            running > id
        });
    }

    /// Meldet eine beendete Suche ab.
    pub fn finish(&self, window: &str, id: u32) {
        if let Ok(mut windows) = self.0.lock() {
            if let Some(searches) = windows.get_mut(window) {
                searches.running.remove(&id);
            }
        }
    }

    /// Bricht die Suchen eines geschlossenen Fensters ab.
    pub fn close_all_of(&self, window: &str) {
        if let Ok(mut windows) = self.0.lock() {
            for cancellation in windows
                .remove(window)
                .iter()
                .flat_map(|w| w.running.values())
            {
                cancellation.cancel();
            }
        }
    }
}
