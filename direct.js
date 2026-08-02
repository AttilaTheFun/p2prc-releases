/* Serverless peer-to-peer: two browsers connect with no host in between.
 *
 * WebRTC needs exactly one thing it can't do itself — the peers must trade an
 * SDP offer and answer. That's a few hundred bytes each way, once, and it
 * doesn't need a server: it needs any channel a person can bridge. So we hand
 * it to the person, as a link or a QR code.
 *
 *   A taps Invite      -> offer  -> link/QR  -> sent to B any way at all
 *   B opens that link  -> answer -> link/QR  -> sent back to A
 *   A pastes the reply -> connected, directly.
 *
 * After that the host is not involved in any way, and neither is DNS.
 *
 * Note B must *paste* their reply to A rather than A opening it as a link:
 * navigating would reload A's page and discard the half-open connection.
 */
(function (global) {
  "use strict";

  var STUN = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ];

  // --- Compact encoding: SDP is repetitive text, so it gzips well. ---

  function toBase64URL(bytes) {
    var binary = "";
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function fromBase64URL(text) {
    var padded = text.replace(/-/g, "+").replace(/_/g, "/");
    while (padded.length % 4) padded += "=";
    var binary = atob(padded);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function pack(text) {
    if (typeof CompressionStream === "undefined") {
      return Promise.resolve("r" + toBase64URL(new TextEncoder().encode(text)));
    }
    var stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Response(stream).arrayBuffer().then(function (buffer) {
      return "z" + toBase64URL(new Uint8Array(buffer));
    });
  }

  function unpack(blob) {
    // Be forgiving about what arrives: blobs get pasted through keyboards that
    // capitalise, mail clients that wrap lines, and links that carry a #a=
    // prefix. Only the payload has to survive.
    var clean = String(blob).trim().replace(/^.*#[ia]=/, "").replace(/\s+/g, "");
    var kind = clean[0].toLowerCase();
    var bytes = fromBase64URL(clean.slice(1));
    if (kind === "r") return Promise.resolve(new TextDecoder().decode(bytes));
    if (typeof DecompressionStream === "undefined") {
      return Promise.reject(new Error("this browser can't un-gzip; ask for an uncompressed reply"));
    }
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text().catch(function () {
      // Not gzip after all — treat it as plain text rather than failing.
      return new TextDecoder().decode(bytes);
    });
  }

  /// Trims SDP to what a data channel actually needs — smaller QR, easier scan.
  ///
  /// SDP must end with a trailing CRLF: dropping the final empty line leaves
  /// the last attribute unterminated, and strict parsers reject the whole
  /// description ("Invalid SDP line").
  function slim(sdp) {
    var kept = sdp
      .split("\r\n")
      .filter(function (line) {
        // TCP candidates roughly double the payload and rarely help a data
        // channel, so drop them.
        if (line.indexOf("a=candidate:") === 0 && line.indexOf(" tcp ") !== -1) return false;
        return line !== "";
      });
    return kept.join("\r\n") + "\r\n";
  }

  /// Resolves once ICE has gathered everything, so the blob is self-contained
  /// (no trickle, nothing left to exchange later).
  function whenGathered(pc) {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise(function (resolve) {
      var done = false;
      function finish() {
        if (done) return;
        done = true;
        resolve();
      }
      pc.addEventListener("icegatheringstatechange", function () {
        if (pc.iceGatheringState === "complete") finish();
      });
      // Some networks never reach "complete"; ship what we have.
      setTimeout(finish, 3000);
    });
  }

  function DirectSession(options) {
    this.onMessage = options.onMessage || function () {};
    this.onState = options.onState || function () {};
    this.name = options.name || "anon";
    this.pc = null;
    this.channel = null;
  }

  DirectSession.prototype.setupChannel = function (channel) {
    var self = this;
    this.channel = channel;
    channel.onopen = function () { self.onState("connected"); };
    channel.onclose = function () { self.onState("closed"); };
    channel.onmessage = function (event) {
      var message;
      try { message = JSON.parse(event.data); } catch (e) { return; }
      self.onMessage(message);
    };
  };

  DirectSession.prototype.newConnection = function () {
    var self = this;
    var pc = new RTCPeerConnection({ iceServers: STUN });
    this.pc = pc;
    pc.onconnectionstatechange = function () {
      if (pc.connectionState === "failed") self.onState("failed");
    };
    pc.ondatachannel = function (event) { self.setupChannel(event.channel); };
    return pc;
  };

  /// A: create the invitation.
  DirectSession.prototype.createInvite = function () {
    var self = this;
    var pc = this.newConnection();
    this.setupChannel(pc.createDataChannel("p2prc-direct", { ordered: true }));
    this.onState("gathering");
    return pc.createOffer()
      .then(function (offer) { return pc.setLocalDescription(offer); })
      .then(function () { return whenGathered(pc); })
      .then(function () { return pack(slim(pc.localDescription.sdp)); });
  };

  /// B: accept an invitation, producing the reply to send back.
  DirectSession.prototype.acceptInvite = function (blob) {
    var self = this;
    var pc = this.newConnection();
    this.onState("gathering");
    return unpack(blob)
      .then(function (sdp) {
        return pc.setRemoteDescription({ type: "offer", sdp: sdp });
      })
      .then(function () { return pc.createAnswer(); })
      .then(function (answer) { return pc.setLocalDescription(answer); })
      .then(function () { return whenGathered(pc); })
      .then(function () { return pack(slim(pc.localDescription.sdp)); });
  };

  /// A: finish, with the reply B sent back.
  DirectSession.prototype.acceptReply = function (blob) {
    var pc = this.pc;
    return unpack(blob).then(function (sdp) {
      return pc.setRemoteDescription({ type: "answer", sdp: sdp });
    });
  };

  DirectSession.prototype.send = function (text) {
    if (!this.channel || this.channel.readyState !== "open") return false;
    this.channel.send(JSON.stringify({ name: this.name, text: text, ts: Date.now() / 1000 }));
    return true;
  };

  DirectSession.prototype.close = function () {
    try { if (this.channel) this.channel.close(); } catch (e) {}
    try { if (this.pc) this.pc.close(); } catch (e) {}
  };

  /// Builds the shareable link. The blob lives in the fragment, so it is never
  /// sent to whatever server happens to have served the page.
  DirectSession.link = function (kind, blob) {
    return location.origin + location.pathname + "#" + kind + "=" + blob;
  };

  DirectSession.readHash = function () {
    var match = (location.hash || "").match(/^#(i|a)=(.+)$/);
    return match ? { kind: match[1], blob: match[2] } : null;
  };

  global.P2PRCDirect = DirectSession;
})(window);
