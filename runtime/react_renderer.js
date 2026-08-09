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

  // A text input holding focus-local state so re-renders from Swift don't
  // reset the caret; external value changes apply while unfocused.
  function TextInput({ n }) {
    const [value, setValue] = R.useState(n.v || "");
    const focused = R.useRef(false);
    R.useEffect(() => {
      if (!focused.current) setValue(n.v || "");
    }, [n.v]);
    return h("input", {
      type: n.searchStyle ? "search" : "text",
      value,
      placeholder: n.placeholder,
      onFocus: () => { focused.current = true; },
      onBlur: () => { focused.current = false; },
      onChange: (e) => {
        setValue(e.target.value);
        if (n.edit) sendEvent(n.edit, e.target.value);
      },
      style: {
        ...(n.baseStyle || {}),
        fontSize: n.size || 15,
        padding: "7px 10px",
        border: "1px solid rgba(120,120,128,0.35)",
        borderRadius: 8,
        outline: "none",
        background: "rgba(120,120,128,0.08)",
        minWidth: 0,
        alignSelf: "stretch",
      },
    });
  }

  function navBar(n) {
    const p = n.params || {};
    const bar = {
      display: "flex", alignItems: "center", width: "100%", height: 44, flex: "none",
      background: "rgba(249,249,249,0.94)", backdropFilter: "blur(8px)",
      borderBottom: "1px solid rgba(0,0,0,0.12)",
      fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
    };
    const button = {
      border: "none", background: "none", color: "#0a84ff", fontSize: 16,
      cursor: "pointer", padding: "0 12px", flex: "0 0 auto", minWidth: 64,
    };
    return h("div", { style: bar },
      h("button", {
        style: { ...button, textAlign: "left", visibility: p.back === "1" ? "visible" : "hidden" },
        onClick: () => sendEvent(n.edit, "back"),
      }, "‹ Back"),
      h("div", {
        style: {
          flex: 1, textAlign: "center", fontWeight: 600, fontSize: 16,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          opacity: p.large === "1" ? Number(p.inlineAlpha || 1) : 1,
        },
      }, p.title || ""),
      h("button", {
        style: { ...button, textAlign: "right", visibility: p.trailing ? "visible" : "hidden" },
        onClick: () => sendEvent(n.edit, "trailing"),
      }, p.trailing || ""));
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
        p["icon" + i]
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

  // Pointer-drag state for the `map` host view (one pointer pans at a time).
  const mapDrag = { active: false, x: 0, y: 0 };

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
    if (isAlert) {
      const head = [];
      if (n.title) {
        head.push(h("div", {
          key: "t",
          style: { fontWeight: 600, fontSize: 17, textAlign: "center" },
        }, n.title));
      }
      if (n.message) {
        head.push(h("div", {
          key: "m",
          style: { fontSize: 14, color: "rgba(0,0,0,0.6)", textAlign: "center" },
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
        ? { background: "#fff", borderRadius: 14, minWidth: 280, maxWidth: 420, padding: 20, boxShadow: "0 12px 40px rgba(0,0,0,0.3)", display: "flex", flexDirection: "column", alignItems: "center" }
        : { background: "#fff", borderTopLeftRadius: 14, borderTopRightRadius: 14, width: "100%", maxWidth: 640, maxHeight: "85%", overflowY: "auto", padding: 16, boxShadow: "0 -8px 32px rgba(0,0,0,0.25)", display: "flex", flexDirection: "column", alignItems: "center" },
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
