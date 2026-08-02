/* QR rendering for the host side of the client.
 *
 * The encoder itself (qrcode.js) is a third-party library and stays plain JS:
 * it is a pure function from text to a bitmap, with no application logic in it,
 * and nothing about it needs to live inside the wasm module.
 */
(function (global) {
  "use strict";

  global.P2PRCQR = {
    draw: function (element, text) {
      element.replaceChildren();
      try {
        // Version 0 = "smallest that fits"; L = most data for a given size,
        // which matters because a packed SDP offer is ~700 characters.
        var qr = qrcode(0, "L");
        qr.addData(text);
        qr.make();
        var image = new Image();
        image.src = qr.createDataURL(4, 8);
        image.alt = "pairing QR";
        element.appendChild(image);
      } catch (e) {
        element.textContent = "too long for one QR — use the link";
      }
    },
  };
})(window);
