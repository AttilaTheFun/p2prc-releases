/* Local persistence.
 *
 * Every member keeps their own copy of every group they belong to. There is no
 * server holding the canonical history — the history *is* whatever the members
 * collectively hold, so persisting locally is what makes the network durable.
 *
 * IndexedDB, because a conversation outgrows local storage quickly and this
 * has to survive reloads to be worth anything.
 */
(function (global) {
  "use strict";

  var DB = "qrc";
  var VERSION = 1;
  var opening = null;

  function open() {
    if (opening) return opening;
    // Never cache a failure: one blocked open (another tab mid-upgrade) would
    // otherwise poison every write for the lifetime of the page, silently.
    opening = new Promise(function (resolve, reject) {
      var settled = false;
      // A blocked upgrade (another tab holding the database) leaves this
      // pending forever. Storage must never be able to hang the app: give up
      // and run from memory instead.
      var giveUp = setTimeout(function () {
        if (!settled) { settled = true; reject(new Error("indexedDB unavailable")); }
      }, 3000);
      var request = indexedDB.open(DB, VERSION);
      request.onblocked = function () {
        if (!settled) { settled = true; clearTimeout(giveUp); reject(new Error("indexedDB blocked")); }
      };
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains("groups")) {
          db.createObjectStore("groups", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("events")) {
          var events = db.createObjectStore("events", { keyPath: "id" });
          events.createIndex("group", "group", { unique: false });
        }
        if (!db.objectStoreNames.contains("peers")) {
          db.createObjectStore("peers", { keyPath: "id" });
        }
      };
      request.onsuccess = function () {
        if (settled) return;
        settled = true;
        clearTimeout(giveUp);
        resolve(request.result);
      };
      request.onerror = function () {
        if (settled) return;
        settled = true;
        clearTimeout(giveUp);
        reject(request.error);
      };
    });
    opening.catch(function () { opening = null; });
    return opening;
  }

  function tx(storeName, mode, work) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var transaction = db.transaction(storeName, mode);
        var store = transaction.objectStore(storeName);
        var result = work(store);
        transaction.oncomplete = function () { resolve(result && result.value !== undefined ? result.value : result); };
        transaction.onerror = function () { reject(transaction.error); };
      });
    });
  }

  function all(storeName, indexName, key) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var transaction = db.transaction(storeName, "readonly");
        var source = transaction.objectStore(storeName);
        if (indexName) source = source.index(indexName);
        var request = key !== undefined ? source.getAll(key) : source.getAll();
        request.onsuccess = function () { resolve(request.result || []); };
        request.onerror = function () { reject(request.error); };
      });
    });
  }

  var warned = false;
  function soft(promise, fallback) {
    return promise.catch(function (error) {
      if (!warned) {
        warned = true;
        console.warn("[qrc] local storage unavailable, running from memory:", error && error.message);
      }
      return fallback;
    });
  }

  var Store = {
    available: function () { return typeof indexedDB !== "undefined"; },

    saveGroup: function (record) {
      return soft(tx("groups", "readwrite", function (store) { store.put(record); }), null);
    },

    loadGroups: function () { return soft(all("groups"), []); },

    /// Events are content-addressed, so re-putting one is a harmless no-op —
    /// which is exactly what a sync that re-delivers old events needs.
    saveEvents: function (events) {
      return soft(tx("events", "readwrite", function (store) {
        for (var i = 0; i < events.length; i++) store.put(events[i]);
      }), null);
    },

    loadEvents: function (groupId) { return soft(all("events", "group", groupId), []); },

    savePeer: function (peer) {
      return tx("peers", "readwrite", function (store) { store.put(peer); });
    },

    loadPeers: function () { return soft(all("peers"), []); },

    clear: function () {
      return open().then(function (db) {
        ["groups", "events", "peers"].forEach(function (name) {
          db.transaction(name, "readwrite").objectStore(name).clear();
        });
      });
    },
  };

  global.QRCStore = Store;
})(typeof window !== "undefined" ? window : globalThis);
