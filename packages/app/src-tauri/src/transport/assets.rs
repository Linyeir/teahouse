//! Images through the app: `<img>` cannot use native_fetch, so world assets of servers on the
//! native transport load from a URI scheme of the app, which fetches them like native_fetch.
//! The client builds the URL with `convertFileSrc(url, "teahouse-asset")`: the asset's full
//! URL, percent-encoded, as the path (`teahouse-asset://localhost/https%3A%2F%2F…`, or
//! `http://teahouse-asset.localhost/…` on Windows and Android).
//!
//! The webview's HTTP cache does not cover a custom scheme, so assets are cached on disk. The
//! server marks them immutable (a new upload gets a new file name), so the cache never asks
//! again; it only drops the least recently used files above a size limit.

use std::fs;
use std::io;
use std::path::PathBuf;
use std::time::SystemTime;

use sha2::{Digest, Sha256};
use url::Url;

pub const SCHEME: &str = "teahouse-asset";
const MAX_CACHE_BYTES: u64 = 256 * 1024 * 1024;

/// The asset URL in a request path of the scheme; None for anything that is not a Teahouse
/// world asset over https, so the scheme cannot be used to fetch other things.
pub fn asset_url(path: &str) -> Option<Url> {
    let decoded = percent_encoding::percent_decode_str(path.strip_prefix('/')?)
        .decode_utf8()
        .ok()?;
    let url = Url::parse(&decoded).ok()?;
    let mut segments = url.path_segments()?;
    let is_asset = url.scheme() == "https"
        && segments.next() == Some("api")
        && segments.next() == Some("worlds")
        && segments.next().is_some_and(|id| !id.is_empty())
        && segments.next() == Some("assets")
        && segments.next().is_some_and(|file| !file.is_empty());
    is_asset.then_some(url)
}

/// The URL without its `token` parameter: the same asset for every device and sign-in.
fn cache_key(url: &Url) -> String {
    let mut url = url.clone();
    let others: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(name, _)| name != "token")
        .map(|(name, value)| (name.into_owned(), value.into_owned()))
        .collect();
    if others.is_empty() {
        url.set_query(None);
    } else {
        url.query_pairs_mut().clear().extend_pairs(others);
    }
    url.to_string()
}

pub struct AssetCache {
    dir: PathBuf,
    max_bytes: u64,
}

impl AssetCache {
    pub fn new(dir: PathBuf) -> Self {
        Self::with_limit(dir, MAX_CACHE_BYTES)
    }

    pub fn with_limit(dir: PathBuf, max_bytes: u64) -> Self {
        Self { dir, max_bytes }
    }

    fn file(&self, url: &Url) -> PathBuf {
        let name: String = Sha256::digest(cache_key(url).as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        self.dir.join(name)
    }

    /// The cached bytes and content type. Reading refreshes the file's time for pruning.
    pub fn get(&self, url: &Url) -> Option<(Vec<u8>, String)> {
        let file = self.file(url);
        let stored = fs::read(&file).ok()?;
        // One line of content type, then the bytes.
        let newline = stored.iter().position(|&b| b == b'\n')?;
        let content_type = String::from_utf8(stored[..newline].to_vec()).ok()?;
        let _ = fs::File::options()
            .append(true)
            .open(&file)
            .and_then(|f| f.set_modified(SystemTime::now()));
        Some((stored[newline + 1..].to_vec(), content_type))
    }

    pub fn put(&self, url: &Url, bytes: &[u8], content_type: &str) -> io::Result<()> {
        fs::create_dir_all(&self.dir)?;
        let file = self.file(url);
        let partial = file.with_extension("partial");
        let mut stored = Vec::with_capacity(content_type.len() + 1 + bytes.len());
        stored.extend_from_slice(content_type.replace('\n', " ").as_bytes());
        stored.push(b'\n');
        stored.extend_from_slice(bytes);
        fs::write(&partial, stored)?;
        fs::rename(partial, file)?;
        self.prune()
    }

    /// Drops the least recently used files until the cache fits its limit.
    fn prune(&self) -> io::Result<()> {
        let mut files: Vec<(SystemTime, u64, PathBuf)> = fs::read_dir(&self.dir)?
            .filter_map(|entry| {
                let entry = entry.ok()?;
                let meta = entry.metadata().ok()?;
                if !meta.is_file() {
                    return None;
                }
                Some((meta.modified().ok()?, meta.len(), entry.path()))
            })
            .collect();
        let mut total: u64 = files.iter().map(|(_, size, _)| size).sum();
        files.sort();
        for (_, size, path) in files {
            if total <= self.max_bytes {
                break;
            }
            if fs::remove_file(&path).is_ok() {
                total -= size;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path(url: &str) -> String {
        format!(
            "/{}",
            percent_encoding::utf8_percent_encode(url, percent_encoding::NON_ALPHANUMERIC)
        )
    }

    #[test]
    fn only_world_assets_over_https_are_served() {
        let asset = "https://teahouse.lan/api/worlds/w1/assets/backgrounds/harbor-1.png?token=t";
        assert_eq!(asset_url(&path(asset)).unwrap().as_str(), asset);
        for other in [
            "http://teahouse.lan/api/worlds/w1/assets/a.png",
            "https://teahouse.lan/api/chats",
            "https://teahouse.lan/api/worlds/w1/files",
            "https://teahouse.lan/api/worlds//assets/a.png",
            "https://teahouse.lan/api/worlds/w1/assets/",
            "https://evil.example/elsewhere/assets/a.png",
        ] {
            assert!(asset_url(&path(other)).is_none(), "{other}");
        }
        assert!(asset_url("/%FF").is_none());
        // As JavaScript's encodeURIComponent writes it (convertFileSrc).
        assert_eq!(
            asset_url("/https%3A%2F%2Fteahouse.lan%2Fapi%2Fworlds%2Fw1%2Fassets%2Fbackgrounds%2Fharbor-1.png%3Ftoken%3Dt")
                .unwrap()
                .as_str(),
            asset
        );
    }

    #[test]
    fn the_token_does_not_change_the_cached_asset() {
        let url = |query: &str| {
            Url::parse(&format!("https://t.lan/api/worlds/w/assets/a.png{query}")).unwrap()
        };
        assert_eq!(cache_key(&url("?token=one")), cache_key(&url("?token=two")));
        assert_eq!(cache_key(&url("?token=one")), cache_key(&url("")));
        assert_ne!(cache_key(&url("?v=2&token=one")), cache_key(&url("")));
    }

    #[test]
    fn cache_keeps_type_and_bytes_and_drops_the_oldest() {
        let dir = std::env::temp_dir().join(format!("teahouse-assets-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let cache = AssetCache::with_limit(dir.clone(), 10 + 2 * ("image/png\n".len() as u64));
        let url =
            |name: &str| Url::parse(&format!("https://t.lan/api/worlds/w/assets/{name}")).unwrap();

        cache.put(&url("a.png"), b"AAAAA", "image/png").unwrap();
        assert_eq!(
            cache.get(&url("a.png")),
            Some((b"AAAAA".to_vec(), "image/png".into()))
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
        cache.put(&url("b.png"), b"BBBBB", "image/png").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        // A third file is over the limit: the least recently used one goes.
        cache.put(&url("c.png"), b"CCCCC", "image/png").unwrap();
        assert_eq!(cache.get(&url("a.png")), None);
        assert!(cache.get(&url("b.png")).is_some());
        assert!(cache.get(&url("c.png")).is_some());
        fs::remove_dir_all(dir).unwrap();
    }
}
