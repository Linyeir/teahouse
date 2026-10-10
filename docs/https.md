# HTTPS

Teahouse itself speaks plain HTTP. For HTTPS, put it behind a reverse proxy (Caddy, nginx,
Traefik) or Tailscale. Devices then have to trust the certificate the proxy presents, and how
that works depends on where the certificate comes from. There are three routes:

1. [A publicly trusted certificate](#a-publicly-trusted-certificate): nothing to do on the
   devices. The best choice whenever you can get one.
2. [Your own CA](#your-own-ca): for servers without a public name. Every device needs the CA
   installed once.
3. [Plain HTTP](#plain-http) inside your LAN or a VPN.

If an app cannot connect, it says why, for example that the device does not trust the
certificate, and shows the certificate it got: issuer, validity and SHA-256 fingerprint.

## A publicly trusted certificate

**Let's Encrypt through the reverse proxy.** Caddy does it on its own:

```
teahouse.example.com {
  reverse_proxy localhost:8787
}
```

That needs a domain that points at the server, and port 80 or 443 reachable from the
internet for the challenge. If the server is only reachable at home, use the DNS challenge
instead: the proxy proves ownership of the domain through your DNS provider's API, so the
server never has to be reachable from outside. Caddy needs the plugin for your DNS provider
for that; Traefik and certbot have it built in for most providers. The domain can point at a
LAN address.

**Tailscale.** With MagicDNS and HTTPS turned on for your tailnet (admin console → DNS),
`tailscale serve --bg 8787` serves Teahouse at `https://<machine>.<tailnet>.ts.net` with a
Let's Encrypt certificate, without a domain of your own. Every device in the tailnet can use
that address. `tailscale cert` fetches the same certificate as files, if you would rather
give it to your own proxy.

## Your own CA

A private CA issues the server certificate, and each device trusts that CA. Tools that make
it easy:

- [mkcert](https://github.com/FiloSottile/mkcert) for a handful of devices: `mkcert -install`
  creates the CA, `mkcert teahouse.lan 192.168.1.10` a certificate for those names. The CA is
  `rootCA.pem` in the folder `mkcert -CAROOT` prints.
- [step-ca](https://smallstep.com/docs/step-ca/) if you want certificates to renew by
  themselves: it speaks ACME, so Caddy or Traefik renew from it like from Let's Encrypt.

Give the certificate every name and address you connect with. A certificate for
`teahouse.lan` does not cover `192.168.1.10`.

Then install the CA certificate (`rootCA.pem`, not the server's certificate) on every device:

- **Linux:** Debian and Ubuntu: copy it to `/usr/local/share/ca-certificates/teahouse-ca.crt`
  (the extension must be `.crt`) and run `sudo update-ca-certificates`. Fedora, Arch and
  openSUSE: copy it to `/etc/pki/ca-trust/source/anchors/` and run `sudo update-ca-trust`.
  Firefox and Chrome keep their own list; `mkcert -install` covers them on the machine that
  made the CA, elsewhere import it in their certificate settings.
- **Windows:** rename it to `rootCA.crt`, open it, choose *Install Certificate…*, *Local
  Machine*, and place it in *Trusted Root Certification Authorities*.
- **macOS:** `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain rootCA.pem`.
- **Android:** copy it to the phone, then *Settings → Security → Encryption & credentials →
  Install a certificate → CA certificate* (the path differs between phones; search the
  settings for "CA certificate"). Android then shows a notice that the network may be
  monitored. That is expected for every CA you install yourself and goes away if you remove
  it. Apps only trust such CAs if they opt in; the Teahouse app does from version 0.3.3 on.

Restart the Teahouse app afterwards.

Keep `rootCA-key.pem` private: whoever has it can issue certificates your devices trust for
any website. Renewing the server certificate is up to you (mkcert's last about two years);
the devices keep trusting the CA, so they need nothing new.

### Self-signed certificates

A self-signed certificate is its own CA. Browsers let you click through the warning, the
apps cannot. Some systems accept it when installed like a CA as above, but a proper CA from
mkcert takes the same effort and works everywhere. Pinning a self-signed certificate in the
apps without installing anything is planned
([#27](https://github.com/Linyeir/teahouse/issues/27)).

### Checking a certificate

To compare the fingerprint an app shows with the server's:

```sh
openssl s_client -connect teahouse.lan:443 -servername teahouse.lan </dev/null 2>/dev/null \
  | openssl x509 -noout -fingerprint -sha256
```

If they differ, something between the device and the server answers in its place.

## Plain HTTP

Inside your LAN or a VPN (WireGuard, Tailscale), plain HTTP works: enter the address with
`http://`, for example `http://192.168.1.10:8787`. The apps allow it. Browsers can only open
Teahouse without the server over HTTPS or on `localhost`, because they allow the service
worker nowhere else.

On HTTP, the password and the device tokens cross the network unencrypted, so anyone on the
same network can read them. Never expose Teahouse to the internet this way.
