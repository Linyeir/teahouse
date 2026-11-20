# Apps and devices

You can play in any browser that reaches your server, or in the apps for Windows, macOS, Linux and Android. All of them show the same worlds and chats, because the server stores everything.

## The apps

The apps are the web client inside a small native shell ([Tauri](https://tauri.app)). They connect to your server in the same way as a browser. They also keep a copy of your recent chats, so they start and work when the server can't be reached.

You can download the apps from the latest [release](https://github.com/Linyeir/teahouse/releases). The builds are not code-signed, so Windows and macOS show a warning on first start.

On Android, allow apps from unknown sources once, and later versions install over the old one. On Android 17 and later, the app also asks for access to the local network ("Nearby devices") before it connects to a server at home. Without this permission, Android blocks every connection to your home network.

> [!NOTE]
> Version 0.3.0 of the Android app was signed with a different key. If you still have it, let it sync, uninstall it, and then install the current version.

## Signing in a device

Your password signs in the first device. You can pair every further device without the password:

1. On a device that is signed in, open **Settings → Pair a device**. It shows a QR code, a link and a short code.
2. On the new device, scan the QR code with the camera, open the link, or enter the code under **Pair with a code instead** on the sign-in screen. The Android app can also scan the QR code itself.

A code works once and expires after five minutes. If the signed-in browser shows Teahouse as `localhost`, the pairing panel offers the server's network addresses instead, because a phone can't reach `localhost`. If you use a reverse proxy or Tailscale, enter the address that the phone uses.

Each device has its own sign-in. **Sign out device** under Settings ends a device's sign-in immediately, for example when you lose a phone.

## Playing offline

Each device keeps a copy of your 30 most recent chats and refreshes it whenever it connects. Without the server, you can do these things:

- read those chats,
- edit messages of the current scene,
- write one message, which is sent and answered when the server is back, even if you closed the app in between.

Replies, ending scenes and switching between versions of a reply need the server.

When devices disagree, Teahouse keeps both sides. A message that you wrote while the chat moved on elsewhere starts a new branch, and the other branch stays one swipe away. If two devices edit the same message, the later edit wins, and the device that made it shows a warning. A message for a scene that was closed in the meantime isn't sent, and its text goes back into the text field.

> [!TIP]
> Browsers allow offline pages only over HTTPS or on `localhost`. In a browser, Teahouse therefore opens without the server only in those two cases. The apps work offline in every case.

## Connection problems

If an app can't connect, it shows the reason: nothing answers at that address, the certificate isn't trusted, or the versions don't fit together. The apps trust the certificates that your system trusts, including your own certificate authority if you installed it on the device. [HTTPS](https.md) explains the possible setups.
