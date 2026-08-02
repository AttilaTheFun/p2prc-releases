/* Direct peer-to-peer chat over WebRTC data channels.
 *
 * The host relays a handful of SDP offers, answers and ICE candidates — the
 * one thing peers can't do for themselves — and then gets out of the way.
 * Once a data channel opens, messages travel straight between browsers and
 * never touch the host again.
 *
 * This also traverses NAT in a way the rest of QRC can't: ICE punches UDP
 * holes from both sides, which works in plenty of places where an inbound TCP
 * connection is refused outright (mobile carriers, most home routers).
 */
(function (global) {
  "use strict";

  var STUN = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ];

  function QRCPeers(options) {
    this.selfId = options.selfId;
    this.api = options.api;                 // key-bearing fetch wrapper
    this.onMessage = options.onMessage || function () {};
    this.onStatus = options.onStatus || function () {};
    this.room = "";
    this.peers = {};                        // peerId -> {pc, channel, state}
    this.since = 0;
    this.polling = false;
  }

  QRCPeers.prototype.setRoom = function (room) {
    if (this.room === room) return;
    this.room = room;
    // Connections are per-room; drop any from the room we just left.
    this.closeAll();
    if (room && !this.polling) {
      this.polling = true;
      this.poll();
    }
  };

  QRCPeers.prototype.closeAll = function () {
    var self = this;
    Object.keys(this.peers).forEach(function (id) { self.close(id); });
  };

  QRCPeers.prototype.close = function (peerId) {
    var peer = this.peers[peerId];
    if (!peer) return;
    try { if (peer.channel) peer.channel.close(); } catch (e) {}
    try { peer.pc.close(); } catch (e) {}
    delete this.peers[peerId];
    this.report();
  };

  /// How many peers we're talking to directly right now.
  QRCPeers.prototype.directCount = function () {
    var self = this;
    return Object.keys(this.peers).filter(function (id) {
      var channel = self.peers[id].channel;
      return channel && channel.readyState === "open";
    }).length;
  };

  QRCPeers.prototype.report = function () {
    this.onStatus(this.directCount());
  };

  QRCPeers.prototype.send = function (text, name) {
    var payload = JSON.stringify({
      cid: this.selfId,
      name: name || "anon",
      text: text,
      ts: Date.now() / 1000,
    });
    var sent = 0;
    var self = this;
    Object.keys(this.peers).forEach(function (id) {
      var channel = self.peers[id].channel;
      if (channel && channel.readyState === "open") {
        try { channel.send(payload); sent += 1; } catch (e) {}
      }
    });
    return sent;
  };

  QRCPeers.prototype.signal = function (to, kind, payload) {
    return this.api("/api/signal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: this.selfId, to: to, kind: kind, payload: payload }),
    }).catch(function () {});
  };

  QRCPeers.prototype.ensurePeer = function (peerId, isInitiator) {
    if (this.peers[peerId]) return this.peers[peerId];
    var self = this;
    var pc = new RTCPeerConnection({ iceServers: STUN });
    var entry = { pc: pc, channel: null };
    this.peers[peerId] = entry;

    pc.onicecandidate = function (event) {
      if (event.candidate) {
        self.signal(peerId, "candidate", JSON.stringify(event.candidate));
      }
    };
    pc.onconnectionstatechange = function () {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        // Hole punching failed — the host relay keeps carrying messages.
        self.close(peerId);
      }
    };
    pc.ondatachannel = function (event) {
      self.attach(peerId, event.channel);
    };

    if (isInitiator) {
      // Deterministic roles: the lower id offers, so two peers never collide
      // by both offering at once (glare).
      var channel = pc.createDataChannel("qrc", { ordered: true });
      this.attach(peerId, channel);
      pc.createOffer()
        .then(function (offer) { return pc.setLocalDescription(offer).then(function () { return offer; }); })
        .then(function (offer) { self.signal(peerId, "offer", JSON.stringify(offer)); })
        .catch(function () {});
    }
    return entry;
  };

  QRCPeers.prototype.attach = function (peerId, channel) {
    var self = this;
    this.peers[peerId].channel = channel;
    channel.onopen = function () {
      console.log("[qrc] direct channel open to", peerId);
      self.report();
    };
    channel.onclose = function () { self.report(); };
    channel.onmessage = function (event) {
      var message;
      try { message = JSON.parse(event.data); } catch (e) { return; }
      self.onMessage({
        cid: message.cid || peerId,
        name: message.name || "peer",
        text: message.text,
        ts: message.ts,
      });
    };
  };

  QRCPeers.prototype.handle = function (envelope) {
    var self = this;
    var peerId = envelope.from;
    var payload;
    try { payload = JSON.parse(envelope.payload); } catch (e) { return; }

    if (envelope.kind === "offer") {
      var entry = this.ensurePeer(peerId, false);
      entry.pc.setRemoteDescription(new RTCSessionDescription(payload))
        .then(function () { return entry.pc.createAnswer(); })
        .then(function (answer) {
          return entry.pc.setLocalDescription(answer).then(function () { return answer; });
        })
        .then(function (answer) { self.signal(peerId, "answer", JSON.stringify(answer)); })
        .catch(function () {});
    } else if (envelope.kind === "answer") {
      var known = this.peers[peerId];
      if (known) {
        known.pc.setRemoteDescription(new RTCSessionDescription(payload)).catch(function () {});
      }
    } else if (envelope.kind === "candidate") {
      var target = this.peers[peerId];
      if (target) {
        target.pc.addIceCandidate(new RTCIceCandidate(payload)).catch(function () {});
      }
    } else if (envelope.kind === "bye") {
      this.close(peerId);
    }
  };

  QRCPeers.prototype.poll = function () {
    var self = this;
    if (!this.room) {
      this.polling = false;
      return;
    }
    this.api("/api/signal?peer=" + encodeURIComponent(this.selfId) +
             "&room=" + encodeURIComponent(this.room) +
             "&since=" + this.since)
      .then(function (response) { return response.json(); })
      .then(function (state) {
        (state.messages || []).forEach(function (envelope) {
          if (envelope.id > self.since) self.since = envelope.id;
          self.handle(envelope);
        });
        // Offer to peers we don't have yet; the lower id initiates.
        (state.peers || []).forEach(function (peerId) {
          if (!self.peers[peerId] && self.selfId < peerId) {
            self.ensurePeer(peerId, true);
          }
        });
      })
      .catch(function () {})
      .finally(function () {
        setTimeout(function () { self.poll(); }, 2000);
      });
  };

  global.QRCPeers = QRCPeers;
})(window);
