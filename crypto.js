/* End-to-end encryption for P2PRC.
 *
 * The server relays ciphertext it cannot read. This follows the JWE
 * multi-recipient pattern (RFC 7516 ECDH-ES): each message gets a random
 * content key, the body is encrypted once with AES-GCM, and that content key
 * is wrapped separately for every recipient using an ephemeral ECDH exchange
 * against their public key. Adding a recipient costs one wrapped key, not a
 * second copy of the message.
 *
 * Identity is a long-lived ECDH P-256 keypair. Where the browser supports the
 * WebAuthn PRF extension, the private key is encrypted at rest with a secret
 * derived from a **passkey** — so the key material is protected by the
 * platform keychain and Face ID, not merely sitting in local storage.
 *
 * A passkey cannot itself perform ECDH (its private key only signs WebAuthn
 * assertions), which is why it wraps a separate encryption key rather than
 * being one. That is the same construction password managers use.
 */
(function (global) {
  "use strict";

  var STORE_KEY = "p2prc-identity";
  var PASSKEY_KEY = "p2prc-passkey-id";
  var subtle = global.crypto && global.crypto.subtle;

  // --- Encoding helpers ----------------------------------------------------

  function toB64(bytes) {
    var binary = "";
    var view = new Uint8Array(bytes);
    for (var i = 0; i < view.length; i++) binary += String.fromCharCode(view[i]);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function fromB64(text) {
    var padded = String(text).replace(/-/g, "+").replace(/_/g, "/");
    while (padded.length % 4) padded += "=";
    var binary = atob(padded);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function randomBytes(length) {
    var bytes = new Uint8Array(length);
    global.crypto.getRandomValues(bytes);
    return bytes;
  }

  // --- Passkey-derived wrapping key ----------------------------------------

  /// Creates a passkey and returns the PRF secret it yields, or null if this
  /// browser/authenticator can't do PRF. The credential lives in the platform
  /// keychain (iCloud Keychain, Windows Hello, Android's provider).
  function createPasskey(displayName) {
    if (!global.PublicKeyCredential || !navigator.credentials) return Promise.resolve(null);
    // WebAuthn needs a user gesture. Arriving by a pairing link isn't one, and
    // calling it anyway leaves the promise pending forever — so check first,
    // and put a ceiling on it regardless.
    if (navigator.userActivation && navigator.userActivation.isActive === false) {
      return Promise.resolve(null);
    }
    var challenge = randomBytes(32);
    var userId = randomBytes(16);
    return navigator.credentials.create({
      publicKey: {
        challenge: challenge,
        rp: { name: "P2PRC", id: location.hostname },
        user: { id: userId, name: displayName || "p2prc", displayName: displayName || "P2PRC identity" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        authenticatorSelection: {
          residentKey: "preferred",
          userVerification: "preferred",
        },
        // Ask for a stable per-credential secret we can derive a wrapping key
        // from. Without this a passkey can only authenticate, not encrypt.
        extensions: { prf: { eval: { first: new TextEncoder().encode("p2prc-identity-v1") } } },
        timeout: 60000,
      },
    }).then(function (credential) {
      if (!credential) return null;
      var results = credential.getClientExtensionResults();
      localStorage.setItem(PASSKEY_KEY, toB64(credential.rawId));
      if (results && results.prf && results.prf.results && results.prf.results.first) {
        return new Uint8Array(results.prf.results.first);
      }
      // Credential made, but PRF unavailable — caller falls back.
      return null;
    }).catch(function () { return null; });
  }

  /// Never let an authenticator prompt block identity creation indefinitely.
  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise(function (resolve) { setTimeout(function () { resolve(null); }, ms); }),
    ]);
  }

  /// Re-derives the same PRF secret by asserting the stored passkey.
  function usePasskey() {
    var stored = localStorage.getItem(PASSKEY_KEY);
    if (!stored || !navigator.credentials) return Promise.resolve(null);
    return navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(32),
        allowCredentials: [{ type: "public-key", id: fromB64(stored) }],
        userVerification: "preferred",
        extensions: { prf: { eval: { first: new TextEncoder().encode("p2prc-identity-v1") } } },
        timeout: 60000,
      },
    }).then(function (assertion) {
      if (!assertion) return null;
      var results = assertion.getClientExtensionResults();
      if (results && results.prf && results.prf.results && results.prf.results.first) {
        return new Uint8Array(results.prf.results.first);
      }
      return null;
    }).catch(function () { return null; });
  }

  function wrappingKeyFrom(secret) {
    return subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"])
      .then(function (material) {
        return subtle.deriveKey(
          { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0),
            info: new TextEncoder().encode("p2prc-key-wrap-v1") },
          material,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"]
        );
      });
  }

  // --- Identity ------------------------------------------------------------

  function Identity(keyPair, publicJWK, fingerprint, passkeyBacked) {
    this.keyPair = keyPair;
    this.publicJWK = publicJWK;
    this.fingerprint = fingerprint;
    this.passkeyBacked = passkeyBacked;
  }

  /// Short, readable fingerprint for out-of-band comparison — the thing two
  /// people actually check to know they're talking to each other.
  function fingerprintOf(publicJWK) {
    var canonical = JSON.stringify({ crv: publicJWK.crv, kty: publicJWK.kty, x: publicJWK.x, y: publicJWK.y });
    return subtle.digest("SHA-256", new TextEncoder().encode(canonical))
      .then(function (digest) {
        var hex = Array.prototype.map.call(new Uint8Array(digest), function (byte) {
          return ("0" + byte.toString(16)).slice(-2);
        }).join("");
        return hex.slice(0, 32).match(/.{4}/g).join("-");
      });
  }

  function generateKeyPair() {
    return subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey", "deriveBits"]);
  }

  function exportIdentity(keyPair, wrappingKey) {
    return Promise.all([
      subtle.exportKey("jwk", keyPair.publicKey),
      subtle.exportKey("jwk", keyPair.privateKey),
    ]).then(function (both) {
      var record = { version: 1, public: both[0] };
      var privateBytes = new TextEncoder().encode(JSON.stringify(both[1]));
      if (!wrappingKey) {
        record.private = both[1];
        return record;
      }
      var iv = randomBytes(12);
      return subtle.encrypt({ name: "AES-GCM", iv: iv }, wrappingKey, privateBytes)
        .then(function (sealed) {
          record.wrapped = { iv: toB64(iv), data: toB64(sealed) };
          return record;
        });
    });
  }

  function importIdentity(record, wrappingKey) {
    var publicPromise = subtle.importKey("jwk", record.public, { name: "ECDH", namedCurve: "P-256" }, true, []);
    var privatePromise;
    if (record.wrapped && wrappingKey) {
      privatePromise = subtle.decrypt(
        { name: "AES-GCM", iv: fromB64(record.wrapped.iv) },
        wrappingKey,
        fromB64(record.wrapped.data)
      ).then(function (plain) {
        var jwk = JSON.parse(new TextDecoder().decode(plain));
        return subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey", "deriveBits"]);
      });
    } else if (record.private) {
      privatePromise = subtle.importKey("jwk", record.private, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey", "deriveBits"]);
    } else {
      return Promise.reject(new Error("identity is passkey-wrapped but the passkey was not available"));
    }
    return Promise.all([publicPromise, privatePromise]).then(function (keys) {
      return { publicKey: keys[0], privateKey: keys[1] };
    });
  }

  /// Loads this device's identity, creating one (and a passkey) on first use.
  /// `interactive` must be true when a user gesture is available: creating or
  /// asserting a passkey prompts for Face ID / Touch ID.
  function loadIdentity(options) {
    options = options || {};
    if (!subtle) return Promise.reject(new Error("this browser has no WebCrypto"));
    var stored = localStorage.getItem(STORE_KEY);

    if (stored) {
      var record;
      try { record = JSON.parse(stored); } catch (e) { record = null; }
      if (record) {
        var unlock = record.wrapped ? withTimeout(usePasskey(), 30000).then(function (secret) {
          return secret ? wrappingKeyFrom(secret) : null;
        }) : Promise.resolve(null);
        return unlock.then(function (wrappingKey) {
          return importIdentity(record, wrappingKey);
        }).then(function (keyPair) {
          return fingerprintOf(record.public).then(function (fingerprint) {
            return new Identity(keyPair, record.public, fingerprint, !!record.wrapped);
          });
        });
      }
    }

    // First run: make a passkey (so the key is keychain-protected) and a
    // fresh ECDH identity.
    var passkeyPromise = options.interactive && options.usePasskey !== false
      ? withTimeout(createPasskey(options.name), 30000)
      : Promise.resolve(null);

    return passkeyPromise.then(function (secret) {
      return (secret ? wrappingKeyFrom(secret) : Promise.resolve(null))
        .then(function (wrappingKey) {
          return generateKeyPair().then(function (keyPair) {
            return exportIdentity(keyPair, wrappingKey).then(function (record) {
              localStorage.setItem(STORE_KEY, JSON.stringify(record));
              return fingerprintOf(record.public).then(function (fingerprint) {
                return new Identity(keyPair, record.public, fingerprint, !!record.wrapped);
              });
            });
          });
        });
    });
  }

  // --- Sealing and opening -------------------------------------------------

  function deriveWrapKey(privateKey, peerPublicJWK) {
    return subtle.importKey("jwk", peerPublicJWK, { name: "ECDH", namedCurve: "P-256" }, false, [])
      .then(function (peerKey) {
        return subtle.deriveBits({ name: "ECDH", public: peerKey }, privateKey, 256);
      })
      .then(function (shared) {
        return subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
      })
      .then(function (material) {
        return subtle.deriveKey(
          { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0),
            info: new TextEncoder().encode("p2prc-message-v1") },
          material,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"]
        );
      });
  }

  /// Encrypts `text` once, then wraps the content key for each recipient.
  /// `recipients` is [{nick, jwk}]. Returns a compact envelope.
  function seal(identity, recipients, text) {
    if (!recipients.length) return Promise.reject(new Error("no recipients"));
    var contentKey;
    var iv = randomBytes(12);
    return subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"])
      .then(function (key) {
        contentKey = key;
        return subtle.encrypt({ name: "AES-GCM", iv: iv }, key, new TextEncoder().encode(text));
      })
      .then(function (ciphertext) {
        return subtle.exportKey("raw", contentKey).then(function (rawContentKey) {
          // A fresh ephemeral keypair per message: recipients can't link
          // messages by sender key, and past traffic stays sealed if the
          // long-lived key later leaks.
          return generateKeyPair().then(function (ephemeral) {
            return subtle.exportKey("jwk", ephemeral.publicKey).then(function (ephemeralJWK) {
              var wraps = recipients.map(function (recipient) {
                var wrapIV = randomBytes(12);
                return deriveWrapKey(ephemeral.privateKey, recipient.jwk)
                  .then(function (wrapKey) {
                    return subtle.encrypt({ name: "AES-GCM", iv: wrapIV }, wrapKey, rawContentKey);
                  })
                  .then(function (wrapped) {
                    return { to: recipient.nick, iv: toB64(wrapIV), key: toB64(wrapped) };
                  });
              });
              return Promise.all(wraps).then(function (keys) {
                return {
                  v: 1,
                  epk: { crv: ephemeralJWK.crv, kty: ephemeralJWK.kty, x: ephemeralJWK.x, y: ephemeralJWK.y },
                  iv: toB64(iv),
                  ct: toB64(ciphertext),
                  keys: keys,
                };
              });
            });
          });
        });
      });
  }

  /// Opens an envelope addressed to `nick`.
  function open(identity, nick, envelope) {
    var entry = null;
    for (var i = 0; i < (envelope.keys || []).length; i++) {
      if (envelope.keys[i].to === nick) { entry = envelope.keys[i]; break; }
    }
    if (!entry) return Promise.reject(new Error("not addressed to us"));
    return deriveWrapKey(identity.keyPair.privateKey, envelope.epk)
      .then(function (wrapKey) {
        return subtle.decrypt({ name: "AES-GCM", iv: fromB64(entry.iv) }, wrapKey, fromB64(entry.key));
      })
      .then(function (rawContentKey) {
        return subtle.importKey("raw", rawContentKey, { name: "AES-GCM" }, false, ["decrypt"]);
      })
      .then(function (contentKey) {
        return subtle.decrypt({ name: "AES-GCM", iv: fromB64(envelope.iv) }, contentKey, fromB64(envelope.ct));
      })
      .then(function (plain) { return new TextDecoder().decode(plain); });
  }

  // --- Wire format ---------------------------------------------------------
  //
  // Encrypted text rides inside an ordinary PRIVMSG body, the way OTR did
  // (`?OTR:`). Any IRC server relays it untouched, and a client that doesn't
  // understand it shows a marker rather than breaking.

  var PREFIX = "+p2prc1:";

  function encode(envelope) {
    return PREFIX + toB64(new TextEncoder().encode(JSON.stringify(envelope)));
  }

  function decode(body) {
    if (String(body).indexOf(PREFIX) !== 0) return null;
    try {
      return JSON.parse(new TextDecoder().decode(fromB64(String(body).slice(PREFIX.length))));
    } catch (e) {
      return null;
    }
  }

  global.P2PRCCrypto = {
    loadIdentity: loadIdentity,
    fingerprintOf: fingerprintOf,
    seal: seal,
    open: open,
    encode: encode,
    decode: decode,
    isEncrypted: function (body) { return String(body).indexOf(PREFIX) === 0; },
    toB64: toB64,
    fromB64: fromB64,
  };
})(window);
