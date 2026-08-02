// Incremental adoption (Level 3) for React host apps: <UniversalUI /> drops
// a SwiftUI surface into an existing React tree — the React analogue of
// `UIHostingController`, and the web peer of Apple's `WasmView`. The component
// owns a container div; on mount it boots the wasm runtime into it under the
// chosen renderer ("react" builds real DOM components inside the div, "webGPU"
// draws into a canvas), and on unmount it tears the surface down.
//
// It is initialized with a BundleProvider (bundle_provider.js), exactly like
// the Apple WasmView: the provider yields an initial bundle synchronously-ish
// and an async stream of newer bundles (dev hot-reload shadow, or dynamic
// delivery), and the component re-instantiates the surface on each update. A
// bare `wasmURL` is sugar for `packagedBundleProvider(wasmURL)`.
//
// Uses the page's React (`window.React`, the same UMD global the tree renderer
// uses), so the host app and the embedded surface share one React.
//
//   const { UniversalUI } = await import("./runtime/react_embed.js");
//   <UniversalUI wasmURL="./app.wasm" renderer="react" style={{ height: 480 }} />
//   // or, with hot reload / dynamic delivery:
//   <UniversalUI provider={appBundleProvider("./app.wasm", { hotReloadURL })} />

import { mountUniversalUI } from "./boot.js?v=685db28e";
import { packagedBundleProvider } from "./bundle_provider.js?v=ca065710";

export function UniversalUI({ provider, wasmURL = "./app.wasm", renderer = "react", style }) {
  const R = window.React;
  const ref = R.useRef(null);
  R.useEffect(() => {
    const source = provider || packagedBundleProvider(wasmURL);
    let mounted = null;
    let cancelled = false;

    (async () => {
      // The initial bundle renders first.
      const initial = await source.initialBundle();
      if (cancelled || !ref.current) return;
      mounted = await mountUniversalUI(ref.current, { bundle: initial, renderer });

      // Newer bundles (hot-reload shadow, dynamic-delivery update) swap in by
      // tearing down and re-instantiating the surface — the web has no
      // in-place reload, and a full swap matches how you would never do this in
      // production anyway (dev-only).
      for await (const next of source.bundleUpdates()) {
        if (cancelled || !ref.current) break;
        if (mounted) mounted.unmount();
        mounted = await mountUniversalUI(ref.current, { bundle: next, renderer });
      }
    })();

    return () => {
      cancelled = true;
      if (mounted) mounted.unmount();
    };
  }, [provider, wasmURL, renderer]);

  return R.createElement("div", {
    ref,
    style: { position: "relative", width: "100%", height: "100%", ...style },
  });
}
