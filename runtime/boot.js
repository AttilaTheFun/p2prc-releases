// Boots a Universal UI wasm application through the swift_ffi bindings:
// `load()` instantiates the reactor (WASI shim included), a plain object
// implements the Swift `WebHost` protocol, and the exported functions drive
// the runtime. Strings and structs copy at the boundary, so there is no
// pointer/length or staging-buffer plumbing here.

import { load } from "../app_bridge.js?v=7be24e5c";
import { createRasterHost } from "./raster.js?v=b562f9c2";
import { createReactTreeRenderer } from "./react_renderer.js?v=491a32fc";
import { applyPatch } from "./flat_tree.js?v=5ec0be73";

// `rendererName` picks the renderer (docs/renderer_layers.md): "webGPU"
// (default) binds the self-drawing SwiftGPURenderer; "react" binds the
// ReactRenderer, which mounts the serialized view tree as React components
// and owns layout itself.
export async function boot({
  canvas, wasmURL, bundle, rendererName = "webGPU", embedded = false,
  // Host-side swift_ffi dependency injection (docs/wasm_di.md): entries built
  // with the generated `Dependencies` builders, keyed by dictionary key. The
  // page owns every app-specific service; boot() just passes the table to
  // load(). Async completions call back through the app's own exports on the
  // returned bridge.
  dependencies = {},
  // WASI shim overrides, merged over the built-ins (extend or replace
  // individual calls — clocks, fds, … — without forking the runtime).
  wasi = undefined,
} = {}) {
  const react = rendererName === "react";
  // SwiftGPURenderer: Swift draws through swift_gpu's executor; this page
  // supplies measurement + rasterization.
  let gpuHost = null;
  let raster = null;
  if (!react) {
    // Imported lazily: the ReactRenderer path never touches WebGPU, and a
    // static import would put swift_gpu's executor on EVERY page's critical
    // module graph (an unresolved ES module import evaluates NOTHING —
    // rendering as a silent blank page when the file isn't served).
    const { createSwiftGPUHost } = await import("./swift_gpu_webgpu.js");
    gpuHost = await createSwiftGPUHost(canvas);
    raster = createRasterHost({
      scale: window.devicePixelRatio || 1,
      invalidate: () => scheduleRender(),
    });
  }

  let bridge = null;
  let reactTree = null;
  // The retained render tree; each renderTree() buffer is a Patch against it.
  let retainedTree = null;
  let treeContainer = null;
  if (react) {
    // React owns the surface: mount a root container where the canvas was.
    treeContainer = document.createElement("div");
    treeContainer.style.cssText =
      "position:absolute;inset:0;overflow:hidden;display:flex;flex-direction:column";
    canvas.style.display = "none";
    (canvas.parentElement || document.body).appendChild(treeContainer);
    reactTree = createReactTreeRenderer({
      container: treeContainer,
      sendEvent: (id, value) => bridge.uuiHostEvent(id, value),
    });
    // Event injection for headless smoke tests (cf. __uuiHostViews).
    window.__uuiSendEvent = (id, value) => bridge.uuiHostEvent(id, value);
  }

  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      bridge.uuiRender();
    });
  }


  // Native text input: a real DOM <input> positioned over the focused
  // TextField (full IME/selection support for free).
  const textOverlay = document.createElement("input");
  textOverlay.type = "text";
  textOverlay.style.cssText = [
    "position:fixed", "display:none", "box-sizing:border-box",
    "border:2px solid #0a84ff", "border-radius:6px", "padding:0 7px",
    "outline:none", "background:#fff", "color:rgba(0,0,0,0.85)",
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
    "z-index:10",
  ].join(";");
  document.body.appendChild(textOverlay);
  window.__uuiTextOverlay = textOverlay; // used by headless smoke tests

  let hidingTextOverlay = false;
  function hideTextOverlay() {
    hidingTextOverlay = true;
    textOverlay.style.display = "none";
    textOverlay.blur();
    hidingTextOverlay = false;
  }
  textOverlay.addEventListener("input", () => bridge.uuiTextChanged(textOverlay.value));
  textOverlay.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      bridge.uuiTextSubmitted();
    }
  });
  textOverlay.addEventListener("blur", () => {
    if (!hidingTextOverlay && textOverlay.style.display !== "none") {
      textOverlay.style.display = "none";
      bridge.uuiTextEnded();
    }
  });

  // Native host views: app-authored representables (`html:<type>`, the
  // UIViewRepresentable analogue) positioned over the canvas, reconciled each
  // frame by id. Framework chrome (navbar/tabbar/search/picker/menu/date/
  // media) is drawn at the GPU layer under the SwiftGPURenderer and built
  // from React components under the ReactRenderer — no DOM widgets here.
  const hostViews = new Map(); // id -> { el, kind }
  let darkMode = false;
  function sendHostEvent(id, value) {
    bridge.uuiHostEvent(id, value);
  }
  function makeHostView(spec) {
    let el;
    if (spec.kind.startsWith("html:")) {
      el = document.createElement("input");
      el.type = spec.kind.slice(5); // e.g. "html:color" -> <input type=color>
      el.addEventListener("input", () => sendHostEvent(spec.id, el.value));
    } else {
      el = document.createElement("div");
    }
    el.style.cssText = [
      "position:fixed", "box-sizing:border-box", "z-index:9",
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
      "font-size:15px",
    ].join(";");
    document.body.appendChild(el);
    return el;
  }
  function updateHostView(entry, spec, bounds) {
    const el = entry.el;
    el.style.left = `${bounds.left + spec.x}px`;
    el.style.top = `${bounds.top + spec.y}px`;
    el.style.width = `${spec.w}px`;
    el.style.height = `${spec.h}px`;
    if (spec.kind.startsWith("html:")) {
      if (document.activeElement !== el && el.value !== spec.value) el.value = spec.value;
    }
  }
  function syncHostViews(json) {
    const specs = JSON.parse(json);
    const seen = new Set();
    const bounds = canvas.getBoundingClientRect();
    for (const spec of specs) {
      seen.add(spec.id);
      let entry = hostViews.get(spec.id);
      if (!entry || entry.kind !== spec.kind) {
        if (entry) entry.el.remove();
        entry = { el: makeHostView(spec), kind: spec.kind };
        hostViews.set(spec.id, entry);
      }
      updateHostView(entry, spec, bounds);
    }
    for (const [id, entry] of hostViews) {
      if (!seen.has(id)) {
        entry.el.remove();
        hostViews.delete(id);
      }
    }
  }
  window.__uuiHostViews = hostViews; // for headless smoke tests

  // The Swift `WebHost` protocol, implemented as a plain object. Strings and
  // structs are real values; Swift retains this object through its foreign
  // proxy for the life of the app.
  const host = {
    measureText(text, fontSize, weight, wrapWidth) {
      if (!raster) {
        // ReactRenderer: the component system owns layout; a rough
        // estimate satisfies any stray build-time queries.
        return { width: text.length * fontSize * 0.6, height: fontSize * 1.3 };
      }
      return raster.measureText(text, fontSize, weight, wrapWidth < 0 ? null : wrapWidth);
    },
    imageInfo(source, isRemote) {
      if (!raster) return { state: 1, width: 0, height: 0 };
      // Image pixels are treated as logical points at 1x.
      return raster.imageInfo(source, isRemote);
    },
    // Drawing happens in Swift (SwiftGPURenderer through swift_gpu's WebGPU
    // backend); the host only supplies the services below.
    syncHostViews(viewsJSON) { syncHostViews(viewsJSON); },
    rasterize(spec) {
      return raster ? raster.rasterize(spec) : new Uint8Array(0);
    },
    beginTextInput(text, x, y, w, h, fontSize) {
      const bounds = canvas.getBoundingClientRect();
      textOverlay.value = text;
      textOverlay.style.left = `${bounds.left + x}px`;
      textOverlay.style.top = `${bounds.top + y}px`;
      textOverlay.style.width = `${w}px`;
      textOverlay.style.height = `${h}px`;
      textOverlay.style.fontSize = `${fontSize}px`;
      textOverlay.style.display = "block";
      requestAnimationFrame(() => textOverlay.focus());
    },
    endTextInput() { hideTextOverlay(); },
    scheduleRender() { scheduleRender(); },
    setColorScheme(dark) {
      darkMode = dark;
      // Makes native form controls (<select>/<input>) and scrollbars adapt.
      document.documentElement.style.colorScheme = darkMode ? "dark" : "light";
      textOverlay.style.background = darkMode ? "#1c1c1e" : "#fff";
      textOverlay.style.color = darkMode ? "rgba(255,255,255,0.92)" : "rgba(0,0,0,0.85)";
    },
    now() { return performance.now() / 1000; },
    storageGet(key) {
      let value = null;
      try {
        value = localStorage.getItem(key);
      } catch (err) {
        console.warn("[storage] get failed", err);
      }
      return { exists: value != null, contents: value ?? "" };
    },
    storageSet(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch (err) {
        console.warn("[storage] set failed", err);
      }
    },
    log(message) { console.log("[swiftui]", message); },
    openURL(url) { window.open(url, "_blank"); },
    // Generic platform-configuration channel (window title, platform
    // modifiers). Unknown keys are ignored by design.
    platformCommand(key, value) {
      // An embedded surface must not reconfigure the host page.
      if (embedded) return;
      if (key === "windowTitle") document.title = value;
    },
    epochMillis() { return Date.now(); },
    renderTree(tree) {
      // Each buffer is a tree.fbs `Patch` — the only wire format — applied in
      // arrival order to the retained plain-object tree the React interpreter
      // walks (the first patch after start is a full-tree op at "n").
      retainedTree = applyPatch(retainedTree, tree);
      window.__uuiLastTree = JSON.stringify(retainedTree); // for headless smoke tests
      reactTree.render(retainedTree);
    },
  };

  // A `bundle` (bytes from a BundleProvider) takes precedence over `wasmURL`
  // (a plain packaged URL) — the two entry points into the same reactor.
  const module = bundle
    ? await WebAssembly.compile(bundle.wasm ?? bundle)
    : await WebAssembly.compileStreaming(fetch(wasmURL));
  bridge = await load(module, { dependencies, wasi });
  if (gpuHost) {
    bridge.gpuConnect(gpuHost); // swift_gpu's WebGPU executor
    bridge.uuiSetDisplayScale(window.devicePixelRatio || 1);
  }

  const scale = window.devicePixelRatio || 1;
  function resizeBacking() {
    if (!gpuHost) return;
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * scale));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * scale));
  }

  resizeBacking();
  // Runs the app's @main (installing the App) and starts the runtime with
  // this host object under the chosen renderer binding.
  // Size from the mount surface (an embedded container or the full page).
  bridge.uuiStart(
    host, rendererName,
    canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight);

  // Scene lifecycle: page visibility maps to `@Environment(\.scenePhase)`.
  document.addEventListener("visibilitychange", () => {
    bridge.uuiSetScenePhase(document.hidden ? "background" : "active");
  });
  // `.onOpenURL`: the launch URL, plus any the host page dispatches later via
  // `window.dispatchEvent(new CustomEvent("uui:openurl", { detail: url }))`.
  bridge.uuiOpenURL(window.location.href);
  window.addEventListener("uui:openurl", (event) => {
    if (event.detail) bridge.uuiOpenURL(String(event.detail));
  });

  if (react) {
    return { bridge, container: treeContainer };
  }

  const localPoint = (event) => {
    const rect = canvas.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  };
  canvas.addEventListener("pointerdown", (event) => {
    canvas.setPointerCapture(event.pointerId);
    bridge.uuiPointerEvent(0, ...localPoint(event));
  });
  canvas.addEventListener("pointermove", (event) => {
    bridge.uuiPointerEvent(2, ...localPoint(event));
  });
  canvas.addEventListener("pointerup", (event) => {
    bridge.uuiPointerEvent(1, ...localPoint(event));
  });
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    bridge.uuiWheelEvent(...localPoint(event), event.deltaX, event.deltaY);
  }, { passive: false });
  window.addEventListener("resize", () => {
    resizeBacking();
    bridge.uuiResize(canvas.clientWidth, canvas.clientHeight);
  });

  return { bridge };
}

// Incremental adoption (Level 3): mount a Universal UI surface inside an
// existing web page — the web analogue of dropping a `UIHostingController`'s
// view into a UIKit hierarchy. Boots the runtime into the host-provided
// `container` (the Swift side decides the root via its `@main` App or a
// `UniversalUIHostingController`) under the chosen renderer: "react" builds
// real DOM/React components inside the container; "webGPU" draws into a
// canvas that fills it. Container resizes re-lay-out the embedded view
// independently of the window. Returns { bridge, unmount }.
export async function mountUniversalUI(container, { wasmURL, bundle, renderer = "webGPU", dependencies = {}, wasi = undefined } = {}) {
  // The react tree / host-view overlays anchor to the container.
  if (getComputedStyle(container).position === "static") {
    container.style.position = "relative";
  }
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "width:100%;height:100%;display:block;touch-action:none";
  container.appendChild(canvas);

  const result = await boot({
    canvas, wasmURL: bundle ? undefined : (wasmURL || "./app.wasm"),
    bundle, rendererName: renderer, embedded: true, dependencies, wasi,
  });

  if (renderer !== "react" && typeof ResizeObserver !== "undefined") {
    const scale = window.devicePixelRatio || 1;
    const observer = new ResizeObserver(() => {
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * scale));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * scale));
      result.bridge.uuiResize(canvas.clientWidth, canvas.clientHeight);
    });
    observer.observe(container);
    result.disconnect = () => observer.disconnect();
  }

  result.unmount = () => {
    if (result.disconnect) result.disconnect();
    if (result.container) result.container.remove();
    canvas.remove();
  };
  return { ...result, canvas };
}
