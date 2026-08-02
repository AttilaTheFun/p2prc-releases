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
  var viewGroups = $("view-groups");
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
  var currentGroupId = null;

  function show(next) {
    level = next;
    if (directView) directView.classList.add("hidden");
  }

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

  // --- Groups --------------------------------------------------------------
  //
  // Groups replace servers entirely. A direct message is a group with two
  // members; a group chat is the same thing with more. Nobody hosts one:
  // every member holds the full history, and members reconcile whenever they
  // meet. A group survives all of its members being offline.

  var net = new QRCNet({
    name: myName(),
    onChange: function () { renderGroups(); renderGroup(); },
    onLog: function (line) { console.log("[qrc] " + line); },
  });

  var groupsEl = $("groups");
  var viewGroup = $("view-group");
  var groupTitle = $("group-title"), groupEpoch = $("group-epoch");
  var groupOnline = $("group-online"), groupMessages = $("group-messages");
  var groupText = $("group-text"), groupSend = $("group-send");
  var currentGroup = null;

  function timeLabel(ts) {
    if (!ts) return "";
    var when = new Date(ts * 1000), now = new Date();
    if (when.toDateString() === now.toDateString()) {
      return when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    return when.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  function renderGroups() {
    if (!groupsEl) return;
    var ids = Object.keys(net.groups);
    groupsEl.innerHTML = "";
    if (!ids.length) {
      var empty = document.createElement("div");
      empty.className = "empty-inbox";
      empty.textContent = "No groups yet. Pair with someone, or tap + to start one.";
      groupsEl.appendChild(empty);
      return;
    }
    ids.map(function (id) { return net.groups[id]; })
      .sort(function (a, b) {
        var la = a.messages().slice(-1)[0], lb = b.messages().slice(-1)[0];
        return (lb ? lb.ts : 0) - (la ? la.ts : 0);
      })
      .forEach(function (group) {
        var row = document.createElement("div");
        row.className = "server-row";
        var top = document.createElement("div");
        top.className = "row";
        var name = document.createElement("span");
        name.className = "name";
        name.textContent = group.title(net.memberId);
        var time = document.createElement("span");
        time.className = "meta";
        var last = group.messages().slice(-1)[0];
        time.textContent = last ? timeLabel(last.ts) : "";
        top.appendChild(name);
        top.appendChild(time);

        var meta = document.createElement("div");
        meta.className = "meta";
        var memberCount = Object.keys(group.members).length;
        meta.textContent = (group.isDirect() ? "direct message" : memberCount + " members") +
          " · " + group.messages().length + " messages";

        row.appendChild(top);
        row.appendChild(meta);
        row.addEventListener("click", function () { openGroup(group); });
        groupsEl.appendChild(row);
      });
  }

  function openGroup(group, push) {
    currentGroup = group;
    Object.keys(pages).forEach(function (key) {
      if (pages[key]) pages[key].classList.add("hidden");
    });
    viewGroup.classList.remove("hidden");
    level = "group";
    if (push !== false) history.pushState({ level: "group", group: group.id }, "", "#" + group.id);
    renderGroup();
    groupText.focus();
  }

  function renderGroup() {
    if (!currentGroup || viewGroup.classList.contains("hidden")) return;
    var group = currentGroup;
    groupTitle.textContent = group.title(net.memberId);
    groupEpoch.textContent = "epoch " + group.epoch;
    groupOnline.textContent = net.onlineCount() + " online";

    net.readGroup(group).then(function (lines) {
      if (currentGroup !== group) return;
      groupMessages.innerHTML = "";
      lines.forEach(function (line) {
        var mine = line.author === net.memberId;
        var wrapper = document.createElement("div");
        wrapper.className = "msg " + (mine ? "me" : "them");
        var meta = document.createElement("div");
        meta.className = "meta";
        meta.textContent = line.name + (line.encrypted && !line.locked ? " \ud83d\udd12 " : " ") +
          new Date(line.ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        var bubble = document.createElement("div");
        bubble.className = "bubble";
        bubble.textContent = line.text;
        wrapper.appendChild(meta);
        wrapper.appendChild(bubble);
        groupMessages.appendChild(wrapper);
      });
      groupMessages.scrollTop = groupMessages.scrollHeight;
    });
  }

  function sendToGroup() {
    var text = groupText.value.trim();
    if (!text || !currentGroup) return;
    groupText.value = "";

    if (text.indexOf("/nick ") === 0) {
      setNick(text.slice(6).trim());
      net.name = myName();
      return;
    }
    if (text === "/leave") {
      net.leaveGroup(currentGroup).then(function () { history.back(); });
      return;
    }
    if (text.indexOf("/invite") === 0) {
      // Inviting is done by pairing: the person needs a link, not a nickname.
      goTo("pairing");
      pairState.textContent = "invite them, then add them to " + currentGroup.title(net.memberId);
      pendingInviteGroup = currentGroup;
      return;
    }
    net.send(currentGroup, text);
  }

  var pendingInviteGroup = null;

  groupSend.addEventListener("click", sendToGroup);
  groupText.addEventListener("keydown", function (event) {
    if (event.key === "Enter") sendToGroup();
  });

  $("new-group").addEventListener("click", function () {
    var name = prompt("Group name:");
    if (!name || !name.trim()) return;
    ensureIdentity().then(function () {
      if (!net.identity) return net.start(identity);
    }).then(function () {
      return net.createGroup(name.trim(), []);
    }).then(function (group) { openGroup(group); });
  });

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
    groups: viewGroups,
    pairing: $("view-pairing"),
    bootstrap: $("view-bootstrap"),
    settings: $("view-settings"),
  };

  function goTo(name, push) {
    Object.keys(pages).forEach(function (key) {
      if (pages[key]) pages[key].classList.toggle("hidden", key !== name);
    });
    if (viewGroup) viewGroup.classList.add("hidden");
    drawer.classList.remove("visible");
    level = name;
    if (push !== false) history.pushState({ level: name }, "", "#" + name);
    if (name === "groups") renderGroups();
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

  // A connected peer is just a peer. Both ends run the same code: adopt the
  // data channel, reconcile every shared group, and carry on. Neither side
  // hosts anything.

  function attachPeer(channel) {
    net.name = myName();
    var promise = net.identity ? Promise.resolve() : net.start(identity);
    promise.then(function () {
      net.addLink(channel, "paired peer");
      pairState.textContent = "connected — syncing";
      showPairChat();
      // Pairing with someone you have no group with creates the direct
      // message that pairing is for.
      var known = Object.keys(net.groups).some(function (id) {
        return net.groups[id].isDirect();
      });
      if (pendingInviteGroup) {
        var group = pendingInviteGroup;
        pendingInviteGroup = null;
        pairLine("", "they can now be added to " + group.title(net.memberId), false);
      } else if (!known) {
        pairLine("", "connected. Open Groups to start a conversation.", false);
      }
    });
  }

  function newSession() {
    if (session) session.close();
    session = new QRCDirect({
      name: myName(),
      onState: function (state) {
        pairState.textContent = state;
        if (state === "connected" && session.channel) attachPeer(session.channel);
      },
      onMessage: function () { /* the sync protocol owns the channel */ },
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
    return newSession().createInvite()
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
    return newSession().acceptInvite(blob)
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

  // Bring up the local identity and stored history straight away: a member
  // should see their groups without needing anyone else to be online.
  if (window.QRCCrypto && localStorage.getItem("qrc-identity")) {
    QRCCrypto.loadIdentity({ interactive: false })
      .then(function (loaded) {
        identity = loaded;
        showIdentity();
        return net.start(identity);
      })
      .then(function () { renderGroups(); })
      .catch(function () { /* passkey-wrapped: unlocks on the next pairing */ });
  }

  history.replaceState({ level: "groups" }, "", location.pathname);
  goTo("groups", false);
})();
