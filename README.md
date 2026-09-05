# QRC releases

The QRC web app, published as a static site. Each commit is a release.

**Open it: https://attilathefun.github.io/qrc-releases/**

## What this is

[QRC](https://github.com/AttilaTheFun/qrc) is chat hosted on devices you own,
joined by scanning a QR code — no DNS and no cloud service holding messages.

A browser tab has no listening socket, so the *first* copy of the app has to
come from something that speaks HTTP. That's all this repo is: a
**bootstrapper**. It hands out the app and nothing else. Pairing happens
directly between people afterward, in a URL fragment that never reaches any
server, so this host never learns who talks to whom.

Serving over HTTPS also makes the page a secure context, which unlocks camera
access for scanning QR codes and the clipboard API.

## Verifying a release

Every release is signed. `bundle-signature.json` carries the version and an
Ed25519 signature over the file contents, checkable against the public key
built into QRC:

```
V/a0p/mRfwhQVDX4QMFNnPZ6TipYo3EtJBjQxCA/QKs=
```

Clients verify this before adopting a bundle from a peer, so a modified copy
served from anywhere — including here — is refused.

Current release: **v77**

## Running your own bootstrapper

Any static host works. So does a file, and so does the small server that ships
with QRC:

```sh
bazel run //applications/qrc_bootstrap
```

## Licence

The application source lives in the main QRC repository, which is not yet
public. `qrcode.js` is by Kazuhiko Arase, MIT licensed.
