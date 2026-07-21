# Architecture

The game is one HTML file. That is a deliberate choice, not an accident of
scale: the target was a design prototype complete enough to be an executable
specification, playable from `file://`, from a phone, or from static hosting,
with nothing between the reader and the code.

Inside, it is organised into numbered sections you can navigate by searching for
`====`:

| Section | What lives there |
|---|---|
| 0 | Seeded PRNG, fixed timestep — the determinism foundation |
| 0b | String table (no user-facing text is hard-coded past this point) |
| 1 | Constants: the map registry, unit table, building table, tech tree, civilisations |
| 2 | Map: terrain generation, forests, walkable regions |
| 3 | State: per-side resources, research, army groups, behaviour policies |
| 4 | Pathfinding: A* over tiles, string-pulling, region checks |
| 5 | Fog of war: line of sight, danger maps, the intelligence gate |
| 6 | Economy: villagers, gathering, building, repair, fleeing |
| 7 | Military units: engagement, targeting, formations, projectiles |
| 7b | Garrisoning, transports |
| 8 | Buildings and projectiles |
| 8b | Scouts |
| 9 | AI: economy, fortifications, navy, military, the learned policy |
| 10 | Orders and production, including the AI command whitelist |
| 11 | Main loop |
| 12–13 | Rendering, camera, input |
| 15–16 | Audio, startup, save snapshots |

## The ideas the rest hangs off

### Determinism is a tool, not a feature

Fixed timestep, one seeded PRNG, no wall-clock reads and no
iteration-order-dependent decisions. The same seed replays the same game exactly.

This is what makes the project measurable. A balance question becomes an
experiment: run the matchup a hundred times headlessly and read the result. An AI
change becomes an A/B test against its own baseline. A regression becomes a
world-state fingerprint that differs.

It also constrains the code permanently. Every optimisation has to be proven
bit-identical — replacing the pathfinder's open set with a binary heap meant
reproducing the old linear scan's tie-breaking exactly, because otherwise every
measured baseline in the project would silently shift.

### Data tables, not branches

Units, buildings, research and civilisations are tables. Adding a unit means
adding a row: the formation system, the AI's threat weighting, the counter
relationships, the production panel and the tech gating all read the table.
The AI logic never names a concrete unit type — it works in roles (front,
ranged, mobile, siege, support) that the table assigns.

The same applies to civilisations: one shared tech tree plus a per-civilisation
enable/lock mask, with the AI's personality, counter weights and research
priorities as further columns.

### One intelligence gate

What a side can see, and what it remembers, is answered by exactly four
functions. Nothing reads the vision buffers directly.

This layer exists because of a bug that took weeks to find. An omniscience
shortcut for testing had been wired into the branches belonging to one side only
— harmless when that side was always the AI and the other always human, and
quietly decisive once the game could run AI against AI. One side played with
better information than the other, and it presented as an unexplained,
irreproducible bias in win rates.

### The AI plays the game, it does not run it

The rule-based AI acts only through a whitelist of the player's own commands,
parameterised by side. It cannot write to a unit's fields, teleport, or create
resources; placement, affordability, unlock, age and starvation checks apply to
it identically.

That constraint is load-bearing rather than decorative. It means an AI capability
the player lacks is a bug by definition — a per-unit garrison order was removed
for exactly that reason, since the player has no gesture for it. And it means the
game's systems really are complete: if the AI can play, the rules are sufficient.

Three layers run on separate clocks — economy (~2s), strategy (~10s), tactics
(~1.2s) — over a shared demand pool. Each domain proposes plans with a score;
plans enter a commitment set in score order; cheap ones reserve their cost
immediately, expensive ones open an income-fed savings bucket. Reservations bind
at the spending end, so an unrelated purchase cannot drain what a committed plan
is saving for.

### Difficulty is economic, never informational

Six tiers. Three are fair — same rules, same fog, same prices. Three are
handicapped, and the handicap is stated in the menu, generated from the same
table that applies it: a gathering multiplier and an upgrade allowance.

No tier ever sees through the fog. Army positions and composition always have to
be scouted. This is the line that keeps difficulty from becoming a lie, and it is
the reason the AI needed a real model of uncertainty rather than a peek.

## Testing

559 headless assertions drive the actual page through the Chrome DevTools
Protocol — the same file that ships, not an extracted module. They assert on
simulation behaviour rather than on the DOM: pathfinding results, fog
computations, combat arithmetic, the legality of AI commands, and the
determinism of save/load (a save, a reload, and 1,200 further ticks must produce
the same world fingerprint as never having saved at all, with a deliberate
sensitivity check proving the fingerprint would have noticed).

Alongside them sit purpose-built probes: an arena that runs equal-cost matchups
to convergence, an AI-versus-AI harness for win-rate baselines, and ablation
runs that disable one mechanism at a time to see whether it is actually doing
anything. The ablation scans taught their own lesson, which is now project
policy: a changed fingerprint proves a mechanism is live, but an unchanged one
proves nothing at all — it may simply mean the trajectory never exercised it.

## Building this repository

`index.html` and `zh/index.html` are generated. See
[../tools/README.md](../tools/README.md).
