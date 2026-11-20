# Apps and devices

You can play in any browser that reaches your server, or in the apps for Windows, macOS, Linux and Android. They all show the same worlds and chats, because everything lives on your server.

## The apps

The apps are the web client in a small native shell ([Tauri](https://tauri.app)). They connect to your server like a browser does, but keep a copy of your recent chats so they start and work without it.

**Getting them:** download them from the latest [release](https://github.com/Linyeir/teahouse/releases). The builds are not code-signed, so Windows and macOS warn on first start.

On Android, allow installing apps from unknown sources once; later versions install over the old one. On Android 17 and later, the app also asks for access to the local network ("Nearby devices") before it connects to a server at home. Without that, Android blocks every connection to your home network.

> [!NOTE]
> Version 0.3.0 of the Android app used a different key. If you still have it, let it sync, uninstall it, then install the current version.

## Signing in a device

Your password signs in the first device. Every further device can be paired without it:

1. On a signed-in device, open **Settings → Pair a device**. It shows a QR code, a link and a short code.
2. On the new device, scan the QR code with the camera (the Android app can scan it itself), open the link, or enter the code under **Pair with a code instead** on the sign-in screen.

A code works once and expires after five minutes. If the signed-in browser shows Teahouse as `localhost`, the pairing panel offers the server's network addresses instead, because a phone can't reach `localhost`. Behind a reverse proxy or Tailscale, enter the address the phone uses.

Each device has its own sign-in. **Sign out device** under Settings ends it immediately, for example for a lost phone.

## Playing offline

Each device keeps a copy of your 30 most recent chats and refreshes it whenever it connects. Without the server you can:

- read those chats,
- edit messages of the current scene,
- write one message, which is sent and answered once the server is back, even if you closed the app in between.

Replies, ending scenes and switching between versions of a reply need the server.

Nothing gets lost when devices disagree. A message written while the chat moved on elsewhere starts a new branch, and the other one stays a swipe away. If two devices edit the same message, the later edit wins, and the device that made it shows a warning. A message for a scene that was closed in the meantime isn't sent; its text goes back into the text field.

> [!TIP]
> In a browser, opening Teahouse without the server only works over HTTPS or on `localhost`, because browsers allow offline pages only there. The apps work offline either way.

## Connection problems

If an app can't connect, it says why: nothing answering at that address, a certificate it doesn't trust, or a version that doesn't fit. The apps trust the certificates your system trusts, including a certificate authority of your own installed on the device. [HTTPS](https.md) explains the setups.
