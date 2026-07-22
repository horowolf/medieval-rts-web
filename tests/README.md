# Regression suite

```
node tests/headless-test.mjs
```

559 assertions, no dependencies, about five seconds. Node 22+ and a local
Chrome; on anything but macOS point `CHROME` at your binary:

```
CHROME=/usr/bin/google-chrome node tests/headless-test.mjs
```

## What it actually drives

Not a DOM snapshot test, and not a unit test of extracted modules — there are no
modules to extract. The harness launches Chrome, opens the real page over the
DevTools Protocol, and then does the one thing that makes the rest possible:

```js
await send('Page.addScriptToEvaluateOnNewDocument',
  { source: 'window.requestAnimationFrame=function(){return 0};' });
```

It replaces the animation loop **before the page's own script runs**, so not a
single frame ticks on its own. From that point the test is the clock: it calls
`step(TICK)` exactly as many times as it wants and reads the world back by
evaluating expressions in page scope, where `units`, `buildings`, `tags`, `UT`
and `step` are all reachable by name.

That is why the assertions can be about behaviour rather than pixels. A test can
say *this spearman engages the enemy it passes and does not walk on to its
waypoint*, run 150 ticks, and check where it stopped. Freezing the loop after
load instead would let a variable number of frames run first — same seed,
different world, and a suite that fails one run in five for reasons that have
nothing to do with the code.

## What is covered

Assertions are grouped in numbered blocks, printed as they run.

| | |
|---|---|
| Orders | attack-move engaging en route, guard relocation, per-unit engagement radius, sub-goals surviving a chase, mode switches clearing them |
| Combat | counter-picking, focus fire, kiting, formation by weapon reach, siege setup time, splash falloff, evasion, tower and castle garrison fire |
| Economy | gathering policies, carry capacity, farm and coppice regeneration, market price drift, starvation, upkeep, resource-node seat limits |
| Terrain & pathing | cliff crossing, ramps, forest line-of-sight tile by tile, gates as one-tile chokepoints, shore landing, transports |
| Fog of war | what each side may see, remembered buildings as ghosts, unit positions never persisting, no command-UI leaking enemy intent |
| Civilisations | one shared tech tree with per-civilisation masks, prerequisites, age gating, unique-unit production guards |
| AI | command legality (it acts only through the player's own command set), per-side brain isolation, difficulty knobs taking effect — including the declared handicaps arriving as real stock rather than a hidden multiplier — scouting and information decay, wave lifecycle and commitment scheduling |
| Saves | snapshot round-trip, pointer relinking, alias survival, and a determinism check: 1,200 ticks after saving must fingerprint identically to 1,200 ticks after loading |
| Maps | every map mirrored tile by tile, left half against right |

Two habits worth calling out, because they are what most of these assertions are
really made of:

**Causal controls.** A test that shows a mechanism firing also runs the same
scenario with the mechanism disabled, and asserts the outcome changes. A green
test that would be green with the feature deleted is not evidence.

**Sensitivity checks.** Where a test asserts two fingerprints match, it also
perturbs the input by one bit and asserts the fingerprint *differs*, so
"identical" cannot quietly mean "the fingerprint sees nothing".

## Why it runs against the Chinese build

`tests/headless-test.mjs` targets `zh/index.html`, and a number of assertions
read interface text back out of the page — a button's label, a panel heading —
in the original strings.

That is deliberate, and it is the point rather than a limitation: the suite is
the evidence that the publishing pipeline did not change the game. It exercises
a *built* file, not the development source it came from. `tools/verify-builds.mjs`
then covers the other half by fingerprinting both builds after 3,000 ticks.

Set `TARGET=index.html` to point it at the English build; the simulation
assertions pass, the handful that compare interface strings do not.

## This file is generated

Like the game itself, it is produced from the development source:

```
node tools/build-tests.mjs
```

which translates the test names and the design commentary and repoints the
target URL. Edits here are overwritten on the next build — see
[../tools/README.md](../tools/README.md).
