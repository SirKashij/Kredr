//! Tests der Benachrichtigungen über ihre öffentliche Schnittstelle. Hier
//! erscheint nie eine echte Windows-Benachrichtigung: Geprüft wird ihr
//! Inhalt, und dass er für Windows gültig ist.

use kredr_lib::notifications::toast_content;
use windows::core::HSTRING;
use windows::Data::Xml::Dom::XmlDocument;

/// Die Texte der Benachrichtigung, wie Windows sie nach dem Einlesen sieht.
fn texts_seen_by_windows(content: &str) -> Vec<String> {
    let document = XmlDocument::new().expect("XML-Dokument sollte anlegbar sein");
    document
        .LoadXml(&HSTRING::from(content))
        .expect("Windows sollte den Inhalt einlesen können");
    let texts = document
        .GetElementsByTagName(&HSTRING::from("text"))
        .expect("Textelemente sollten auffindbar sein");
    (0..texts.Length().unwrap())
        .map(|index| texts.Item(index).unwrap().InnerText().unwrap().to_string())
        .collect()
}

#[test]
fn benachrichtigung_nennt_projekt_und_terminal() {
    let content = toast_content("Kredr", "Agent wartet auf Eingabe");

    assert_eq!(
        texts_seen_by_windows(&content),
        ["Kredr", "Agent wartet auf Eingabe"]
    );
}

#[test]
fn sonderzeichen_in_namen_bleiben_woertlich_erhalten() {
    let content = toast_content("Müller & Söhne <alt>", "\"Tests\" 'schnell' wartet");

    assert_eq!(
        texts_seen_by_windows(&content),
        ["Müller & Söhne <alt>", "\"Tests\" 'schnell' wartet"]
    );
}
