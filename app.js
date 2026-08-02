/* QRC client: servers → channels → chat.
   The device that served this page always hosts its own server ("My server")
   and can also be a client of any number of other servers at once — QRC hosts
   or plain IRC networks. All of it lives behind the same origin. */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  var statusDot = $("status-dot"), peerCount = $("peer-count");
  var menuToggle = $("menu-toggle"), drawer = $("drawer");
  var serversEl = $("servers"), addServerButton = $("add-server");
  var viewServers = $("view-servers"), viewChannels = $("view-channels"), viewChat = $("view-chat");
  var channelsBack = $("channels-back"), serverTitle = $("server-title"), serverPeers = $("server-peers");
  var shareToggle = $("share-toggle"), sharePanel = $("share-panel");
  var qrImage = $("qr-image"), joinUrlEl = $("join-url"), copyToast = $("copy-toast");
  var ircDetails = $("irc-details");
  var channelsEl = $("channels"), addChannelButton = $("add-channel");
  var chatBack = $("chat-back"), roomTitle = $("room-title"), roomPeers = $("room-peers");
  var messagesEl = $("messages"), textInput = $("text"), sendButton = $("send");
  var p2pBadge = $("p2p-badge");
  var nameInput = { value: "" };  // nick is set with /nick, not a field
  var modeIpv4 = $("mode-ipv4"), modeIpv6 = $("mode-ipv6");
  var stunToggle = $("stun-toggle"), upnpToggle = $("upnp-toggle");
  var stunRow = $("stun-row"), upnpRow = $("upnp-row");
  var settingsApply = $("settings-apply"), settingsStatus = $("settings-status");
  var joinSheet = $("join-sheet"), joinPaste = $("join-paste"), joinPort = $("join-port");
  var joinKey = $("join-key"), joinCancel = $("join-cancel"), joinConfirm = $("join-confirm");
  var tlsToggle = $("join-tls"), tlsNote = $("join-tls-note");

  // --- Identity and the room key from the QR link ---

  var clientId =
    localStorage.getItem("qrc-cid") ||
    Math.random().toString(36).slice(2) + Date.now().toString(36);
  localStorage.setItem("qrc-cid", clientId);

  var roomKey = "";
  (function () {
    var match = location.search.match(/[?&]k=([^&]+)/);
    if (match) {
      roomKey = decodeURIComponent(match[1]);
      localStorage.setItem("qrc-key", roomKey);
      // Opening someone's link signs you straight in; drop the key from the
      // visible URL once it's stored.
      history.replaceState({}, "", location.pathname);
    } else {
      roomKey = localStorage.getItem("qrc-key") || "";
    }
  })();

  /// True when this browser is on the machine running the host (loopback).
  /// A visitor who scanned the QR is a guest in someone else's host, so the
  /// "local" server is theirs, not ours — the label has to say so.
  function isHostOperator() {
    return ["localhost", "127.0.0.1", "::1", "[::1]"].indexOf(location.hostname) !== -1;
  }

  function localServerLabel() {
    if (isHostOperator()) return "My server";
    return (connection.ircHost || location.hostname) + " — this host";
  }

  // Read once. Local storage is shared across every tab on this origin, so
  // reading it on each call means another window renaming itself would
  // silently change who *we* are — and messages are addressed by nick, so
  // that quietly breaks encryption addressing.
  var myNick = localStorage.getItem("qrc-name") || "anon";

  function myName() {
    return myNick;
  }

  /// One name everywhere: the servers, IRC, and any direct pairing.
  function setNick(nick) {
    myNick = nick;
    localStorage.setItem("qrc-name", nick);
    if (session) session.name = nick;
    api("/api/nick", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nick: nick }),
    }).catch(function () {});
  }

  function api(path, options) {
    var separator = path.indexOf("?") === -1 ? "?" : "&";
    var url = roomKey ? path + separator + "k=" + encodeURIComponent(roomKey) : path;
    options = options || {};
    options.headers = options.headers || {};
    if (roomKey) options.headers["X-QRC-Key"] = roomKey;
    return fetch(url, options).then(function (response) {
      if (response.status === 401) {
        showKeyPrompt();
        throw new Error("unauthorized");
      }
      return response;
    });
  }

  function showKeyPrompt() {
    if ($("key-prompt")) return;
    var overlay = document.createElement("div");
    overlay.id = "key-prompt";
    overlay.innerHTML =
      '<div class="key-card"><h2>Room key needed</h2>' +
      "<p>Scan the host's QR code, or paste the key below.</p>" +
      '<input id="key-input" type="text" placeholder="room key" autocomplete="off">' +
      '<button id="key-submit">Join</button></div>';
    document.body.appendChild(overlay);
    $("key-submit").addEventListener("click", function () {
      var value = $("key-input").value.trim();
      if (!value) return;
      localStorage.setItem("qrc-key", value);
      location.reload();
    });
  }

  // --- Navigation: servers → channels → chat ---

  var level = "servers";
  var currentServer = null;   // {id, name, isLocal}
  var currentRoom = null;     // {id, name}
  var lastId = 0;
  var connection = {};        // url / key / ircHost / ircPort reported by the host

  function show(next) {
    level = next;
    if (directView) directView.classList.add("hidden");
    viewServers.classList.toggle("hidden", next !== "servers");
    viewChannels.classList.toggle("hidden", next !== "channels");
    viewChat.classList.toggle("hidden", next !== "chat");
  }

  function openServers(push) {
    currentServer = null;
    currentRoom = null;
    if (peers) peers.setRoom("");
    show("servers");
    if (push !== false) history.pushState({ level: "servers" }, "", "#servers");
    pollServers();
  }

  function openServer(server, push) {
    currentServer = server;
    currentRoom = null;
    serverTitle.textContent = server.name;
    // Only your own server has a QR to share; the others are someone else's.
    shareToggle.classList.toggle("hidden", !server.isLocal);
    sharePanel.classList.remove("visible");
    show("channels");
    if (push !== false) history.pushState({ level: "channels", server: server }, "", "#" + server.id);
    pollChannels();
  }

  function openRoom(room, push) {
    currentRoom = room;
    lastId = 0;
    messagesEl.innerHTML = "";
    roomTitle.textContent = "#" + room.name;
    show("chat");
    if (push !== false) {
      history.pushState({ level: "chat", server: currentServer, room: room }, "", "#" + room.id);
    }
    if (peers) peers.setRoom(room.id);
    pollRoom();
    textInput.focus();
  }

  channelsBack.addEventListener("click", function () { history.back(); });
  chatBack.addEventListener("click", function () { history.back(); });

  window.addEventListener("popstate", function (event) {
    var state = event.state || {};
    if (pages[state.level]) {
      goTo(state.level, false);
      return;
    }
    if (state.level === "chat" && state.room) {
      currentServer = state.server;
      openRoom(state.room, false);
    } else if (state.level === "direct") {
      openDirect(false);
    } else if (state.level === "channels" && state.server) {
      openServer(state.server, false);
    } else {
      openServers(false);
    }
  });

  // --- QR sharing (your own server) ---

  var renderedQrFor = null;
  var joinLink = "";

  function renderQr(url) {
    if (!url || url === renderedQrFor) return;
    renderedQrFor = url;
    joinLink = url;
    try {
      var qr = qrcode(0, "M");
      qr.addData(url);
      qr.make();
      qrImage.src = qr.createDataURL(8, 8);
    } catch (e) { /* fall through to the text form */ }
    joinUrlEl.textContent = url;
  }

  function copyLink() {
    if (!joinLink) return;
    function done() {
      copyToast.classList.add("show");
      setTimeout(function () { copyToast.classList.remove("show"); }, 1400);
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(joinLink).then(done);
    } else {
      var scratch = document.createElement("textarea");
      scratch.value = joinLink;
      scratch.style.position = "fixed";
      scratch.style.opacity = "0";
      document.body.appendChild(scratch);
      scratch.select();
      try { document.execCommand("copy"); done(); } catch (e) {}
      document.body.removeChild(scratch);
    }
  }
  qrImage.addEventListener("click", copyLink);
  shareToggle.addEventListener("click", function () { sharePanel.classList.toggle("visible"); });

  function renderShare() {
    renderQr(connection.url || location.origin + "/");
    if (!connection.ircEnabled || !connection.ircHost) {
      ircDetails.textContent = "";
      return;
    }
    var html =
      '<div class="field-label">Any IRC client</div>' +
      "<code>/connect " + connection.ircHost + " " + connection.ircPort +
      (connection.key ? " " + connection.key : "") + "</code>";
    if (connection.tlsEnabled) {
      html +=
        '<div class="field-label">Encrypted (TLS, self-signed)</div>' +
        "<code>/connect " + connection.ircHost + " +" + connection.ircTLSPort +
        (connection.key ? " " + connection.key : "") + "</code>" +
        '<code class="fingerprint">sha256 ' + connection.fingerprint + "</code>";
    }
    ircDetails.innerHTML = html;
  }

  // --- Level 1: servers ---

  function timeLabel(ts) {
    if (!ts) return "";
    var when = new Date(ts * 1000), now = new Date();
    if (when.toDateString() === now.toDateString()) {
      return when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    return when.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  function renderServers(list) {
    serversEl.innerHTML = "";
    list.forEach(function (server) {
      var row = document.createElement("div");
      row.className = "server-row";

      var top = document.createElement("div");
      top.className = "row";
      var name = document.createElement("span");
      name.className = "name";
      name.textContent = server.isLocal ? localServerLabel() : server.name;
      top.appendChild(name);
      if (server.isLocal) {
        var badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = isHostOperator() ? "hosting" : "you're a guest";
        top.appendChild(badge);
      } else {
        if (server.tls) {
          var lock = document.createElement("span");
          lock.className = "badge lock";
          lock.textContent = "TLS";
          top.appendChild(lock);
        }
        var time = document.createElement("span");
        time.className = "meta";
        time.textContent = timeLabel(server.lastTs);
        top.appendChild(time);
      }

      var meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = server.last ||
        (server.channels + (server.channels === 1 ? " channel" : " channels"));

      var state = document.createElement("div");
      state.className = "state " + server.status;
      state.textContent = server.detail || server.status;

      row.appendChild(top);
      row.appendChild(meta);
      row.appendChild(state);
      var label = server.isLocal ? localServerLabel() : server.name;
      row.addEventListener("click", function () {
        openServer({ id: server.id, name: label, isLocal: server.isLocal });
      });

      if (!server.isLocal) {
        var leave = document.createElement("button");
        leave.className = "leave";
        leave.textContent = "leave";
        leave.addEventListener("click", function (event) {
          event.stopPropagation();
          api("/api/servers/remove", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: server.id }),
          }).then(pollServers).catch(function () {});
        });
        row.appendChild(leave);
      }
      serversEl.appendChild(row);
    });
  }

  function pollServers() {
    api("/api/servers?cid=" + encodeURIComponent(clientId))
      .then(function (response) { return response.json(); })
      .then(function (state) {
        statusDot.className = "dot online";
        connection = Object.assign({}, connection, state);
        renderServers(state.servers || []);
        syncVersion(state.bundleVersion);
      })
      .catch(function () {
        statusDot.className = "dot";
      });
  }

  // --- Joining another server ---

  /// A QRC link carries host, port and key; plain "host:port" works too.
  function parseJoinTarget(text) {
    var result = { host: "", port: "", key: "", fingerprint: "", tls: false };
    if (!text) return result;
    text = text.trim();
    var match = text.match(/^(?:(https?|ircs?):\/\/)?(?::([^@]+)@)?(\[[^\]]+\]|[^:\/?#\s]+)(?::(\d+))?/i);
    if (match) {
      result.host = match[3] || "";
      if (match[2]) result.key = match[2];
      // A web link's port is the HTTP port, not IRC — only trust irc:// ports.
      if (match[4] && (!match[1] || /^ircs?$/i.test(match[1]))) result.port = match[4];
    }
    var keyParam = text.match(/[?&]k=([^&#\s]+)/);
    if (keyParam) result.key = decodeURIComponent(keyParam[1]);
    // A QRC link carries the cert fingerprint (f) and TLS port (tp): with
    // those we can pin the exact certificate instead of trusting a CA.
    var fingerprintParam = text.match(/[?&]f=([0-9a-fA-F]{64})/);
    if (fingerprintParam) {
      result.fingerprint = fingerprintParam[1].toLowerCase();
      result.tls = true;
    }
    var tlsPortParam = text.match(/[?&]tp=(\d+)/);
    if (tlsPortParam) result.port = tlsPortParam[1];
    // ircs:// means TLS too.
    if (/^ircs:/i.test(text.trim())) result.tls = true;
    return result;
  }

  function openJoinSheet() {
    joinSheet.classList.remove("hidden");
    joinPaste.value = "";
    joinPort.value = "6667";
    joinKey.value = "";
    joinPaste.focus();
  }

  var pastedFingerprint = "";

  function fillFromPaste() {
    var parsed = parseJoinTarget(joinPaste.value);
    if (parsed.host && parsed.host !== joinPaste.value.trim()) joinPaste.value = parsed.host;
    if (parsed.port) joinPort.value = parsed.port;
    if (parsed.key) joinKey.value = parsed.key;
    pastedFingerprint = parsed.fingerprint || "";
    tlsToggle.checked = parsed.tls || !!parsed.fingerprint;
    reflectTLS();
  }

  function reflectTLS() {
    tlsNote.textContent = tlsToggle.checked
      ? (pastedFingerprint
          ? "encrypted, certificate pinned from their QR code"
          : "encrypted, but their certificate is unverified")
      : "plaintext";
  }
  tlsToggle.addEventListener("change", reflectTLS);

  var guestExplanation =
    "Browsers can't accept inbound network connections, so this tab can't host " +
    "a server or change this host's network settings. Those controls belong to " +
    "the device running QRC — run QRC on this device to host your own.";

  if (!isHostOperator()) {
    // A browser tab has no listening socket, so it can neither host nor
    // reconfigure the host it's visiting. Disable rather than hide, so the
    // capability is visible and the reason is explainable.
    addServerButton.disabled = true;
    addServerButton.title = guestExplanation;
    menuToggle.disabled = true;
    menuToggle.title = guestExplanation;
    addServerButton.addEventListener("click", function (event) {
      event.preventDefault();
      showGuestNotice();
    });
    menuToggle.addEventListener("click", function (event) {
      event.preventDefault();
      showGuestNotice();
    });
  }

  function showGuestNotice() {
    var existing = $("guest-notice");
    if (existing) { existing.remove(); return; }
    var notice = document.createElement("div");
    notice.id = "guest-notice";
    notice.textContent = guestExplanation;
    serversEl.parentNode.insertBefore(notice, serversEl);
    setTimeout(function () { notice.remove(); }, 9000);
  }

  addServerButton.addEventListener("click", function () {
    if (!addServerButton.disabled) openJoinSheet();
  });
  joinCancel.addEventListener("click", function () { joinSheet.classList.add("hidden"); });
  joinPaste.addEventListener("paste", function () { setTimeout(fillFromPaste, 0); });
  joinPaste.addEventListener("change", fillFromPaste);

  joinConfirm.addEventListener("click", function () {
    var parsed = parseJoinTarget(joinPaste.value);
    var host = parsed.host || joinPaste.value.trim();
    if (!host) return;
    api("/api/servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        host: host,
        port: parseInt(joinPort.value, 10) || parseInt(parsed.port, 10) || (tlsToggle.checked ? 6697 : 6667),
        key: joinKey.value.trim() || parsed.key || "",
        nick: myName(),
        tls: tlsToggle.checked,
        fingerprint: pastedFingerprint || parsed.fingerprint || "",
      }),
    })
      .then(function () {
        joinSheet.classList.add("hidden");
        pollServers();
      })
      .catch(function () {});
  });

  // --- Level 2: channels ---

  function renderChannels(rooms) {
    channelsEl.innerHTML = "";
    if (!rooms.length) {
      var empty = document.createElement("div");
      empty.className = "empty-inbox";
      empty.textContent = "No channels yet — tap + to open one.";
      channelsEl.appendChild(empty);
      return;
    }
    rooms.forEach(function (room) {
      var row = document.createElement("div");
      row.className = "channel-row";
      var top = document.createElement("div");
      top.className = "row";
      var name = document.createElement("span");
      name.className = "name";
      name.textContent = "#" + room.name;
      var time = document.createElement("span");
      time.className = "preview";
      time.textContent = timeLabel(room.lastTs);
      top.appendChild(name);
      top.appendChild(time);
      var preview = document.createElement("div");
      preview.className = "preview";
      preview.textContent = room.count === 0 ? "no messages yet" : room.lastName + ": " + room.last;
      row.appendChild(top);
      row.appendChild(preview);
      row.addEventListener("click", function () {
        openRoom({ id: room.id, name: room.name });
      });
      channelsEl.appendChild(row);
    });
  }

  function pollChannels() {
    if (!currentServer) return;
    var server = currentServer;
    api("/api/channels?server=" + encodeURIComponent(server.id) +
        "&cid=" + encodeURIComponent(clientId))
      .then(function (response) { return response.json(); })
      .then(function (state) {
        if (currentServer !== server) return;
        connection = Object.assign({}, connection, state);
        serverPeers.textContent = state.peers + (state.peers === 1 ? " device" : " devices");
        renderChannels(state.rooms || []);
        if (server.isLocal) renderShare();
        syncVersion(state.bundleVersion);
      })
      .catch(function () { serverPeers.textContent = "offline"; });
  }

  function createChannel(name) {
    return api("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name.replace(/^#/, ""),
        server: currentServer ? currentServer.id : "local",
        cid: clientId,
      }),
    }).then(function (response) { return response.json(); });
  }

  addChannelButton.addEventListener("click", function () {
    var name = prompt("Channel name:");
    if (!name || !name.trim()) return;
    createChannel(name.trim()).then(function (room) { openRoom(room); }).catch(function () {});
  });

  // --- Level 3: chat ---

  var renderedRecently = {};

  /// True the first time a given (sender, text) is seen; false for the copy
  /// that arrives by the other path moments later.
  function firstSighting(message) {
    var key = (message.cid || "") + "|" + message.text;
    var now = Date.now() / 1000;
    for (var old in renderedRecently) {
      if (now - renderedRecently[old] > 30) delete renderedRecently[old];
    }
    if (renderedRecently[key] !== undefined) return false;
    renderedRecently[key] = now;
    return true;
  }

  function addMessage(message) {
    if (!firstSighting(message)) return;
    var mine = message.cid === clientId;
    var wrapper = document.createElement("div");
    wrapper.className = "msg " + (mine ? "me" : "them");
    var meta = document.createElement("div");
    meta.className = "meta";
    var when = new Date(message.ts * 1000);
    meta.textContent = message.name + " · " +
      when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    var bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = message.text;
    wrapper.appendChild(meta);
    wrapper.appendChild(bubble);
    messagesEl.appendChild(wrapper);
  }

  function systemLine(text) {
    var el = document.createElement("div");
    el.className = "system";
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function pollRoom() {
    if (!currentRoom) return;
    var room = currentRoom;
    api("/api/state?room=" + encodeURIComponent(room.id) +
        "&since=" + lastId + "&cid=" + encodeURIComponent(clientId))
      .then(function (response) { return response.json(); })
      .then(function (state) {
        if (currentRoom !== room) return;
        roomPeers.textContent = state.peers + (state.peers === 1 ? " device" : " devices");
        (state.messages || []).forEach(function (message) {
          if (message.id > lastId) {
            lastId = message.id;
            addMessage(message);
          }
        });
        if ((state.messages || []).length) messagesEl.scrollTop = messagesEl.scrollHeight;
        syncVersion(state.bundleVersion);
      })
      .catch(function () { roomPeers.textContent = "offline"; });
  }

  function postMessage(text) {
    // Fire down the direct channels first — that copy arrives immediately,
    // without waiting for the host round trip.
    if (peers) peers.send(text, myName());
    sendButton.disabled = true;
    api("/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room: currentRoom.id, name: myName(), text: text, cid: clientId }),
    })
      .then(function () { textInput.value = ""; pollRoom(); })
      .finally(function () { sendButton.disabled = false; textInput.focus(); });
  }

  /// IRC-style commands typed into the message box.
  function handleCommand(text) {
    if (text[0] !== "/") return false;
    var parts = text.slice(1).split(/\s+/);
    var command = parts[0].toLowerCase();
    var rest = text.slice(1 + parts[0].length).trim();

    if (command === "nick") {
      if (!rest) { systemLine("usage: /nick <name>"); return true; }
      setNick(rest);
      api("/api/nick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nick: rest }),
      }).catch(function () {});
      systemLine("you are now " + rest);
      return true;
    }
    if (command === "join") {
      if (!rest) { systemLine("usage: /join <channel>"); return true; }
      createChannel(rest).then(function (room) { openRoom(room); }).catch(function () {});
      return true;
    }
    if (command === "me") {
      postMessage("* " + myName() + " " + rest);
      return true;
    }
    if (command === "help") {
      systemLine("/nick <name> · /join <channel> · /me <action>");
      return true;
    }
    systemLine("unknown command: /" + command);
    return true;
  }

  function send() {
    var text = textInput.value.trim();
    if (!text || !currentRoom) return;
    if (handleCommand(text)) { textInput.value = ""; return; }
    postMessage(text);
  }

  sendButton.addEventListener("click", send);
  textInput.addEventListener("keydown", function (event) {
    if (event.key === "Enter") send();
  });

  // --- Direct peer-to-peer messaging ---
  //
  // The host relays a few signalling messages, then peers talk straight to
  // each other over a WebRTC data channel. Messages still go through the host
  // as well, so everyone (IRC clients included) sees them and history is
  // kept — the direct path is what makes delivery immediate, and what works
  // between two devices that could never accept each other's connections.

  var peers = null;
  if (typeof RTCPeerConnection !== "undefined" && typeof QRCPeers !== "undefined") {
    peers = new QRCPeers({
      selfId: clientId,
      api: api,
      onStatus: function (count) {
        p2pBadge.classList.toggle("hidden", count === 0);
        p2pBadge.textContent = count === 1 ? "direct" : "direct ×" + count;
      },
      onMessage: function (message) {
        if (!currentRoom) return;
        addMessage({
          id: -1, name: message.name, text: message.text,
          cid: message.cid, ts: message.ts,
        });
        messagesEl.scrollTop = messagesEl.scrollHeight;
      },
    });
  }

  // --- Signed app propagation ---
  //
  // Every host serves a versioned, signed copy of this app. A client carries
  // the newest bundle it has seen: on an older host it offers the update (the
  // host verifies the signature before adopting), and on a newer host it
  // caches that bundle and reloads into it.

  var myVersion = null;
  var reloading = false;

  function cachedVersion() {
    return parseInt(localStorage.getItem("qrc-bundle-version") || "0", 10) || 0;
  }

  function cacheBundle(bundle) {
    try {
      localStorage.setItem("qrc-bundle", JSON.stringify(bundle));
      localStorage.setItem("qrc-bundle-version", String(bundle.version));
    } catch (e) { /* storage full: propagation is best-effort */ }
  }

  function reloadInto(version) {
    if (reloading) return;
    reloading = true;
    console.log("[qrc] host is running v" + version + ", reloading");
    setTimeout(function () { location.reload(); }, 300);
  }

  function pushBundleTo(hostVersion) {
    var raw = localStorage.getItem("qrc-bundle");
    if (!raw) return;
    var bundle;
    try { bundle = JSON.parse(raw); } catch (e) { return; }
    if (!bundle || bundle.version <= hostVersion) return;
    api("/api/bundle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bundle),
    })
      .then(function (response) { return response.json(); })
      .then(function (result) { if (result.ok) reloadInto(result.version); })
      .catch(function () {});
  }

  function syncVersion(hostVersion) {
    if (typeof hostVersion !== "number") return;
    if (myVersion === null) myVersion = hostVersion;

    if (hostVersion > myVersion) {
      api("/api/bundle")
        .then(function (response) { return response.json(); })
        .then(function (bundle) {
          if (bundle && bundle.version > cachedVersion()) cacheBundle(bundle);
          reloadInto(hostVersion);
        })
        .catch(function () { reloadInto(hostVersion); });
      return;
    }
    if (hostVersion > cachedVersion()) {
      api("/api/bundle")
        .then(function (response) { return response.json(); })
        .then(function (bundle) {
          if (bundle && bundle.version > cachedVersion()) cacheBundle(bundle);
        })
        .catch(function () {});
    } else if (cachedVersion() > hostVersion) {
      pushBundleTo(hostVersion);
    }
  }

  // --- Network settings (hamburger, servers level) ---

  var selectedFamily = "ipv4";

  function reflectFamily() {
    modeIpv4.className = "seg" + (selectedFamily === "ipv4" ? " active" : "");
    modeIpv6.className = "seg" + (selectedFamily === "ipv6" ? " active" : "");
    stunRow.className = "setting" + (selectedFamily === "ipv6" ? " disabled" : "");
    upnpRow.className = "setting" + (selectedFamily === "ipv6" ? " disabled" : "");
  }

  function loadSettings() {
    api("/api/settings")
      .then(function (response) { return response.json(); })
      .then(function (settings) {
        selectedFamily = settings.family;
        stunToggle.checked = settings.stun;
        upnpToggle.checked = settings.upnp;
        reflectFamily();
        connection = Object.assign({}, connection, settings);
        settingsStatus.textContent =
          settings.status === "error" ? "error: " + settings.detail : settings.detail;
        if (settings.status === "applying") {
          settingsStatus.textContent = "applying…";
          settingsApply.disabled = true;
          setTimeout(loadSettings, 1000);
        } else {
          settingsApply.disabled = false;
        }
      })
      .catch(function () { settingsStatus.textContent = "host unreachable"; });
  }

  modeIpv4.addEventListener("click", function () { selectedFamily = "ipv4"; reflectFamily(); });
  modeIpv6.addEventListener("click", function () { selectedFamily = "ipv6"; reflectFamily(); });
  menuToggle.addEventListener("click", function () {
    drawer.classList.toggle("visible");
    if (drawer.classList.contains("visible")) {
      loadSettings();
      loadDNS();
    }
  });

  settingsApply.addEventListener("click", function () {
    settingsApply.disabled = true;
    settingsStatus.textContent = "applying…";
    api("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        family: selectedFamily,
        stun: stunToggle.checked,
        upnp: upnpToggle.checked,
      }),
    })
      .then(function () { setTimeout(loadSettings, 1000); })
      .catch(function () {
        settingsStatus.textContent = "host unreachable";
        settingsApply.disabled = false;
      });
  });

  // --- Optional Duck DNS publishing + pasted certificate ---

  var dnsToggle = $("dns-toggle"), dnsFields = $("dns-fields");
  var dnsHost = $("dns-host"), dnsToken = $("dns-token"), dnsPem = $("dns-pem");
  var dnsApply = $("dns-apply"), dnsStatus = $("dns-status");

  function reflectDNS() {
    dnsFields.classList.toggle("hidden", !dnsToggle.checked);
  }
  dnsToggle.addEventListener("change", reflectDNS);

  function loadDNS() {
    api("/api/dns")
      .then(function (response) { return response.json(); })
      .then(function (dns) {
        dnsToggle.checked = !!dns.enabled;
        dnsHost.value = dns.hostname || "";
        // Secrets stay on the host; blank means "keep what's stored".
        dnsToken.placeholder = dns.hasToken ? "saved — leave blank to keep" : "kept on this device";
        dnsPem.placeholder = dns.hasCertificate
          ? "saved — leave blank to keep"
          : "-----BEGIN CERTIFICATE-----";
        dnsStatus.textContent = dns.usingCertificate
          ? "serving your certificate · " + dns.status
          : dns.status;
        reflectDNS();
      })
      .catch(function () {});
  }

  dnsApply.addEventListener("click", function () {
    dnsStatus.textContent = "saving…";
    api("/api/dns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: dnsToggle.checked,
        hostname: dnsHost.value.trim(),
        token: dnsToken.value,
        pem: dnsPem.value,
      }),
    })
      .then(function () {
        dnsToken.value = "";
        dnsPem.value = "";
        setTimeout(loadDNS, 1200);
      })
      .catch(function () { dnsStatus.textContent = "host unreachable"; });
  });

  // --- Bootstrappers ---
  //
  // A browser tab can't hand the app to a device that has nothing, so the
  // first copy must come from something that speaks HTTP. Anything will do —
  // a QRC host, a bare file server, any static host — and it holds nothing
  // sensitive: the app is public code.
  //
  // Every client remembers where it was bootstrapped from (it must have come
  // from somewhere) so it can point the next person at one. That link is kept
  // separate from the pairing link on purpose: the bootstrapper hands out the
  // app and learns nothing about who ends up talking to whom.

  function knownBootstrappers() {
    try {
      return JSON.parse(localStorage.getItem("qrc-bootstrappers") || "[]");
    } catch (e) {
      return [];
    }
  }

  function rememberBootstrapper(url) {
    if (!url || url.indexOf("http") !== 0) return;
    var list = knownBootstrappers();
    if (list.indexOf(url) === -1) {
      list.unshift(url);
      localStorage.setItem("qrc-bootstrappers", JSON.stringify(list.slice(0, 8)));
    }
  }

  // Where this very page came from is, by definition, a working bootstrapper.
  if (location.protocol === "http:" || location.protocol === "https:") {
    rememberBootstrapper(location.origin + location.pathname.replace(/[^/]*$/, ""));
  }

  // --- Navigation -------------------------------------------------------
  //
  // Four destinations: the servers list, pairing (a direct peer connection),
  // bootstrapping (handing the app to someone who has nothing), and settings.

  var pages = {
    servers: viewServers,
    pairing: $("view-pairing"),
    bootstrap: $("view-bootstrap"),
    settings: $("view-settings"),
  };

  function goTo(name, push) {
    Object.keys(pages).forEach(function (key) {
      if (pages[key]) pages[key].classList.toggle("hidden", key !== name);
    });
    viewChannels.classList.add("hidden");
    viewChat.classList.add("hidden");
    drawer.classList.remove("visible");
    level = name;
    if (push !== false) history.pushState({ level: name }, "", "#" + name);
    if (name === "servers") pollServers();
    if (name === "bootstrap") showBootstrap();
    if (name === "settings") { loadSettings(); loadDNS(); }
  }

  Array.prototype.forEach.call(document.querySelectorAll(".nav-item"), function (item) {
    item.addEventListener("click", function () { goTo(item.getAttribute("data-view")); });
  });
  Array.prototype.forEach.call(document.querySelectorAll(".back-button"), function (button) {
    button.addEventListener("click", function () { history.back(); });
  });

  // --- Shared helpers for the two QR pages ---------------------------------

  function drawQR(image, url) {
    try {
      var qr = qrcode(0, "L");
      qr.addData(url);
      qr.make();
      image.src = qr.createDataURL(6, 8);
      image.dataset.ok = "1";
    } catch (e) {
      image.removeAttribute("src");
      image.alt = "too long for one QR — use the link";
      image.dataset.ok = "";
    }
  }

  function downloadQR(image, filename) {
    if (!image.src) return;
    var link = document.createElement("a");
    link.href = image.src;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    var scratch = document.createElement("textarea");
    scratch.value = text;
    scratch.style.position = "fixed";
    scratch.style.opacity = "0";
    document.body.appendChild(scratch);
    scratch.select();
    try { document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(scratch);
    return Promise.resolve();
  }

  /// Native share sheet where there is one, clipboard everywhere else.
  function shareLink(url, title) {
    if (navigator.share) {
      navigator.share({ title: title, url: url }).catch(function () {});
    } else {
      copyText(url).then(function () { flash("link copied"); });
    }
  }

  function flash(text) {
    var toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = text;
    document.body.appendChild(toast);
    setTimeout(function () { toast.remove(); }, 1800);
  }

  /// Where this app came from, and therefore where to send someone who needs
  /// a copy of it.
  function bootstrapBase() {
    var known = knownBootstrappers();
    if (known.length) return known[0];
    return location.origin + location.pathname.replace(/[^/]*$/, "");
  }

  // --- Bootstrapping page --------------------------------------------------

  var bootstrapQR = $("bootstrap-qr"), bootstrapURL = $("bootstrap-url");

  function bootstrapLink() {
    var base = bootstrapBase();
    return base + (base.indexOf("?") === -1 ? "?" : "&") + "bootstrap=true";
  }

  function showBootstrap() {
    var url = bootstrapLink();
    bootstrapURL.textContent = url;
    drawQR(bootstrapQR, url);
  }

  $("bootstrap-download").addEventListener("click", function () {
    downloadQR(bootstrapQR, "qrc-bootstrap.png");
  });
  $("bootstrap-share").addEventListener("click", function () {
    shareLink(bootstrapLink(), "Get QRC");
  });

  // --- Pairing page --------------------------------------------------------

  var tabSend = $("tab-send"), tabReceive = $("tab-receive");
  var pairSend = $("pair-send"), pairReceive = $("pair-receive");
  var pairState = $("pair-state"), pairCreate = $("pair-create");
  var pairSendOut = $("pair-send-out"), pairQR = $("pair-qr"), pairURL = $("pair-url");
  var pairInput = $("pair-input"), pairAccept = $("pair-accept"), pairScan = $("pair-scan");
  var pairVideo = $("pair-video");
  var pairAnswerOut = $("pair-answer-out"), pairAnswerQR = $("pair-answer-qr");
  var pairAnswerURL = $("pair-answer-url");
  var pairMessages = $("pair-messages"), pairFooter = $("pair-footer");
  var pairText = $("pair-text"), pairSendMessage = $("pair-send-message");

  var session = null;
  var inviteURL = "";
  var answerURL = "";
  var awaitingReply = false;   // true once we've issued an invitation

  function showTab(which) {
    tabSend.classList.toggle("active", which === "send");
    tabReceive.classList.toggle("active", which === "receive");
    pairSend.classList.toggle("hidden", which !== "send");
    pairReceive.classList.toggle("hidden", which !== "receive");
  }
  tabSend.addEventListener("click", function () { showTab("send"); });
  tabReceive.addEventListener("click", function () { showTab("receive"); });

  function pairLine(name, text, mine) {
    var wrapper = document.createElement("div");
    wrapper.className = "msg " + (mine ? "me" : "them");
    var meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = name;
    var bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = text;
    wrapper.appendChild(meta);
    wrapper.appendChild(bubble);
    pairMessages.appendChild(wrapper);
    pairMessages.scrollTop = pairMessages.scrollHeight;
  }

  // --- Identity and end-to-end encryption ---------------------------------
  //
  // Every device has a long-lived ECDH keypair. Where the platform supports
  // it, the private half is encrypted at rest with a secret derived from a
  // passkey, so it sits behind the keychain and Face ID rather than in plain
  // local storage.
  //
  // Public keys travel with pairing and are then republished by whoever is
  // acting as server, so every member can seal messages for every other
  // member. The server relays ciphertext and holds only public halves — it
  // cannot read what it forwards.

  var identity = null;

  function showIdentity() {
    var fingerprintEl = $("identity-fingerprint");
    var backingEl = $("identity-backing");
    if (!fingerprintEl) return;
    if (!identity) {
      fingerprintEl.textContent = "not created yet";
      return;
    }
    fingerprintEl.textContent = identity.fingerprint;
    backingEl.textContent = identity.passkeyBacked
      ? "· protected by a passkey"
      : "· stored on this device";
  }

  /// Called from a user gesture (creating or accepting an invitation), which
  /// is what lets us prompt for a passkey.
  function ensureIdentity() {
    if (identity) return Promise.resolve(identity);
    return QRCCrypto.loadIdentity({ interactive: true, name: myName() })
      .then(function (loaded) {
        identity = loaded;
        showIdentity();
        return identity;
      })
      .catch(function (error) {
        pairState.textContent = "identity unavailable: " + error.message;
        return null;
      });
  }

  // The peer link carries IRC, not a bespoke chat protocol. Whoever issued
  // the invitation runs the server; whoever accepted it connects as a client.
  // Same protocol as the native hosts speak over TCP — only the transport
  // differs — so a browser can host a network with no inbound connectivity.
  var ircServer = null;
  var ircClient = null;
  var pairRole = $("pair-role");

  function showPairChat(roleLabel) {
    pairSend.classList.add("hidden");
    pairReceive.classList.add("hidden");
    document.querySelector("#view-pairing .tabs").classList.add("hidden");
    pairMessages.classList.remove("hidden");
    pairFooter.classList.remove("hidden");
    pairRole.textContent = roleLabel;
    pairRole.classList.remove("hidden");
    stopCamera();
  }

  /// Everyone we can encrypt to, other than ourselves.
  function currentRoster() {
    var roster = ircServer ? ircServer.roster : (ircClient ? ircClient.roster : {});
    var recipients = [];
    for (var nick in roster) {
      if (nick !== myName() && roster[nick]) recipients.push({ nick: nick, jwk: roster[nick] });
    }
    return recipients;
  }

  function updateEncryptionBadge() {
    var on = identity && currentRoster().length > 0;
    $("pair-e2ee").classList.toggle("hidden", !on);
  }

  /// Decrypts if the body is sealed, otherwise shows it as-is.
  function receiveMessage(nick, text) {
    var envelope = QRCCrypto.decode(text);
    if (!envelope || !identity) {
      pairLine(nick, text, false);
      return;
    }
    QRCCrypto.open(identity, myName(), envelope)
      .then(function (plain) { pairLine(nick + " \ud83d\udd12", plain, false); })
      .catch(function () { pairLine(nick, "[encrypted — not addressed to you]", false); });
  }

  /// What a joining peer is told about the network on arrival.
  function networkInfo() {
    return {
      bootstrappers: knownBootstrappers(),
      host: myName(),
      channels: ircServer ? Object.keys(ircServer.channels) : ["#general"],
    };
  }

  function startAsServer(channel) {
    ircServer = new QRCIRC.Server({
      serverName: myName() + "-host",
      hostNick: myName(),
      identityKey: identity ? identity.publicJWK : null,
      networkInfo: networkInfo,
      onEvent: function (event) {
        if (event.type === "message") {
          receiveMessage(event.nick, event.text);
        } else if (event.type === "key") {
          updateEncryptionBadge();
        } else if (event.type === "join") {
          pairLine("", event.nick + " joined " + event.channel, false);
        } else if (event.type === "registered") {
          pairLine("", event.nick + " connected to your server", false);
        } else if (event.type === "disconnected" && event.nick) {
          pairLine("", event.nick + " left", false);
        }
      },
    });
    ircServer.hostNick = myName();
    ircServer.accept(channel, "paired peer");
    showPairChat("serving");
    pairLine("", "you are hosting an IRC server over this peer link", false);
  }

  function startAsClient(channel) {
    ircClient = new QRCIRC.Client({
      nick: myName(),
      identityKey: identity ? identity.publicJWK : null,
      onEvent: function (event) {
        if (event.type === "message") {
          receiveMessage(event.nick, event.text);
        } else if (event.type === "roster" || event.type === "key") {
          updateEncryptionBadge();
        } else if (event.type === "registered") {
          pairLine("", event.text, false);
        } else if (event.type === "join" && event.nick !== myName()) {
          pairLine("", event.nick + " joined " + event.channel, false);
        } else if (event.type === "network") {
          // Learn the network from whoever let us in.
          (event.info.bootstrappers || []).forEach(rememberBootstrapper);
          pairLine("", "joined " + (event.info.host || "a peer") + "'s network", false);
        }
      },
    });
    ircClient.attach(channel);
    showPairChat("client");
  }

  function newSession(asServer) {
    if (session) session.close();
    ircServer = null;
    ircClient = null;
    session = new QRCDirect({
      name: myName(),
      onState: function (state) {
        pairState.textContent = state;
        if (state === "connected" && session.channel) {
          if (asServer) startAsServer(session.channel);
          else startAsClient(session.channel);
        }
      },
      onMessage: function () { /* IRC framing handles the data channel now */ },
    });
    return session;
  }

  /// The link that carries an invitation: it points at a bootstrapper so
  /// someone without the app still gets it, and the payload rides in the
  /// query so a native camera app can open it.
  function pairingLink(kind, blob) {
    var base = bootstrapBase();
    return base + (base.indexOf("?") === -1 ? "?" : "&") +
      "pair=true&" + kind + "=" + blob;
  }

  pairCreate.addEventListener("click", function () {
    pairCreate.disabled = true;
    pairState.textContent = "preparing your identity…";
    ensureIdentity().then(function () {
    pairState.textContent = "gathering…";
    return newSession(true).createInvite()
      .then(function (blob) {
        awaitingReply = true;
        inviteURL = pairingLink("o", blob);
        pairSendOut.classList.remove("hidden");
        pairURL.textContent = inviteURL;
        drawQR(pairQR, inviteURL);
        pairState.textContent = "waiting for their reply";
      })
      .catch(function (error) { pairState.textContent = "failed: " + error; })
      .finally(function () { pairCreate.disabled = false; });
    });
  });

  $("pair-download").addEventListener("click", function () { downloadQR(pairQR, "qrc-invite.png"); });
  $("pair-share").addEventListener("click", function () { shareLink(inviteURL, "Pair with me on QRC"); });
  $("pair-answer-download").addEventListener("click", function () { downloadQR(pairAnswerQR, "qrc-reply.png"); });
  $("pair-answer-share").addEventListener("click", function () { shareLink(answerURL, "QRC reply"); });

  /// Accepts whatever the other side showed us — an invitation or a reply.
  function acceptBlob(text) {
    var payload = String(text).trim();
    var match = payload.match(/[?&#][oai]=([A-Za-z0-9\-_]+)/);
    var kind = match ? payload.charAt(payload.indexOf(match[1]) - 2) : null;
    var blob = match ? match[1] : payload;
    if (!blob) return;

    if (awaitingReply && session && kind !== "o") {
      pairState.textContent = "connecting…";
      session.acceptReply(blob).catch(function (error) {
        pairState.textContent = "that reply didn't parse: " + error;
      });
      return;
    }
    pairState.textContent = "answering…";
    ensureIdentity().then(function () {
    return newSession(false).acceptInvite(blob)
      .then(function (answerBlob) {
        answerURL = pairingLink("a", answerBlob);
        pairAnswerOut.classList.remove("hidden");
        pairAnswerURL.textContent = answerURL;
        drawQR(pairAnswerQR, answerURL);
        pairState.textContent = "send them the reply";
      })
      .catch(function (error) {
        pairState.textContent = "that didn't parse: " + error;
      });
    });
  }

  pairAccept.addEventListener("click", function () { acceptBlob(pairInput.value); });

  // --- Camera scanning (where the browser supports it) ---------------------

  var cameraStream = null;
  var scanTimer = null;

  function stopCamera() {
    if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
    if (cameraStream) {
      cameraStream.getTracks().forEach(function (track) { track.stop(); });
      cameraStream = null;
    }
    pairVideo.classList.add("hidden");
  }

  pairScan.addEventListener("click", function () {
    if (cameraStream) { stopCamera(); return; }
    if (!navigator.mediaDevices || !window.isSecureContext) {
      pairState.textContent = "camera needs https — paste the link instead";
      return;
    }
    if (typeof BarcodeDetector === "undefined") {
      // Safari has no BarcodeDetector; the native camera app scans QRs and
      // opens the link, which reaches the same place.
      pairState.textContent = "this browser can't scan — use the camera app, or paste";
      return;
    }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
      .then(function (stream) {
        cameraStream = stream;
        pairVideo.srcObject = stream;
        pairVideo.classList.remove("hidden");
        pairVideo.play();
        var detector = new BarcodeDetector({ formats: ["qr_code"] });
        scanTimer = setInterval(function () {
          detector.detect(pairVideo)
            .then(function (codes) {
              if (codes.length) {
                stopCamera();
                acceptBlob(codes[0].rawValue);
              }
            })
            .catch(function () {});
        }, 400);
      })
      .catch(function (error) {
        pairState.textContent = "camera unavailable: " + error;
      });
  });

  function sendPairMessage() {
    var text = pairText.value.trim();
    if (!text) return;
    if (text.indexOf("/nick ") === 0) {
      var nick = text.slice(6).trim();
      if (nick) {
        setNick(nick);
        if (ircClient) ircClient.setNick(nick);
        if (ircServer) ircServer.hostNick = nick;
        pairLine("", "you are now " + nick, false);
      }
      pairText.value = "";
      return;
    }
    if (text.indexOf("/join ") === 0) {
      var channelName = text.slice(6).trim().replace(/^#?/, "#");
      if (ircClient) ircClient.join(channelName);
      if (ircServer) ircServer.ensureChannel(channelName);
      pairLine("", "now in " + channelName, false);
      pairText.value = "";
      return;
    }
    var recipients = currentRoster();
    var deliver = function (body) {
      if (ircServer) ircServer.say("#general", myName(), body);
      else if (ircClient) ircClient.say(body);
    };
    if (identity && recipients.length) {
      // Seal once for everyone present; the relay forwards bytes it can't read.
      QRCCrypto.seal(identity, recipients, text)
        .then(function (envelope) { deliver(QRCCrypto.encode(envelope)); })
        .catch(function () { deliver(text); });
      pairLine(myName() + " \ud83d\udd12", text, true);
    } else {
      if (!ircServer && !ircClient) return;
      deliver(text);
      pairLine(myName(), text, true);
    }
    pairText.value = "";
  }
  pairSendMessage.addEventListener("click", sendPairMessage);
  pairText.addEventListener("keydown", function (event) {
    if (event.key === "Enter") sendPairMessage();
  });

  // --- Arriving by link ----------------------------------------------------
  //
  // ?bootstrap=true  someone sent us here to get the app; go straight to
  //                  pairing, which is what they want next.
  // ?pair=true&o=..  they showed us an invitation; answer it automatically.
  // ?pair=true&a=..  they sent back a reply.

  (function () {
    var search = location.search || "";
    var hash = location.hash || "";
    var offer = (search + hash).match(/[?&#]o=([A-Za-z0-9\-_]+)/);
    var reply = (search + hash).match(/[?&#]a=([A-Za-z0-9\-_]+)/);

    if (/[?&]pair=true/.test(search) || offer || reply) {
      history.replaceState({ level: "pairing" }, "", location.pathname);
      goTo("pairing", false);
      if (offer) {
        showTab("receive");
        acceptBlob(offer[1]);
      } else if (reply) {
        showTab("receive");
        acceptBlob(reply[1]);
      }
      return;
    }
    if (/[?&]bootstrap=true/.test(search)) {
      history.replaceState({ level: "pairing" }, "", location.pathname);
      goTo("pairing", false);
    }
  })();

  // --- Main loop ---

  // Pick up an existing identity quietly; creating one needs a gesture.
  if (window.QRCCrypto && localStorage.getItem("qrc-identity")) {
    QRCCrypto.loadIdentity({ interactive: false })
      .then(function (loaded) { identity = loaded; showIdentity(); })
      .catch(function () { /* passkey-wrapped: unlocks on the next pairing */ });
  }

  history.replaceState({ level: "servers" }, "", location.pathname);
  setInterval(function () {
    if (level === "chat") {
      pollRoom();
    } else if (level === "channels") {
      pollChannels();
    } else {
      pollServers();
    }
  }, 1500);
  pollServers();
})();
