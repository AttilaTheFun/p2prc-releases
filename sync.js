/* Gossip sync between peers.
 *
 * Every member keeps their own copy of a group's history. When two members
 * connect — at any time, in any order, having been apart for any length of
 * time — they reconcile: each tells the other what it has, each sends back
 * what the other lacks. Because events are content-addressed and carry their
 * parents, the result is simply the union of both histories, and no peer needs
 * to be authoritative.
 *
 * The protocol is deliberately three messages:
 *
 *   have    "these are the event ids I hold for this group"
 *   give    "here are the events you were missing" (+ my ids, so you can too)
 *   give    the reply in the other direction
 *
 * Sending full id lists is obviously correct and fine for conversation-sized
 * histories. It is O(history) per reconnect, so a large group would want a
 * Bloom filter or a walk back from heads instead; the wire format leaves room
 * for that without changing the shape.
 */
(function (global) {
  "use strict";

  function Sync(options) {
    this.groups = options.groups;              // id -> Group
    this.send = options.send;                  // (object) -> void
    this.onChange = options.onChange || function () {};
    this.ensureGroup = options.ensureGroup || function () { return null; };
  }

  /// Offer our state for every group we know about. Called on connect.
  Sync.prototype.begin = function () {
    for (var id in this.groups) {
      this.send({
        t: "have",
        group: id,
        ids: this.groups[id].graph.ids(),
        heads: this.groups[id].graph.heads(),
      });
    }
  };

  /// Announce a single new event to a connected peer.
  Sync.prototype.publish = function (event) {
    this.send({ t: "give", group: event.group, events: [event] });
  };

  Sync.prototype.handle = function (message) {
    if (!message || !message.t) return;
    var group = this.groups[message.group] || this.ensureGroup(message.group, message);
    if (!group) return;

    if (message.t === "have") {
      // Send what they lack, and tell them what we hold so they can do the
      // same. One round trip each way, regardless of who has been offline.
      var missing = group.graph.missingFrom(message.ids || []);
      this.send({
        t: "give",
        group: message.group,
        events: missing,
        ids: group.graph.ids(),
      });
      return;
    }

    if (message.t === "give") {
      var added = group.graph.merge(message.events || []);
      if (added) {
        group.applyMembership();
        this.onChange(group, added);
      }
      // The `ids` ride along on the first give so the exchange completes
      // symmetrically without a third round.
      if (message.ids) {
        var theirsMissing = group.graph.missingFrom(message.ids);
        if (theirsMissing.length) {
          this.send({ t: "give", group: message.group, events: theirsMissing });
        }
      }
    }
  };

  global.P2PRCSync = Sync;
})(typeof window !== "undefined" ? window : globalThis);
