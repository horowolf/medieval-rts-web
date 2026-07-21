# Build tools

The two playable files in this repository are generated:

```
node tools/build.mjs [path-to-development-source]
```

produces `index.html` (English) and `zh/index.html` (the original Chinese UI)
from one development source file. **Never edit the generated files** — the next
build overwrites them.

The development source is not in this repository. Running the build therefore
requires the private repository; the tools are here because the pipeline is part
of what this project is, and because the translation data has to live somewhere
reviewable.

## What the build does

**1. Comments.** The source carries years of Chinese design notes — dates,
measurements, arguments with earlier versions of itself. Structural comments
(section headers, function contracts, the reasoning behind a mechanism) are
replaced with an English rewrite from `i18n/comments-*.json`; everything else is
cut.

Those files are keyed by a hash of the original rather than by its text, so this
repository publishes the rewrites and never the private notes.

**2. Interface text.** Every Chinese string literal is swapped for English from
`i18n/strings-*.json`, keyed by the original text so a translation survives the
source moving around and only genuinely new text is reported as missing.

The unit of translation is a whole string literal, or one chunk of a template
literal between interpolations — not a word — so English is free to reorder
around the `{placeholders}`. A handful of one-character labels collide across
contexts (the stone resource and the siege ship are both `石`), so a key may be
qualified by the field name in front of it: `uc_siegeship:石`.

Markup is translated a whole line at a time. Substring replacement is
deliberately not used there: single-character labels also occur inside unrelated
words, and doing it the easy way turned `對戰` into `對GAL` the first time.

**3. Developer tools.** The debug overlay and the arena are hidden unless `?dev=1`
is set. They are hidden rather than removed, because the headless regression
suite drives them — deleting them would take the tests with it. The build fails
loudly if the elements it expects to gate have disappeared from the source.

## Why the source is parsed rather than pattern-matched

`lib/scan.mjs` is a small JavaScript lexer. Regexes are not safe on this file:
`/*` appears inside string literals, and `/` is ambiguous between division and
the start of a regex literal. The lexer tracks string literals, template
literals with nested interpolation, and regex literals disambiguated by the
preceding token, and reports the spans of comments and strings. Everything else
is a span rewrite.

## Verifying a build

```
node tools/verify-builds.mjs
```

drives both builds headlessly from the same seed with the AI running, and
compares a fingerprint of the entire world after 3,000 simulation ticks. If
translating the interface had touched any string the simulation itself compares,
the fingerprints would differ.

One caveat worth knowing, because it produced a false positive the first time:
the animation loop has to be frozen *before* the page's own script runs. Killing
it after load lets a variable number of frames tick first, which means the two
builds start from different worlds and diverge for reasons that have nothing to
do with the change being tested.

The regression suite is the other half of this: it runs unmodified against
`zh/index.html`, so the build is proven not to have altered behaviour at all
(559 assertions, 0 failures at the time of the last build).

## Updating after the source changes

Re-run the build. Existing translations are reused; anything new is reported:

```
34 UI string(s) have no English translation:
  "..."
```

Add them to the relevant `i18n/strings-*.json` and build again. For comments,
`REPORT_COMMENTS=/path/to/scratch.json` writes the untranslated ones — with
their hashes — somewhere outside this repository for review. `STRICT=1` makes
anything missing a non-zero exit, which is what CI would use.
