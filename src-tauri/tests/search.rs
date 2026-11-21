//! Tests des Moduls Suche über seine öffentliche Schnittstelle, gegen echte
//! temporäre Ordner.

use std::fs;
use std::path::Path;
use std::sync::Mutex;

use kredr_lib::search::{
    search_text, Cancellation, FileMatches, SearchError, SearchOutcome, Searches, TextQuery,
};
use tempfile::TempDir;

fn temp_project() -> TempDir {
    tempfile::Builder::new()
        .prefix("kredr-test-")
        .tempdir()
        .expect("Testordner sollte anlegbar sein")
}

/// Legt eine Datei samt ihren Ordnern an; `path` ist relativ zum Projekt.
fn write(project: &TempDir, path: &str, content: impl AsRef<[u8]>) {
    let file = project.path().join(path);
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(file, content).unwrap();
}

fn query(text: &str) -> TextQuery {
    TextQuery {
        text: text.to_owned(),
        ..TextQuery::default()
    }
}

/// Sucht bis zum Ende und liefert die Treffer nach Pfad sortiert.
fn search(project: &Path, query: &TextQuery) -> Vec<FileMatches> {
    let (files, outcome) = search_with_outcome(project, query);
    assert_eq!(outcome, SearchOutcome::default());
    files
}

fn search_with_outcome(project: &Path, query: &TextQuery) -> (Vec<FileMatches>, SearchOutcome) {
    let found = Mutex::new(Vec::new());
    let outcome = search_text(project, query, &Cancellation::default(), |file| {
        found.lock().unwrap().push(file)
    })
    .expect("Die Suche sollte laufen");
    let mut files = found.into_inner().unwrap();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    (files, outcome)
}

fn paths(files: &[FileMatches]) -> Vec<&str> {
    files.iter().map(|file| file.path.as_str()).collect()
}

/// Je Trefferzeile: Zeilennummer, Text und die Funde als Textstücke.
fn lines(file: &FileMatches) -> Vec<(u64, &str, Vec<String>)> {
    file.lines
        .iter()
        .map(|line| {
            let units: Vec<u16> = line.text.encode_utf16().collect();
            let hits = line
                .matches
                .iter()
                .map(|hit| {
                    let start = (hit.start - line.text_start) as usize;
                    let end = (hit.end - line.text_start) as usize;
                    String::from_utf16(&units[start..end]).unwrap()
                })
                .collect();
            (line.line, line.text.as_str(), hits)
        })
        .collect()
}

#[test]
fn treffer_kommen_je_datei_mit_zeile_text_und_fund() {
    let project = temp_project();
    write(&project, "README.md", "# Kredr\n\nKredr ist schlank.\n");
    write(
        &project,
        "src/ui/App.tsx",
        "const a = 1;\r\nconst name = \"Kredr\"; // Kredr\r\n",
    );
    write(&project, "src/leer.txt", "nichts\n");

    let files = search(project.path(), &query("Kredr"));

    assert_eq!(paths(&files), ["README.md", "src/ui/App.tsx"]);
    assert_eq!(
        lines(&files[0]),
        [
            (1, "# Kredr", vec!["Kredr".to_owned()]),
            (3, "Kredr ist schlank.", vec!["Kredr".to_owned()]),
        ]
    );
    assert_eq!(
        lines(&files[1]),
        [(
            2,
            "const name = \"Kredr\"; // Kredr",
            vec!["Kredr".to_owned(), "Kredr".to_owned()]
        )]
    );
    // Die Stelle des Fundes zählt in UTF-16-Einheiten ab dem Zeilenanfang.
    let hit = &files[1].lines[0].matches[0];
    assert_eq!((hit.start, hit.end), (14, 19));
}

#[test]
fn ohne_optionen_zaehlt_gross_und_kleinschreibung_nicht() {
    let project = temp_project();
    write(&project, "a.txt", "Suche\nsuche\nSUCHE\nversuchen\n");

    let files = search(project.path(), &query("suche"));
    assert_eq!(files[0].lines.len(), 4);

    let exact = TextQuery {
        case_sensitive: true,
        ..query("suche")
    };
    let files = search(project.path(), &exact);
    let found: Vec<u64> = files[0].lines.iter().map(|line| line.line).collect();
    assert_eq!(found, [2, 4]);
}

#[test]
fn ganzes_wort_findet_keine_wortteile() {
    let project = temp_project();
    write(&project, "a.txt", "suche\nversuchen\ndie suche, hier\n");

    let whole = TextQuery {
        whole_word: true,
        ..query("suche")
    };
    let files = search(project.path(), &whole);

    let found: Vec<u64> = files[0].lines.iter().map(|line| line.line).collect();
    assert_eq!(found, [1, 3]);
    assert_eq!(lines(&files[0])[1].2, ["suche"]);
}

#[test]
fn ohne_regulaeren_ausdruck_gelten_sonderzeichen_woertlich() {
    let project = temp_project();
    write(
        &project,
        "a.txt",
        "f(x) [a-z]+ $1.50 a.b\nfx abc 1x50 axb\nC:\\Users\\test\n",
    );

    for (text, line) in [
        ("f(x)", 1),
        ("[a-z]+", 1),
        ("$1.50", 1),
        ("a.b", 1),
        ("C:\\Users", 3),
        ("(", 1),
    ] {
        let files = search(project.path(), &query(text));
        let found: Vec<u64> = files[0].lines.iter().map(|line| line.line).collect();
        assert_eq!(found, [line], "Suche nach {text}");
        assert_eq!(lines(&files[0])[0].2, [text], "Suche nach {text}");
    }
}

#[test]
fn regulaerer_ausdruck_findet_muster() {
    let project = temp_project();
    write(
        &project,
        "a.txt",
        "fn eins() {}\nfn zwei(x: u8) {}\nlet fnord;\n",
    );

    let regex = TextQuery {
        regex: true,
        ..query(r"fn \w+\(")
    };
    let files = search(project.path(), &regex);

    assert_eq!(
        lines(&files[0])
            .into_iter()
            .map(|(line, _, hits)| (line, hits))
            .collect::<Vec<_>>(),
        [
            (1, vec!["fn eins(".to_owned()]),
            (2, vec!["fn zwei(".to_owned()]),
        ]
    );
}

#[test]
fn ungueltiger_regulaerer_ausdruck_wird_gemeldet() {
    let project = temp_project();
    write(&project, "a.txt", "text\n");

    let regex = TextQuery {
        regex: true,
        ..query("(offen")
    };
    let result = search_text(project.path(), &regex, &Cancellation::default(), |_| {});

    assert!(
        matches!(result, Err(SearchError::InvalidPattern(_))),
        "{result:?}"
    );
}

#[test]
fn umlaute_und_emoji_werden_gefunden_und_in_utf16_gezaehlt() {
    let project = temp_project();
    write(
        &project,
        "größe/Übersicht.md",
        "😀 Größe ändern: 日本語 Größe\n",
    );

    let files = search(project.path(), &query("größe"));

    assert_eq!(paths(&files), ["größe/Übersicht.md"]);
    let line = &files[0].lines[0];
    assert_eq!(lines(&files[0])[0].2, ["Größe", "Größe"]);
    // Das Emoji belegt zwei UTF-16-Einheiten, jeder Umlaut eine.
    let found: Vec<(u32, u32)> = line
        .matches
        .iter()
        .map(|hit| (hit.start, hit.end))
        .collect();
    assert_eq!(found, [(3, 8), (21, 26)]);
}

#[test]
fn ignorierte_dateien_werden_nicht_durchsucht() {
    let project = temp_project();
    write(&project, ".gitignore", "node_modules/\n*.log\n/build\n");
    write(&project, "src/.gitignore", "geheim.txt\n");
    write(&project, "src/main.rs", "treffer\n");
    write(&project, "src/geheim.txt", "treffer\n");
    write(&project, "node_modules/paket/index.js", "treffer\n");
    write(&project, "build/out.js", "treffer\n");
    write(&project, "lauf.log", "treffer\n");
    // Versteckte Dateien gehören zum Projekt, das Innere von `.git` nicht.
    write(&project, ".github/workflows/ci.yml", "treffer\n");
    write(&project, ".git/config", "treffer\n");

    let files = search(project.path(), &query("treffer"));

    assert_eq!(paths(&files), [".github/workflows/ci.yml", "src/main.rs"]);
}

#[test]
fn binaerdateien_werden_nicht_durchsucht() {
    let project = temp_project();
    write(&project, "text.txt", "treffer\n");
    write(&project, "bild.png", b"treffer\n\x89PNG\x00\x00treffer\n");
    // UTF-16 zeigt auch die Dateiansicht nicht als Text.
    let utf16: Vec<u8> = [0xFF, 0xFE]
        .into_iter()
        .chain("treffer\n".encode_utf16().flat_map(u16::to_le_bytes))
        .collect();
    write(&project, "utf16.txt", utf16);

    let files = search(project.path(), &query("treffer"));

    assert_eq!(paths(&files), ["text.txt"]);
}

#[test]
fn suche_laesst_sich_auf_ordner_und_dateimuster_einschraenken() {
    let project = temp_project();
    write(&project, ".gitignore", "erzeugt/\n");
    write(&project, "src/ui/App.tsx", "treffer\n");
    write(&project, "src/ui/erzeugt/Gen.tsx", "treffer\n");
    write(&project, "src/kern.rs", "treffer\n");
    write(&project, "docs/src/lies.md", "treffer\n");
    write(&project, "docs/plan.md", "treffer\n");

    let only = |include: &[&str]| {
        let query = TextQuery {
            include: include.iter().map(|&pattern| pattern.to_owned()).collect(),
            ..query("treffer")
        };
        let files = search(project.path(), &query);
        files
            .into_iter()
            .map(|file| file.path)
            .collect::<Vec<String>>()
    };

    // Ein Ordner mit Pfad gilt ab dem Projektordner, ignorierte Dateien bleiben draußen.
    assert_eq!(only(&["src/ui"]), ["src/ui/App.tsx"]);
    assert_eq!(
        only(&["./src/ui/", "docs\\src"]),
        ["docs/src/lies.md", "src/ui/App.tsx"]
    );
    // Ein bloßer Name oder ein Muster gilt in jeder Tiefe.
    assert_eq!(only(&["*.md"]), ["docs/plan.md", "docs/src/lies.md"]);
    assert_eq!(
        only(&["src"]),
        ["docs/src/lies.md", "src/kern.rs", "src/ui/App.tsx"]
    );
    assert_eq!(
        only(&["src/**/*.tsx", "*.RS"]),
        ["src/kern.rs", "src/ui/App.tsx"]
    );
}

#[test]
fn muster_lassen_sich_ausschliessen() {
    let project = temp_project();
    write(&project, "src/ui/App.tsx", "treffer\n");
    write(&project, "src/ui/App.test.tsx", "treffer\n");
    write(&project, "src/kern.rs", "treffer\n");
    write(&project, "docs/plan.md", "treffer\n");

    let exclude = TextQuery {
        exclude: vec!["*.test.tsx".to_owned(), "docs".to_owned()],
        ..query("treffer")
    };
    assert_eq!(
        paths(&search(project.path(), &exclude)),
        ["src/kern.rs", "src/ui/App.tsx"]
    );

    // Ausschließen geht vor Einschränken.
    let both = TextQuery {
        include: vec!["src".to_owned()],
        exclude: vec!["src/ui".to_owned()],
        ..query("treffer")
    };
    assert_eq!(paths(&search(project.path(), &both)), ["src/kern.rs"]);
}

#[test]
fn ungueltiges_dateimuster_wird_gemeldet() {
    let project = temp_project();
    write(&project, "a.txt", "text\n");

    let broken = TextQuery {
        include: vec!["src/{a,b".to_owned()],
        ..query("text")
    };
    let result = search_text(project.path(), &broken, &Cancellation::default(), |_| {});

    assert!(
        matches!(result, Err(SearchError::InvalidGlob(_))),
        "{result:?}"
    );
}

#[test]
fn ordner_ohne_git_repository_beachtet_gitignore_trotzdem() {
    let project = temp_project();
    assert!(!project.path().join(".git").exists());
    write(&project, ".gitignore", "aus/\n");
    write(&project, "aus/a.txt", "treffer\n");
    write(&project, "an/a.txt", "treffer\n");

    assert_eq!(
        paths(&search(project.path(), &query("treffer"))),
        ["an/a.txt"]
    );
}

#[test]
fn lange_zeile_wird_um_den_fund_herum_gekuerzt() {
    let project = temp_project();
    let line = format!("{}treffer{}", "a".repeat(5000), "b".repeat(5000));
    write(
        &project,
        "min.js",
        format!("    eingerückt treffer\n{line}\n"),
    );

    let files = search(project.path(), &query("treffer"));

    // Einrückung gehört nicht in die Trefferzeile; die Stelle des Fundes bleibt.
    let short = &files[0].lines[0];
    assert_eq!(
        (short.text.as_str(), short.text_start),
        ("eingerückt treffer", 4)
    );
    assert_eq!((short.matches[0].start, short.matches[0].end), (15, 22));
    let long = &files[0].lines[1];
    assert!(long.text.len() < 1000, "{} Zeichen", long.text.len());
    assert_eq!((long.matches[0].start, long.matches[0].end), (5000, 5007));
    assert_eq!(lines(&files[0])[1].2, ["treffer"]);
}

#[test]
fn abgebrochene_suche_endet_vorzeitig() {
    let project = temp_project();
    for index in 0..300 {
        write(
            &project,
            &format!("ordner{}/datei{index}.txt", index % 7),
            "treffer\n",
        );
    }

    // Vor dem Start abgebrochen: Es kommt nichts.
    let cancellation = Cancellation::default();
    cancellation.cancel();
    let outcome = search_text(project.path(), &query("treffer"), &cancellation, |_| {
        panic!("Eine abgebrochene Suche liefert nichts mehr")
    })
    .unwrap();
    assert!(outcome.cancelled);

    // Während des Laufs abgebrochen: Es kommen nicht mehr alle Treffer.
    let cancellation = Cancellation::default();
    let found = Mutex::new(0);
    let outcome = search_text(project.path(), &query("treffer"), &cancellation, |_| {
        *found.lock().unwrap() += 1;
        cancellation.cancel();
    })
    .unwrap();
    assert!(outcome.cancelled);
    let found = found.into_inner().unwrap();
    assert!((1..300).contains(&found), "{found} Dateien geliefert");
}

#[test]
fn bei_sehr_vielen_treffern_endet_die_suche_an_der_obergrenze() {
    let project = temp_project();
    let many = "treffer treffer treffer treffer\n".repeat(1000);
    for index in 0..5 {
        write(&project, &format!("viel{index}.txt"), &many);
    }

    let (files, outcome) = search_with_outcome(project.path(), &query("treffer"));

    assert!(outcome.limit_reached);
    assert!(!outcome.cancelled);
    let total: usize = files
        .iter()
        .flat_map(|file| &file.lines)
        .map(|line| line.matches.len())
        .sum();
    assert_eq!(total, kredr_lib::search::MAX_MATCHES);
}

#[test]
fn neue_suche_eines_fensters_bricht_die_vorige_ab() {
    let searches = Searches::default();

    let first = searches.begin("fenster", 1).expect("Die erste Suche läuft");
    let other = searches
        .begin("anderes", 1)
        .expect("Jedes Fenster sucht für sich");
    let second = searches
        .begin("fenster", 2)
        .expect("Die zweite Suche läuft");

    assert!(first.is_cancelled());
    assert!(!second.is_cancelled());
    assert!(!other.is_cancelled());
    // Eine abgelöste Suche, die erst jetzt beginnt, läuft gar nicht mehr an.
    assert!(searches.begin("fenster", 1).is_none());
}

#[test]
fn abbruch_gilt_auch_fuer_eine_suche_die_noch_nicht_begonnen_hat() {
    let searches = Searches::default();
    let running = searches.begin("fenster", 1).unwrap();

    searches.cancel("fenster", 2);

    assert!(running.is_cancelled());
    assert!(searches.begin("fenster", 2).is_none());
    assert!(searches.begin("fenster", 3).is_some());
}

#[test]
fn geschlossenes_fenster_bricht_seine_suche_ab() {
    let searches = Searches::default();
    let running = searches.begin("fenster", 1).unwrap();

    searches.close_all_of("fenster");

    assert!(running.is_cancelled());
}
