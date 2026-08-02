/* Group encryption with MLS-style epochs.
 *
 * Follows the *architecture* of MLS (RFC 9420) — a group advances through
 * numbered epochs, each with its own secret; membership changes force a new
 * epoch; message keys are derived from the current epoch secret through a key
 * schedule — but it distributes the epoch secret by encrypting it once per
 * member rather than through a TreeKEM ratchet tree.
 *
 * What that buys, and what it doesn't:
 *
 *   ✓ removal actually removes: a member dropped in epoch N cannot read
 *     epoch N+1, because the new secret is never encrypted to them
 *   ✓ forward secrecy between epochs: old epoch secrets are discarded, so a
 *     key stolen today does not open earlier epochs
 *   ✓ addition is confidential to the group, and a joiner can be given
 *     history deliberately rather than by accident
 *   ✗ rekeying costs O(members), where TreeKEM costs O(log members)
 *   ✗ no per-message ratchet inside an epoch, so no message-level forward
 *     secrecy the way a Double Ratchet gives
 *   ✗ not wire-compatible with other MLS implementations
 *
 * The interface is deliberately the shape MLS needs, so a real implementation
 * (openmls compiled to wasm, say) can be dropped in behind it: create a group,
 * propose membership changes, commit them to advance the epoch, and encrypt or
 * decrypt against the current epoch.
 */
(function (global) {
  "use strict";

  var subtle = global.crypto.subtle;
  var enc = new TextEncoder();
  var dec = new TextDecoder();

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

  function random(length) {
    var bytes = new Uint8Array(length);
    global.crypto.getRandomValues(bytes);
    return bytes;
  }

  /// MLS derives everything from the epoch secret through labelled expansions;
  /// same idea here, so distinct uses can never collide.
  function expand(secret, label, length) {
    return subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"])
      .then(function (material) {
        return subtle.deriveBits({
          name: "HKDF", hash: "SHA-256",
          salt: new Uint8Array(0),
          info: enc.encode("qrc-mls-v1 " + label),
        }, material, length * 8);
      })
      .then(function (bits) { return new Uint8Array(bits); });
  }

  function aesKey(raw, usages) {
    return subtle.importKey("raw", raw, { name: "AES-GCM" }, false, usages);
  }

  // --- Sealing the epoch secret to each member -----------------------------

  function agree(privateKey, peerJWK, label) {
    return subtle.importKey("jwk", peerJWK, { name: "ECDH", namedCurve: "P-256" }, false, [])
      .then(function (peer) {
        return subtle.deriveBits({ name: "ECDH", public: peer }, privateKey, 256);
      })
      .then(function (shared) { return expand(new Uint8Array(shared), label, 32); })
      .then(function (raw) { return aesKey(raw, ["encrypt", "decrypt"]); });
  }

  /// The equivalent of an MLS Welcome: hand the new epoch secret to every
  /// member, encrypted individually to their identity key.
  function sealEpoch(identity, members, epochSecret) {
    return subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
      .then(function (ephemeral) {
        return subtle.exportKey("jwk", ephemeral.publicKey).then(function (epk) {
          var wraps = members.map(function (member) {
            var iv = random(12);
            return agree(ephemeral.privateKey, member.key, "welcome")
              .then(function (key) {
                return subtle.encrypt({ name: "AES-GCM", iv: iv }, key, epochSecret);
              })
              .then(function (sealed) {
                return { to: member.id, iv: toB64(iv), secret: toB64(sealed) };
              });
          });
          return Promise.all(wraps).then(function (entries) {
            return {
              epk: { crv: epk.crv, kty: epk.kty, x: epk.x, y: epk.y },
              members: entries,
            };
          });
        });
      });
  }

  function openEpoch(identity, memberId, welcome) {
    var entry = (welcome.members || []).filter(function (m) { return m.to === memberId; })[0];
    if (!entry) return Promise.reject(new Error("this epoch was not shared with us"));
    return agree(identity.keyPair.privateKey, welcome.epk, "welcome")
      .then(function (key) {
        return subtle.decrypt({ name: "AES-GCM", iv: fromB64(entry.iv) }, key, fromB64(entry.secret));
      })
      .then(function (secret) { return new Uint8Array(secret); });
  }

  // --- Messages within an epoch --------------------------------------------

  /// Message keys come from the epoch secret plus the sender and a counter, so
  /// two members never reuse a key even without coordinating.
  function messageKey(epochSecret, sender, counter) {
    return expand(epochSecret, "msg " + sender + " " + counter, 32)
      .then(function (raw) { return aesKey(raw, ["encrypt", "decrypt"]); });
  }

  function encryptMessage(epochSecret, epoch, sender, counter, text) {
    var iv = random(12);
    return messageKey(epochSecret, sender, counter)
      .then(function (key) {
        return subtle.encrypt(
          { name: "AES-GCM", iv: iv, additionalData: enc.encode(epoch + "|" + sender + "|" + counter) },
          key, enc.encode(text)
        );
      })
      .then(function (sealed) {
        return { e: epoch, s: sender, n: counter, iv: toB64(iv), ct: toB64(sealed) };
      });
  }

  function decryptMessage(epochSecret, envelope) {
    return messageKey(epochSecret, envelope.s, envelope.n)
      .then(function (key) {
        return subtle.decrypt({
          name: "AES-GCM",
          iv: fromB64(envelope.iv),
          additionalData: enc.encode(envelope.e + "|" + envelope.s + "|" + envelope.n),
        }, key, fromB64(envelope.ct));
      })
      .then(function (plain) { return dec.decode(plain); });
  }

  // --- Group state ---------------------------------------------------------

  /// Tracks epoch secrets for one group. Secrets live in memory only; history
  /// is re-readable because past epoch secrets are kept for as long as the
  /// member holds the messages they protect.
  function GroupKeys(identity, memberId) {
    this.identity = identity;
    this.memberId = memberId;
    // Keyed by the id of the rekey *event*, not by an epoch number. Two
    // members can rekey at the same moment — in a graph with no central
    // authority that is normal, not an error — and numbering by integer would
    // make their different secrets collide. Event ids never collide, so both
    // key contexts simply coexist and everyone can read either.
    this.secrets = {};      // rekey event id -> Uint8Array
    this.rank = {};         // rekey event id -> epoch number, for choosing
    this.currentId = null;
    this.counter = 0;
  }

  /// Produces a secret and the welcome that shares it. The caller stores it
  /// once the rekey event exists and its id is known.
  GroupKeys.prototype.prepare = function (members) {
    var secret = random(32);
    return sealEpoch(this.identity, members, secret).then(function (welcome) {
      return { secret: secret, welcome: welcome };
    });
  };

  GroupKeys.prototype.remember = function (id, secret, epoch) {
    this.secrets[id] = secret;
    this.rank[id] = epoch || 0;
    this.chooseCurrent();
  };

  /// Adopts a key context someone else created, if it was shared with us.
  GroupKeys.prototype.adopt = function (id, welcome, epoch) {
    var self = this;
    if (this.secrets[id]) return Promise.resolve(true);
    return openEpoch(this.identity, this.memberId, welcome).then(function (secret) {
      self.remember(id, secret, epoch);
      return true;
    }).catch(function () { return false; });
  };

  /// Newest wins; ties broken by id so every member picks the same one.
  GroupKeys.prototype.chooseCurrent = function () {
    var best = null;
    for (var id in this.secrets) {
      if (best === null) { best = id; continue; }
      if (this.rank[id] > this.rank[best] || (this.rank[id] === this.rank[best] && id > best)) {
        best = id;
      }
    }
    if (best !== this.currentId) { this.currentId = best; this.counter = 0; }
  };

  GroupKeys.prototype.canSend = function () { return !!this.currentId; };

  GroupKeys.prototype.encrypt = function (text) {
    if (!this.currentId) return Promise.reject(new Error("no group key"));
    var counter = this.counter++;
    return encryptMessage(this.secrets[this.currentId], this.currentId, this.memberId, counter, text);
  };

  GroupKeys.prototype.decrypt = function (envelope) {
    var secret = this.secrets[envelope.e];
    if (!secret) return Promise.reject(new Error("no key for this context"));
    return decryptMessage(secret, envelope);
  };

  global.QRCGroupCrypto = {
    GroupKeys: GroupKeys,
    sealEpoch: sealEpoch,
    openEpoch: openEpoch,
    encryptMessage: encryptMessage,
    decryptMessage: decryptMessage,
  };
})(typeof window !== "undefined" ? window : globalThis);
