"""The app's AI page finder (DocCornerNet, vendor/ml/doccornernet_lean.ort) run in Python, as the app runs it:
the whole frame squeezed to 224 x 224, ImageNet normalisation, corners and a page score out."""
import math, os
import numpy as np, cv2, onnxruntime as ort

MODEL = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "vendor", "ml", "doccornernet_lean.ort")
_sess = None


def ml_detect(rgb):
    """rgb: H x W x 3 uint8 RGB. Returns (quad normalised [TL, TR, BR, BL], score 0..1)."""
    global _sess
    if _sess is None:
        _sess = ort.InferenceSession(MODEL, providers=["CPUExecutionProvider"])
    x = cv2.resize(rgb, (224, 224), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0
    x = (x - np.array([.485, .456, .406], np.float32)) / np.array([.229, .224, .225], np.float32)
    outs = _sess.run(None, {_sess.get_inputs()[0].name: x[None]})
    coords = score = None
    for o in outs:
        o = np.asarray(o).ravel()
        if o.size == 8: coords = o
        elif o.size == 1: score = 1 / (1 + math.exp(-float(o[0])))
    return [[float(coords[2 * i]), float(coords[2 * i + 1])] for i in range(4)], score
