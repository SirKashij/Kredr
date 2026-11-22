//! Tests der vorbereiteten Antworten auf Ordnerdialoge über ihre öffentliche
//! Schnittstelle.

use std::ffi::OsStr;
use std::path::PathBuf;

use kredr_lib::dialog_answers::DialogAnswers;

#[test]
fn ohne_vorbereitete_ordner_erscheint_der_dialog() {
    let answers = DialogAnswers::default();

    assert_eq!(answers.next(), None);
}

#[test]
fn die_ordner_kommen_der_reihe_nach_und_der_letzte_bleibt() {
    let answers = DialogAnswers::from_list(OsStr::new("C:\\eins;C:\\zwei"));

    assert_eq!(answers.next(), Some(PathBuf::from("C:\\eins")));
    assert_eq!(answers.next(), Some(PathBuf::from("C:\\zwei")));
    // Wer denselben Ordner noch einmal wählt, etwa für eine Ablehnung, braucht keinen Neustart.
    assert_eq!(answers.next(), Some(PathBuf::from("C:\\zwei")));
}

#[test]
fn eine_leere_liste_bereitet_nichts_vor() {
    let answers = DialogAnswers::from_list(OsStr::new(""));

    assert_eq!(answers.next(), None);
}
