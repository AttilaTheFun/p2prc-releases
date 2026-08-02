/* The network: equal peers, no hosts.
 *
 * Every client is the same. There is no server, no one in charge of a group,
 * and no one whose absence stops the rest working. A client holds:
 *
 *   * its own identity keypair,
 *   * the groups it belongs to and their full history,
 *   * links to whichever other members happen to be online.
 *
 * When two members connect they reconcile every group they share (see
 * sync.js). When someone sends a message it goes to whoever is reachable now,
 * and reaches everyone else the next time they meet anybody who has it. Nobody
 * has to be online for the conversation to survive.
 *
 * The only asymmetries left in the whole system sit outside it: something has
 * to serve the app the first time (a static page), and an existing member has
 * to invite you in. Once you are in, you are the same as everyone else.
 */
(function (global) {
  "use strict";

  function Net(options) {
    options = options || {};
    this.identity = null;
    this.memberId = "";
    this.name = options.name || "anon";
    this.groups = {};           // groupId -> Group
    this.keys = {};             // groupId -> GroupKeys
    this.links = [];            // live peer connections
    this.onChange = options.onChange || function () {};
    this.onLog = options.onLog || function () {};
  }

  Net.prototype.start = function (identity) {
    var self = this;
    this.identity = identity;
    // A member is named by their key, not by a nickname anyone could claim.
    this.memberId = identity.fingerprint.replace(/-/g, "").slice(0, 16);
    return this.load();
  };

  Net.prototype.load = function () {
    var self = this;
    if (!global.P2PRCStore || !P2PRCStore.available()) return Promise.resolve();
    return P2PRCStore.loadGroups().then(function (records) {
      return Promise.all(records.map(function (record) {
        var group = new P2PRCModel.Group(record);
        self.groups[group.id] = group;
        return P2PRCStore.loadEvents(group.id).then(function (events) {
          group.graph.merge(events);
          group.applyMembership();
        });
      }));
    }).then(function () { self.onChange(); });
  };

  Net.prototype.persist = function (group, events) {
    if (!global.P2PRCStore || !P2PRCStore.available()) return Promise.resolve();
    return Promise.all([
      P2PRCStore.saveGroup({ id: group.id, name: group.name, createdBy: group.createdBy, epoch: group.epoch }),
      P2PRCStore.saveEvents(events || group.graph.ordered()),
    ]);
  };

  // --- Groups --------------------------------------------------------------

  Net.prototype.groupKeys = function (groupId) {
    if (!this.keys[groupId]) {
      this.keys[groupId] = new P2PRCGroupCrypto.GroupKeys(this.identity, this.memberId);
    }
    return this.keys[groupId];
  };

  /// Creates a group containing us. A direct message is just this with one
  /// other member added.
  Net.prototype.createGroup = function (name, otherMembers) {
    var self = this;
    var members = [{ id: this.memberId, name: this.name, key: this.identity.publicJWK }]
      .concat(otherMembers || []);
    return P2PRCModel.hash(this.memberId + "|" + name + "|" + Date.now()).then(function (id) {
      var group = new P2PRCModel.Group({ id: id, name: name, createdBy: self.memberId });
      self.groups[id] = group;
      // Everything about a group is an event, including its name — a peer
      // that learns of the group by sync must be able to reconstruct it
      // without being told anything out of band.
      var creation = P2PRCModel.makeEvent({
        group: id, author: self.memberId, kind: "create",
        parents: [], body: { name: name },
      });
      return creation.then(function (createEvent) {
        var joins = members.map(function (member) {
          return P2PRCModel.makeEvent({
            group: id, author: self.memberId, kind: "join",
            parents: [createEvent.id],
            body: { member: member.id, name: member.name, key: member.key },
          });
        });
        return Promise.all(joins).then(function (joinEvents) {
          var events = [createEvent].concat(joinEvents);
          group.graph.merge(events);
          group.applyMembership();
          // Tell anyone already connected: they can't ask for what they don't
          // know exists.
          events.forEach(function (event) { self.broadcast(event); });
          return self.persist(group, events).then(function () {
            return self.rekey(group);
          }).then(function () {
            self.onChange();
            return group;
          });
        });
      });
    });
  };

  /// Advances the group to a fresh epoch keyed to the current membership.
  /// Called on creation and whenever anyone joins or leaves.
  Net.prototype.rekey = function (group) {
    var self = this;
    var members = Object.keys(group.members).map(function (id) {
      return { id: id, key: group.members[id].key };
    }).filter(function (member) { return !!member.key; });
    if (!members.length) return Promise.resolve();

    var epoch = group.epoch + 1;
    var keys = this.groupKeys(group.id);
    var prepared;
    return keys.prepare(members).then(function (result) {
      prepared = result;
      return P2PRCModel.makeEvent({
        group: group.id, author: self.memberId, kind: "rekey",
        parents: group.graph.heads(), body: { epoch: epoch, welcome: result.welcome },
      });
    }).then(function (event) {
      // The event's id *is* the key context, so concurrent rekeys coexist.
      keys.remember(event.id, prepared.secret, epoch);
      group.graph.add(event);
      group.epoch = epoch;
      self.broadcast(event);
      return self.persist(group, [event]);
    });
  };

  /// Adds someone to a group and rekeys so they can read from now on.
  Net.prototype.addMember = function (group, member) {
    var self = this;
    return P2PRCModel.makeEvent({
      group: group.id, author: this.memberId, kind: "invite",
      parents: group.graph.heads(),
      body: { member: member.id, name: member.name, key: member.key },
    }).then(function (event) {
      group.graph.add(event);
      group.applyMembership();
      self.broadcast(event);
      return self.persist(group, [event]);
    }).then(function () { return self.rekey(group); })
      .then(function () { self.onChange(); });
  };

  Net.prototype.leaveGroup = function (group) {
    var self = this;
    return P2PRCModel.makeEvent({
      group: group.id, author: this.memberId, kind: "leave",
      parents: group.graph.heads(), body: { member: this.memberId },
    }).then(function (event) {
      group.graph.add(event);
      group.applyMembership();
      self.broadcast(event);
      return self.persist(group, [event]);
    }).then(function () { self.onChange(); });
  };

  // --- Messages ------------------------------------------------------------

  Net.prototype.send = function (group, text) {
    var self = this;
    var keys = this.groupKeys(group.id);
    var sealed = keys.canSend() ? keys.encrypt(text) : Promise.resolve(null);

    return sealed.then(function (envelope) {
      return P2PRCModel.makeEvent({
        group: group.id, author: self.memberId, kind: "message",
        parents: group.graph.heads(),
        // Unencrypted only when we have no epoch key at all — visible in the
        // UI rather than silently downgraded.
        body: envelope ? { sealed: envelope } : { text: text, plain: true },
      });
    }).then(function (event) {
      group.graph.add(event);
      self.broadcast(event);
      self.onChange();
      return self.persist(group, [event]);
    });
  };

  /// Turns stored events into readable lines, decrypting what we hold keys
  /// for and labelling what we don't.
  Net.prototype.readGroup = function (group) {
    var self = this;
    var keys = this.groupKeys(group.id);

    // Take in any epochs shared with us before reading the messages.
    var rekeys = group.graph.ordered().filter(function (event) { return event.kind === "rekey"; });
    var adopting = rekeys.map(function (event) {
      return keys.adopt(event.id, event.body.welcome, event.body.epoch);
    });

    return Promise.all(adopting).then(function () {
      var messages = group.messages();
      return Promise.all(messages.map(function (event) {
        var who = group.members[event.author];
        var name = (who && who.name) || event.author.slice(0, 8);
        if (event.body && event.body.plain) {
          return { id: event.id, author: event.author, name: name, text: event.body.text, ts: event.ts, encrypted: false };
        }
        return keys.decrypt(event.body.sealed)
          .then(function (text) {
            return { id: event.id, author: event.author, name: name, text: text, ts: event.ts, encrypted: true };
          })
          .catch(function () {
            return { id: event.id, author: event.author, name: name, text: "[encrypted — no key for this epoch]", ts: event.ts, encrypted: true, locked: true };
          });
      }));
    });
  };

  // --- Peer links ----------------------------------------------------------

  /// Adopts a connected data channel as a peer. Both ends do exactly this;
  /// neither is a server.
  Net.prototype.addLink = function (channel, label) {
    var self = this;
    var link = { channel: channel, label: label || "peer", sync: null, peer: null };

    function post(message) {
      if (channel.readyState !== "open") return;
      try { channel.send(JSON.stringify(message)); } catch (e) {}
    }

    link.sync = new P2PRCSync({
      groups: this.groups,
      send: post,
      ensureGroup: function (groupId) {
        // Learning about a group we've never seen: accept it, since being
        // told about it is how joining works.
        if (!self.groups[groupId]) {
          self.groups[groupId] = new P2PRCModel.Group({ id: groupId });
        }
        return self.groups[groupId];
      },
      onChange: function (group, added) {
        group.applyMembership();
        self.persist(group);
        self.onLog(added + " event(s) synced in " + (group.name || group.id.slice(0, 8)));
        self.onChange();
      },
    });

    channel.onmessage = function (event) {
      var message;
      try { message = JSON.parse(event.data); } catch (e) { return; }

      // Peers introduce themselves before anything else: a member is their
      // key, and without it nobody could ever be added to a group.
      if (message.t === "hello") {
        link.peer = { id: message.id, name: message.name, key: message.key };
        self.onLog("met " + (message.name || message.id.slice(0, 8)));
        self.ensureDirectGroup(link.peer).then(function () {
          link.sync.begin();
          self.onChange();
        });
        return;
      }
      link.sync.handle(message);
    };
    channel.onclose = function () {
      var index = self.links.indexOf(link);
      if (index !== -1) self.links.splice(index, 1);
      self.onChange();
    };

    this.links.push(link);
    post({ t: "hello", id: this.memberId, name: this.name, key: this.identity.publicJWK });
    link.sync.begin();
    this.onChange();
    return link;
  };

  /// Pairing means "we can talk", so the natural result is a direct message —
  /// a group with exactly the two of us. Created once, then synced like any
  /// other group.
  Net.prototype.ensureDirectGroup = function (peer) {
    var self = this;
    var existing = Object.keys(this.groups).map(function (id) { return self.groups[id]; })
      .filter(function (group) {
        return group.isDirect() && group.members[peer.id] && group.members[self.memberId];
      })[0];
    if (existing) return Promise.resolve(existing);

    // Deterministic id from both member ids, so both sides create the *same*
    // group rather than two halves of a conversation.
    var pair = [this.memberId, peer.id].sort().join("|");
    return P2PRCModel.hash("dm|" + pair).then(function (id) {
      if (self.groups[id]) return self.groups[id];
      var group = new P2PRCModel.Group({ id: id, name: "" });
      self.groups[id] = group;
      var members = [
        { id: self.memberId, name: self.name, key: self.identity.publicJWK },
        { id: peer.id, name: peer.name, key: peer.key },
      ];
      var joins = members.map(function (member) {
        return P2PRCModel.makeEvent({
          group: id, author: self.memberId, kind: "join", parents: [],
          // Fixed timestamp: both sides must generate byte-identical events
          // so their ids match and the graphs merge instead of duplicating.
          ts: 0,
          body: { member: member.id, name: member.name, key: member.key },
        });
      });
      return Promise.all(joins).then(function (events) {
        group.graph.merge(events);
        group.applyMembership();
        events.forEach(function (event) { self.broadcast(event); });
        return self.persist(group, events).then(function () {
          return self.rekey(group);
        }).then(function () { return group; });
      });
    });
  };

  /// Adds every currently connected peer to a group, then rekeys.
  Net.prototype.addConnectedPeers = function (group) {
    var self = this;
    var newcomers = this.links.map(function (link) { return link.peer; })
      .filter(function (peer) { return peer && !group.members[peer.id]; });
    if (!newcomers.length) return Promise.resolve(0);
    return newcomers.reduce(function (chain, peer) {
      return chain.then(function () { return self.addMember(group, peer); });
    }, Promise.resolve()).then(function () { return newcomers.length; });
  };

  Net.prototype.broadcast = function (event) {
    for (var i = 0; i < this.links.length; i++) {
      this.links[i].sync.publish(event);
    }
  };

  Net.prototype.onlineCount = function () { return this.links.length; };

  global.P2PRCNet = Net;
})(typeof window !== "undefined" ? window : globalThis);
