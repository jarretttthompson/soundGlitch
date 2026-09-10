# soundGlitch

Microphone in, strange visuals out. A WebGL2 feedback engine driven by a Web
Audio analyser: thirteen shader modes, twelve palettes, two blendable layers,
a logo or camera source, scenes, MIDI learn, OSC, and a pop-out output window.
No build step. The only dependency is `ws` for the optional OSC bridge.

Live: https://thejrummer.art/soundGlitch/

## Run locally

```bash
python3 serve.py            # http://localhost:8412
```

Any static server works, but `serve.py` sends no-cache headers so edits show
up on reload. Mic access needs `localhost` or `https`. There is a Desktop
launcher, `SoundGlitch.app`, which runs `scripts/launch.sh`.

## Input

- START MIC uses the selected input device (the dropdown lists every input
  once the browser has mic permission; the choice is remembered).
- SYSTEM AUDIO asks to share a tab or screen and keeps only its audio, so you
  can feed Spotify or a DAW without a cable. Tick "share audio" in the picker.
- TEST SIGNAL runs a silent synthetic kick / sweep / noise pattern into the
  analyser for hacking on shaders without making noise.

The analyser auto-gains everything with a slow noise-floor tracker, so a
quiet laptop mic drives the shaders as hard as a loud source. Give it a few
seconds after starting to settle.

## Controls

- Keys: `1`-`9` and `0` pick the first ten modes, `space` or the arrow keys
  step through all of them, `shift+1`-`9` loads a scene, `p` palette, `a`
  auto-cycle, `[` / `]` slower or faster auto-cycle, `m` mic, `t` test
  signal, `r` randomize, `c` clear the feedback buffer, `f` fullscreen, `h`
  hide the panel. The panel also hides itself after a few seconds without
  mouse movement.
- CORRUPT scales the block tears, chroma splits, inversions and dropouts.
  DECAY is how long the previous frame persists (0% = short trails, 100% =
  very long). SENS multiplies the analysed level and bands and boosts the
  spectrum texture.
- FOCUS is music focus: a speech-versus-music detector (tempo confidence
  plus sub-bass presence) ducks the reaction during announcements. 0% does
  nothing, 100% goes almost still when someone talks between songs.
- FADE is the crossfade length for mode and palette changes, 0 (hard cut)
  to 10 s. During a mode fade the outgoing mode keeps running on its own
  buffers and the post pass mixes the two; palettes blend inside the shaders.
- CYCLE sets how many beats auto-cycle waits between modes (1 to 64). When
  no beats are detected it falls back to a timer of about three quarters of
  a second per beat. When the tempo tracker is confident, the switch is held
  until the next predicted beat so changes land on the grid.
- CYCLE SCENES makes auto-cycle walk the saved scenes in order instead of
  the mode list. RANDOM CYCLE rerolls everything on each step instead.
  Either one switches AUTO CYCLE on; AUTO CYCLE off stops all of them.
- Every transition (mode change, scene load, random) uses the current FADE:
  mode and palette crossfade in the engine, and the sliders glide from their
  old values to the new ones over the same time. Touching a slider during a
  glide takes it over. FADE itself is never changed by a scene load's
  transition or by randomization.
- RES is the render scale. 70% is the default; a big TV or a slow laptop
  may want it lower, a 4K output can go higher.
- RANDOM rerolls the mode, palette, CORRUPT, DECAY, SENS, CYCLE and
  sometimes adds a second layer (SENS stays within a sane 0.7x to 2.2x).
  FADE and auto-cycle are left alone.
- Settings persist in localStorage.

## Layer B

The LAYER B dropdown runs a second mode on its own feedback buffers, and the
blend dropdown composites it over the main layer: MIX, ADD, MULTIPLY, SCREEN,
DIFFERENCE or LIGHTEN. The third dropdown gives layer B its own palette, or
FOLLOW A to share the main one. Both layers crossfade on mode and palette
changes.

## Source (logo / camera)

IMAGE loads a picture (or drop one anywhere on the page). CAMERA uses the
webcam. BURN injects the source into the main layer's feedback every frame,
so the datamosh, melt or ink eats it. OVERLAY draws it clean on top. SIZE, X
and Y place it. The image is remembered; the camera is not.

## Scenes

SAVE SCENE snapshots the current look under a name (mode, palette, sliders,
layer B, source placement). Click a scene to load it with the current FADE,
`shift+1`-`9` for the first nine, the small cross deletes. EXPORT writes all
scenes to a JSON file and IMPORT merges one in, so a set can be handed to
someone else.

## MIDI

MIDI asks the browser for Web MIDI access (Chrome and Edge). LEARN then turns
every slider, button, mode, palette and scene into a target: click one, then
move a knob or hit a pad, and it is mapped. Knobs on a CC drive sliders across
their full range; pads (notes, or a CC crossing half) fire buttons. The LAYER
B and blend dropdowns map to a CC that sweeps through their options. Mappings
persist; CLEAR MAP forgets them all.

## OSC

Browsers cannot receive UDP, so `bridge.js` does: it listens for OSC and
forwards each message to the page over a WebSocket.

```bash
npm install
npm run bridge              # OSC udp :8413 -> ws :8414
```

Then switch on OSC BRIDGE in the panel. Addresses:

| address | args | effect |
|---------|------|--------|
| `/sg/corrupt` `/sg/decay` `/sg/sens` `/sg/focus` `/sg/fade` `/sg/res` `/sg/srcBurn` `/sg/srcOpacity` `/sg/srcSize` `/sg/srcX` `/sg/srcY` | f 0..1 | slider, as a fraction of its range |
| `/sg/cycle` | i | beats between auto-cycle steps |
| `/sg/mode` | i | mode by index (0-based) |
| `/sg/fadeTo` | i f | mode by index with a one-off fade time in seconds |
| `/sg/next` `/sg/prev` | | step mode |
| `/sg/palette` | i | palette by index |
| `/sg/layer` | i | layer B mode, -1 for off |
| `/sg/blend` | i | blend mode 0..5 |
| `/sg/paletteB` | i | layer B palette, -1 to follow A |
| `/sg/scene` | i or s | load a scene by index or name |
| `/sg/random` `/sg/clear` | | as the buttons |
| `/sg/auto` `/sg/cycleScenes` `/sg/randomCycle` | i | 1 on, 0 off (no arg toggles) |

## Stage output

STAGE OUTPUT opens a second window showing only the visuals. Drag it to the
projector or TV and press `f` there for fullscreen. The controller window
keeps the panel and the microphone; it mirrors every setting, the analysed
audio and the loaded image to the output over a BroadcastChannel, so only one
window needs mic permission. Any number of outputs can be open. The camera
source is local to the controller.

## Modes

| mode | what it does |
|------|--------------|
| MOSH | datamosh feedback: macroblocks tear on beats, curl flow, waveform ring |
| SLIT | spectral slit-scan scrolling right to left, rows shear with bass |
| ORACLE | kaleidoscoped lissajous curve deformed by the waveform, rotating feedback |
| BITRUPT | XOR cell logic; each row listens to one frequency band, rows byte-shift on beats |
| VOID | spectrum tunnel, bass pushes the walls, beats zoom the feedback |
| VHS | stacked oscilloscope rows of the waveform, tracking wobble, chroma bleed, static and dropout lines |
| MELT | pixel-sort drip: bright pixels sink, the spectrum is poured in along the top edge |
| RIPPLE | rings refract the previous frame, beats throw an expanding shockwave |
| STRINGS | fourteen strings, each tuned to a band, plucked by the waveform |
| RADAR | sweeping beam reveals a polar spectrum with phosphor afterglow |
| SHATTER | voronoi shards, each listening to its own band, shoving the frame on beats |
| INK | marbling: curl-noise fluid with two pens that follow the sound |
| REACT | Gray-Scott reaction-diffusion in its own state buffer; bass feeds growth, the waveform seeds it |

Palettes: SPECTRUM, ACID, PHOSPHOR, HEAT, BRUISE, STROBE, VAPOR, ICE, AMBER,
TOXIC, BLOOD, CGA.

## Layout

```
index.html      panel + canvas (add ?output for a bare output window)
js/audio.js     AudioIn: mic / system / test / remote, auto-gain, bands, beat,
                tempo tracker (autocorrelation + phase), music focus, 512x2 texture
js/shaders.js   COMMON prelude, MODES[] (src + optional sim), SIM_PRELUDE, SOURCE, MIX, POST
js/engine.js    WebGL2 layers with ping-pong + crossfade buffers, sim buffers,
                source injection, post blend, probe() for debugging
js/app.js       UI, params, scenes, keys, MIDI/OSC actions, auto-cycle, loop
js/midi.js      Web MIDI with learn-mode mapping
js/scenes.js    scene store + JSON export/import
js/link.js      BroadcastChannel mirror + WebSocket to bridge.js
bridge.js       OSC udp -> WebSocket (node, needs ws)
serve.py        no-cache static server
scripts/        launch.sh for the Desktop launcher
```

Add a mode by pushing `{ name, blurb, src }` to `MODES` in `js/shaders.js`.
The fragment body has `uPrev` (last frame), `spec(x)` (0..1 spectrum, x = 0
is DC, 0.5 is roughly 11 kHz), `wav(x)` (-1..1 auto-gained waveform),
`uLevel / uBass / uMid / uTreble / uBeat / uBeatCount`, `uCorrupt / uDecay /
uSens`, `palette(t)` and `hash21 / noise / sdSeg` helpers. A mode may also
carry `sim`, a shader stepped eight times per frame on a half-float state
buffer readable as `uSim` (see REACT).

`window.sg` exposes `audio`, `engine`, `params`, `scenes`, `midi`, `link`,
`frame()`, `setMode()`, `loadScene()`, `act()` and `onOsc()` for poking from
the console.

## Deploy

Pushing to `main` runs `.github/workflows/deploy.yml`, which publishes
`index.html` and `js/` to GitHub Pages at https://thejrummer.art/soundGlitch/.
