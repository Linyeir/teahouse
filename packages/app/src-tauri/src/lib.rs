//! The Teahouse apps are a shell around the web client (packages/client). All data lives on
//! the user's server; the client keeps its local copy in the webview's IndexedDB.

mod probe;
#[cfg(test)]
mod test_tls;
mod transport;

#[cfg(not(target_os = "android"))]
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            probe::probe_server,
            transport::native_fetch,
            transport::native_socket_open,
            transport::native_socket_send,
            transport::native_socket_close,
            transport::pin_certificate,
            transport::remove_pin,
            transport::list_pins,
        ]);
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_local_network::init());
    builder
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // On Android the platform verifier needs its Kotlin component wired up first; until
            // then the app there does not use the native transport.
            #[cfg(not(target_os = "android"))]
            app.manage(transport::Transport::new(
                app.path().app_data_dir()?.join("pins.json"),
            )?);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Teahouse");
}
