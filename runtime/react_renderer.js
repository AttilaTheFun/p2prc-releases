// The web half of the ReactRenderer (the component-system renderer
// bound by uuiStart when the page asks for "react").
//
// Interprets the runtime's serialized view tree (docs/renderer_layers.md) as
// React elements built from web-native components: flex layout, real inputs
// (<input type=search|date|checkbox>, <select>), a header nav bar, a bottom
// tab bar, and modal presentations. Interactive nodes report back through
// `sendEvent(id, value)` (which feeds Runtime.hostViewEvent). React owns
// layout and reconciliation — the runtime never computes frames or emits
// draw commands under this binding.
//
// Uses the React 18 UMD globals (window.React / window.ReactDOM), served
// from the hermetic @react_umd repositories next to this bundle.

export function createReactTreeRenderer({ container, sendEvent, assetBase = "assets/", mapSurface = null }) {
  const R = window.React;
  const h = R.createElement;
  const root = window.ReactDOM.createRoot(container);

  if (!document.getElementById("uui-react-style")) {
    const style = document.createElement("style");
    style.id = "uui-react-style";
    style.textContent =
      "@keyframes uui-spin{to{transform:rotate(1turn)}}" +
      ".uui-spinner{width:22px;height:22px;border-radius:50%;flex:none;" +
      "border:2.5px solid rgba(120,120,128,0.3);border-top-color:rgba(120,120,128,0.9);" +
      "animation:uui-spin 0.8s linear infinite}" +
      ".uui-tap{transition:background-color 0.12s}" +
      ".uui-tap:active{background-color:rgba(120,120,128,0.18) !important}" +
      ".uui-switch{appearance:none;-webkit-appearance:none;width:44px;height:26px;flex:none;" +
      "border-radius:13px;background:rgba(120,120,128,0.35);position:relative;outline:none;" +
      "cursor:pointer;transition:background 0.15s;border:none;margin:0}" +
      ".uui-switch:checked{background:#34c759}" +
      ".uui-switch::after{content:'';position:absolute;left:2px;top:2px;width:22px;height:22px;" +
      "border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.3);transition:left 0.15s}" +
      ".uui-switch:checked::after{left:20px}";
    document.head.appendChild(style);
  }

  const rgba = (c) =>
    c ? `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${c[3]})` : undefined;

  const alignCSS = { leading: "flex-start", center: "center", trailing: "flex-end", top: "flex-start", bottom: "flex-end" };

  function gradientCSS(n) {
    if (!n.gradient) return undefined;
    try {
      const g = JSON.parse(n.gradient);
      const colors = (g.stops || [])
        .map((stop) => `${rgba(stop.c)} ${Math.round((stop.l || 0) * 100)}%`)
        .join(",");
      if (!colors) return undefined;
      if (g.kind === "radial") return `radial-gradient(circle, ${colors})`;
      if (g.kind === "angular") return `conic-gradient(${colors})`;
      if (g.kind === "solid") return rgba((g.stops[0] || {}).c);
      const angle = g.p0 && g.p1
        ? Math.atan2(g.p1[1] - g.p0[1], g.p1[0] - g.p0[0]) * 180 / Math.PI + 90
        : 180;
      return `linear-gradient(${angle}deg, ${colors})`;
    } catch (_) {
      return undefined;
    }
  }

  function baseStyle(n) {
    const s = { boxSizing: "border-box" };
    if (n.padding) {
      s.paddingTop = n.padding[0];
      s.paddingLeft = n.padding[1];
      s.paddingBottom = n.padding[2];
      s.paddingRight = n.padding[3];
    }
    if (n.width != null) s.width = n.width;
    if (n.height != null) s.height = n.height;
    if (n.bg) s.background = rgba(n.bg);
    const gradient = gradientCSS(n);
    if (gradient) s.background = gradient;
    // cornerRadius has CLIP semantics (SwiftUI clips to the rounded rect);
    // without overflow:hidden an oversized child (a fill image) pokes past
    // the rounded corners and the frame itself.
    if (n.radius) { s.borderRadius = n.radius; s.overflow = "hidden"; }
    if (n.opacity != null) s.opacity = n.opacity;
    if (n.shadow) {
      s.boxShadow = `${n.shadow.x}px ${n.shadow.y}px ${n.shadow.radius * 2}px ${rgba(n.shadow.color)}`;
    }
    if (n.tap) s.cursor = "pointer";
    return s;
  }

  function interactive(n, props) {
    if (n.tap) {
      props["data-tap"] = n.tap; // exposed for headless smoke tests
      props.onClick = (e) => {
        e.stopPropagation();
        sendEvent(n.tap, "");
      };
      // Web-idiomatic press feedback on tappable regions.
      props.className = ((props.className || "") + " uui-tap").trim();
      if (props.style.borderRadius == null) props.style.borderRadius = 8;
    }
    return props;
  }

  // A text input holding local state between keystroke echoes so re-renders
  // from Swift don't reset the caret — but a PROGRAMMATIC guest change (a new
  // serialized value that is neither the current text nor an in-flight edit
  // echoing back, e.g. a chat composer clearing its draft on send) applies
  // immediately, focused or not. The vertical-axis form
  // (`TextField(_:text:axis: .vertical)`, params.axis "v") renders a textarea
  // that grows with its content between minLines and maxLines
  // (`.lineLimit(1...6)`), then scrolls internally.
  function TextInput({ n }) {
    const [value, setValue] = R.useState(n.v || "");
    const pending = R.useRef([]);
    const lastSerialized = R.useRef(n.v || "");
    const areaRef = R.useRef(null);
    R.useEffect(() => {
      const v = n.v || "";
      if (v === lastSerialized.current) return;
      lastSerialized.current = v;
      setValue((current) => {
        if (v === current) {
          pending.current = [];
          return current;
        }
        const echo = pending.current.indexOf(v);
        if (echo >= 0) {
          // An older keystroke echoing back; the local text is newer.
          pending.current.splice(0, echo + 1);
          return current;
        }
        pending.current = [];
        return v;
      });
    }, [n.v]);
    const p = n.params || {};
    const multiline = p.axis === "v";
    const lineHeight = (n.size || 15) * 1.35;
    const fit = () => {
      const el = areaRef.current;
      if (!el) return;
      el.style.height = "auto";
      const max = Number(p.maxLines || 5) * lineHeight + 14;
      el.style.height = `${Math.min(el.scrollHeight, max)}px`;
      el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
    };
    R.useLayoutEffect(() => { if (multiline) fit(); });
    const style = {
      ...(n.baseStyle || {}),
      fontSize: n.size || 15,
      padding: "7px 10px",
      border: "1px solid rgba(120,120,128,0.35)",
      borderRadius: 8,
      outline: "none",
      background: "rgba(120,120,128,0.08)",
      minWidth: 0,
      alignSelf: "stretch",
    };
    const shared = {
      value,
      placeholder: n.placeholder,
      onChange: (e) => {
        setValue(e.target.value);
        pending.current.push(e.target.value);
        if (n.edit) sendEvent(n.edit, e.target.value);
      },
    };
    if (multiline) {
      return h("textarea", {
        ...shared,
        ref: areaRef,
        rows: Number(p.minLines || 1),
        style: {
          ...style,
          lineHeight: `${lineHeight}px`,
          resize: "none",
          fontFamily: "inherit",
        },
      });
    }
    return h("input", { ...shared, type: n.searchStyle ? "search" : "text", style });
  }

  function navBar(n) {
    const p = n.params || {};
    const dark = p.dark === "1";
    const bar = {
      display: "flex", alignItems: "center", width: "100%", height: 44, flex: "none",
      background: dark ? "rgba(28,28,30,0.94)" : "rgba(249,249,249,0.94)",
      backdropFilter: "blur(8px)",
      borderBottom: `1px solid ${dark ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.12)"}`,
      color: dark ? "rgba(255,255,255,0.92)" : "rgba(0,0,0,0.85)",
      fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
    };
    const button = {
      border: "none", background: "none", color: "#0a84ff", fontSize: 16,
      cursor: "pointer", padding: "0 10px", flex: "0 0 auto",
    };
    // Toolbar items (`ToolbarItem(placement:)`): newline-joined title lists.
    const split = (key) => (p[key] ? p[key].split("\n") : []);
    const leading = split("leading");
    const trailing = split("trailingItems");
    // `.principal`: the trailing item at this index renders centered in
    // place of the title (a tappable pill), the way a macOS/iOS bar does.
    const principal = p.principal === "" || p.principal == null ? -1 : Number(p.principal);
    // Symmetric side clusters keep the title centered.
    const side = { display: "flex", alignItems: "center", minWidth: 64, flex: "0 0 auto" };
    return h("div", { style: bar },
      h("div", { style: side },
        p.back === "1"
          ? h("button", { key: "back", style: button, onClick: () => sendEvent(n.edit, "back") }, "‹ Back")
          : null,
        leading.map((title, i) => h("button", {
          key: `l${i}`, style: button,
          onClick: () => sendEvent(n.edit, `leading:${i}`),
        }, title))),
      h("div", {
        style: {
          flex: 1, textAlign: "center", fontWeight: 600, fontSize: 16,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          // Explicit shrinkability: overflow:hidden already zeroes the flex
          // minimum (the automatic min-size only applies to visible
          // overflow), but state it outright so a future overflow change
          // can't silently let a long nowrap title push the trailing
          // toolbar cluster off-viewport on narrow screens.
          minWidth: 0,
          opacity: p.large === "1" ? Number(p.inlineAlpha || 1) : 1,
        },
      }, principal >= 0
        ? h("button", {
            style: {
              ...button, fontWeight: 600, fontSize: 15, padding: "4px 12px",
              borderRadius: 14, background: dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.06)",
              color: dark ? "rgba(255,255,255,0.92)" : "rgba(0,0,0,0.85)",
            },
            onClick: () => sendEvent(n.edit, `trailingItem:${principal}`),
          }, trailing[principal] || "")
        : (p.title || "")),
      h("div", { style: { ...side, justifyContent: "flex-end" } },
        trailing.map((title, i) => i === principal ? null : h("button", {
          key: `t${i}`, style: button,
          onClick: () => sendEvent(n.edit, `trailingItem:${i}`),
        }, title))));
  }

  function tabBar(n) {
    const p = n.params || {};
    const count = Number(p.count || 0);
    const selected = Number(p.selected || 0);
    const tabs = [];
    for (let i = 0; i < count; i++) {
      const active = i === selected;
      tabs.push(h("button", {
        key: i,
        onClick: () => sendEvent(n.edit, String(i)),
        style: {
          flex: 1, border: "none", background: "none", cursor: "pointer",
          display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
          padding: "7px 0 5px", fontSize: 11, opacity: active ? 1 : 0.45,
          color: active ? "#0a84ff" : "rgba(0,0,0,0.55)",
        },
      },
        p["glyph" + i]
          ? h("span", { style: { fontSize: 22, lineHeight: "24px" } }, p["glyph" + i])
          : p["icon" + i]
            ? h("img", { src: `${assetBase}${p["icon" + i]}.png`, style: { width: 24, height: 24, objectFit: "contain" } })
            : null,
        h("span", null, p["label" + i] || "")));
    }
    return h("div", {
      style: {
        display: "flex", width: "100%", flex: "none",
        background: "rgba(249,249,249,0.94)", borderTop: "1px solid rgba(0,0,0,0.12)",
      },
    }, tabs);
  }

  // Semantic navigation (`navstack`) → the web idiom: a compact header bar
  // (back, leading items, centered title, trailing items) shown when it has
  // content, a large-title heading + search row unless the title mode is
  // inline, then the content column. Events ride the node's host-event
  // channel: "back", "leading:<i>", "trailingItem:<i>", "search:<text>".
  function navStack(n, key, kids) {
    const p = n.params || {};
    const dark = p.dark === "1";
    const depth = Number(p.depth || 0);
    const inline = p.displayMode === "inline";
    const leading = p.leading ? p.leading.split("\n") : [];
    const trailing = p.trailingItems ? p.trailingItems.split("\n") : [];
    const showBar = depth > 0 || leading.length > 0 || trailing.length > 0 || inline;
    const rows = [];
    if (showBar) {
      rows.push(h(R.Fragment, { key: "bar" }, navBar({
        edit: n.edit,
        params: {
          title: inline || !p.title ? (p.title || "") : "",
          back: depth > 0 ? "1" : "0",
          dark: p.dark,
          leading: p.leading,
          trailingItems: p.trailingItems,
          principal: p.principal,
        },
      })));
    }
    if (!inline && p.title) {
      rows.push(h("div", {
        key: "title",
        style: {
          fontSize: 34, fontWeight: 700, padding: "6px 16px 8px",
          color: dark ? "rgba(255,255,255,0.92)" : "rgba(0,0,0,0.85)",
          fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
        },
      }, p.title));
    }
    if (p.searchPrompt != null && p.searchPrompt !== "") {
      rows.push(h("input", {
        key: "search",
        type: "search",
        defaultValue: p.searchValue || "",
        placeholder: p.searchPrompt,
        onInput: (e) => sendEvent(n.edit, `search:${e.target.value}`),
        style: {
          margin: "0 16px 8px", padding: "7px 10px", fontSize: 15,
          border: "1px solid rgba(120,120,128,0.35)", borderRadius: 8,
          outline: "none", background: "rgba(120,120,128,0.08)",
          color: "inherit",
        },
      }));
    }
    rows.push(h("div", {
      key: `content:${depth}`, // remount per level: a push swaps the screen
      style: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0, alignSelf: "stretch" },
    }, kids));
    return h("div", {
      key,
      style: {
        display: "flex", flexDirection: "column", flex: 1,
        minHeight: 0, minWidth: 0, alignSelf: "stretch", width: "100%",
        color: dark ? "rgba(255,255,255,0.92)" : "rgba(0,0,0,0.85)",
      },
    }, rows);
  }

  // Semantic `navsplit` → three columns (240 | 340 | remainder) with
  // hairline dividers; the sidebar carries the bar tint, like a desktop
  // split view. On a COMPACT container it collapses to a single-pane drill
  // (like SwiftUI's own split view on an iPhone): a tap inside the visible
  // column advances to the next pane, the back row retreats.
  // `.tabViewStyle(.sidebarAdaptable)` (the modern Tab/TabSection form):
  // macOS semantics on the web — ALWAYS a sidebar (TabSections as groups,
  // like the navsplit sidebar column) regardless of width, with the
  // standard collapse/expand toggle at the top leading edge; collapsed,
  // the panes take the full width and the floating toggle brings it back.
  // The collapsed state persists per browser (localStorage). Labels carry
  // SF-symbol text glyphs (`glyph<i>`) mapped by the guest.
  function SidebarTabs({ n, kids }) {
    const p = n.params || {};
    const dark = p.dark === "1";
    const count = Number(p.count || 0);
    const selected = Number(p.selected || 0);
    const [collapsed, setCollapsed] = R.useState(() => {
      try { return localStorage.getItem("uui-sidebar-collapsed") === "1"; }
      catch (_) { return false; }
    });
    const toggle = () => setCollapsed((value) => {
      try { localStorage.setItem("uui-sidebar-collapsed", value ? "0" : "1"); }
      catch (_) {}
      return !value;
    });
    // The macOS sidebar.leading control, inline SVG (crisper than a glyph).
    const toggleButton = (extra) => h("button", {
      key: "toggle",
      title: collapsed ? "Show Sidebar" : "Hide Sidebar",
      onClick: toggle,
      style: {
        border: "none", background: "none", cursor: "pointer", padding: 6,
        borderRadius: 6, display: "flex", alignItems: "center",
        color: dark ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.5)",
        ...extra,
      },
    }, h("svg", { width: 18, height: 16, viewBox: "0 0 18 16" },
      h("rect", { x: 0.75, y: 0.75, width: 16.5, height: 14.5, rx: 3, fill: "none", stroke: "currentColor", strokeWidth: 1.5 }),
      h("line", { x1: 6.5, y1: 1, x2: 6.5, y2: 15, stroke: "currentColor", strokeWidth: 1.5 }),
      h("rect", { x: 2, y: 3, width: 3, height: 1.6, rx: 0.8, fill: "currentColor" }),
      h("rect", { x: 2, y: 6, width: 3, height: 1.6, rx: 0.8, fill: "currentColor" })));
    const content = h("div", {
      key: "content",
      style: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0, minWidth: 0, alignSelf: "stretch" },
    }, kids);
    if (collapsed) {
      return h("div", {
        style: { position: "relative", display: "flex", flexDirection: "row", flex: 1, width: "100%", minHeight: 0, alignSelf: "stretch" },
      },
        content,
        h("div", { key: "float", style: { position: "absolute", top: 8, left: 8, zIndex: 20 } },
          toggleButton({ background: dark ? "rgba(30,30,32,0.85)" : "rgba(247,247,247,0.9)", boxShadow: "0 1px 4px rgba(0,0,0,0.25)" })));
    }
    // Group by section title, ungrouped tabs first, preserving order.
    const rows = [];
    let lastSection = "";
    for (let i = 0; i < count; i++) {
      const section = p["section" + i] || "";
      if (section !== lastSection && section) {
        rows.push(h("div", {
          key: `s${i}`,
          style: {
            padding: "14px 14px 4px", fontSize: 11, fontWeight: 600,
            textTransform: "uppercase", letterSpacing: "0.4px",
            color: dark ? "rgba(255,255,255,0.45)" : "rgba(0,0,0,0.45)",
          },
        }, section));
      }
      lastSection = section;
      const active = i === selected;
      rows.push(h("button", {
        key: i,
        onClick: () => sendEvent(n.edit, String(i)),
        style: {
          display: "flex", alignItems: "center", gap: 9, width: "calc(100% - 12px)",
          margin: "1px 6px", padding: "7px 9px", border: "none", cursor: "pointer",
          borderRadius: 7, textAlign: "left", fontSize: 13.5,
          fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
          background: active ? (dark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.08)") : "none",
          color: dark ? "rgba(255,255,255,0.92)" : "rgba(0,0,0,0.85)",
        },
      },
        p["glyph" + i]
          ? h("span", { style: { fontSize: 15, width: 22, textAlign: "center", color: "#0a84ff" } }, p["glyph" + i])
          : null,
        h("span", null, p["label" + i] || "")));
    }
    const sidebarBg = dark ? "rgba(30,30,32,0.94)" : "rgba(247,247,247,0.94)";
    return h("div", {
      style: { display: "flex", flexDirection: "row", flex: 1, width: "100%", minHeight: 0, alignSelf: "stretch" },
    },
      h("div", {
        key: "sidebar",
        style: {
          width: 220, flex: "none", display: "flex", flexDirection: "column",
          minHeight: 0, alignSelf: "stretch", background: sidebarBg,
          overflowY: "auto",
        },
      },
        h("div", { key: "head", style: { display: "flex", padding: "6px 6px 2px" } }, toggleButton()),
        rows),
      h("div", {
        key: "d0",
        style: { width: 1, flex: "none", alignSelf: "stretch", background: dark ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.12)" },
      }),
      content);
  }

  function NavSplit({ dark, kids, preferredPane, edit, sidebarWidth, contentWidth }) {
    // `preferredCompactColumn`: the compact presentation starts on the
    // guest's preferred column and reports pane changes back so the app's
    // binding tracks ("compact:<column>" on the navsplit's event channel).
    // Two-column splits (sidebar + detail, no content child) have one fewer
    // pane; the preferred column clamps into range.
    const paneCount = kids.length;
    const paneNames = paneCount === 2 ? ["sidebar", "detail"] : ["sidebar", "content", "detail"];
    const lastPane = paneCount - 1;
    const [pane, setPaneState] = R.useState(Math.min(preferredPane ?? 0, lastPane));
    const setPane = (next) => {
      setPaneState(next);
      if (edit) sendEvent(edit, "compact:" + paneNames[next]);
    };
    const compact = window.innerWidth < 700;
    const divider = (k) => h("div", {
      key: k,
      style: { width: 1, flex: "none", alignSelf: "stretch", background: dark ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.12)" },
    });
    const column = (k, width, kid, background, extra) => h("div", {
      key: k,
      ...extra,
      style: {
        width, flex: width == null ? 1 : "none",
        minWidth: width == null ? 0 : undefined,
        display: "flex", flexDirection: "column", minHeight: 0,
        alignSelf: "stretch", background,
      },
    }, kid);
    const sidebarBg = dark ? "rgba(30,30,32,0.94)" : "rgba(247,247,247,0.94)";
    if (!compact) {
      if (paneCount === 2) {
        return h("div", {
          style: { display: "flex", flexDirection: "row", flex: 1, width: "100%", minHeight: 0, alignSelf: "stretch" },
        },
          column("sidebar", sidebarWidth, kids[0], sidebarBg),
          divider("d0"),
          column("detail", null, kids[1]));
      }
      return h("div", {
        style: { display: "flex", flexDirection: "row", flex: 1, width: "100%", minHeight: 0, alignSelf: "stretch" },
      },
        column("sidebar", sidebarWidth, kids[0], sidebarBg),
        divider("d0"),
        column("content", contentWidth, kids[1]),
        divider("d1"),
        column("detail", null, kids[2]));
    }
    // Compact: pane 0 = sidebar, 1 = content, 2 = detail. Advance on click
    // (bubble phase, so the row's own tap fired first), retreat via the
    // back row.
    const rows = [];
    if (pane > 0) {
      rows.push(h("div", {
        key: "back",
        onClick: () => setPane(pane - 1),
        style: {
          padding: "10px 14px", color: "#0a84ff", cursor: "pointer",
          fontSize: 16, flex: "none",
          fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
        },
      }, "‹ Back"));
    }
    rows.push(column(
      `pane${pane}`, null, kids[pane],
      pane === 0 ? sidebarBg : undefined,
      // Capture phase: row handlers stopPropagation, so the bubble never
      // arrives — capture runs first and the row's own tap still fires.
      pane < lastPane ? { onClickCapture: () => setPane(pane + 1) } : undefined));
    return h("div", {
      style: { display: "flex", flexDirection: "column", flex: 1, width: "100%", minHeight: 0, alignSelf: "stretch" },
    }, rows);
  }

  function navSplit(n, key, kids) {
    const p = n.params || {};
    const preferred = p.columns === "2"
      ? { sidebar: 0, content: 0, detail: 1 }[p.compact]
      : { sidebar: 0, content: 1, detail: 2 }[p.compact];
    return h(NavSplit, {
      key, dark: p.dark === "1", kids,
      preferredPane: preferred, edit: n.edit,
      // `.navigationSplitViewColumnWidth` hints (sidebarWidth/contentWidth).
      sidebarWidth: Number(p.sidebarWidth) || 240,
      contentWidth: Number(p.contentWidth) || 340,
    });
  }

  // Pointer-drag state for the `map` host view (one pointer pans at a time).
  const mapDrag = { active: false, x: 0, y: 0 };

  // A scroll pinned to its bottom edge (`.defaultScrollAnchor(.bottom)`):
  // GeometryReader measurement: observe the wrapper div's border-box and
  // send each size the host lays out to the guest (deduped per element; a
  // same-size re-report after a remount is harmless — the guest's rebuild is
  // identical, the patch is empty, and the observer quiesces). Sizes are CSS
  // pixels — the same logical points the guest's canvas size uses.
  function GeometryBox({ divProps, geoId, children }) {
    const ref = R.useRef(null);
    const lastSent = R.useRef("");
    R.useLayoutEffect(() => {
      const el = ref.current;
      if (!el) return undefined;
      const report = () => {
        const w = Math.round(el.clientWidth);
        const h2 = Math.round(el.clientHeight);
        if (w <= 0 || h2 <= 0) return;
        const value = `${w}x${h2}`;
        if (lastSent.current === value) return;
        lastSent.current = value;
        sendEvent(geoId, value);
      };
      report();
      const observer = new ResizeObserver(report);
      observer.observe(el);
      return () => observer.disconnect();
    }, [geoId]);
    return h("div", { ...divProps, ref }, children);
  }

  // starts at the newest content and follows growth while the user is at the
  // bottom; scrolling up unpins until they return (within a small slop).
  function BottomAnchoredScroll({ divProps, children }) {
    const ref = R.useRef(null);
    const pinned = R.useRef(true);
    R.useLayoutEffect(() => {
      const el = ref.current;
      if (el && pinned.current) el.scrollTop = el.scrollHeight;
    });
    return h("div", {
      ...divProps,
      ref,
      onScroll: (e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
      },
    }, children);
  }

  function hostView(n, props, kids) {
    const p = n.params || {};
    switch (n.view) {
      case "navbar": return navBar(n);
      case "tabbar": return tabBar(n);
      case "search":
        return h(TextInput, { n: { ...n, searchStyle: true, placeholder: p.prompt || "" } });
      case "toggle":
        return h("input", {
          type: "checkbox",
          className: "uui-switch",
          checked: n.v === "1",
          onChange: (e) => sendEvent(n.edit, e.target.checked ? "1" : "0"),
        });
      case "picker":
      case "menu": {
        props.value = n.view === "picker" ? Number(n.v) || 0 : 0;
        props.onChange = (e) => sendEvent(n.edit, String(e.target.selectedIndex));
        props.style = { ...props.style, fontSize: 15, padding: "4px 8px" };
        return h("select", props,
          (n.options || []).map((label, i) => h("option", { key: i, value: i }, label)));
      }
      case "datepicker":
        props.type = "date";
        props.value = n.v || "";
        props.onChange = (e) => sendEvent(n.edit, e.target.value);
        return h("input", props);
      case "image":
        props.src = /^(https?:|data:|blob:)/.test(n.v) ? n.v : assetBase + n.v;
        props.style = { ...props.style, maxWidth: "100%", objectFit: "contain" };
        return h("img", props);
      case "webview":
        props.src = n.v;
        props.style = { ...props.style, border: "none", width: "100%", height: "100%", flex: 1, alignSelf: "stretch" };
        return h("iframe", props);
      case "map": {
        // Real SwiftMap tiles: the wasm module draws into the page canvas,
        // which the boot layer parks inside this element (mapSurface). This
        // element owns the gestures, translated to the same camera-binding
        // commands the self-drawing renderers send ("pan:dx,dy" /
        // "zoom:dy,ax,ay,w,h" — MapSupport.applyGesture).
        props.style = {
          ...props.style, width: "100%", height: "100%", flex: 1,
          alignSelf: "stretch", position: "relative", overflow: "hidden",
          touchAction: "none",
        };
        if (mapSurface) props.ref = (el) => mapSurface.attach(el, n);
        props.onPointerDown = (e) => {
          mapDrag.active = true;
          mapDrag.x = e.clientX;
          mapDrag.y = e.clientY;
          e.currentTarget.setPointerCapture(e.pointerId);
        };
        props.onPointerMove = (e) => {
          if (!mapDrag.active) return;
          sendEvent(n.edit, `pan:${e.clientX - mapDrag.x},${e.clientY - mapDrag.y}`);
          mapDrag.x = e.clientX;
          mapDrag.y = e.clientY;
        };
        props.onPointerUp = () => { mapDrag.active = false; };
        props.onWheel = (e) => {
          const r = e.currentTarget.getBoundingClientRect();
          sendEvent(n.edit,
            `zoom:${e.deltaY},${e.clientX - r.left},${e.clientY - r.top},${r.width},${r.height}`);
        };
        return h("div", props);
      }
      case "video":
        props.src = n.v;
        props.controls = true;
        props.playsInline = true;
        props.style = { ...props.style, width: "100%", background: "#000", objectFit: "contain" };
        return h("video", props);
      default:
        if (n.view && n.view.startsWith("html:")) {
          props.type = n.view.slice(5);
          props.value = n.v || "";
          props.onChange = (e) => sendEvent(n.edit, e.target.value);
          return h("input", props);
        }
        return h("div", props, kids);
    }
  }

  function presentation(n, kids) {
    const isAlert = n.style === "alert";
    // Panel chrome colors ride the node, scheme-resolved by the serializer
    // (Color.secondaryBackground / Color.primary) — never hardcode a light
    // palette here, or dark-scheme presented content renders white-on-white.
    const panelBg = rgba(n.bg) || "#fff";
    const headColor = n.color ? rgba(n.color) : undefined;
    const messageColor = n.color
      ? rgba([n.color[0], n.color[1], n.color[2], n.color[3] * 0.65])
      : "rgba(0,0,0,0.6)";
    if (isAlert) {
      const head = [];
      if (n.title) {
        head.push(h("div", {
          key: "t",
          style: { fontWeight: 600, fontSize: 17, textAlign: "center", color: headColor },
        }, n.title));
      }
      if (n.message) {
        head.push(h("div", {
          key: "m",
          style: { fontSize: 14, color: messageColor, textAlign: "center" },
        }, n.message));
      }
      kids = [h("div", {
        key: "head",
        style: {
          display: "flex", flexDirection: "column", gap: 8,
          marginBottom: kids.length ? 14 : 0,
          fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
        },
      }, head), ...kids];
    }
    return h("div", {
      style: {
        position: "fixed", inset: 0, display: "flex", zIndex: 20,
        alignItems: isAlert ? "center" : "flex-end", justifyContent: "center",
        background: "rgba(0,0,0,0.35)",
      },
      onClick: () => sendEvent(n.dismiss, ""),
    }, h("div", {
      onClick: (e) => e.stopPropagation(),
      style: isAlert
        ? { background: panelBg, borderRadius: 14, minWidth: 280, maxWidth: 420, padding: 20, boxShadow: "0 12px 40px rgba(0,0,0,0.3)", display: "flex", flexDirection: "column", alignItems: "center" }
        : { background: panelBg, borderTopLeftRadius: 14, borderTopRightRadius: 14, width: "100%", maxWidth: 640, maxHeight: "85%", overflowY: "auto", padding: 16, boxShadow: "0 -8px 32px rgba(0,0,0,0.25)", display: "flex", flexDirection: "column", alignItems: "center" },
    }, kids));
  }

  function render(n, key, parentAxis) {
    if (n.k === "hostView" && (n.view === "navbar" || n.view === "tabbar")) {
      // Bars ignore box decorations; they are chrome rows.
      return h(R.Fragment, { key }, hostView(n, {}, []));
    }
    const props = interactive(n, { key, style: baseStyle(n) });
    const s = props.style;
    if (key === "root") {
      s.width = "100%";
      s.height = "100%";
    }
    // Greedy nodes fill their parent: grow along the parent's main axis,
    // stretch across it (SwiftUI greediness, computed by the serializer).
    if ((parentAxis === "v" && n.growH) || (parentAxis === "h" && n.growW)) {
      s.flexGrow = 1;
      s.minHeight = 0;
      s.minWidth = 0;
    }
    if ((parentAxis === "v" && n.growW) || (parentAxis === "h" && n.growH)) {
      s.alignSelf = "stretch";
    }
    // In a ZStack layer, greedy nodes fill the stack (e.g. a shape backdrop).
    if (parentAxis === "z") {
      if (n.growW) s.width = "100%";
      if (n.growH) s.height = "100%";
    }
    // `.frame(maxWidth/Height: .infinity)` along the parent's main axis means
    // "fill the remaining space", which in CSS is flex-grow — NOT a 100%
    // preferred size, which would overflow the row and shrink the fixed
    // siblings. Across the main axis it is a plain 100%.
    if (n.expandW) {
      if (parentAxis === "h") {
        s.flexGrow = 1;
        s.flexBasis = 0;
        s.minWidth = 0;
      } else {
        s.width = "100%";
      }
    }
    if (n.expandH) {
      if (parentAxis === "v") {
        s.flexGrow = 1;
        s.flexBasis = 0;
        s.minHeight = 0;
      } else {
        s.height = "100%";
      }
    }
    // SwiftUI fixed frames don't compress; keep flexbox from shrinking them
    // along the parent's main axis.
    if (parentAxis === "h" && n.width != null) s.flexShrink = 0;
    if (parentAxis === "v" && n.height != null) s.flexShrink = 0;
    const childAxis = n.k === "stack" ? n.axis : "v";
    // Key children by kind (and stack axis / host-view kind), not bare index:
    // when navigation swaps a whole subtree, a same-position node of a
    // different kind must REMOUNT, not be incrementally patched — React's
    // style diffing across such transitions has left stale inline styles
    // (e.g. a dropped flex-grow centering a re-visited pane).
    let kids = (n.ch || []).map((c, i) =>
      render(c, `${i}:${c.k}${c.axis || ""}${c.view || ""}`, childAxis));

    switch (n.k) {
      case "stack": {
        if (n.axis === "z") {
          // Layers stretch over the whole stack; each aligns its child by
          // the ZStack's alignment (SwiftUI's ZStack(alignment:)).
          const place = `${alignCSS[n.alignV] || "center"} ${alignCSS[n.alignH] || "center"}`;
          s.display = "grid";
          s.placeItems = "stretch";
          kids = kids.map((kid, i) => {
            const c = (n.ch || [])[i] || {};
            return h("div", {
              key: i,
              style: {
                gridArea: "1 / 1", display: "grid", placeItems: place,
                minWidth: 0, minHeight: 0,
                width: c.growW ? "100%" : undefined,
                height: c.growH ? "100%" : undefined,
                // Each layer stacks above the previous even when an earlier
                // layer contains positioned content (the map's canvas).
                position: "relative", zIndex: i,
              },
            }, kid);
          });
        } else {
          s.display = "flex";
          s.flexDirection = n.axis === "h" ? "row" : "column";
          s.alignItems = n.axis === "h"
            ? (alignCSS[n.alignV] || "center")
            : (alignCSS[n.alignH] || "center");
          s.minHeight = 0;
          s.minWidth = 0;
          s.gap = n.spacing != null ? n.spacing : 8;
        }
        return h("div", props, kids);
      }
      case "text": {
        s.fontSize = n.size;
        s.fontWeight = n.weight;
        s.color = rgba(n.color);
        s.whiteSpace = "pre-wrap";
        s.fontFamily = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";
        if (n.lines) {
          s.display = "-webkit-box";
          s.WebkitLineClamp = n.lines;
          s.WebkitBoxOrient = "vertical";
          s.overflow = "hidden";
        }
        return h("span", props, n.v);
      }
      case "spacer":
        s.flexGrow = 1;
        if (n.min != null) { s.minWidth = n.min; s.minHeight = n.min; }
        return h("div", props);
      case "divider":
        s.alignSelf = "stretch";
        s.flex = "0 0 1px";
        s.background = "rgba(120,120,128,0.3)";
        return h("div", props);
      case "scroll":
        s.flex = "1 1 0";
        s.alignSelf = "stretch";
        s.minHeight = 0;
        s.minWidth = 0;
        s[n.axis === "h" ? "overflowX" : "overflowY"] = "auto";
        // `.defaultScrollAnchor(.bottom)` (a chat log): start at the bottom
        // and stay pinned there as content grows, until the user scrolls up.
        if ((n.params || {}).anchor === "bottom") {
          return h(BottomAnchoredScroll, { key, divProps: props }, kids);
        }
        return h("div", props, kids);
      case "image": {
        const src = /^(https?:|data:|blob:)/.test(n.src) ? n.src : assetBase + n.src + (n.src.includes(".") ? "" : ".png");
        props.src = src;
        s.objectFit = n.fit ? "contain" : "cover";
        // scaledToFill: fill the frame box and crop (matching real SwiftUI
        // and the self-drawing renderers) — a bare <img> would render at its
        // natural size and overflow the frame into neighboring content. An
        // explicit propagated frame size (n.width/n.height) wins.
        if (n.resizable && !n.fit) {
          if (n.width == null) s.width = "100%";
          if (n.height == null) s.height = "100%";
        }
        if (!n.resizable && n.width == null) s.maxWidth = "100%";
        if (n.width == null && n.height == null) { s.minWidth = 0; s.minHeight = 0; }
        return h("img", props);
      }
      case "textField":
        return h(TextInput, { key: n.id || key, n: { ...n, baseStyle: s } });
      case "slider":
        props.type = "range";
        props.min = 0;
        props.max = 1;
        props.step = 0.001;
        props.value = n.v || 0;
        props.onChange = (e) => sendEvent(n.edit, e.target.value);
        s.alignSelf = "stretch";
        return h("input", props);
      case "progress":
        if (n.v == null) {
          props.className = ((props.className || "") + " uui-spinner").trim();
          return h("div", props);
        }
        props.value = n.v;
        props.max = 1;
        s.alignSelf = "stretch";
        return h("progress", props);
      case "shape":
      case "gradient": {
        if (n.shape === "circle") s.borderRadius = "50%";
        if (n.shape === "capsule") s.borderRadius = 9999;
        if (n.fill) s.background = rgba(n.fill);
        if (n.stroke) s.border = `${n.strokeWidth || 1}px solid ${rgba(n.stroke)}`;
        if (n.width == null && !n.expandW) s.minWidth = 10;
        if (n.height == null && !n.expandH) s.minHeight = 10;
        s.display = "grid";
        s.placeItems = "center";
        return h("div", props, kids);
      }
      case "hostView":
        if (n.view === "navstack") return navStack(n, key, kids);
        if (n.view === "navsplit") return navSplit(n, key, kids);
        if (n.view === "tabs") {
          if ((n.params || {}).style === "sidebarAdaptable") {
            return h(SidebarTabs, { key, n, kids });
          }
          // Semantic tabs → the selected tab's content over the bottom bar.
          return h("div", {
            key,
            style: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0, alignSelf: "stretch", width: "100%" },
          },
            h("div", { key: "content", style: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 } }, kids),
            h(R.Fragment, { key: "bar" }, tabBar({ edit: n.edit, params: n.params })));
        }
        return hostView(n, props, kids);
      case "presentation":
        return presentation(n, kids);
      default: {
        if (kids.length > 0) {
          s.display = "flex";
          s.flexDirection = "column";
          s.alignItems = alignCSS[n.alignH] || "center";
          s.justifyContent = alignCSS[n.alignV] || "center";
          s.minHeight = 0;
          s.minWidth = 0;
        }
        // Semantic list rows carry a `cell` role instead of baked-in
        // chrome — this host's row idiom: comfortable padding, a minimum
        // touch height, and a hairline separator.
        if ((n.params || {}).cell === "row") {
          s.padding = "11px 16px";
          s.minHeight = 44;
          s.boxSizing = "border-box";
          s.justifyContent = "center";
          s.borderBottom = "1px solid rgba(120,120,128,0.2)";
        }
        // A GeometryReader wrapper: measure the box the host actually laid
        // out and report it back ("<w>x<h>" on the `.geo` id), so the guest
        // rebuilds the reader's content against its CONTAINER, not the
        // canvas. The guest ignores same-size re-reports (empty patch), so
        // remounts converge.
        if ((n.params || {}).geo) {
          return h(GeometryBox, { key, divProps: props, geoId: n.params.geo }, kids);
        }
        return h("div", props, kids);
      }
    }
  }

  return {
    render(tree) {
      root.render(render(tree, "root", "v"));
    },
  };
}
