/* IRC over a WebRTC data channel.
 *
 * A data channel is a reliable, ordered byte stream — which is exactly what
 * IRC was designed for. So instead of inventing a messaging protocol for
 * peers, we run the real one over it: the peer that issued the pairing
 * invitation becomes the *server*, whoever joins is a *client*, and the lines
 * on the wire are the same lines a native client would send over TCP.
 *
 * That keeps one protocol across every transport (TCP, TLS, WebRTC), means a
 * browser can host a network with no inbound connectivity at all, and leaves
 * room to layer end-to-end encryption on top later without changing any of it.
 */
(function (global) {
  "use strict";

  // --- Protocol ------------------------------------------------------------

  function parse(line) {
    var rest = line;
    var prefix = null;
    if (rest.charAt(0) === ":") {
      var space = rest.indexOf(" ");
      if (space === -1) return null;
      prefix = rest.slice(1, space);
      rest = rest.slice(space + 1);
    }
    var params = [];
    var command = null;
    while (rest.length) {
      if (rest.charAt(0) === ":") {
        params.push(rest.slice(1));
        break;
      }
      var index = rest.indexOf(" ");
      var token = index === -1 ? rest : rest.slice(0, index);
      rest = index === -1 ? "" : rest.slice(index + 1);
      if (!token.length) continue;
      if (command === null) command = token.toUpperCase();
      else params.push(token);
    }
    if (!command) return null;
    return { prefix: prefix, command: command, params: params };
  }

  function serialize(message) {
    var line = "";
    if (message.prefix) line += ":" + message.prefix + " ";
    line += message.command;
    var params = message.params || [];
    for (var i = 0; i < params.length; i++) {
      var last = i === params.length - 1;
      var value = String(params[i]);
      line += " " + (last && (value === "" || value.indexOf(" ") !== -1 || value.charAt(0) === ":")
        ? ":" + value : value);
    }
    return line;
  }

  /// Splits an incoming chunk into complete lines, keeping any remainder.
  function Framer(onLine) {
    this.buffer = "";
    this.onLine = onLine;
  }
  Framer.prototype.push = function (chunk) {
    this.buffer += chunk;
    var lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop();
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].length) this.onLine(lines[i]);
    }
  };

  // --- Server --------------------------------------------------------------

  /// An IRC server whose "sockets" are WebRTC data channels. Everything a
  /// native QRC host does over TCP, a browser tab can do here.
  function IRCServer(options) {
    options = options || {};
    this.name = options.serverName || "qrc-peer";
    this.onEvent = options.onEvent || function () {};
    /// Extra state handed to a client the moment it registers — the point of
    /// pairing is to join a network, so a joiner learns what we know.
    this.networkInfo = options.networkInfo || function () { return {}; };
    this.clients = [];
    this.channels = {};      // name -> {topic, history: []}
    this.nextId = 1;
    /// nick -> public key JWK. The server relays these but, holding only
    /// public halves, can never read the traffic they protect.
    this.roster = {};
    this.identityKey = options.identityKey || null;
    this.hostNick = options.hostNick || "host";
    this.ensureChannel("#general");
  }

  IRCServer.prototype.ensureChannel = function (name) {
    if (!this.channels[name]) this.channels[name] = { topic: name.slice(1), history: [] };
    return this.channels[name];
  };

  /// Adopts a data channel as a client connection.
  IRCServer.prototype.accept = function (channel, label) {
    var self = this;
    var client = {
      id: "peer-" + this.nextId++,
      channel: channel,
      nick: null,
      user: null,
      registered: false,
      joined: {},
      label: label || "peer",
    };
    this.clients.push(client);

    var framer = new Framer(function (line) {
      var message = parse(line);
      if (message) self.handle(client, message);
    });
    channel.onmessage = function (event) { framer.push(event.data); };
    channel.onclose = function () { self.drop(client); };
    this.onEvent({ type: "connected", client: client.id });
    return client;
  };

  IRCServer.prototype.write = function (client, message) {
    if (!client.channel || client.channel.readyState !== "open") return;
    if (!message.prefix && /^\d{3}$/.test(message.command)) message.prefix = this.name;
    try { client.channel.send(serialize(message) + "\r\n"); } catch (e) {}
  };

  IRCServer.prototype.numeric = function (client, code, params) {
    this.write(client, { command: code, params: [client.nick || "*"].concat(params) });
  };

  IRCServer.prototype.drop = function (client) {
    var index = this.clients.indexOf(client);
    if (index !== -1) this.clients.splice(index, 1);
    this.onEvent({ type: "disconnected", client: client.id, nick: client.nick });
  };

  IRCServer.prototype.broadcast = function (channelName, message, except) {
    for (var i = 0; i < this.clients.length; i++) {
      var client = this.clients[i];
      if (client === except || !client.registered) continue;
      if (channelName && !client.joined[channelName]) continue;
      this.write(client, message);
    }
  };

  /// Messages the host itself sends, as though from a local client.
  IRCServer.prototype.say = function (channelName, nick, text) {
    this.ensureChannel(channelName).history.push({ nick: nick, text: text, ts: Date.now() / 1000 });
    this.broadcast(channelName, {
      prefix: nick + "!qrc@qrc",
      command: "PRIVMSG",
      params: [channelName, text],
    });
  };

  IRCServer.prototype.handle = function (client, message) {
    var self = this;
    switch (message.command) {
      case "NICK":
        var wanted = (message.params[0] || "").replace(/[^\w\-\[\]{}\\`|^]/g, "_") || "anon";
        var taken = this.clients.some(function (other) {
          return other !== client && other.nick === wanted;
        });
        if (taken) return this.numeric(client, "433", [wanted, "Nickname is already in use"]);
        var previous = client.nick;
        client.nick = wanted;
        if (client.registered && previous) {
          this.broadcast(null, { prefix: previous + "!qrc@qrc", command: "NICK", params: [wanted] });
          this.onEvent({ type: "nick", from: previous, to: wanted });
        } else {
          this.register(client);
        }
        break;

      case "USER":
        client.user = message.params[0] || "qrc";
        this.register(client);
        break;

      case "PING":
        this.write(client, { command: "PONG", params: [this.name].concat(message.params.slice(0, 1)) });
        break;

      case "JOIN":
        (message.params[0] || "").split(",").forEach(function (name) {
          if (!name) return;
          var channelName = name.charAt(0) === "#" ? name : "#" + name;
          self.ensureChannel(channelName);
          client.joined[channelName] = true;
          var join = { prefix: client.nick + "!qrc@qrc", command: "JOIN", params: [channelName] };
          self.write(client, join);
          self.broadcast(channelName, join, client);
          self.numeric(client, "332", [channelName, self.channels[channelName].topic]);
          var names = self.clients
            .filter(function (other) { return other.registered && other.joined[channelName]; })
            .map(function (other) { return other.nick; });
          names.push(self.hostNick || "host");
          self.numeric(client, "353", ["=", channelName, names.join(" ")]);
          self.numeric(client, "366", [channelName, "End of /NAMES list"]);
          // Replay what was said before they arrived, the way a bouncer does.
          self.channels[channelName].history.slice(-30).forEach(function (entry) {
            self.write(client, {
              prefix: entry.nick + "!qrc@qrc",
              command: "PRIVMSG",
              params: [channelName, entry.text],
            });
          });
          self.onEvent({ type: "join", nick: client.nick, channel: channelName });
        });
        break;

      // Clients announce their public key on arrival; the server fans the
      // roster back out so everyone can seal messages for everyone else.
      case "QRCKEY":
        try {
          client.publicKey = JSON.parse(message.params[0]);
          this.roster[client.nick] = client.publicKey;
          this.publishRoster();
          this.onEvent({ type: "key", nick: client.nick });
        } catch (e) { /* ignore malformed keys */ }
        break;

      case "PRIVMSG":
        var target = message.params[0];
        var text = message.params[1] || "";
        if (!target) return;
        this.ensureChannel(target).history.push({
          nick: client.nick, text: text, ts: Date.now() / 1000,
        });
        this.broadcast(target, {
          prefix: client.nick + "!qrc@qrc",
          command: "PRIVMSG",
          params: [target, text],
        }, client);
        this.onEvent({ type: "message", channel: target, nick: client.nick, text: text });
        break;

      case "PART":
        var parting = message.params[0];
        if (parting && client.joined[parting]) {
          delete client.joined[parting];
          this.broadcast(parting, {
            prefix: client.nick + "!qrc@qrc", command: "PART", params: [parting],
          });
        }
        break;

      case "QUIT":
        this.drop(client);
        break;

      default:
        this.numeric(client, "421", [message.command, "Unknown command"]);
    }
  };

  /// Sends the current roster to every registered client.
  IRCServer.prototype.publishRoster = function () {
    var roster = {};
    for (var nick in this.roster) roster[nick] = this.roster[nick];
    if (this.identityKey) roster[this.hostNick] = this.identityKey;
    var payload = JSON.stringify(roster);
    for (var i = 0; i < this.clients.length; i++) {
      if (!this.clients[i].registered) continue;
      this.write(this.clients[i], {
        prefix: this.name,
        command: "NOTICE",
        params: [this.clients[i].nick, "QRCROSTER " + payload],
      });
    }
  };

  IRCServer.prototype.register = function (client) {
    if (client.registered || !client.nick || !client.user) return;
    client.registered = true;
    this.numeric(client, "001", ["Welcome to QRC, " + client.nick]);
    this.numeric(client, "002", ["Your host is " + this.name + ", running over WebRTC"]);
    this.numeric(client, "004", [this.name, "qrc-1.0", "o", "nt"]);
    this.numeric(client, "005", ["NETWORK=QRC", "CHANTYPES=#", "are supported by this server"]);
    this.numeric(client, "375", ["- " + this.name + " -"]);
    this.numeric(client, "372", ["- You are connected over a direct peer link."]);
    this.numeric(client, "376", ["End of /MOTD command"]);

    // Hand over what we know about the network. Joining is the point of
    // pairing, so a new peer shouldn't have to discover it all again.
    var info = this.networkInfo() || {};
    this.write(client, {
      prefix: this.name,
      command: "NOTICE",
      params: [client.nick, "QRCNET " + JSON.stringify(info)],
    });
    if (this.identityKey) {
      this.write(client, {
        prefix: this.name,
        command: "QRCKEY",
        params: [JSON.stringify(this.identityKey)],
      });
    }
    this.publishRoster();
    this.onEvent({ type: "registered", nick: client.nick });
  };

  // --- Client --------------------------------------------------------------

  /// The other half: speaks IRC to a peer that is acting as the server.
  function IRCClient(options) {
    options = options || {};
    this.nick = options.nick || "anon";
    this.onEvent = options.onEvent || function () {};
    this.channel = null;
    this.current = "#general";
    this.registered = false;
    this.identityKey = options.identityKey || null;
    this.roster = {};
  }

  IRCClient.prototype.attach = function (dataChannel) {
    var self = this;
    this.channel = dataChannel;
    var framer = new Framer(function (line) {
      var message = parse(line);
      if (message) self.handle(message);
    });
    dataChannel.onmessage = function (event) { framer.push(event.data); };
    this.send({ command: "NICK", params: [this.nick] });
    this.send({ command: "USER", params: [this.nick, "0", "*", "QRC"] });
    if (this.identityKey) {
      this.send({ command: "QRCKEY", params: [JSON.stringify(this.identityKey)] });
    }
  };

  IRCClient.prototype.send = function (message) {
    if (!this.channel || this.channel.readyState !== "open") return;
    try { this.channel.send(serialize(message) + "\r\n"); } catch (e) {}
  };

  IRCClient.prototype.join = function (channelName) {
    this.current = channelName;
    this.send({ command: "JOIN", params: [channelName] });
  };

  IRCClient.prototype.say = function (text) {
    this.send({ command: "PRIVMSG", params: [this.current, text] });
  };

  IRCClient.prototype.setNick = function (nick) {
    this.nick = nick;
    this.send({ command: "NICK", params: [nick] });
  };

  IRCClient.prototype.handle = function (message) {
    var nick = message.prefix ? message.prefix.split("!")[0] : this.serverName;
    switch (message.command) {
      case "001":
        this.registered = true;
        this.onEvent({ type: "registered", text: message.params[1] });
        this.join(this.current);
        break;
      case "PING":
        this.send({ command: "PONG", params: message.params });
        break;

      case "PRIVMSG":
        this.onEvent({
          type: "message", channel: message.params[0], nick: nick, text: message.params[1],
        });
        break;
      case "JOIN":
        this.onEvent({ type: "join", nick: nick, channel: message.params[0] });
        break;
      case "PART":
      case "QUIT":
        this.onEvent({ type: "part", nick: nick, channel: message.params[0] });
        break;
      case "QRCKEY":
        try {
          this.roster[nick] = JSON.parse(message.params[0]);
          this.onEvent({ type: "key", nick: nick, roster: this.roster });
        } catch (e) {}
        break;

      case "NOTICE":
        var text = message.params[1] || "";
        if (text.indexOf("QRCROSTER ") === 0) {
          try {
            this.roster = JSON.parse(text.slice(10));
            this.onEvent({ type: "roster", roster: this.roster });
          } catch (e) {}
          break;
        }
        if (text.indexOf("QRCNET ") === 0) {
          // The network the server knows about, handed over on registration.
          try {
            this.onEvent({ type: "network", info: JSON.parse(text.slice(7)) });
          } catch (e) {}
        } else {
          this.onEvent({ type: "notice", text: text });
        }
        break;
      case "372":
      case "375":
      case "376":
      case "002":
      case "004":
      case "005":
        this.onEvent({ type: "server", text: message.params[message.params.length - 1] });
        break;
      case "433":
        this.nick += "_";
        this.send({ command: "NICK", params: [this.nick] });
        break;
      default:
        break;
    }
  };

  global.QRCIRC = {
    parse: parse,
    serialize: serialize,
    Framer: Framer,
    Server: IRCServer,
    Client: IRCClient,
  };
})(window);
