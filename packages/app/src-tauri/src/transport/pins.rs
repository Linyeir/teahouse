//! Certificates the user accepted, by origin. A pin is the SHA-256 of the server's own (leaf)
//! certificate, so accepting trusts exactly that certificate and nothing it might sign.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::PathBuf;

use url::Url;

/// `https://host:port` (port always included), the key pins are stored under. A WebSocket
/// URL maps to the server it belongs to: `wss://` shares the pin of `https://`.
pub fn origin_of(url: &Url) -> Option<String> {
    let host = url.host_str()?;
    let port = url.port_or_known_default()?;
    let scheme = match url.scheme() {
        "wss" => "https",
        "ws" => "http",
        other => other,
    };
    Some(format!("{scheme}://{host}:{port}"))
}

/// `AB:CD:…` (as shown to the user) to raw bytes; None for anything else.
pub fn parse_fingerprint(text: &str) -> Option<[u8; 32]> {
    let bytes = text
        .split(':')
        .map(|pair| {
            u8::from_str_radix(pair, 16)
                .ok()
                .filter(|_| pair.len() == 2)
        })
        .collect::<Option<Vec<u8>>>()?;
    bytes.try_into().ok()
}

pub struct Pins {
    file: PathBuf,
    by_origin: BTreeMap<String, String>,
}

impl Pins {
    /// Reads `file`; a missing or unreadable file means no pins.
    pub fn load(file: PathBuf) -> Self {
        let by_origin = fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Self { file, by_origin }
    }

    pub fn get(&self, origin: &str) -> Option<[u8; 32]> {
        parse_fingerprint(self.by_origin.get(origin)?)
    }

    pub fn list(&self) -> &BTreeMap<String, String> {
        &self.by_origin
    }

    pub fn set(&mut self, origin: String, fingerprint: String) -> io::Result<()> {
        self.by_origin.insert(origin, fingerprint);
        self.save()
    }

    pub fn remove(&mut self, origin: &str) -> io::Result<()> {
        self.by_origin.remove(origin);
        self.save()
    }

    fn save(&self) -> io::Result<()> {
        if let Some(dir) = self.file.parent() {
            fs::create_dir_all(dir)?;
        }
        // Written aside and renamed, so a crash cannot leave half a file.
        let partial = self.file.with_extension("json.partial");
        fs::write(&partial, serde_json::to_vec_pretty(&self.by_origin)?)?;
        fs::rename(partial, &self.file)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_always_carry_the_port() {
        let origin = |url: &str| origin_of(&Url::parse(url).unwrap()).unwrap();
        assert_eq!(
            origin("https://teahouse.lan/api"),
            "https://teahouse.lan:443"
        );
        assert_eq!(origin("https://10.0.0.2:8443/x"), "https://10.0.0.2:8443");
        assert_eq!(origin("https://[::1]:8443"), "https://[::1]:8443");
        assert_eq!(
            origin("wss://teahouse.lan/api/ws"),
            "https://teahouse.lan:443"
        );
    }

    #[test]
    fn fingerprints_parse_only_in_full() {
        let full = vec!["AB"; 32].join(":");
        assert_eq!(parse_fingerprint(&full), Some([0xAB; 32]));
        assert_eq!(parse_fingerprint(&full.to_lowercase()), Some([0xAB; 32]));
        assert_eq!(parse_fingerprint(&vec!["AB"; 31].join(":")), None);
        assert_eq!(parse_fingerprint(&full.replacen("AB", "ABC", 1)), None);
        assert_eq!(parse_fingerprint("not a fingerprint"), None);
    }

    #[test]
    fn pins_survive_a_reload() {
        let dir = std::env::temp_dir().join(format!("teahouse-pins-{}", std::process::id()));
        let file = dir.join("pins.json");
        let fingerprint = vec!["0F"; 32].join(":");
        let mut pins = Pins::load(file.clone());
        pins.set("https://teahouse.lan:443".into(), fingerprint.clone())
            .unwrap();

        let reloaded = Pins::load(file.clone());
        assert_eq!(reloaded.get("https://teahouse.lan:443"), Some([0x0F; 32]));
        assert_eq!(reloaded.get("https://other.lan:443"), None);

        let mut pins = reloaded;
        pins.remove("https://teahouse.lan:443").unwrap();
        assert_eq!(Pins::load(file).get("https://teahouse.lan:443"), None);
        fs::remove_dir_all(dir).unwrap();
    }
}
