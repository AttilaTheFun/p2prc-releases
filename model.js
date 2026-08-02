/* The data model: groups, and a hash-linked event graph per group.
 *
 * There are no servers here, so there is no authority to decide what order
 * things happened in. Instead every event names the events its author had
 * already seen (its `parents`), which makes the history a directed acyclic
 * graph rather than a list.
 *
 * That is what lets fragmented histories merge. If A and B talk while C and D
 * are offline, and later C and D talk while A and B are away, the two
 * branches simply have different parents. When anyone reconnects, taking the
 * union of the events reconstructs the whole graph, and a deterministic
 * topological sort gives every member the same reading order — without anyone
 * having been in charge.
 *
 * Works unchanged in a browser and in Node, so the merge behaviour can be
 * tested directly.
 */
(function (global) {
  "use strict";

  var subtle = (global.crypto && global.crypto.subtle) || null;

  function toB64(bytes) {
    var binary = "";
    var view = new Uint8Array(bytes);
    for (var i = 0; i < view.length; i++) binary += String.fromCharCode(view[i]);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  /// Stable serialisation: object keys in sorted order, so two peers hash the
  /// same event to the same id.
  function canonical(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
    var keys = Object.keys(value).sort();
    return "{" + keys.map(function (key) {
      return JSON.stringify(key) + ":" + canonical(value[key]);
    }).join(",") + "}";
  }

  function hash(text) {
    return subtle.digest("SHA-256", new TextEncoder().encode(text))
      .then(function (digest) { return toB64(digest).slice(0, 22); });
  }

  /// Builds an event and derives its id from its content, so an id can't be
  /// forged onto different content and duplicates collapse naturally.
  function makeEvent(fields) {
    var event = {
      group: fields.group,
      author: fields.author,
      kind: fields.kind || "message",
      parents: (fields.parents || []).slice().sort(),
      ts: fields.ts != null ? fields.ts : Math.floor(Date.now() / 1000),
      body: fields.body != null ? fields.body : "",
    };
    return hash(canonical(event)).then(function (id) {
      event.id = id;
      return event;
    });
  }

  // --- The graph -----------------------------------------------------------

  function EventGraph() {
    this.events = {};          // id -> event
    this.childCount = {};      // id -> number of known children
  }

  EventGraph.prototype.has = function (id) {
    return Object.prototype.hasOwnProperty.call(this.events, id);
  };

  EventGraph.prototype.size = function () {
    return Object.keys(this.events).length;
  };

  /// Adds an event. Returns true if it was new.
  EventGraph.prototype.add = function (event) {
    if (!event || !event.id || this.has(event.id)) return false;
    this.events[event.id] = event;
    for (var i = 0; i < event.parents.length; i++) {
      var parent = event.parents[i];
      this.childCount[parent] = (this.childCount[parent] || 0) + 1;
    }
    return true;
  };

  /// Merges a batch, returning how many were new. Order doesn't matter:
  /// events may arrive before their parents and still land correctly.
  EventGraph.prototype.merge = function (events) {
    var added = 0;
    for (var i = 0; i < events.length; i++) {
      if (this.add(events[i])) added += 1;
    }
    return added;
  };

  /// The current frontier — events nothing else builds on. New events cite
  /// these as parents, which is how concurrent branches get recorded.
  EventGraph.prototype.heads = function () {
    var heads = [];
    for (var id in this.events) {
      if (!this.childCount[id]) heads.push(id);
    }
    return heads.sort();
  };

  EventGraph.prototype.ids = function () {
    return Object.keys(this.events).sort();
  };

  /// Every event this graph holds that `theirIds` does not.
  EventGraph.prototype.missingFrom = function (theirIds) {
    var known = {};
    for (var i = 0; i < theirIds.length; i++) known[theirIds[i]] = true;
    var missing = [];
    for (var id in this.events) {
      if (!known[id]) missing.push(this.events[id]);
    }
    return missing;
  };

  /// Causal order, with a deterministic tiebreak so every member reads the
  /// same sequence. Events whose parents are missing are still included —
  /// a partial sync should show what it has rather than nothing.
  EventGraph.prototype.ordered = function () {
    var self = this;
    var remaining = {};
    var pending = {};
    var ready = [];

    for (var id in this.events) {
      var unmet = this.events[id].parents.filter(function (parent) {
        return self.has(parent);
      }).length;
      remaining[id] = unmet;
      if (unmet === 0) ready.push(id);
    }
    // Children waiting on each parent.
    for (var childId in this.events) {
      this.events[childId].parents.forEach(function (parent) {
        if (!self.has(parent)) return;
        (pending[parent] = pending[parent] || []).push(childId);
      });
    }

    function rank(a, b) {
      var ea = self.events[a], eb = self.events[b];
      if (ea.ts !== eb.ts) return ea.ts - eb.ts;
      return ea.id < eb.id ? -1 : 1;
    }

    var order = [];
    ready.sort(rank);
    while (ready.length) {
      var next = ready.shift();
      order.push(this.events[next]);
      (pending[next] || []).forEach(function (child) {
        remaining[child] -= 1;
        if (remaining[child] === 0) {
          ready.push(child);
          ready.sort(rank);
        }
      });
    }
    // A cycle can't occur with content-addressed parents, but be safe: append
    // anything left rather than dropping it.
    if (order.length < this.size()) {
      var seen = {};
      order.forEach(function (event) { seen[event.id] = true; });
      var leftovers = [];
      for (var leftover in this.events) {
        if (!seen[leftover]) leftovers.push(leftover);
      }
      leftovers.sort(rank).forEach(function (leftoverId) {
        order.push(self.events[leftoverId]);
      });
    }
    return order;
  };

  // --- Groups --------------------------------------------------------------

  /// A group is the unit of conversation: a direct message is simply a group
  /// with two members. Membership changes are events like any other, so they
  /// merge and order the same way.
  function Group(record) {
    this.id = record.id;
    this.name = record.name || "";
    this.createdBy = record.createdBy || "";
    this.graph = new EventGraph();
    this.members = {};         // memberId -> {name, key, joinedAt}
    this.epoch = record.epoch || 0;
  }

  Group.prototype.isDirect = function () {
    return Object.keys(this.members).length === 2;
  };

  Group.prototype.title = function (selfId) {
    if (this.name) return this.name;
    var others = Object.keys(this.members).filter(function (id) { return id !== selfId; });
    if (!others.length) return "empty group";
    var names = others.map(function (id) { return this.members[id].name || id.slice(0, 8); }, this);
    return names.join(", ");
  };

  /// Replays membership events so every member computes the same roster.
  Group.prototype.applyMembership = function () {
    var members = {};
    var self = this;
    this.graph.ordered().forEach(function (event) {
      if (event.kind === "create") {
        // The name travels as an event, so a peer that learns of this group
        // by syncing ends up calling it the same thing.
        if (!self.name && event.body && event.body.name) self.name = event.body.name;
      } else if (event.kind === "join" || event.kind === "invite") {
        var info = event.body || {};
        if (info.member) {
          members[info.member] = {
            name: info.name || "",
            key: info.key || null,
            joinedAt: event.ts,
          };
        }
      } else if (event.kind === "leave") {
        var leaving = (event.body || {}).member || event.author;
        delete members[leaving];
      }
    });
    this.members = members;
    return members;
  };

  Group.prototype.messages = function () {
    return this.graph.ordered().filter(function (event) {
      return event.kind === "message";
    });
  };

  global.P2PRCModel = {
    canonical: canonical,
    hash: hash,
    makeEvent: makeEvent,
    EventGraph: EventGraph,
    Group: Group,
  };
})(typeof window !== "undefined" ? window : globalThis);
