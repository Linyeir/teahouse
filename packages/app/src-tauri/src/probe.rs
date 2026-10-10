//! Tells a server that is down apart from one whose certificate the webview rejects. In
//! JavaScript both are the same `TypeError`, so the client asks here when a request fails.
//!
//! The probe accepts any certificate in order to see it. That makes the connection unsafe for
//! data, so it never carries any: it ends after the handshake. The handshake signatures are
//! still checked, so the certificate shown belongs to the server that answered.

use std::net::{IpAddr, SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, verify_tls12_signature, verify_tls13_signature};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::server::ParsedCertificate;
use rustls::{ClientConfig, ClientConnection, DigitallySignedStruct, SignatureScheme};
use serde::Serialize;
use sha2::{Digest, Sha256};
use url::{Host, Url};

const TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Serialize)]
#[serde(tag = "result", rename_all = "camelCase")]
pub enum Probe {
    /// A plain-HTTP address: there is no certificate to look at.
    NotTls,
    /// The name does not resolve, or no TCP connection could be made.
    Unreachable { reason: String },
    /// TCP works, but the TLS handshake failed: no TLS on that port, or the server refused it.
    TlsFailed {
        reason: String,
        certificate: Option<Certificate>,
    },
    /// The handshake succeeded, whether or not the device trusts the certificate.
    Tls { certificate: Certificate },
}

/// The server's own (leaf) certificate.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Certificate {
    subject: Option<String>,
    issuer: Option<String>,
    /// Unix seconds.
    not_before: Option<i64>,
    not_after: Option<i64>,
    /// SHA-256 of the DER encoding, as `AB:CD:…`, like browsers and `openssl x509 -fingerprint`.
    sha256: String,
    self_signed: bool,
    /// Whether the certificate names the host the client connects to.
    matches_host: bool,
}

#[tauri::command]
pub async fn probe_server(url: String) -> Probe {
    tauri::async_runtime::spawn_blocking(move || probe(&url))
        .await
        .unwrap_or_else(|err| Probe::Unreachable {
            reason: err.to_string(),
        })
}

pub fn probe(url: &str) -> Probe {
    let unreachable = |reason: String| Probe::Unreachable { reason };
    let url = match Url::parse(url) {
        Ok(url) => url,
        Err(err) => return unreachable(format!("invalid address: {err}")),
    };
    if url.scheme() != "https" {
        return Probe::NotTls;
    }
    let port = url.port_or_known_default().unwrap_or(443);
    let (addrs, server_name) = match url.host() {
        Some(Host::Domain(domain)) => {
            let addrs = match (domain, port).to_socket_addrs() {
                Ok(addrs) => addrs.collect(),
                Err(err) => return unreachable(format!("{domain} does not resolve: {err}")),
            };
            match ServerName::try_from(domain.to_owned()) {
                Ok(name) => (addrs, name),
                Err(err) => return unreachable(format!("invalid host name: {err}")),
            }
        }
        Some(Host::Ipv4(ip)) => ip_target(IpAddr::V4(ip), port),
        Some(Host::Ipv6(ip)) => ip_target(IpAddr::V6(ip), port),
        None => return unreachable("the address has no host".into()),
    };

    let mut tcp = match connect(&addrs) {
        Ok(tcp) => tcp,
        Err(err) => return unreachable(err),
    };
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let recorder = Arc::new(Recorder {
        provider: provider.clone(),
        seen: Mutex::new(None),
    });
    let config =
        match ClientConfig::builder_with_provider(provider).with_safe_default_protocol_versions() {
            Ok(builder) => builder
                .dangerous()
                .with_custom_certificate_verifier(recorder.clone())
                .with_no_client_auth(),
            Err(err) => return unreachable(err.to_string()),
        };
    let mut conn = match ClientConnection::new(Arc::new(config), server_name.clone()) {
        Ok(conn) => conn,
        Err(err) => return unreachable(err.to_string()),
    };

    let mut handshake = Ok(());
    while conn.is_handshaking() {
        if let Err(err) = conn.complete_io(&mut tcp) {
            handshake = Err(err);
            break;
        }
    }
    // Nothing else is sent: say goodbye and let the socket close.
    conn.send_close_notify();
    let _ = conn.complete_io(&mut tcp);

    let certificate = recorder
        .seen
        .lock()
        .ok()
        .and_then(|mut seen| seen.take())
        .map(|der| describe(&der, &server_name));
    match (handshake, certificate) {
        (Ok(()), Some(certificate)) => Probe::Tls { certificate },
        (Ok(()), None) => Probe::TlsFailed {
            reason: "the server sent no certificate".into(),
            certificate: None,
        },
        (Err(err), certificate) => Probe::TlsFailed {
            reason: err.to_string(),
            certificate,
        },
    }
}

fn ip_target(ip: IpAddr, port: u16) -> (Vec<SocketAddr>, ServerName<'static>) {
    (
        vec![SocketAddr::new(ip, port)],
        ServerName::IpAddress(ip.into()),
    )
}

fn connect(addrs: &[SocketAddr]) -> Result<TcpStream, String> {
    let mut last = String::from("the name resolves to no address");
    for addr in addrs {
        match TcpStream::connect_timeout(addr, TIMEOUT) {
            Ok(tcp) => {
                // A server that accepts but never answers must not hang the probe.
                let _ = tcp.set_read_timeout(Some(TIMEOUT));
                let _ = tcp.set_write_timeout(Some(TIMEOUT));
                return Ok(tcp);
            }
            Err(err) => last = format!("{addr}: {err}"),
        }
    }
    Err(last)
}

fn describe(der: &CertificateDer<'_>, server_name: &ServerName<'_>) -> Certificate {
    let sha256 = Sha256::digest(der)
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(":");
    let matches_host = ParsedCertificate::try_from(der)
        .is_ok_and(|cert| rustls::client::verify_server_name(&cert, server_name).is_ok());
    match x509_parser::parse_x509_certificate(der) {
        Ok((_, cert)) => Certificate {
            subject: Some(cert.subject().to_string()),
            issuer: Some(cert.issuer().to_string()),
            not_before: Some(cert.validity().not_before.timestamp()),
            not_after: Some(cert.validity().not_after.timestamp()),
            sha256,
            self_signed: cert.subject().as_raw() == cert.issuer().as_raw(),
            matches_host,
        },
        Err(_) => Certificate {
            subject: None,
            issuer: None,
            not_before: None,
            not_after: None,
            sha256,
            self_signed: false,
            matches_host,
        },
    }
}

/// Accepts the server's certificate without judging it and keeps it for `describe`.
#[derive(Debug)]
struct Recorder {
    provider: Arc<CryptoProvider>,
    seen: Mutex<Option<CertificateDer<'static>>>,
}

impl ServerCertVerifier for Recorder {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        if let Ok(mut seen) = self.seen.lock() {
            *seen = Some(end_entity.clone().into_owned());
        }
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rcgen::{
        BasicConstraints, CertificateParams, CertifiedIssuer, DnType, IsCa, KeyPair, date_time_ymd,
    };
    use rustls::ServerConnection;
    use rustls::pki_types::PrivateKeyDer;
    use std::net::TcpListener;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn plain_http_is_not_probed() {
        assert!(matches!(probe("http://192.168.1.10:8787"), Probe::NotTls));
    }

    #[test]
    fn closed_port_is_unreachable() {
        // Bound and dropped again, so nothing listens there.
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        assert!(matches!(
            probe(&format!("https://127.0.0.1:{port}")),
            Probe::Unreachable { .. }
        ));
    }

    #[test]
    fn plain_http_server_on_https_fails_the_handshake() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            let (mut socket, _) = listener.accept().unwrap();
            let _ = socket.read(&mut [0; 1024]);
            let _ = socket.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n");
        });
        assert!(matches!(
            probe(&format!("https://127.0.0.1:{port}")),
            Probe::TlsFailed {
                certificate: None,
                ..
            }
        ));
    }

    fn params(name: &str) -> CertificateParams {
        let mut params = CertificateParams::new(vec![name.to_owned()]).unwrap();
        params.distinguished_name.push(DnType::CommonName, name);
        params
    }

    /// A TLS server on 127.0.0.1 for one handshake, presenting `cert` with `key`.
    fn tls_server(cert: CertificateDer<'static>, key: &KeyPair) -> u16 {
        let config = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![cert], PrivateKeyDer::Pkcs8(key.serialize_der().into()))
        .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut tcp, _) = listener.accept().unwrap();
            let mut conn = ServerConnection::new(Arc::new(config)).unwrap();
            while conn.is_handshaking() {
                if conn.complete_io(&mut tcp).is_err() {
                    return;
                }
            }
            let _ = conn.complete_io(&mut tcp);
        });
        port
    }

    fn tls_certificate(url: &str) -> Certificate {
        match probe(url) {
            Probe::Tls { certificate } => certificate,
            other => panic!("expected a TLS handshake, got {other:?}"),
        }
    }

    fn now() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
    }

    #[test]
    fn certificate_from_a_private_ca_is_described() {
        let ca_key = KeyPair::generate().unwrap();
        let mut ca_params = params("Teahouse Test CA");
        ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        let ca = CertifiedIssuer::self_signed(ca_params, ca_key).unwrap();
        let key = KeyPair::generate().unwrap();
        let cert = params("127.0.0.1").signed_by(&key, &ca).unwrap();
        let der = cert.der().clone();
        let port = tls_server(der.clone(), &key);

        let certificate = tls_certificate(&format!("https://127.0.0.1:{port}"));
        assert_eq!(certificate.subject.as_deref(), Some("CN=127.0.0.1"));
        assert_eq!(certificate.issuer.as_deref(), Some("CN=Teahouse Test CA"));
        assert!(!certificate.self_signed);
        assert!(certificate.matches_host);
        assert!(certificate.not_before.unwrap() <= now() && now() < certificate.not_after.unwrap());
        // What the user compares with `openssl x509 -fingerprint -sha256`.
        let expected = Sha256::digest(&der)
            .iter()
            .map(|byte| format!("{byte:02X}"))
            .collect::<Vec<_>>()
            .join(":");
        assert_eq!(certificate.sha256, expected);
        assert_eq!(certificate.sha256.len(), 32 * 3 - 1);
    }

    #[test]
    fn self_signed_certificate_is_flagged() {
        let key = KeyPair::generate().unwrap();
        let cert = params("127.0.0.1").self_signed(&key).unwrap();
        let port = tls_server(cert.der().clone(), &key);

        let certificate = tls_certificate(&format!("https://127.0.0.1:{port}"));
        assert!(certificate.self_signed);
        assert!(certificate.matches_host);
    }

    #[test]
    fn certificate_for_another_name_does_not_match() {
        let key = KeyPair::generate().unwrap();
        let cert = params("teahouse.lan").self_signed(&key).unwrap();
        let port = tls_server(cert.der().clone(), &key);

        assert!(!tls_certificate(&format!("https://127.0.0.1:{port}")).matches_host);
    }

    #[test]
    fn host_name_is_matched_against_the_certificate() {
        let key = KeyPair::generate().unwrap();
        let cert = params("localhost").self_signed(&key).unwrap();
        let port = tls_server(cert.der().clone(), &key);

        assert!(tls_certificate(&format!("https://localhost:{port}")).matches_host);
    }

    #[test]
    fn expired_certificate_is_still_described() {
        let key = KeyPair::generate().unwrap();
        let mut params = params("127.0.0.1");
        params.not_before = date_time_ymd(2020, 1, 1);
        params.not_after = date_time_ymd(2020, 2, 1);
        let cert = params.self_signed(&key).unwrap();
        let port = tls_server(cert.der().clone(), &key);

        let certificate = tls_certificate(&format!("https://127.0.0.1:{port}"));
        assert!(certificate.not_after.unwrap() < now());
    }

    #[test]
    fn name_that_does_not_resolve_is_unreachable() {
        match probe("https://teahouse.invalid") {
            Probe::Unreachable { reason } => {
                assert!(reason.contains("does not resolve"), "{reason}")
            }
            other => panic!("expected unreachable, got {other:?}"),
        }
    }
}
