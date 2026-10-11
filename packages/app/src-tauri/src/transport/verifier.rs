//! Decides whether to trust a server: first as the platform would (the OS trust store; on
//! Android also the CAs the app's network security config allows, user CAs included), then by
//! a certificate the user accepted (a pin). Only the chain check is replaced by the pin: the
//! handshake signatures are always checked, so a pin cannot be used without the server's key.

use std::sync::{Arc, Mutex};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, verify_tls12_signature, verify_tls13_signature};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use sha2::{Digest, Sha256};

#[derive(Debug)]
pub struct PinningVerifier {
    platform: Arc<dyn ServerCertVerifier>,
    provider: Arc<CryptoProvider>,
    pin: Option<[u8; 32]>,
    /// The last certificate that was not trusted, to show the user what they would accept.
    rejected: Mutex<Option<CertificateDer<'static>>>,
}

impl PinningVerifier {
    pub fn new(
        platform: Arc<dyn ServerCertVerifier>,
        provider: Arc<CryptoProvider>,
        pin: Option<[u8; 32]>,
    ) -> Self {
        Self {
            platform,
            provider,
            pin,
            rejected: Mutex::new(None),
        }
    }

    /// The certificate rejected most recently, if any. Kept, not taken: requests and the
    /// WebSocket share the verifier, and may fail on the same certificate at the same time.
    pub fn rejected(&self) -> Option<CertificateDer<'static>> {
        self.rejected.lock().ok()?.clone()
    }

    pub fn pin(&self) -> Option<[u8; 32]> {
        self.pin
    }
}

impl ServerCertVerifier for PinningVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let platform = self.platform.verify_server_cert(
            end_entity,
            intermediates,
            server_name,
            ocsp_response,
            now,
        );
        match (platform, self.pin) {
            (Ok(verified), _) => Ok(verified),
            // The user accepted exactly this certificate. That includes its validity dates: a
            // pinned certificate that expired still is the one they accepted.
            (Err(_), Some(pin)) if Sha256::digest(end_entity).as_slice() == pin => {
                Ok(ServerCertVerified::assertion())
            }
            (Err(err), _) => {
                if let Ok(mut rejected) = self.rejected.lock() {
                    *rejected = Some(end_entity.clone().into_owned());
                }
                Err(err)
            }
        }
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
