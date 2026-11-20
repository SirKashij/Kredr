//! Tests der Fenstergeometrie: reine Entscheidungen ohne Fenster und Bildschirm.

use kredr_lib::window_geometry::{Observed, Screen, WindowGeometry};

const PRIMARY: Screen = Screen {
    x: 0,
    y: 0,
    width: 1920,
    height: 1040,
};
/// Ein zweiter Bildschirm links vom ersten.
const LEFT: Screen = Screen {
    x: -2560,
    y: 0,
    width: 2560,
    height: 1400,
};

fn window(x: i32, y: i32, width: u32, height: u32) -> WindowGeometry {
    WindowGeometry {
        x,
        y,
        width,
        height,
        maximized: false,
    }
}

#[test]
fn ein_fenster_auf_einem_bildschirm_bleibt_wo_es_war() {
    let stored = window(200, 100, 1280, 800);

    assert_eq!(stored.visible_on(&[PRIMARY]), stored);
}

#[test]
fn ein_fenster_auf_dem_zweiten_bildschirm_bleibt_dort() {
    let stored = window(-2000, 300, 1280, 800);

    assert_eq!(stored.visible_on(&[PRIMARY, LEFT]), stored);
}

#[test]
fn fehlt_der_zweite_bildschirm_erscheint_das_fenster_mittig_auf_dem_ersten() {
    let stored = window(-2000, 300, 1280, 800);

    assert_eq!(stored.visible_on(&[PRIMARY]), window(320, 120, 1280, 800));
}

#[test]
fn ein_fenster_das_nur_mit_einem_schmalen_streifen_hineinragt_gilt_als_nicht_sichtbar() {
    let stored = window(1900, 100, 1280, 800);

    assert_eq!(stored.visible_on(&[PRIMARY]), window(320, 120, 1280, 800));
}

#[test]
fn ein_fenster_dessen_titelleiste_ueber_oder_unter_dem_bildschirm_liegt_wird_hereingeholt() {
    let above = window(200, -300, 1280, 800);
    let below = window(200, 1030, 1280, 800);

    assert_eq!(above.visible_on(&[PRIMARY]), window(320, 120, 1280, 800));
    assert_eq!(below.visible_on(&[PRIMARY]), window(320, 120, 1280, 800));
}

#[test]
fn ein_am_rand_angedocktes_fenster_bleibt_trotz_unsichtbarem_rahmen_wo_es_war() {
    // Windows legt den unsichtbaren Rahmen eines angedockten Fensters knapp außerhalb ab.
    let docked = window(-7, 0, 974, 1047);

    assert_eq!(docked.visible_on(&[PRIMARY]), docked);
}

#[test]
fn ein_hereingeholtes_fenster_wird_hoechstens_so_gross_wie_der_bildschirm() {
    let stored = window(-2560, 0, 2560, 1400);

    assert_eq!(stored.visible_on(&[PRIMARY]), window(0, 0, 1920, 1040));
}

#[test]
fn ein_hereingeholtes_fenster_bleibt_maximiert() {
    let stored = WindowGeometry {
        maximized: true,
        ..window(-2000, 300, 1280, 800)
    };

    assert!(stored.visible_on(&[PRIMARY]).maximized);
}

#[test]
fn ohne_bekannte_bildschirme_bleibt_die_geometrie_unveraendert() {
    let stored = window(-2000, 300, 1280, 800);

    assert_eq!(stored.visible_on(&[]), stored);
}

#[test]
fn ein_gewoehnliches_fenster_wird_mit_ort_und_groesse_gemerkt() {
    let previous = Some(window(0, 0, 800, 600));

    let remembered = WindowGeometry::remember(previous, Observed::Normal(window(50, 60, 900, 700)));

    assert_eq!(remembered, Some(window(50, 60, 900, 700)));
}

#[test]
fn ein_maximiertes_fenster_behaelt_ort_und_groesse_von_davor() {
    let previous = Some(window(50, 60, 900, 700));

    let remembered =
        WindowGeometry::remember(previous, Observed::Maximized(window(-8, -8, 1936, 1056)));

    assert_eq!(
        remembered,
        Some(WindowGeometry {
            maximized: true,
            ..window(50, 60, 900, 700)
        })
    );
}

#[test]
fn ein_von_anfang_an_maximiertes_fenster_wird_maximiert_gemerkt() {
    let remembered =
        WindowGeometry::remember(None, Observed::Maximized(window(-8, -8, 1936, 1056)));

    assert_eq!(
        remembered,
        Some(WindowGeometry {
            maximized: true,
            ..window(-8, -8, 1936, 1056)
        })
    );
}

#[test]
fn ein_minimiertes_fenster_aendert_das_gemerkte_nicht() {
    let previous = Some(window(50, 60, 900, 700));

    assert_eq!(
        WindowGeometry::remember(previous, Observed::Minimized),
        previous
    );
    assert_eq!(WindowGeometry::remember(None, Observed::Minimized), None);
}
