//! Requests that go through the app instead of the webview (issue #27), for servers the
//! webview cannot verify on its own: a self-signed certificate the user accepted (a pin), or a
//! private CA the platform trusts while the webview ignores it (seen with LineageOS's webview,
//! which disregards the app's network security config). The trust decision is the same on every
//! platform: the platform's verifier first, then the pin (verifier.rs).

mod pins;
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
use pins::{Pins, origin_of, parse_fingerprint};
use verifier::PinningVerifier;

const TIMEOUT: Duration = Duration::from_secs(60);

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

/// One client per origin, rebuilt when its pin changes.
struct OriginClient {
    pin: Option<[u8; 32]>,
    client: reqwest::Client,
    verifier: Arc<PinningVerifier>,
}

pub struct Transport {
    provider: Arc<CryptoProvider>,
    platform: Arc<dyn ServerCertVerifier>,
    pins: Mutex<Pins>,
    clients: Mutex<HashMap<String, OriginClient>>,
}

// Not set up on Android yet: the platform verifier needs its Kotlin component there first.
#[cfg_attr(target_os = "android", allow(dead_code))]
impl Transport {
    pub fn new(pins_file: PathBuf) -> Result<Self, String> {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let platform = rustls_platform_verifier::Verifier::new(provider.clone())
            .map_err(|err| err.to_string())?;
        Ok(Self::with_platform(Arc::new(platform), provider, pins_file))
    }

    fn with_platform(
        platform: Arc<dyn ServerCertVerifier>,
        provider: Arc<CryptoProvider>,
        pins_file: PathBuf,
    ) -> Self {
        Self {
            provider,
            platform,
            pins: Mutex::new(Pins::load(pins_file)),
            clients: Mutex::new(HashMap::new()),
        }
    }

    fn client_for(
        &self,
        origin: &str,
    ) -> Result<(reqwest::Client, Arc<PinningVerifier>), FetchError> {
        let pin = self.pins.lock().map_err(invalid)?.get(origin);
        let mut clients = self.clients.lock().map_err(invalid)?;
        if let Some(existing) = clients.get(origin).filter(|c| c.pin == pin) {
            return Ok((existing.client.clone(), existing.verifier.clone()));
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
            .use_preconfigured_tls(tls)
            .timeout(TIMEOUT)
            .build()
            .map_err(invalid)?;
        clients.insert(
            origin.to_owned(),
            OriginClient {
                pin,
                client: client.clone(),
                verifier: verifier.clone(),
            },
        );
        Ok((client, verifier))
    }

    pub async fn fetch(&self, request: NativeRequest) -> Result<NativeResponse, FetchError> {
        let url = Url::parse(&request.url).map_err(invalid)?;
        if url.scheme() != "https" {
            return Err(invalid("only https addresses go through the app"));
        }
        let origin = origin_of(&url).ok_or_else(|| invalid("the address has no host"))?;
        let (client, verifier) = self.client_for(&origin)?;

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
            Err(err) => return Err(self.explain(err, &url, &verifier)),
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

    /// A failed request: an untrusted certificate when the verifier rejected one, else the
    /// network error.
    fn explain(&self, err: reqwest::Error, url: &Url, verifier: &PinningVerifier) -> FetchError {
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
                message: error_chain(&err),
            },
        }
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
    use crate::test_tls::{https_capture_server, https_server, params};
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
        Transport::with_platform(platform, provider, file)
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
        let transport = Transport::with_platform(Arc::new(platform), provider, file);
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
