# ORBIT — Object Recognition: Browser-based Implicit Test

A feasibility prototype for measuring object-recognition ability without an overt response, using an
ordinary webcam or phone camera. It runs entirely in the browser: video is processed on the device and
never stored or transmitted; only numeric gaze and pupil time series are kept, and only if you download them.

**Live:** https://maierav.github.io/orbit/ (add `?sim=1` for a no-camera simulation)

## Tasks
- **Gaze calibration** — centre / left / right targets.
- **Light-reflex check** — bright flashes; gives the pupil noise floor of the device.
- **Preferential looking** — familiarise with one object, then a new same-category vs. other-category pair.
- **Odd one out** — three matching shapes and one different, graded dissimilarity, scored by screen half.
- **Pupil oddball** — repeated object with rare same- or other-category deviants.

An ADULT / INFANT toggle switches pacing, attention getters and trial counts.

## Status
Research prototype, not a validated instrument. Left/right gaze works on a 720p laptop webcam; pupil size
needs more pixels on the iris than such a webcam gives. The built-in shapes are placeholders.

## Run locally
`python3 serve.py`, then open http://127.0.0.1:8765. Camera access needs HTTPS or localhost.

Face tracking uses MediaPipe Face Landmarker (pinned version, loaded from a CDN).
