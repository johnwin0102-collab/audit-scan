# vendor

`opencv.js` is OpenCV 4.10.0 compiled to WebAssembly, taken unmodified from the npm package
`@techstark/opencv-js@4.10.0-release.1`.

OpenCV is licensed under the Apache License, Version 2.0: https://opencv.org/license/

## ml/

- `doccornernet_lean.ort`: DocCornerNet LEAN page-corner model (MobileNetV2 + SimCC head, 224 x 224 input),
  from the npm package `scanic-ml@0.2.0` (MIT). Original model project: https://github.com/mapo80/DocCornerNet-CoordClass (MIT).
- `ort-wasm-simd-threaded.wasm` / `.mjs`: minimal ONNX Runtime Web build from `scanic-ml@0.2.0` (MIT; ONNX Runtime is MIT).
- `ort.min.js`: the ONNX Runtime Web JavaScript bundled by `scanic@1.7.1` (`dist/scanic-ort.wasm.min.js`, MIT).
- `LICENSE-scanic.txt`: scanic's MIT licence.
