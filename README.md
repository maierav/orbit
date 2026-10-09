# ORBIT — Object Recognition: Browser-based Implicit Test

A feasibility prototype for measuring object-recognition ability without an overt response, using an
ordinary webcam or phone camera. It runs entirely in the browser: video is processed on the device and
never stored or transmitted; only numeric gaze and pupil time series are kept, and only if you download them.

**Live:** https://maierav.github.io/orbit/ (add `?sim=1` for a no-camera simulation)

## Using it
Four pages: Welcome, Set up, Tests, Results. On Set up, two eye icons turn green when each eye is being
measured; the camera image, eye close-ups, eye position and pupil traces are optional views. The camera can
be stopped at any time. "Units and distance" calibrates the screen scale (bank card) and viewing distance so
gaze is reported in degrees of visual angle.

Works in current Chrome, Safari, Firefox and Edge, including Safari on iPhone and iPad ("Add to Home Screen"
gives a full-screen app). On a Mac, an iPhone can serve as a higher-resolution eye camera through Continuity
Camera: pick it in the Camera menu.

## Tests
- **Gaze calibration** — a target at five positions.
- **Light-reflex check** — bright flashes; gives the pupil noise floor of the device.
- **Novelty preference** — the same picture on both sides, a blank, then that picture beside a new one.
- **Object novelty** — two views of one object, a blank, then a third view of it beside a different object.
- **Odd one out** — three matching shapes and one different, graded dissimilarity, scored by screen half.
- **Pupil oddball** — a repeated picture with rare changes.

An ADULT / INFANT toggle switches pacing, attention getters and trial counts.

## Stimuli
`stimuli/set1` is a generated set of novel objects (no third-party images): 96 objects from three families,
paired within family, on full-screen low-contrast 1/f noise, equalised within pair on gray-level histogram
and spatial-frequency amplitude (after the SHINE toolbox, Willenbockel et al. 2010; our own implementation).
Forms A and B present the same pairs in the same fixed order and differ only in which object is familiar.
The pipeline is in `tools/`:
1. `make_objects.py` — Blender (4.5) generator and renderer; objects are small parameter dictionaries, and
   each base object has variants along a line in parameter space for graded similarity;
2. `build_set.py` — sizing by projected area, pairing, noise backgrounds, matching, fixed trial forms;
3. `image_stats.py`, `shine_match.py` — image statistics, salience balance and the matching operations.

## Status
Research prototype, not a validated instrument. Left/right gaze works on a 720p laptop webcam; pupil size
needs more pixels on the iris than such a webcam gives. The built-in shapes are placeholders.

## Run locally
`python3 serve.py`, then open http://127.0.0.1:8765. Camera access needs HTTPS or localhost.

Face tracking uses MediaPipe Face Landmarker (pinned version, loaded from a CDN).
