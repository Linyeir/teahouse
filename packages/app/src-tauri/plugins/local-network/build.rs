// The permission commands come from Tauri's Kotlin plugin base class.
const COMMANDS: &[&str] = &["check_permissions", "request_permissions", "open_app_settings"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
