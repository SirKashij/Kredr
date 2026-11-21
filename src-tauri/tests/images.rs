//! Tests für das Lesen von Bildern im Modul Projektdateien, über seine
//! öffentliche Schnittstelle und gegen echte temporäre Ordner.

use std::fs;

use kredr_lib::project_files::{
    read_file, read_image, FileContent, ImageContent, MAX_FILE_SIZE, MAX_IMAGE_SIZE,
};
use tempfile::TempDir;

fn temp_project() -> TempDir {
    tempfile::Builder::new()
        .prefix("kredr-test-")
        .tempdir()
        .expect("Testordner sollte anlegbar sein")
}

/// Der Anfang einer PNG-Datei; kein gültiger UTF-8-Text.
const PNG: &[u8] = &[
    0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d,
];

#[test]
fn ein_bild_wird_byte_fuer_byte_geliefert() {
    let project = temp_project();
    let path = project.path().join("logo.png");
    fs::write(&path, PNG).unwrap();

    let content = read_image(&path).expect("Bild sollte lesbar sein");

    assert_eq!(
        content,
        ImageContent::Image {
            bytes: PNG.to_vec()
        }
    );
}

#[test]
fn alle_gaengigen_bildformate_gelten_als_bild_unabhaengig_von_der_schreibweise() {
    let project = temp_project();
    for name in [
        "a.png", "b.jpg", "c.jpeg", "d.gif", "e.svg", "f.webp", "g.PNG", "h.Svg",
    ] {
        let path = project.path().join(name);
        fs::write(&path, b"inhalt").unwrap();

        let content = read_image(&path).expect("Bild sollte lesbar sein");

        assert_eq!(
            content,
            ImageContent::Image {
                bytes: b"inhalt".to_vec()
            },
            "{name}"
        );
    }
}

#[test]
fn andere_dateien_gibt_das_lesen_von_bildern_nicht_heraus() {
    let project = temp_project();
    for name in [
        ".env",
        "geheim.txt",
        "id_rsa",
        "seite.html",
        "bild.png.exe",
        "png",
    ] {
        let path = project.path().join(name);
        fs::write(&path, b"geheim").unwrap();

        let content = read_image(&path).expect("die Anfrage selbst sollte gelingen");

        assert_eq!(content, ImageContent::NotAnImage, "{name}");
    }
}

#[test]
fn ein_fehlendes_bild_ist_kein_fehler() {
    let project = temp_project();

    let content = read_image(&project.path().join("fehlt.png")).unwrap();

    assert_eq!(content, ImageContent::Missing);
}

#[test]
fn ein_ordner_mit_bildendung_scheitert() {
    let project = temp_project();
    let folder = project.path().join("ordner.png");
    fs::create_dir(&folder).unwrap();

    assert!(read_image(&folder).is_err());
}

#[test]
fn ein_bild_darf_groesser_sein_als_die_grenze_der_dateiansicht() {
    let project = temp_project();
    let path = project.path().join("gross.png");
    let size = MAX_FILE_SIZE as usize + 1024;
    fs::write(&path, vec![7u8; size]).unwrap();

    let content = read_image(&path).unwrap();

    assert!(matches!(content, ImageContent::Image { bytes } if bytes.len() == size));
    // Als Text bleibt dieselbe Datei zu groß.
    assert!(matches!(
        read_file(&path).unwrap(),
        FileContent::TooLarge { .. }
    ));
}

#[test]
fn ein_uebergrosses_bild_wird_nicht_gelesen_sondern_mit_groesse_gemeldet() {
    let project = temp_project();
    let path = project.path().join("riesig.png");
    let size = MAX_IMAGE_SIZE + 1;
    // Nur die Länge zählt; die Datei wird nicht beschrieben.
    fs::File::create(&path).unwrap().set_len(size).unwrap();

    let content = read_image(&path).unwrap();

    assert_eq!(content, ImageContent::TooLarge { size });
}
