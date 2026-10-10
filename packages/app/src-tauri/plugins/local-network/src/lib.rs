//! Android 17 blocks connections to the local network for apps that target it, the webview's
//! included, until the user grants `ACCESS_LOCAL_NETWORK` ("Nearby devices"). A server at
//! home is usually on that network. The permission is a runtime one, so it takes Kotlin
//! (android/), which this plugin carries; the client asks through `check_permissions` and
//! `request_permissions`, and `open_app_settings` once Android no longer asks. Other
//! platforms have no such permission.

use tauri::{
    Runtime,
    plugin::{Builder, TauriPlugin},
};

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("local-network")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            _api.register_android_plugin(
                "io.github.linyeir.teahouse.localnetwork",
                "LocalNetworkPlugin",
            )?;
            Ok(())
        })
        .build()
}
