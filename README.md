# HELLCREED: The Burning of Vellano

A third-person action game for the browser that mixes three games:

- **Assassin's Creed**: third-person free-running. Climb any wall, hang from ledges, leap between rooftops, cross beams, dive from viewpoints into hay carts, hide, and assassinate from the shadows. Stealth works through demon view cones, awareness meters, hearing, Ashen Sight (eagle vision), hiding in hay and sneaking.
- **Witcher 3**: sword combat with fast-attack combos and long lunges, strong attacks (hold for a charged *Rend*), block and timed parry into a counter-attack, dodge and roll with invulnerability frames, lock-on, five magic **Sigils** paid for with stamina, adrenaline (*Fury*), throwing knives and a healing tonic.
- **Modern Doom**: demons from Hell, wounded demons that stagger and glow, **Glory Kills** that burst into health orbs, burning demons that shed armor, arena fights behind walls of hellfire, and an aggressive, keep-moving loop.

You are the last blade of the Ashen Creed in Vellano, an Italian city in 1499. Hell has torn the sky open above its cathedral. Climb the five viewpoint towers to read the city, close the three **Hell Rifts**, then face **the Cardinal of Ash** in the Piazza del Duomo.

## Play

The easiest way: open **`dist/index.html`** in Chrome, Edge or Firefox. It is one self-contained file with the code and textures inlined, so you can double-click it with no server and no install.

To run from source:

```bash
npm install
npm run dev      # dev server with hot reload, then open the printed URL
npm run build    # writes the single-file game to dist/index.html
```

Click the game window to capture the mouse. `Esc` pauses. Progress auto-saves at viewpoints, chests and rifts (stored in your browser's `localStorage`).

## Controls

| Action | Keyboard & mouse | Gamepad |
|---|---|---|
| Move | `W A S D` | Left stick |
| Camera | Mouse | Right stick |
| Sprint / free-run (automatic rooftop leaps) | `Shift` (hold) | RT |
| Jump / climb / ledge leap | `Space` | A |
| Roll (sword drawn, demon close) | `Space` | A |
| Sneak | `C` | L3 |
| Fast attack (combo) | Left mouse | X |
| Strong attack (hold to charge *Rend*) | `R` or `Shift` + Left mouse | Y |
| Block (hold) / Parry (time it) | Right mouse | LT |
| Dodge | `E` | B |
| Cast Sigil | `Q` | RB |
| Select Sigil | `1`–`5` / mouse wheel | D-pad left/right |
| Assassinate / Glory Kill / Interact | `F` | LB |
| Throwing knife | `G` | D-pad up |
| Blood Tonic (heal) | `H` | D-pad down |
| Lock on target | Middle mouse / `Z` | R3 |
| Ashen Sight (see demons through walls) | `V` | View / Back |
| Map | `M` / `Tab` | Pause menu |
| Pause | `Esc` / `P` | Start |

Arrow keys turn the camera too. They help if mouse capture isn't available, for example inside an embedded frame.

### Climbing and free-running
- Hold **Shift** and run at a wall to run up it and start climbing. Climbing works on almost every wall. **W/A/S/D** climbs, **Space** does an upward leap, **S + Space** jumps off backwards, **A/D + Space** leaps sideways, and **C** or **E** lets go. Climbing wraps around outer and inner corners.
- At a ledge, press **W** (or **Space**) to pull yourself up. Running into anything about chest-high makes you vault it.
- Sprinting off a roof edge leaps automatically to the next rooftop or beam (jumps are aim-assisted). If there's nowhere to land, you stop at the edge unless you press Space.
- Landing in **hay** cancels fall damage and hides you. Each synchronized viewpoint gives a **Leap of Faith** into the cart below it.

### Stealth
- A meter fills above a demon that can see you: **?** means suspicious, **!** means it has spotted you. Sneaking, staying on rooftops and keeping out of view cones slow it down. Sprinting and fighting are loud.
- Press **F** behind or beside an unaware demon, from a ledge above it, while hanging below it, or from inside a hay cart to **assassinate** it. Brutes survive a ground assassination with heavy damage, but not one from above.
- Throwing knives kill unaware Thralls and Imps in one hit.

### Combat
- A demon flashes **yellow** before an attack you can parry. Tap block just before the hit to **parry**, which staggers it and triggers an automatic counter. **Red** attacks can't be blocked, so dodge or roll.
- Parried, knocked-down, dazed or badly wounded demons glow. Press **F** for a **Glory Kill**, which showers **health** orbs.
- **Burning** demons drop **armor shards**, and assassinated demons drop **knives**.
- Sigils cost 50 stamina each:
  - **Pyre**: a cone of fire.
  - **Gust**: a force blast that knocks lesser demons down.
  - **Aegis**: a ward that absorbs a blow.
  - **Snare**: a glyph trap that slows demons and drags flying Gazers to the ground.
  - **Hex**: stuns a demon.
- Brutes are armored from the front. Burn them, hit them from behind, or bait their charge into a wall to stun them.

### Progression
Ashen Runes come from chests, viewpoints, closed rifts and every third hidden Creed Relic. Spend them in **The Creed** (pause menu) on health, sword damage, stamina, Sigil power, more knives, an extra tonic and stealth.

## The demons

| Demon | Notes |
|---|---|
| Thrall | Possessed townsfolk that shamble in patrols. Weak, but they come in groups. |
| Imp | Climbs walls to reach you on rooftops and throws fireballs. Parry a fireball to throw it back. |
| Hellhound | Fast. Its pounce knocks you down, so parry or dodge it. |
| Gazer | Floating eye that fires homing orb volleys and a sweeping beam. Snare drags it down where it's vulnerable. |
| Brute | Armored. Its punches and ground slam hurt, and its charge stuns it if it hits a wall. |
| The Cardinal of Ash | The final boss. Has three phases: sweeps, stomp shockwaves (jump them), fire breath, a meteor rain, and summoned minions. When he kneels exhausted, press **F** to strike his heart. |

## How it's made

- **Engine**: [Three.js](https://threejs.org/) with custom systems: an AABB/slope collision world with a spatial hash, a kinematic character controller, a nav grid with A* and a flow field, procedural animation, and particles. Post-processing adds bloom, color grading, and the Ashen Sight x-ray pass.
- **Refresh-rate independent**: game logic runs on a fixed 60 Hz timestep. Rendering interpolates between steps, and all smoothing is exponential in real time. 60, 144 and 240 Hz displays play identically.
- **Procedural everything else**:
  - The city: street grid, buildings with ledges and gable roofs, enterable houses with stairs and window openings, the cathedral, towers, beams and props.
  - Characters and demons: primitives skinned to bones in a single mesh each, with procedural animation.
  - Audio: Web Audio SFX and adaptive music (dark ambient, stealth tension, Doom-style metal in combat, a boss track).
- **Generated assets ([Higgsfield](https://higgsfield.ai/))**: 8 seamless material textures, a 360° hell-sky panorama (two halves) and the title key art. Normal maps, seamless tiling and the glowing-lava emissive map are derived locally by `tools/process_textures.py`. Total cost was about 3.5 Higgsfield credits: 11 images at 0.25–0.5 credits each with the `gpt_image_2_5` model.

### Project layout

```
index.html              page shell (canvas + UI root)
src/main.js             bootstrap
src/core/               loop (fixed timestep), input (KB/mouse/gamepad), audio, math, events
src/render/             renderer + post FX, materials, sky, particles/lights/trails, mesh builder
src/world/              collision world, procedural city, navigation grid
src/entities/           player controller + combat, rigs/models/animation, demons, projectiles
src/game/               game state, director (spawns, arenas, boss), camera, UI, pickups, interactions
assets/textures/        processed Higgsfield textures (webp)
tools/                  texture processing script
```

### Graphics settings
Settings has Low, Medium and High graphics presets that change shadows, bloom, MSAA, resolution scale, particles and the number of dynamic lights. On slower or integrated GPUs, start with **Low**.
