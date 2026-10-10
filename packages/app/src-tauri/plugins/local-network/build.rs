// Both commands come from Tauri's Kotlin plugin base class.
const COMMANDS: &[&str] = &["check_permissions", "request_permissions"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
