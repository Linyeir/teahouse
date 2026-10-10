//! The Teahouse apps are a shell around the web client (packages/client). All data lives on
//! the user's server; the client keeps its local copy in the webview's IndexedDB.

mod probe;
#[cfg(test)]
mod test_tls;
mod transport;

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
        ])
        .register_asynchronous_uri_scheme_protocol(
            transport::assets::SCHEME,
            |ctx, request, responder| {
                let app = ctx.app_handle().clone();
                let path = request.uri().path().to_owned();
                tauri::async_runtime::spawn(async move {
                    let asset = match app.try_state::<transport::Transport>() {
                        Some(transport) => transport.serve_asset(&path).await,
                        None => transport::AssetResponse {
                            status: 503,
                            content_type: None,
                            body: Vec::new(),
                        },
                    };
                    let mut response = tauri::http::Response::builder().status(asset.status);
                    if let Some(content_type) = asset.content_type {
                        response = response.header(tauri::http::header::CONTENT_TYPE, content_type);
                    }
                    responder.respond(response.body(asset.body).unwrap_or_default());
                });
            },
        );
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
                app.path().app_cache_dir()?.join("assets"),
            )?);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Teahouse");
}
