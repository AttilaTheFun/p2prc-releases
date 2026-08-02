/* QRC — a peer-to-peer, end-to-end encrypted chat network with no servers.
 *
 * Every client is equal. There is no host, no room owner, and nothing that has
 * to stay online for a conversation to exist. A client holds its own identity,
 * the groups it belongs to, and the whole history of those groups; when it
 * meets another member they reconcile whatever each has missed.
 *
 * Two things sit outside that symmetry, and only two:
 *   * something must serve this page the first time (any static host, or a
 *     file) — a browser tab cannot hand the app to a device that has nothing;
 *   * an existing member must invite you, because a network of strangers has
 *     no way to know you belong.
 * After that you are the same as everyone else.
 */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  // --- Identity ------------------------------------------------------------

  // Read once: local storage is shared by every tab on this origin, so
  // re-reading would let another window silently change who we are.
  var myNick = localStorage.getItem("qrc-name") || "anon";
  var identity = null;

  function myName() { return myNick; }

  function setNick(nick) {
    myNick = nick;
    localStorage.setItem("qrc-name", nick);
    net.name = nick;
    if ($("nick-field")) $("nick-field").value = nick;
  }

  function showIdentity() {
    if (!$("identity-fingerprint")) return;
    $("identity-fingerprint").textContent = identity ? identity.fingerprint : "not created yet";
    $("identity-backing").textContent = !identity ? "" : (identity.passkeyBacked
      ? "Protected by a passkey in this device's keychain."
      : "Stored on this device. A passkey wasn't available here.");
  }

  /// Creating an identity may prompt for Face ID, so it needs a user gesture.
  function ensureIdentity() {
    if (identity) return Promise.resolve(identity);
    return QRCCrypto.loadIdentity({ interactive: true, name: myName() })
      .then(function (loaded) {
        identity = loaded;
        showIdentity();
        return net.start(identity).then(function () { return identity; });
      });
  }

  // --- The network ---------------------------------------------------------

  var net = new QRCNet({
    name: myName(),
    onChange: function () { renderGroups(); renderGroup(); renderPresence(); },
    onLog: function (line) { console.log("[qrc] " + line); },
  });

  function renderPresence() {
    var online = net.onlineCount();
    $("status-dot").className = "dot" + (online ? " online" : "");
    $("peer-count").textContent = online === 1 ? "1 peer" : online + " peers";
  }

  // --- Bootstrappers -------------------------------------------------------

  function knownBootstrappers() {
    try { return JSON.parse(localStorage.getItem("qrc-bootstrappers") || "[]"); }
    catch (e) { return []; }
  }

  function rememberBootstrapper(url) {
    if (!url || url.indexOf("http") !== 0) return;
    var list = knownBootstrappers();
    if (list.indexOf(url) === -1) {
      list.unshift(url);
      localStorage.setItem("qrc-bootstrappers", JSON.stringify(list.slice(0, 8)));
    }
  }

  if (location.protocol === "http:" || location.protocol === "https:") {
    rememberBootstrapper(location.origin + location.pathname.replace(/[^/]*$/, ""));
  }

  function bootstrapBase() {
    var known = knownBootstrappers();
    return known.length ? known[0] : location.origin + location.pathname.replace(/[^/]*$/, "");
  }

  // --- Navigation ----------------------------------------------------------

  var viewGroup = $("view-group");
  var pages = {
    groups: $("view-groups"),
    pairing: $("view-pairing"),
    bootstrap: $("view-bootstrap"),
    settings: $("view-settings"),
  };
  var level = "groups";

  function goTo(name, push) {
    Object.keys(pages).forEach(function (key) {
      pages[key].classList.toggle("hidden", key !== name);
    });
    viewGroup.classList.add("hidden");
    $("drawer").classList.remove("visible");
    level = name;
    if (push !== false) history.pushState({ level: name }, "", "#" + name);
    if (name === "groups") renderGroups();
    if (name === "bootstrap") showBootstrap();
    if (name === "settings") showSettings();
  }

  Array.prototype.forEach.call(document.querySelectorAll(".nav-item"), function (item) {
    item.addEventListener("click", function () { goTo(item.getAttribute("data-view")); });
  });
  Array.prototype.forEach.call(document.querySelectorAll(".back-button"), function (button) {
    button.addEventListener("click", function () { history.back(); });
  });
  $("menu-toggle").addEventListener("click", function () {
    $("drawer").classList.toggle("visible");
  });

  window.addEventListener("popstate", function (event) {
    var state = event.state || {};
    if (state.level === "group" && net.groups[state.group]) {
      openGroup(net.groups[state.group], false);
    } else if (pages[state.level]) {
      goTo(state.level, false);
    } else {
      goTo("groups", false);
    }
  });

  // --- Shared QR helpers ---------------------------------------------------

  function drawQR(image, url) {
    try {
      var qr = qrcode(0, "L");
      qr.addData(url);
      qr.make();
      image.src = qr.createDataURL(6, 8);
    } catch (e) {
      image.removeAttribute("src");
      image.alt = "too long for one QR — use the link";
    }
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
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

  function flash(text) {
    var toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = text;
    document.body.appendChild(toast);
    setTimeout(function () { toast.remove(); }, 1800);
  }

  function shareLink(url, title) {
    if (navigator.share) navigator.share({ title: title, url: url }).catch(function () {});
    else copyText(url).then(function () { flash("link copied"); });
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

  // --- Bootstrapping page --------------------------------------------------

  function bootstrapLink() {
    var base = bootstrapBase();
    return base + (base.indexOf("?") === -1 ? "?" : "&") + "bootstrap=true";
  }

  function showBootstrap() {
    $("bootstrap-url").textContent = bootstrapLink();
    drawQR($("bootstrap-qr"), bootstrapLink());
  }

  $("bootstrap-download").addEventListener("click", function () {
    downloadQR($("bootstrap-qr"), "qrc-bootstrap.png");
  });
  $("bootstrap-share").addEventListener("click", function () {
    shareLink(bootstrapLink(), "Get QRC");
  });

  // --- Groups --------------------------------------------------------------

  var currentGroup = null;

  function timeLabel(ts) {
    if (!ts) return "";
    var when = new Date(ts * 1000);
    if (when.toDateString() === new Date().toDateString()) {
      return when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    return when.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  function renderGroups() {
    var list = $("groups");
    if (!list) return;
    var ids = Object.keys(net.groups);
    list.innerHTML = "";
    if (!ids.length) {
      var empty = document.createElement("div");
      empty.className = "empty-inbox";
      empty.textContent = "No groups yet. Tap + to start one, or pair with someone to join theirs.";
      list.appendChild(empty);
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
        meta.textContent = (group.isDirect() ? "direct message" : Object.keys(group.members).length + " members") +
          " · " + group.messages().length + " messages";
        row.appendChild(top);
        row.appendChild(meta);
        row.addEventListener("click", function () { openGroup(group); });
        list.appendChild(row);
      });
  }

  function openGroup(group, push) {
    currentGroup = group;
    Object.keys(pages).forEach(function (key) { pages[key].classList.add("hidden"); });
    viewGroup.classList.remove("hidden");
    level = "group";
    if (push !== false) history.pushState({ level: "group", group: group.id }, "", "#" + group.id);
    renderGroup();
    $("group-text").focus();
  }

  function renderGroup() {
    if (!currentGroup || viewGroup.classList.contains("hidden")) return;
    var group = currentGroup;
    $("group-title").textContent = group.title(net.memberId);
    $("group-epoch").textContent = "epoch " + group.epoch;
    $("group-online").textContent = net.onlineCount() + " online";

    net.readGroup(group).then(function (lines) {
      if (currentGroup !== group) return;
      var pane = $("group-messages");
      pane.innerHTML = "";
      lines.forEach(function (line) {
        var wrapper = document.createElement("div");
        wrapper.className = "msg " + (line.author === net.memberId ? "me" : "them");
        var meta = document.createElement("div");
        meta.className = "meta";
        meta.textContent = line.name + (line.encrypted && !line.locked ? " 🔒 " : " ") +
          new Date(line.ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        var bubble = document.createElement("div");
        bubble.className = "bubble";
        bubble.textContent = line.text;
        wrapper.appendChild(meta);
        wrapper.appendChild(bubble);
        pane.appendChild(wrapper);
      });
      pane.scrollTop = pane.scrollHeight;
    });
  }

  function sendToGroup() {
    var text = $("group-text").value.trim();
    if (!text || !currentGroup) return;
    $("group-text").value = "";

    if (text.indexOf("/nick ") === 0) {
      setNick(text.slice(6).trim());
      renderGroup();
      return;
    }
    if (text === "/leave") {
      net.leaveGroup(currentGroup).then(function () { goTo("groups"); });
      return;
    }
    if (text === "/add") {
      net.addConnectedPeers(currentGroup).then(function (count) {
        flash(count ? "added " + count + " peer(s)" : "no connected peers to add");
      });
      return;
    }
    if (text === "/invite") {
      // You invite a person, not a nickname: they need a pairing link.
      goTo("pairing");
      $("pair-state").textContent = "invite them — they'll join " +
        currentGroup.title(net.memberId) + " once connected";
      pendingInviteGroup = currentGroup;
      return;
    }
    net.send(currentGroup, text);
  }

  $("group-send").addEventListener("click", sendToGroup);
  $("group-text").addEventListener("keydown", function (event) {
    if (event.key === "Enter") sendToGroup();
  });

  $("new-group").addEventListener("click", function () {
    var name = prompt("Group name:");
    if (!name || !name.trim()) return;
    ensureIdentity()
      .then(function () { return net.createGroup(name.trim(), []); })
      .then(function (group) { openGroup(group); })
      .catch(function (error) { flash("could not create group: " + error.message); });
  });

  // --- Pairing: joining the network ---------------------------------------

  var session = null;
  var inviteURL = "";
  var answerURL = "";
  var awaitingReply = false;
  var pendingInviteGroup = null;

  function showTab(which) {
    $("tab-send").classList.toggle("active", which === "send");
    $("tab-receive").classList.toggle("active", which === "receive");
    $("pair-send").classList.toggle("hidden", which !== "send");
    $("pair-receive").classList.toggle("hidden", which !== "receive");
  }
  $("tab-send").addEventListener("click", function () { showTab("send"); });
  $("tab-receive").addEventListener("click", function () { showTab("receive"); });

  function pairLine(text) {
    var line = document.createElement("div");
    line.className = "system";
    line.textContent = text;
    $("pair-messages").appendChild(line);
  }

  function pairingLink(kind, blob) {
    var base = bootstrapBase();
    return base + (base.indexOf("?") === -1 ? "?" : "&") + "pair=true&" + kind + "=" + blob;
  }

  /// Both ends run exactly this. Neither is a host.
  function attachPeer(channel) {
    var ready = net.identity ? Promise.resolve() : net.start(identity);
    ready.then(function () {
      net.addLink(channel, "peer");
      $("pair-state").textContent = "connected — reconciling history";
      $("pair-messages").classList.remove("hidden");
      $("pair-send").classList.add("hidden");
      $("pair-receive").classList.add("hidden");
      document.querySelector("#view-pairing .tabs").classList.add("hidden");
      $("pair-e2ee").classList.remove("hidden");
      stopCamera();
      pairLine("Connected. You are peers — neither of you hosts anything.");

      if (pendingInviteGroup) {
        var group = pendingInviteGroup;
        pendingInviteGroup = null;
        pairLine("They can now be added to " + group.title(net.memberId) + ".");
      } else if (!Object.keys(net.groups).length) {
        pairLine("No shared groups yet — create one and they will receive it.");
      }
    });
  }

  function newSession() {
    if (session) session.close();
    session = new QRCDirect({
      name: myName(),
      onState: function (state) {
        $("pair-state").textContent = state;
        if (state === "connected" && session.channel) attachPeer(session.channel);
      },
      onMessage: function () { /* the sync protocol owns this channel */ },
    });
    return session;
  }

  $("pair-create").addEventListener("click", function () {
    $("pair-create").disabled = true;
    $("pair-state").textContent = "preparing your identity…";
    ensureIdentity()
      .then(function () {
        $("pair-state").textContent = "gathering…";
        return newSession().createInvite();
      })
      .then(function (blob) {
        awaitingReply = true;
        inviteURL = pairingLink("o", blob);
        $("pair-send-out").classList.remove("hidden");
        $("pair-url").textContent = inviteURL;
        drawQR($("pair-qr"), inviteURL);
        $("pair-state").textContent = "waiting for their reply";
      })
      .catch(function (error) { $("pair-state").textContent = "failed: " + error.message; })
      .finally(function () { $("pair-create").disabled = false; });
  });

  $("pair-download").addEventListener("click", function () { downloadQR($("pair-qr"), "qrc-invite.png"); });
  $("pair-share").addEventListener("click", function () { shareLink(inviteURL, "Join me on QRC"); });
  $("pair-answer-download").addEventListener("click", function () { downloadQR($("pair-answer-qr"), "qrc-reply.png"); });
  $("pair-answer-share").addEventListener("click", function () { shareLink(answerURL, "QRC reply"); });

  function acceptBlob(text) {
    var payload = String(text).trim();
    var match = payload.match(/[?&#]([oa])=([A-Za-z0-9\-_]+)/);
    var kind = match ? match[1] : null;
    var blob = match ? match[2] : payload;
    if (!blob) return;

    if (awaitingReply && session && kind !== "o") {
      $("pair-state").textContent = "connecting…";
      session.acceptReply(blob).catch(function (error) {
        $("pair-state").textContent = "that reply didn't parse: " + error.message;
      });
      return;
    }
    $("pair-state").textContent = "preparing your identity…";
    ensureIdentity()
      .then(function () { return newSession().acceptInvite(blob); })
      .then(function (answerBlob) {
        answerURL = pairingLink("a", answerBlob);
        $("pair-answer-out").classList.remove("hidden");
        $("pair-answer-url").textContent = answerURL;
        drawQR($("pair-answer-qr"), answerURL);
        $("pair-state").textContent = "send them the reply";
      })
      .catch(function (error) { $("pair-state").textContent = "that didn't parse: " + error.message; });
  }

  $("pair-accept").addEventListener("click", function () { acceptBlob($("pair-input").value); });

  // Camera scanning, where the browser has a barcode detector.
  var cameraStream = null, scanTimer = null;

  function stopCamera() {
    if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
    if (cameraStream) {
      cameraStream.getTracks().forEach(function (track) { track.stop(); });
      cameraStream = null;
    }
    $("pair-video").classList.add("hidden");
  }

  $("pair-scan").addEventListener("click", function () {
    if (cameraStream) return stopCamera();
    if (!navigator.mediaDevices || !window.isSecureContext) {
      $("pair-state").textContent = "camera needs https — paste the link instead";
      return;
    }
    if (typeof BarcodeDetector === "undefined") {
      $("pair-state").textContent = "this browser can't scan — use the camera app, or paste";
      return;
    }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
      .then(function (stream) {
        cameraStream = stream;
        $("pair-video").srcObject = stream;
        $("pair-video").classList.remove("hidden");
        $("pair-video").play();
        var detector = new BarcodeDetector({ formats: ["qr_code"] });
        scanTimer = setInterval(function () {
          detector.detect($("pair-video")).then(function (codes) {
            if (codes.length) { stopCamera(); acceptBlob(codes[0].rawValue); }
          }).catch(function () {});
        }, 400);
      })
      .catch(function (error) { $("pair-state").textContent = "camera unavailable: " + error.message; });
  });

  // --- Settings ------------------------------------------------------------

  function showSettings() {
    showIdentity();
    $("nick-field").value = myName();
    var list = $("bootstrapper-list");
    list.innerHTML = "";
    knownBootstrappers().forEach(function (url) {
      var item = document.createElement("code");
      item.className = "bootstrapper";
      item.textContent = url;
      list.appendChild(item);
    });
    var groups = Object.keys(net.groups).length;
    var events = Object.keys(net.groups).reduce(function (total, id) {
      return total + net.groups[id].graph.size();
    }, 0);
    $("storage-summary").textContent = groups + " group(s), " + events + " event(s) held on this device.";
  }

  $("nick-field").addEventListener("change", function () {
    var value = $("nick-field").value.trim();
    if (value) setNick(value);
  });

  $("forget-all").addEventListener("click", function () {
    if (!confirm("Delete your identity, groups and history from this device? Other members keep theirs.")) return;
    QRCStore.clear().finally(function () {
      localStorage.clear();
      location.reload();
    });
  });

  // --- Arriving by link ----------------------------------------------------

  (function () {
    var query = location.search || "";
    var offer = query.match(/[?&]o=([A-Za-z0-9\-_]+)/);
    var reply = query.match(/[?&]a=([A-Za-z0-9\-_]+)/);
    if (/[?&]pair=true/.test(query) || offer || reply) {
      history.replaceState({ level: "pairing" }, "", location.pathname);
      goTo("pairing", false);
      if (offer) { showTab("receive"); acceptBlob(offer[1]); }
      else if (reply) { showTab("receive"); acceptBlob(reply[1]); }
      return;
    }
    if (/[?&]bootstrap=true/.test(query)) {
      history.replaceState({ level: "pairing" }, "", location.pathname);
      goTo("pairing", false);
    }
  })();

  // --- Startup -------------------------------------------------------------

  // Load an existing identity and history quietly: your groups should be there
  // whether or not anyone else is online.
  if (localStorage.getItem("qrc-identity")) {
    QRCCrypto.loadIdentity({ interactive: false })
      .then(function (loaded) {
        identity = loaded;
        showIdentity();
        return net.start(identity);
      })
      .then(function () { renderGroups(); renderPresence(); })
      .catch(function () { /* passkey-wrapped: unlocks at the next pairing */ });
  }

  if (level === "groups") {
    history.replaceState({ level: "groups" }, "", location.pathname);
    goTo("groups", false);
  }
  renderPresence();
})();
