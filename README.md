# soundGlitch

Microphone in, strange visuals out. A WebGL2 feedback engine driven by a Web
Audio analyser: twenty shader modes, twelve palettes, three blendable layers,
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
- DYNAMICS makes soft sound calmer. The analyser auto-gains everything so
  the shaders always get a full-range signal; DYNAMICS scales that back by
  how loud the room actually is, measured in dB against the loudest passage
  heard in the last minute or two (the LOUD meter shows it). At 0% a whisper
  drives the visuals as hard as a drop; at 100% the reaction, the drift
  speed, the corruption and the auto-cycle rate all follow the loudness.
  The reference forgets slowly, about 30 dB over 75 s, so a quiet song after
  a loud one stays calm, and a quiet set calibrates itself within a minute.
- MUSIC section. The analyser also tracks per-band onsets (kick, snare,
  hat), bars and 8-bar phrases with a downbeat estimate, build-ups and
  drops, the key and a 12-class chroma, dominant pitch, spectral centroid
  (brightness), flatness (noisiness), harmonic-versus-percussive balance,
  stereo width and pan, silence, envelope punch and transient sharpness,
  plus a two-second spectrum history. The readouts show key, bar and
  phrase, and the flags light on kick, snare, hat, bar line and drop.
  - MUSIC is how much those mappings apply. Globally: kicks pump a zoom,
    snares tear blocks, hats glint, drops flash and slam the chroma split,
    builds tighten the vignette and drain colour, noisiness adds grain,
    brightness sharpens pixelation, pan tilts the chroma split and stereo
    width skews the kaleidoscope, percussive passages shorten trails,
    harmonic ones lengthen them, and silence fades to black. Every mode
    also has its own hooks, for example RIPPLE shockwaves on kicks, HEX and
    GLYPH flip on snares, RADAR blips brighten on hats, ORACLE changes its
    segments per bar, REACT's regime follows brightness, FLARE colours by
    pitch, RIDGE scrolls with pan.
  - KEY shifts every palette by the song's key, so a track in E is a
    different colour from one in B flat and chord changes move the hues.
  - LOCK ties the drift speed of the shaders to the tempo (120 BPM is 1x)
    when the tracker is confident, so motion runs at the music's rate.
  - WATERFALL and CHROMA are modes built directly on the history texture
    and the pitch classes.
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
- RANDOM rerolls the mode, palette, both variation seeds, CORRUPT, DECAY,
  SENS, CYCLE, the FX section, and half the time adds a second layer with
  its own blend and palette (SENS stays within a sane 0.7x to 2.2x). It
  avoids the last six modes and five palettes so runs don't repeat. FADE
  and auto-cycle are left alone.
- VARY (`v`) rerolls only the variation seeds: same modes, new structure.
- Locks: the padlock beside every setting excludes it from RANDOM, RANDOM
  CYCLE and VARY. FADE, FOCUS, DYNAMICS and the source placement start
  locked; unlock them and they get rolled too (FADE between 0.5 and 6 s,
  DYNAMICS 20% to 100%, the source only when one is loaded). LOCK ALL and
  UNLOCK ALL sit next to VARY. RES has no lock because changing the render
  size clears the buffers, which would never be smooth. Locks persist.
- Every change crossfades. Mode, seed, palette, layer B on/off, blend mode
  and mirror all blend over the fade time; the continuous sliders glide;
  hue takes the short way round the wheel. The default FADE is 4 s; turn
  it up for slower morphs.
- Variation seeds: every mode reads four random numbers that change its
  structure, not just its motion. Grid sizes, ring radii, string counts,
  kaleidoscope segments, scroll direction, sweep direction, lissajous
  frequencies, voronoi scale, the reaction-diffusion regime, and the time
  phase all come from the seed, so one mode has thousands of distinct
  looks. Auto-cycle draws a fresh seed on every step. Seeds are saved with
  scenes, so a scene recalls the exact look.
- FX: MIRROR folds the output into a 2 to 8 way kaleidoscope, PIXEL
  quantises it, HUE rotates every colour, POSTER crushes it to a few
  levels. They stack with any mode, layer and palette. A MIRROR change
  from RANDOM, a scene or OSC crossfades the two folds over the fade
  time; the other three glide like the sliders. Dragging MIRROR by hand
  is immediate.
- Settings persist in localStorage.

## Layers B and C

The LAYER B and LAYER C rows each run another mode on their own feedback
buffers, with a blend dropdown (MIX, ADD, MULTIPLY, SCREEN, DIFFERENCE or
LIGHTEN) for compositing over what's below, and a palette dropdown (or
FOLLOW A to share the main one). C composites over A plus B. Every layer
crossfades on mode, seed and palette changes, fades its opacity when
switched on or off, and crossfades blend-mode changes. RANDOM adds layer B
half the time and layer C a third of the time.

## Source (logo / camera)

IMAGE loads a picture (or drop one anywhere on the page). CAMERA uses the
webcam. Two separate paths:

- OVERLAY draws the source clean on its own full-resolution canvas above
  the shader canvas. Nothing touches it: no mode, effect, mirror, pixelation,
  hue shift, kick zoom, drop flash, silence dim or render scale. It is
  exactly the file you loaded, at the opacity, size and position you set.
- BURN is the deliberate opposite: it feeds the source into the main layer's
  feedback every frame so the datamosh, melt or ink eats it. Leave it at 0
  for an untouched logo.

SIZE, X and Y place both. The source sliders are locked from randomization
by default. The image is remembered; the camera is not.

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
| `/sg/corrupt` `/sg/decay` `/sg/sens` `/sg/focus` `/sg/dynamics` `/sg/music` `/sg/keyColor` `/sg/lock` `/sg/fade` `/sg/res` `/sg/mirror` `/sg/pixel` `/sg/hue` `/sg/poster` `/sg/srcBurn` `/sg/srcOpacity` `/sg/srcSize` `/sg/srcX` `/sg/srcY` | f 0..1 | slider, as a fraction of its range |
| `/sg/vary` | | new variation seeds, same modes |
| `/sg/cycle` | i | beats between auto-cycle steps |
| `/sg/mode` | i | mode by index (0-based) |
| `/sg/fadeTo` | i f | mode by index with a one-off fade time in seconds |
| `/sg/next` `/sg/prev` | | step mode |
| `/sg/palette` | i | palette by index |
| `/sg/layer` | i | layer B mode, -1 for off |
| `/sg/blend` | i | blend mode 0..5 |
| `/sg/paletteB` | i | layer B palette, -1 to follow A |
| `/sg/layerC` `/sg/blendC` `/sg/paletteC` | i | same for layer C |
| `/sg/scene` | i or s | load a scene by index or name |
| `/sg/random` `/sg/clear` | | as the buttons |
| `/sg/auto` `/sg/cycleScenes` `/sg/randomCycle` | i | 1 on, 0 off (no arg toggles) |

## Keeping the screen awake

The page requests a Screen Wake Lock as soon as it loads (and again on the
first click, and whenever the tab becomes visible again). While it is held,
macOS will not start the screensaver or sleep the display. The status line
shows AWAKE when the lock is held. Both the controller and the stage output
hold their own lock, so the projector window stays on even if the laptop
lid panel is the one you're looking at.

Two things can still put the display to sleep: the tab being hidden (a
different app fullscreen on the same display releases the lock, which is
why the output should be the only thing on the projector) and a very low
"Turn display off" setting in macOS Battery or Lock Screen settings on a
browser that does not support the API. Chrome, Edge and Safari 16.4 and
later support it. The Desktop launcher also runs `caffeinate -d` for twelve
hours as a belt-and-braces measure; stop it early with
`pkill -f "caffeinate -d"`.

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
| WARP | domain-warped noise field, bass bends the warp, slow rotating feedback |
| GRID | perspective floor rushing past, columns lit by bands, waveform on the horizon, beat-lit tiles |
| HEX | hex cells pulsing to their own bands, inverting on beats |
| SPIRAL | log-spiral arms carrying the spectrum, feedback pulls inward or outward |
| GLYPH | a terminal of invented glyphs, each row typed by a band, rows invert on beats |
| FLARE | beat-spawned bursts with spokes on a starfield, outward feedback leaves expanding rings |
| RIDGE | stacked ridge lines, one per band, with the waveform running through them |
| WATERFALL | the last two seconds of spectrum as a waterfall, bar lines marching through it |
| CHROMA | twelve pitch-class wedges turning once per bar, the key glowing at the centre |

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
`hist(x, age)` (the spectrum up to two seconds ago), `chroma(pc)`,
`uLevel / uBass / uMid / uTreble / uBeat / uBeatCount`, `uKick / uSnare /
uHat` and their counts, `uBar / uBarPhase / uBeatTime / uPhrase /
uPhrasePhase / uDownbeat`, `uDrop / uBuild`, `uPitch / uKeyHue /
uChromaClarity`, `uCentroid / uFlat / uHarm / uPerc`, `uWidth / uPan`,
`uSilence / uPunch / uSharp`, `uMusic`, `uSeed`, `uCorrupt / uDecay / uSens`,
`palette(t)` and `hash21 / noise / sdSeg` helpers (see `AUDIO_UNIFORMS`). A mode may also
carry `sim`, a shader stepped eight times per frame on a half-float state
buffer readable as `uSim` (see REACT).

`window.sg` exposes `audio`, `engine`, `params`, `scenes`, `midi`, `link`,
`frame()`, `setMode()`, `loadScene()`, `act()` and `onOsc()` for poking from
the console.

## Deploy

Pushing to `main` runs `.github/workflows/deploy.yml`, which publishes
`index.html` and `js/` to GitHub Pages at https://thejrummer.art/soundGlitch/.
