//! TLS servers for tests: real handshakes on 127.0.0.1, with certificates made by rcgen.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use rcgen::{CertificateParams, DnType, KeyPair};
use rustls::ServerConnection;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};

pub fn params(name: &str) -> CertificateParams {
    let mut params = CertificateParams::new(vec![name.to_owned()]).unwrap();
    params.distinguished_name.push(DnType::CommonName, name);
    params
}

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

fn server_config(cert: CertificateDer<'static>, key: &KeyPair) -> Arc<rustls::ServerConfig> {
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(vec![cert], PrivateKeyDer::Pkcs8(key.serialize_der().into()))
    .unwrap();
    Arc::new(config)
}

/// A TLS server for one handshake, presenting `cert` with `key`. Returns its port.
pub fn tls_server(cert: CertificateDer<'static>, key: &KeyPair) -> u16 {
    https_server(cert, key, 1, "")
}

/// An HTTPS server for `connections` connections that answers every request with `response`
/// (a complete HTTP/1.1 response). Returns its port.
pub fn https_server(
    cert: CertificateDer<'static>,
    key: &KeyPair,
    connections: usize,
    response: &'static str,
) -> u16 {
    let config = server_config(cert, key);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for _ in 0..connections {
            let Ok((mut tcp, _)) = listener.accept() else {
                return;
            };
            let mut conn = ServerConnection::new(config.clone()).unwrap();
            let mut tls = rustls::Stream::new(&mut conn, &mut tcp);
            if response.is_empty() {
                // Handshake only.
                let _ = tls.flush();
                let _ = tls.read(&mut [0; 1]);
                continue;
            }
            let mut request = Vec::new();
            let mut buffer = [0; 4096];
            while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                match tls.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => request.extend_from_slice(&buffer[..n]),
                }
            }
            let _ = tls.write_all(response.as_bytes());
            let _ = tls.flush();
            conn.send_close_notify();
            let _ = conn.complete_io(&mut tcp);
        }
    });
    port
}

/// An HTTPS server for one request that answers with `response` and hands the raw request
/// (head and body) to the test.
pub fn https_capture_server(
    cert: CertificateDer<'static>,
    key: &KeyPair,
    response: &'static str,
) -> (u16, std::sync::mpsc::Receiver<Vec<u8>>) {
    let config = server_config(cert, key);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let (mut tcp, _) = listener.accept().unwrap();
        let mut conn = ServerConnection::new(config).unwrap();
        let mut tls = rustls::Stream::new(&mut conn, &mut tcp);
        let mut request = Vec::new();
        let mut buffer = [0; 4096];
        loop {
            if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&request[..end]).to_lowercase();
                let length = head
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length:"))
                    .and_then(|value| value.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                if request.len() >= end + 4 + length {
                    break;
                }
            }
            match tls.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => request.extend_from_slice(&buffer[..n]),
            }
        }
        let _ = tls.write_all(response.as_bytes());
        let _ = tls.flush();
        let _ = sender.send(request);
        conn.send_close_notify();
        let _ = conn.complete_io(&mut tcp);
    });
    (port, receiver)
}
