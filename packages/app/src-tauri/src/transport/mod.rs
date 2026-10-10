//! Requests that go through the app instead of the webview (issue #27), for servers the
//! webview cannot verify on its own: a self-signed certificate the user accepted (a pin), or a
//! private CA the platform trusts while the webview ignores it (seen with LineageOS's webview,
//! which disregards the app's network security config). The trust decision is the same on every
//! platform: the platform's verifier first, then the pin (verifier.rs).

pub mod assets;
mod pins;
mod socket;
mod verifier;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use rustls::ClientConfig;
use rustls::client::danger::ServerCertVerifier;
use rustls::crypto::CryptoProvider;
use rustls::pki_types::ServerName;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::probe::{Certificate, describe};
use assets::AssetCache;
use pins::{Pins, origin_of, parse_fingerprint};
pub use socket::SocketEvent;
use socket::{Outgoing, Sockets};
use verifier::PinningVerifier;

const TIMEOUT: Duration = Duration::from_secs(60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRequest {
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    /// Base64.
    body: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeResponse {
    status: u16,
    headers: Vec<(String, String)>,
    /// Base64.
    body: String,
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FetchError {
    InvalidRequest {
        message: String,
    },
    /// Neither the platform nor a pin trusts the server's certificate. `pinned` means a pin
    /// exists for this origin and the server now presents a different certificate.
    Untrusted {
        certificate: Certificate,
        pinned: bool,
    },
    /// The request did not complete (no connection, timeout, broken response).
    Network {
        message: String,
    },
}

fn invalid(message: impl ToString) -> FetchError {
    FetchError::InvalidRequest {
        message: message.to_string(),
    }
}

/// One client per origin, rebuilt when its pin changes. Requests and the WebSocket share its
/// TLS config and verifier.
#[derive(Clone)]
struct OriginClient {
    pin: Option<[u8; 32]>,
    client: reqwest::Client,
    tls: Arc<ClientConfig>,
    verifier: Arc<PinningVerifier>,
}

pub struct Transport {
    provider: Arc<CryptoProvider>,
    platform: Arc<dyn ServerCertVerifier>,
    pins: Mutex<Pins>,
    clients: Mutex<HashMap<String, OriginClient>>,
    sockets: Sockets,
    assets: AssetCache,
}

/// What the asset scheme answers.
#[derive(Debug)]
pub struct AssetResponse {
    pub status: u16,
    pub content_type: Option<String>,
    pub body: Vec<u8>,
}

impl AssetResponse {
    fn status(status: u16) -> Self {
        Self {
            status,
            content_type: None,
            body: Vec::new(),
        }
    }
}

// Not set up on Android yet: the platform verifier needs its Kotlin component there first.
#[cfg_attr(target_os = "android", allow(dead_code))]
impl Transport {
    pub fn new(pins_file: PathBuf, asset_dir: PathBuf) -> Result<Self, String> {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let platform = rustls_platform_verifier::Verifier::new(provider.clone())
            .map_err(|err| err.to_string())?;
        Ok(Self::with_platform(
            Arc::new(platform),
            provider,
            pins_file,
            asset_dir,
        ))
    }

    fn with_platform(
        platform: Arc<dyn ServerCertVerifier>,
        provider: Arc<CryptoProvider>,
        pins_file: PathBuf,
        asset_dir: PathBuf,
    ) -> Self {
        Self {
            provider,
            platform,
            pins: Mutex::new(Pins::load(pins_file)),
            clients: Mutex::new(HashMap::new()),
            sockets: Sockets::default(),
            assets: AssetCache::new(asset_dir),
        }
    }

    fn client_for(&self, origin: &str) -> Result<OriginClient, FetchError> {
        let pin = self.pins.lock().map_err(invalid)?.get(origin);
        let mut clients = self.clients.lock().map_err(invalid)?;
        if let Some(existing) = clients.get(origin).filter(|c| c.pin == pin) {
            return Ok(existing.clone());
        }
        let verifier = Arc::new(PinningVerifier::new(
            self.platform.clone(),
            self.provider.clone(),
            pin,
        ));
        let tls = ClientConfig::builder_with_provider(self.provider.clone())
            .with_safe_default_protocol_versions()
            .map_err(invalid)?
            .dangerous()
            .with_custom_certificate_verifier(verifier.clone())
            .with_no_client_auth();
        let client = reqwest::Client::builder()
            .use_preconfigured_tls(tls.clone())
            .timeout(TIMEOUT)
            .build()
            .map_err(invalid)?;
        let origin_client = OriginClient {
            pin,
            client,
            tls: Arc::new(tls),
            verifier,
        };
        clients.insert(origin.to_owned(), origin_client.clone());
        Ok(origin_client)
    }

    pub async fn fetch(&self, request: NativeRequest) -> Result<NativeResponse, FetchError> {
        let url = Url::parse(&request.url).map_err(invalid)?;
        if url.scheme() != "https" {
            return Err(invalid("only https addresses go through the app"));
        }
        let origin = origin_of(&url).ok_or_else(|| invalid("the address has no host"))?;
        let OriginClient {
            client, verifier, ..
        } = self.client_for(&origin)?;

        let method = reqwest::Method::from_bytes(request.method.as_bytes()).map_err(invalid)?;
        let mut builder = client.request(method, url.clone());
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        if let Some(body) = &request.body {
            builder = builder.body(BASE64.decode(body).map_err(invalid)?);
        }

        let response = match builder.send().await {
            Ok(response) => response,
            Err(err) => return Err(explain(&err, &url, &verifier)),
        };
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .filter_map(|(name, value)| Some((name.to_string(), value.to_str().ok()?.to_owned())))
            .collect();
        let body = response.bytes().await.map_err(|err| FetchError::Network {
            message: err.to_string(),
        })?;
        Ok(NativeResponse {
            status,
            headers,
            body: BASE64.encode(body),
        })
    }

    /// Opens a WebSocket to `url` (wss) and runs it; `on_event` gets its messages and, last,
    /// its close. Resolves once the connection is open, with the id for sending and closing.
    pub async fn open_socket(
        &self,
        url: &str,
        on_event: impl Fn(SocketEvent) + Send + 'static,
    ) -> Result<u32, FetchError> {
        let url = Url::parse(url).map_err(invalid)?;
        if url.scheme() != "wss" {
            return Err(invalid("only wss addresses go through the app"));
        }
        let origin = origin_of(&url).ok_or_else(|| invalid("the address has no host"))?;
        let OriginClient { tls, verifier, .. } = self.client_for(&origin)?;
        let connect = tokio_tungstenite::connect_async_tls_with_config(
            url.as_str(),
            None,
            true,
            Some(tokio_tungstenite::Connector::Rustls(tls)),
        );
        let (stream, _) = match tokio::time::timeout(CONNECT_TIMEOUT, connect).await {
            Ok(Ok(connected)) => connected,
            Ok(Err(err)) => return Err(explain(&err, &url, &verifier)),
            Err(_) => {
                return Err(FetchError::Network {
                    message: "timed out connecting".into(),
                });
            }
        };
        Ok(self.sockets.run(stream, on_event))
    }

    /// Answers a request of the asset scheme: from the cache, else fetched like native_fetch.
    pub async fn serve_asset(&self, path: &str) -> AssetResponse {
        let Some(url) = assets::asset_url(path) else {
            return AssetResponse::status(403);
        };
        if let Some((body, content_type)) = self.assets.get(&url) {
            return AssetResponse {
                status: 200,
                content_type: Some(content_type),
                body,
            };
        }
        let Some(origin) = origin_of(&url) else {
            return AssetResponse::status(403);
        };
        let Ok(OriginClient {
            client, verifier, ..
        }) = self.client_for(&origin)
        else {
            return AssetResponse::status(500);
        };
        let response = match client.get(url.clone()).send().await {
            Ok(response) => response,
            Err(err) => {
                return match explain(&err, &url, &verifier) {
                    FetchError::Untrusted { .. } => AssetResponse::status(502),
                    _ => AssetResponse::status(504),
                };
            }
        };
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_owned();
        let Ok(body) = response.bytes().await else {
            return AssetResponse::status(504);
        };
        if status != 200 {
            return AssetResponse::status(status);
        }
        if let Err(err) = self.assets.put(&url, &body, &content_type) {
            log::warn!("caching {url} failed: {err}");
        }
        AssetResponse {
            status,
            content_type: Some(content_type),
            body: body.to_vec(),
        }
    }

    pub fn send_socket(&self, id: u32, data: String) -> Result<(), String> {
        self.sockets.send(id, Outgoing::Text(data))
    }

    pub fn close_socket(
        &self,
        id: u32,
        code: Option<u16>,
        reason: Option<String>,
    ) -> Result<(), String> {
        self.sockets.send(
            id,
            Outgoing::Close(code.unwrap_or(1000), reason.unwrap_or_default()),
        )
    }

    /// Trusts the certificate with this fingerprint for `server`'s origin from now on.
    pub fn pin(&self, server: &str, sha256: &str) -> Result<(), String> {
        let url = Url::parse(server).map_err(|err| err.to_string())?;
        let origin = origin_of(&url).ok_or("the address has no host")?;
        let sha256 = sha256.to_uppercase();
        parse_fingerprint(&sha256).ok_or("not a SHA-256 fingerprint")?;
        self.pins
            .lock()
            .map_err(|err| err.to_string())?
            .set(origin, sha256)
            .map_err(|err| err.to_string())
    }

    pub fn unpin(&self, server: &str) -> Result<(), String> {
        let url = Url::parse(server).map_err(|err| err.to_string())?;
        let origin = origin_of(&url).ok_or("the address has no host")?;
        self.pins
            .lock()
            .map_err(|err| err.to_string())?
            .remove(&origin)
            .map_err(|err| err.to_string())
    }

    pub fn pins(&self) -> Vec<Pin> {
        self.pins
            .lock()
            .map(|pins| {
                pins.list()
                    .iter()
                    .map(|(origin, sha256)| Pin {
                        origin: origin.clone(),
                        sha256: sha256.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Pin {
    origin: String,
    sha256: String,
}

/// A failed connection: an untrusted certificate when the verifier rejected one, else the
/// network error.
fn explain(err: &dyn std::error::Error, url: &Url, verifier: &PinningVerifier) -> FetchError {
    let rejected = verifier.take_rejected();
    let server_name = url
        .host_str()
        .map(|host| {
            host.trim_start_matches('[')
                .trim_end_matches(']')
                .to_owned()
        })
        .and_then(|host| ServerName::try_from(host).ok());
    match (rejected, server_name) {
        (Some(der), Some(server_name)) => FetchError::Untrusted {
            certificate: describe(&der, &server_name),
            pinned: verifier.pin().is_some(),
        },
        _ => FetchError::Network {
            message: error_chain(err),
        },
    }
}

/// reqwest's own message is only "error sending request"; the causes say what happened.
fn error_chain(err: &dyn std::error::Error) -> String {
    let mut message = err.to_string();
    let mut source = err.source();
    while let Some(cause) = source {
        message.push_str(": ");
        message.push_str(&cause.to_string());
        source = cause.source();
    }
    message
}

#[tauri::command]
pub async fn native_fetch(
    transport: tauri::State<'_, Transport>,
    request: NativeRequest,
) -> Result<NativeResponse, FetchError> {
    transport.fetch(request).await
}

#[tauri::command]
pub async fn native_socket_open(
    transport: tauri::State<'_, Transport>,
    url: String,
    on_event: tauri::ipc::Channel<SocketEvent>,
) -> Result<u32, FetchError> {
    transport
        .open_socket(&url, move |event| {
            let _ = on_event.send(event);
        })
        .await
}

#[tauri::command]
pub fn native_socket_send(
    transport: tauri::State<'_, Transport>,
    id: u32,
    data: String,
) -> Result<(), String> {
    transport.send_socket(id, data)
}

#[tauri::command]
pub fn native_socket_close(
    transport: tauri::State<'_, Transport>,
    id: u32,
    code: Option<u16>,
    reason: Option<String>,
) -> Result<(), String> {
    transport.close_socket(id, code, reason)
}

#[tauri::command]
pub fn pin_certificate(
    transport: tauri::State<'_, Transport>,
    server: String,
    sha256: String,
) -> Result<(), String> {
    transport.pin(&server, &sha256)
}

#[tauri::command]
pub fn remove_pin(transport: tauri::State<'_, Transport>, server: String) -> Result<(), String> {
    transport.unpin(&server)
}

#[tauri::command]
pub fn list_pins(transport: tauri::State<'_, Transport>) -> Vec<Pin> {
    transport.pins()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::probe::fingerprint;
    use crate::test_tls::{https_capture_server, https_server, params, wss_server};
    use rcgen::{BasicConstraints, CertifiedIssuer, IsCa, KeyPair, date_time_ymd};

    const OK: &str = "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 11\r\nconnection: close\r\n\r\n{\"ok\":true}";

    /// A transport whose "platform" trusts `roots` and nothing else.
    fn transport(roots: Vec<rustls::pki_types::CertificateDer<'static>>, name: &str) -> Transport {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let mut store = rustls::RootCertStore::empty();
        for root in roots {
            store.add(root).unwrap();
        }
        let platform = rustls::client::WebPkiServerVerifier::builder_with_provider(
            Arc::new(store),
            provider.clone(),
        )
        .build()
        .unwrap_or_else(|_| {
            // An empty store is refused; a store with a root nobody uses trusts nothing.
            let key = KeyPair::generate().unwrap();
            let unused = params("unused").self_signed(&key).unwrap();
            let mut store = rustls::RootCertStore::empty();
            store.add(unused.der().clone()).unwrap();
            rustls::client::WebPkiServerVerifier::builder_with_provider(
                Arc::new(store),
                provider.clone(),
            )
            .build()
            .unwrap()
        });
        let file = std::env::temp_dir().join(format!(
            "teahouse-transport-{}-{name}/pins.json",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&file);
        let assets = file.with_file_name("assets");
        let _ = std::fs::remove_dir_all(&assets);
        Transport::with_platform(platform, provider, file, assets)
    }

    fn get(port: u16) -> NativeRequest {
        NativeRequest {
            url: format!("https://127.0.0.1:{port}/api/auth/status"),
            method: "GET".into(),
            headers: vec![("authorization".into(), "Bearer test".into())],
            body: None,
        }
    }

    #[tokio::test]
    async fn server_the_platform_trusts_needs_no_pin() {
        let ca_key = KeyPair::generate().unwrap();
        let mut ca_params = params("Teahouse Test CA");
        ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        let ca = CertifiedIssuer::self_signed(ca_params, ca_key).unwrap();
        let key = KeyPair::generate().unwrap();
        let cert = params("127.0.0.1").signed_by(&key, &ca).unwrap();
        let port = https_server(cert.der().clone(), &key, 1, OK);

        let response = transport(vec![ca.der().clone()], "trusted")
            .fetch(get(port))
            .await
            .unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(BASE64.decode(&response.body).unwrap(), br#"{"ok":true}"#);
        assert!(
            response
                .headers
                .contains(&("content-type".into(), "application/json".into()))
        );
    }

    #[tokio::test]
    async fn untrusted_certificate_is_reported_for_the_user_to_accept() {
        let key = KeyPair::generate().unwrap();
        let cert = params("127.0.0.1").self_signed(&key).unwrap();
        let port = https_server(cert.der().clone(), &key, 1, OK);

        match transport(vec![], "untrusted").fetch(get(port)).await {
            Err(FetchError::Untrusted {
                certificate,
                pinned,
            }) => {
                assert_eq!(certificate.sha256, fingerprint(cert.der()));
                assert!(certificate.self_signed);
                assert!(!pinned);
            }
            other => panic!("expected an untrusted certificate, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn accepted_certificate_is_trusted() {
        let key = KeyPair::generate().unwrap();
        let cert = params("127.0.0.1").self_signed(&key).unwrap();
        let port = https_server(cert.der().clone(), &key, 1, OK);
        let transport = transport(vec![], "pinned");
        let server = format!("https://127.0.0.1:{port}");
        transport.pin(&server, &fingerprint(cert.der())).unwrap();

        let response = transport.fetch(get(port)).await.unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(
            transport.pins(),
            vec![Pin {
                origin: format!("https://127.0.0.1:{port}"),
                sha256: fingerprint(cert.der()),
            }]
        );
    }

    #[tokio::test]
    async fn changed_certificate_of_a_pinned_server_is_refused() {
        let accepted_key = KeyPair::generate().unwrap();
        let accepted = params("127.0.0.1").self_signed(&accepted_key).unwrap();
        let key = KeyPair::generate().unwrap();
        let other = params("127.0.0.1").self_signed(&key).unwrap();
        let port = https_server(other.der().clone(), &key, 1, OK);
        let transport = transport(vec![], "changed");
        transport
            .pin(
                &format!("https://127.0.0.1:{port}"),
                &fingerprint(accepted.der()),
            )
            .unwrap();

        match transport.fetch(get(port)).await {
            Err(FetchError::Untrusted {
                certificate,
                pinned,
            }) => {
                assert_eq!(certificate.sha256, fingerprint(other.der()));
                assert!(pinned);
            }
            other => panic!("expected a refused certificate, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn pinned_certificate_that_expired_is_still_trusted() {
        let key = KeyPair::generate().unwrap();
        let mut expired = params("127.0.0.1");
        expired.not_before = date_time_ymd(2020, 1, 1);
        expired.not_after = date_time_ymd(2020, 2, 1);
        let cert = expired.self_signed(&key).unwrap();
        let port = https_server(cert.der().clone(), &key, 1, OK);
        let transport = transport(vec![], "expired");
        transport
            .pin(
                &format!("https://127.0.0.1:{port}"),
                &fingerprint(cert.der()),
            )
            .unwrap();

        assert_eq!(transport.fetch(get(port)).await.unwrap().status, 200);
    }

    #[tokio::test]
    async fn pin_is_per_origin() {
        let key = KeyPair::generate().unwrap();
        let cert = params("127.0.0.1").self_signed(&key).unwrap();
        let port = https_server(cert.der().clone(), &key, 1, OK);
        let transport = transport(vec![], "origin");
        // The same certificate, accepted for another port.
        transport
            .pin(
                &format!("https://127.0.0.1:{}", port + 1),
                &fingerprint(cert.der()),
            )
            .unwrap();

        assert!(matches!(
            transport.fetch(get(port)).await,
            Err(FetchError::Untrusted { pinned: false, .. })
        ));
    }

    #[tokio::test]
    async fn nothing_listening_is_a_network_error() {
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        assert!(matches!(
            transport(vec![], "closed").fetch(get(port)).await,
            Err(FetchError::Network { .. })
        ));
    }

    #[tokio::test]
    async fn only_https_goes_through_the_app() {
        let mut request = get(1);
        request.url = "http://127.0.0.1:1/".into();
        assert!(matches!(
            transport(vec![], "http").fetch(request).await,
            Err(FetchError::InvalidRequest { .. })
        ));
    }

    /// The verifier the app really uses, with a test CA added as if the OS trusted it.
    #[tokio::test]
    async fn real_platform_verifier_trusts_its_roots_and_pins() {
        let ca_key = KeyPair::generate().unwrap();
        let mut ca_params = params("Teahouse Test CA");
        ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        let ca = CertifiedIssuer::self_signed(ca_params, ca_key).unwrap();
        let key = KeyPair::generate().unwrap();
        let signed = params("127.0.0.1").signed_by(&key, &ca).unwrap();
        let trusted_port = https_server(signed.der().clone(), &key, 1, OK);
        let self_signed_key = KeyPair::generate().unwrap();
        let self_signed = params("127.0.0.1").self_signed(&self_signed_key).unwrap();
        let pinned_port = https_server(self_signed.der().clone(), &self_signed_key, 1, OK);

        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let platform = rustls_platform_verifier::Verifier::new_with_extra_roots(
            [ca.der().clone()],
            provider.clone(),
        )
        .unwrap();
        let file = std::env::temp_dir().join(format!(
            "teahouse-transport-{}-real/pins.json",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&file);
        let assets = file.with_file_name("assets");
        let transport = Transport::with_platform(Arc::new(platform), provider, file, assets);
        transport
            .pin(
                &format!("https://127.0.0.1:{pinned_port}"),
                &fingerprint(self_signed.der()),
            )
            .unwrap();

        assert_eq!(
            transport.fetch(get(trusted_port)).await.unwrap().status,
            200
        );
        assert_eq!(transport.fetch(get(pinned_port)).await.unwrap().status, 200);
    }

    #[tokio::test]
    async fn method_headers_and_body_reach_the_server() {
        let key = KeyPair::generate().unwrap();
        let cert = params("127.0.0.1").self_signed(&key).unwrap();
        let (port, request) = https_capture_server(cert.der().clone(), &key, OK);
        let transport = transport(vec![], "capture");
        transport
            .pin(
                &format!("https://127.0.0.1:{port}"),
                &fingerprint(cert.der()),
            )
            .unwrap();
        let body = "--b\r\ncontent-disposition: form-data; name=\"file\"; filename=\"a.png\"\r\n\r\n\u{89}PNG\r\n--b--\r\n";

        let response = transport
            .fetch(NativeRequest {
                url: format!("https://127.0.0.1:{port}/api/worlds/w1/backgrounds?x=1"),
                method: "POST".into(),
                headers: vec![
                    ("authorization".into(), "Bearer secret".into()),
                    (
                        "content-type".into(),
                        "multipart/form-data; boundary=b".into(),
                    ),
                ],
                body: Some(BASE64.encode(body)),
            })
            .await
            .unwrap();
        assert_eq!(response.status, 200);

        let raw = request.recv().unwrap();
        let text = String::from_utf8_lossy(&raw);
        assert!(
            text.starts_with("POST /api/worlds/w1/backgrounds?x=1 HTTP/1.1\r\n"),
            "{text}"
        );
        assert!(text.contains("authorization: Bearer secret\r\n"), "{text}");
        assert!(
            text.contains("content-type: multipart/form-data; boundary=b\r\n"),
            "{text}"
        );
        assert!(raw.ends_with(body.as_bytes()), "{text}");
    }

    /// A transport and its socket events for a pinned self-signed WebSocket server.
    async fn pinned_socket(
        name: &str,
    ) -> (
        Transport,
        u32,
        tokio::sync::mpsc::UnboundedReceiver<SocketEvent>,
        std::sync::mpsc::Receiver<String>,
    ) {
        let key = KeyPair::generate().unwrap();
        let cert = params("127.0.0.1").self_signed(&key).unwrap();
        let (port, server) = wss_server(cert.der().clone(), &key);
        let transport = transport(vec![], name);
        transport
            .pin(
                &format!("https://127.0.0.1:{port}"),
                &fingerprint(cert.der()),
            )
            .unwrap();
        let (sender, events) = tokio::sync::mpsc::unbounded_channel();
        let id = transport
            .open_socket(
                &format!("wss://127.0.0.1:{port}/api/ws?token=t"),
                move |event| {
                    let _ = sender.send(event);
                },
            )
            .await
            .unwrap();
        (transport, id, events, server)
    }

    async fn next(events: &mut tokio::sync::mpsc::UnboundedReceiver<SocketEvent>) -> SocketEvent {
        tokio::time::timeout(Duration::from_secs(5), events.recv())
            .await
            .expect("an event within 5 s")
            .expect("the socket to send an event")
    }

    fn message(data: &str) -> SocketEvent {
        SocketEvent::Message { data: data.into() }
    }

    #[tokio::test]
    async fn socket_carries_messages_both_ways_and_the_close_code() {
        let (transport, id, mut events, _) = pinned_socket("socket").await;
        assert_eq!(next(&mut events).await, message("hello"));
        transport.send_socket(id, "ping".into()).unwrap();
        assert_eq!(next(&mut events).await, message("echo:ping"));
        // The server signs the device out.
        transport.send_socket(id, "close-me".into()).unwrap();
        assert_eq!(
            next(&mut events).await,
            SocketEvent::Close {
                code: 4401,
                reason: "signed out".into()
            }
        );
        assert!(transport.send_socket(id, "late".into()).is_err());
    }

    #[tokio::test]
    async fn closing_a_socket_tells_the_server() {
        let (transport, id, mut events, server) = pinned_socket("close").await;
        assert_eq!(next(&mut events).await, message("hello"));
        transport.close_socket(id, None, None).unwrap();
        assert_eq!(
            next(&mut events).await,
            SocketEvent::Close {
                code: 1000,
                reason: String::new()
            }
        );
        assert_eq!(
            server.recv_timeout(Duration::from_secs(5)).unwrap(),
            "closed by client"
        );
    }

    #[tokio::test]
    async fn socket_to_an_untrusted_server_is_refused() {
        let key = KeyPair::generate().unwrap();
        let cert = params("127.0.0.1").self_signed(&key).unwrap();
        let (port, _) = wss_server(cert.der().clone(), &key);
        let result = transport(vec![], "socket-untrusted")
            .open_socket(&format!("wss://127.0.0.1:{port}/api/ws"), |_| {})
            .await;
        match result {
            Err(FetchError::Untrusted {
                certificate,
                pinned,
            }) => {
                assert_eq!(certificate.sha256, fingerprint(cert.der()));
                assert!(!pinned);
            }
            other => panic!("expected an untrusted certificate, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn only_wss_sockets_go_through_the_app() {
        let transport = transport(vec![], "socket-ws");
        assert!(matches!(
            transport
                .open_socket("ws://127.0.0.1:1/api/ws", |_| {})
                .await,
            Err(FetchError::InvalidRequest { .. })
        ));
        assert!(transport.send_socket(99, "nobody".into()).is_err());
    }

    /// The scheme's request path for an asset URL, as convertFileSrc builds it.
    fn asset_path(url: &str) -> String {
        format!(
            "/{}",
            percent_encoding::utf8_percent_encode(url, percent_encoding::NON_ALPHANUMERIC)
        )
    }

    const PNG: &str = "HTTP/1.1 200 OK\r\ncontent-type: image/png\r\ncontent-length: 7\r\ncache-control: private, max-age=31536000, immutable\r\nconnection: close\r\n\r\nPNGDATA";

    #[tokio::test]
    async fn asset_is_fetched_once_then_served_from_the_cache() {
        let key = KeyPair::generate().unwrap();
        let cert = params("127.0.0.1").self_signed(&key).unwrap();
        // One connection only: a second fetch would fail.
        let port = https_server(cert.der().clone(), &key, 1, PNG);
        let transport = transport(vec![], "assets");
        transport
            .pin(
                &format!("https://127.0.0.1:{port}"),
                &fingerprint(cert.der()),
            )
            .unwrap();
        let asset = |token: &str| {
            asset_path(&format!(
                "https://127.0.0.1:{port}/api/worlds/w1/assets/backgrounds/harbor-1.png?token={token}"
            ))
        };

        let first = transport.serve_asset(&asset("one")).await;
        assert_eq!(first.status, 200);
        assert_eq!(first.content_type.as_deref(), Some("image/png"));
        assert_eq!(first.body, b"PNGDATA");
        // Another sign-in, the same image: from the cache.
        let second = transport.serve_asset(&asset("two")).await;
        assert_eq!(second.status, 200);
        assert_eq!(second.body, b"PNGDATA");
    }

    #[tokio::test]
    async fn missing_asset_is_not_cached() {
        const NOT_FOUND: &str =
            "HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n";
        let key = KeyPair::generate().unwrap();
        let cert = params("127.0.0.1").self_signed(&key).unwrap();
        let port = https_server(cert.der().clone(), &key, 2, NOT_FOUND);
        let transport = transport(vec![], "assets-missing");
        transport
            .pin(
                &format!("https://127.0.0.1:{port}"),
                &fingerprint(cert.der()),
            )
            .unwrap();
        let path = asset_path(&format!(
            "https://127.0.0.1:{port}/api/worlds/w1/assets/gone.png"
        ));
        assert_eq!(transport.serve_asset(&path).await.status, 404);
        assert_eq!(transport.serve_asset(&path).await.status, 404);
    }

    #[tokio::test]
    async fn asset_from_an_untrusted_server_is_refused() {
        let key = KeyPair::generate().unwrap();
        let cert = params("127.0.0.1").self_signed(&key).unwrap();
        let port = https_server(cert.der().clone(), &key, 1, PNG);
        let path = asset_path(&format!(
            "https://127.0.0.1:{port}/api/worlds/w1/assets/a.png"
        ));
        let response = transport(vec![], "assets-untrusted")
            .serve_asset(&path)
            .await;
        assert_eq!(response.status, 502);
        assert!(response.body.is_empty());
    }

    #[tokio::test]
    async fn the_scheme_serves_only_world_assets() {
        let transport = transport(vec![], "assets-other");
        assert_eq!(
            transport
                .serve_asset(&asset_path("https://127.0.0.1:1/api/chats"))
                .await
                .status,
            403
        );
    }

    /// The JSON shapes packages/client/src/transport.ts sends and expects.
    #[test]
    fn json_matches_the_client() {
        let request: NativeRequest = serde_json::from_str(
            r#"{"url":"https://a.lan/x","method":"POST","headers":[["content-type","application/json"]],"body":"e30="}"#,
        )
        .unwrap();
        assert_eq!(
            request.headers,
            vec![("content-type".to_owned(), "application/json".to_owned())]
        );
        assert_eq!(request.body.as_deref(), Some("e30="));
        let without_body: NativeRequest =
            serde_json::from_str(r#"{"url":"https://a.lan/x","method":"GET","headers":[]}"#)
                .unwrap();
        assert!(without_body.body.is_none());

        let response = serde_json::to_value(NativeResponse {
            status: 200,
            headers: vec![("content-type".into(), "application/json".into())],
            body: "e30=".into(),
        })
        .unwrap();
        assert_eq!(
            response,
            serde_json::json!({ "status": 200, "headers": [["content-type", "application/json"]], "body": "e30=" })
        );

        let key = KeyPair::generate().unwrap();
        let cert = params("a.lan").self_signed(&key).unwrap();
        let untrusted = serde_json::to_value(FetchError::Untrusted {
            certificate: describe(cert.der(), &ServerName::try_from("a.lan").unwrap()),
            pinned: true,
        })
        .unwrap();
        assert_eq!(untrusted["kind"], "untrusted");
        assert_eq!(untrusted["pinned"], true);
        assert_eq!(untrusted["certificate"]["selfSigned"], true);
        assert_eq!(untrusted["certificate"]["matchesHost"], true);
        assert_eq!(
            serde_json::to_value(message("x")).unwrap(),
            serde_json::json!({ "type": "message", "data": "x" })
        );
        assert_eq!(
            serde_json::to_value(SocketEvent::Close {
                code: 4401,
                reason: "out".into()
            })
            .unwrap(),
            serde_json::json!({ "type": "close", "code": 4401, "reason": "out" })
        );
        let network = serde_json::to_value(FetchError::Network {
            message: "refused".into(),
        })
        .unwrap();
        assert_eq!(
            network,
            serde_json::json!({ "kind": "network", "message": "refused" })
        );
    }

    #[test]
    fn invalid_fingerprints_are_not_pinned() {
        let transport = transport(vec![], "invalid");
        assert!(transport.pin("https://teahouse.lan", "AB:CD").is_err());
        assert!(transport.pins().is_empty());
    }
}
