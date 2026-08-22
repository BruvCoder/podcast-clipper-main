import assert from "node:assert/strict";
import test from "node:test";

import { centreFromDetections, cropOffsetX, cropWindow } from "../src/lib/faceCrop.js";

const FRAME = { frameWidth: 1080, frameHeight: 608 };

function frame(...faces) {
  return { path: "f.jpg", faces: faces.map((f) => ({ score: 0.9, ...FRAME, ...f })) };
}

test("takes the largest face in a frame, not the first", () => {
  const result = centreFromDetections({
    frames: [
      frame({ x: 100, y: 0, w: 40, h: 40 }, { x: 500, y: 0, w: 120, h: 140 }),
      frame({ x: 90, y: 0, w: 40, h: 40 }, { x: 505, y: 0, w: 120, h: 140 }),
    ],
  });
  // The 120x140 face is centred at 560/565, not the small one at 120/110.
  assert.ok(result.centreX > 500, `expected the big face, got ${result.centreX}`);
});

test("a single lucky detection is not enough to move the crop", () => {
  const one = centreFromDetections({ frames: [frame({ x: 300, y: 0, w: 90, h: 120 }), { path: "b", faces: [] }] });
  assert.equal(one, null, "one frame should not be trusted");
});

test("the median ignores an outlier frame", () => {
  const result = centreFromDetections({
    frames: [
      frame({ x: 400, y: 0, w: 90, h: 120 }),
      frame({ x: 410, y: 0, w: 90, h: 120 }),
      frame({ x: 405, y: 0, w: 90, h: 120 }),
      // A cutaway to someone on the far right.
      frame({ x: 980, y: 0, w: 90, h: 120 }),
    ],
  });
  assert.ok(result.centreX < 520, `an outlier dragged the centre to ${result.centreX}`);
});

test("returns null when nothing was detected", () => {
  assert.equal(centreFromDetections({ frames: [{ path: "a", faces: [] }] }), null);
  assert.equal(centreFromDetections({ frames: [] }), null);
  assert.equal(centreFromDetections(null), null);
  assert.equal(centreFromDetections(undefined), null);
});

test("computes the 9:16 window for a 16:9 frame", () => {
  assert.deepEqual(cropWindow(1920, 1080), { width: 608, height: 1080 });
  assert.deepEqual(cropWindow(1080, 608), { width: 342, height: 608 });
});

test("never lets the window leave the frame", () => {
  const { width } = cropWindow(1080, 608);
  // Face hard against the left edge.
  const left = cropOffsetX(0, 1080, width);
  assert.ok(left >= 0, `left offset ${left} is off-frame`);
  // Face hard against the right edge.
  const right = cropOffsetX(1080, 1080, width);
  assert.ok(right + width <= 1080, `right offset ${right}+${width} overflows 1080`);
});

test("centres on the detected face rather than the frame", () => {
  const { width } = cropWindow(1080, 608);
  const x = cropOffsetX(458, 1080, width);
  const centreCrop = Math.round((1080 - width) / 2);
  assert.notEqual(x, centreCrop, "should not have fallen back to a centre crop");
  // Within a couple of px of putting the face in the middle of the window.
  assert.ok(Math.abs(x + width / 2 - 458) <= 2, `window centre ${x + width / 2} misses the face at 458`);
});

test("degenerate frames do not throw or produce NaN", () => {
  assert.equal(cropOffsetX(500, 100, 200), 0, "window wider than the frame pins to 0");
  const x = cropOffsetX(Number.NaN, 1080, 342);
  assert.ok(Number.isFinite(x), `offset was ${x}`);
});
