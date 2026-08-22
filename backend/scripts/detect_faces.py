"""Reports where the faces are in a set of sampled video frames.

Called by src/lib/faceCrop.js. Reads image paths on stdin (one per line) and
writes one JSON object to stdout:

    {"frames": [{"path": "...", "faces": [{"x":..,"y":..,"w":..,"h":..,"score":..}]}]}

Uses OpenCV's YuNet detector rather than the bundled Haar cascades. Measured on
a real podcast frame with the speaker in profile, the Haar frontal cascade
reported a single false positive up in the background curtain and the profile
cascades found nothing at all, while YuNet found the actual face at 0.90
confidence. A wrong face position is worse than none, because it crops
confidently to the wrong place.

Exits non-zero only if it cannot run at all; per-frame failures come back as an
empty face list so the caller can fall back to a centre crop.
"""
import json
import sys

MIN_SCORE = 0.6


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: detect_faces.py <yunet.onnx>", file=sys.stderr)
        return 2
    model_path = sys.argv[1]

    try:
        import cv2
    except ImportError as exc:  # pragma: no cover - environment problem
        print(f"opencv is not available: {exc}", file=sys.stderr)
        return 3

    paths = [line.strip() for line in sys.stdin if line.strip()]
    if not paths:
        json.dump({"frames": []}, sys.stdout)
        return 0

    try:
        detector = cv2.FaceDetectorYN.create(model_path, "", (320, 320), MIN_SCORE, 0.3, 5000)
    except Exception as exc:
        print(f"could not load the face model: {exc}", file=sys.stderr)
        return 4

    frames = []
    for path in paths:
        faces = []
        try:
            image = cv2.imread(path)
            if image is not None:
                height, width = image.shape[:2]
                # YuNet must be told each frame's size before detect().
                detector.setInputSize((width, height))
                _, found = detector.detect(image)
                for face in found if found is not None else []:
                    x, y, w, h = (float(v) for v in face[:4])
                    score = float(face[-1])
                    if score < MIN_SCORE:
                        continue
                    faces.append(
                        {"x": x, "y": y, "w": w, "h": h, "score": score, "frameWidth": width, "frameHeight": height}
                    )
        except Exception:
            # A single unreadable frame must not sink the whole clip.
            faces = []
        frames.append({"path": path, "faces": faces})

    json.dump({"frames": frames}, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
