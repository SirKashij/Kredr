fn main() {
    // Das Manifest verlangt die Common Controls in Version 6, ohne die sich die
    // Dialoge nicht laden. Tauri bettet es nur in Kredr selbst ein; die Tests
    // mit der Mock-Runtime brauchen es ebenso, deshalb geht es an alle
    // Programmdateien.
    let windows_attributes = tauri_build::WindowsAttributes::new_without_app_manifest();
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows_attributes))
        .expect("tauri-build ist gescheitert");
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os == "windows" && target_env == "msvc" {
        let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed=windows-app-manifest.xml");
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
}
