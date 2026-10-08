# HELLCREED: The Burning of Vellano

A third-person action game for the browser that mixes three games:

- **Assassin's Creed**: third-person free-running. Climb any wall, hang from ledges, leap between rooftops, cross beams, dive from viewpoints into hay carts, hide, and assassinate from the shadows. Stealth works through demon view cones, awareness meters, hearing, Ashen Sight (eagle vision), hiding in hay and sneaking.
- **Witcher 3**: sword combat with fast-attack combos and long lunges, strong attacks (hold for a charged *Rend*), block and timed parry into a counter-attack, dodge and roll with invulnerability frames, lock-on, five magic **Sigils** paid for with stamina, adrenaline (*Fury*), a hand crossbow and a healing tonic.
- **Modern Doom**: demons from Hell, wounded demons that stagger and glow, **Glory Kills** that burst into health orbs, burning demons that shed armor, arena fights behind walls of hellfire, and an aggressive, keep-moving loop.

You are the last blade of the Ashen Creed in Vellano, an Italian city in 1499. Hell has torn the sky open above its cathedral. Climb the five viewpoint towers to read the city, close the three **Hell Rifts**, then face **the Cardinal of Ash** in the Piazza del Duomo.

## Play

The easiest way: open **`dist/index.html`** in Chrome, Edge or Firefox. It is one self-contained file with the code and textures inlined, so you can double-click it with no server and no install.

**Online:** the workflow in `.github/workflows/pages.yml` builds the game and publishes it to GitHub Pages at <https://m1omg.github.io/AsasinsKridDum/> on every push. It needs Pages switched on once in the repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

To run from source:

```bash
npm install
npm run dev      # dev server with hot reload, then open the printed URL
npm run build    # writes the single-file game to dist/index.html
```

Play with a keyboard and mouse, a gamepad, or the on-screen [touch controls](#touch-controls) on a phone or tablet. With a mouse, click the game window to capture it. `Esc` pauses. Progress auto-saves at viewpoints, chests and rifts (stored in your browser's `localStorage`).

## Controls

Every control can be changed in the game (see [Changing controls](#changing-controls)). These are the defaults:

| Action | Keyboard & mouse | Gamepad |
|---|---|---|
| Move | `W A S D` or the arrow keys (both work) | Left stick |
| Camera | Mouse, or `J` `L` `I` `K` / numpad `4` `6` `8` `2` (left, right, up, down) | Right stick |
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
| Crossbow | `G` | D-pad up |
| Blood Tonic (heal) | `H` | D-pad down |
| Lock on target | Middle mouse / `Z` | R3 |
| Ashen Sight (see demons through walls) | `V` | View / Back |
| Map | `M` / `Tab` | Pause menu |
| Pause | `Esc` / `P` | Start |

The camera keys also help if mouse capture isn't available, for example inside an embedded frame.

### Touch controls
On a phone or tablet the game shows on-screen controls. It plays best with the screen sideways.

- **Move**: put your left thumb down anywhere in the lower left. The stick appears under it and follows your thumb; push it to the rim to run.
- **Look**: drag anywhere else on the screen.
- **Right thumb**, around **Attack**: **Jump** (climb, leap, roll in a fight), **Dodge**, **Block** (hold it, or tap it just before a strike lands to parry), **Interact**, **Heavy** (hold it to charge *Rend*), **Sigil**, **Crossbow** and **Lock** (tap again to switch target).
- **Interact** lights up and names what it will do: assassinate, Glory Kill, open a chest, hide in hay, synchronize, Leap of Faith. Tapping the prompt in the middle of the screen does the same.
- **Left thumb**, above the stick: **Sprint** and **Sneak** switch on and off with a tap (sprinting stops when you stop moving), and **Tonic** drinks a Blood Tonic.
- **Sight** (next to the minimap) switches Ashen Sight. Tap a Sigil icon to choose that Sigil, the minimap to open the map, and the emblem to pause.
- In **Settings**: **Touch controls** *Auto* (shown on touch screens; a key, mouse click or gamepad hides them until you touch the screen again), *On* or *Off*, plus **Touch look speed** and **Touch button size**.
- **Full screen** is in the title and pause menus where the browser allows it. Safari on iPhone doesn't let pages go full screen, but the game opens without the browser bars when you add it to the Home Screen.

### Changing controls
Open **Controls** from the title screen or from the pause menu (`Esc`), at any point in a game.

- Each action has three boxes: two for keys or mouse buttons, one for a gamepad button. Both keys work at the same time.
- To change one, click its box, or move to it with the arrow keys (or D-pad) and press `Enter` (or A). Then press the key, mouse button, mouse wheel direction or gamepad button you want. `Esc` cancels, and if you press nothing for 8 seconds the box stays as it was.
- To clear a box, right-click it, or select it and press `Delete` (or X on a gamepad).
- A key can do only one thing. If you give it to another action, it's removed from the old one and the screen tells you.
- **Reset to defaults** puts everything back. Changes save automatically in your browser.
- `Esc` always pauses and can't be reassigned. Menus always answer to the arrow keys, `Enter` and `Esc`, and to your own movement keys.
- Hints and on-screen prompts show the keys you've chosen.

**Hold or toggle.** At the top of the Controls screen you can choose how **Sprint**, **Block** and **Sneak** work:
- **Hold** (default for sprint and block): the action lasts while you hold the key.
- **Toggle** (default for sneak): one press switches it on and the next switches it off.
  - Toggled sprint also stops when you stop moving or start sneaking.
  - A toggled guard still parries if you raise it just before a hit, and lowers by itself when no demons are near.
  - With sprint on toggle, the strong-attack shortcut (sprint key + fast attack) works while you physically hold the sprint key. The strong attack key works as always.

### Climbing and free-running
- Hold **Shift** and run at a wall to run up it and start climbing. Climbing works on almost every wall. **W/A/S/D** or the arrow keys climb, **Space** does an upward leap, **S** (or Down) **+ Space** jumps off backwards, **A/D** (or Left/Right) **+ Space** leaps sideways, and **C** or **E** lets go. Climbing wraps around outer and inner corners.
- At a ledge, press **W** (or **Space**) to pull yourself up. Running into anything about chest-high makes you vault it.
- Sprinting off a roof edge leaps automatically to the next rooftop or beam (jumps are aim-assisted). If there's nowhere to land, you stop at the edge unless you press Space.
- Sloped roofs are solid the way they look. You keep your pace up and down a slope, and sprinting over a ridge carries you on down the far side to the eave before the automatic leap. The cathedral's dome is round: climb its drum, then scramble up the dome to the lantern. The corner towers' pointed roofs can be climbed to the top.
- Landing in **hay** cancels fall damage and hides you. Each synchronized viewpoint gives a **Leap of Faith** into the cart below it.

### Stealth
- A meter fills above a demon that can see you: **?** means suspicious, **!** means it has spotted you. Sneaking, staying on rooftops and keeping out of view cones slow it down. Sprinting and fighting are loud.
- Press **F** behind or beside an unaware demon, from a ledge above it, while hanging below it, or from inside a hay cart to **assassinate** it. Brutes survive a ground assassination with heavy damage, but not one from above.
- A crossbow bolt kills an unaware Thrall or Imp in one hit and does double damage to any other unaware demon. Snipe from the rooftops: the crossbow aims at demons far above or below you.

### Combat
- A demon flashes **yellow** before an attack you can parry. Tap block just before the hit to **parry**, which staggers it and triggers an automatic counter. **Red** attacks can't be blocked, so dodge or roll.
- Parried, knocked-down, dazed or badly wounded demons glow. Press **F** for a **Glory Kill**, which showers **health** orbs.
- **Burning** demons drop **armor shards**, and assassinated demons drop **crossbow bolts**.
- These drops are glowing orbs: green heal you, gold give armor and silver give crossbow bolts. Walk near one and it flies to you. If that resource is already full, the orb restores stamina instead.
- Sigils cost 50 stamina each:
  - **Pyre**: a cone of fire.
  - **Gust**: a force blast that knocks lesser demons down.
  - **Aegis**: a ward that absorbs a blow.
  - **Snare**: a glyph trap that slows demons. Cast it at a flying Gazer and it opens under the Gazer and drags it to the ground.
  - **Hex**: stuns a demon. A hexed Gazer sinks within sword reach.
- Brutes are armored from the front. Burn them, hit them from behind, or bait their charge into a wall to stun them.

### Difficulty
Choose **Easy**, **Medium** (the default) or **Hard** when you start a new game, and change it any time in **Settings**.

| | Easy | Medium | Hard |
|---|---|---|---|
| Damage you take | 35% | 60% | 100% |
| Damage you deal | 150% | 120% | 100% |
| Demons attacking at once | 1 melee, 1 ranged | 1 melee, 1 ranged | 2 melee, 2 ranged |
| Warning before a strike | 45% longer | 20% longer | normal |
| Time between a demon's attacks | 70% longer | 30% longer | normal |
| Parry window | 0.42 s | 0.34 s | 0.26 s |
| How fast demons notice you | 60% | 80% | 100% |

Hard is the game's original balance. Saves made before difficulty levels existed start on Medium.

Settings work from the keyboard or a gamepad: up and down pick a setting, left and right change it.

### Progression
Ashen Runes come from chests, viewpoints, closed rifts and every third hidden Creed Relic. Spend them in **The Creed** (pause menu) on health, sword damage, stamina, Sigil power, more crossbow bolts, an extra tonic and stealth.

## The demons

| Demon | Notes |
|---|---|
| Thrall | Possessed townsfolk that shamble in patrols. Weak, but they come in groups. |
| Imp | Climbs walls to reach you on rooftops and throws fireballs. Parry a fireball to throw it back. |
| Hellhound | Fast. Its pounce knocks you down, so parry or dodge it. |
| Gazer | Floating eye that fires homing orb volleys and a sweeping beam, out of sword reach. Shoot it down with the crossbow, or cast Snare or Hex at it, then finish it on the ground. |
| Brute | Armored. Its punches and ground slam hurt, and its charge stuns it if it hits a wall. |
| The Cardinal of Ash | The final boss. Has three phases: sweeps, stomp shockwaves (jump them), fire breath, a meteor rain, and summoned minions. When he kneels exhausted, press **F** to strike his heart. |

## How it's made

- **Engine**: [Three.js](https://threejs.org/) with custom systems: a collision world of boxes, slopes, pyramids, cylinders and domes in a spatial hash, a kinematic character controller, a nav grid with A* and a flow field, procedural animation, and particles. Post-processing adds bloom, color grading, and the Ashen Sight x-ray pass.
- **Refresh-rate independent**: game logic runs on a fixed 60 Hz timestep and rendering interpolates between steps. Input events carry timestamps and are applied on the step in which they happened, hit-stop and slow motion are timed in real time inside the frame, and all smoothing is exponential in real time. A scripted 20-second fight simulates bit-identically at 30, 60, 144 and 240 Hz and with uneven frame pacing, both from the keyboard and through the touch controls (whose buttons and timestamped stick positions feed the same input queue).
- **Procedural**:
  - The city: street grid, buildings with ledges and gable roofs, enterable houses with stairs and window openings, the cathedral, towers, beams and props.
  - Animation: every character is animated procedurally (gait, climbing, combat clips, recoils, death) on a small shared skeleton. Feet are planted with two-bone IK: a foot stays fixed on the ground while it carries weight, then swings to a foothold predicted from the character's velocity, so nobody glides. Footholds follow stairs and slopes, standing characters step their feet around when they turn, and the stride length matches each character's legs.
  - Climbing: the assassin's hands and feet rest on holds on the real surface of the wall, so they don't sink into it. That includes window frames, panes, shutters, sills, cornices and ledges, read from a map of the facades' decorations. A hand grips the top edge of a ledge when one is near. Holds stay put while the body moves, and the limbs take turns to reach for the next hold, hand over hand at the pace you climb. After a leap they reach for where you land. The body hugs the wall and stands out from it only as far as a sill or cornice behind it needs. All of this is visual: climbing itself works as before.
  - Audio: Web Audio SFX and adaptive music (dark ambient, stealth tension, Doom-style metal in combat, a boss track).
- **Generated assets ([Higgsfield](https://higgsfield.ai/))**:
  - 8 seamless material textures, a 360° hell-sky panorama (two halves) and the title key art. Normal maps, seamless tiling and the glowing-lava emissive map are derived locally by `tools/process_textures.py`.
  - 3D characters: the assassin, the five demon types and the Cardinal of Ash. Each started as a concept image (`gpt_image_2_5`), was turned into a textured mesh (`sam_3_3d` for the demons; `tripo_h3_1_image_to_3d` with detailed textures for the assassin, whose face needs the finer detail), then `tools/convert_character.mjs` rigged it for the game's skeletons and packed it into a small binary. `tools/process_character_textures.py` makes the textures, the glow maps (molten cracks, burning eyes) and a soft light on the assassin's face so it stays readable under his hood. The old primitive models remain in the code as a fallback.
  - Cost: about 31 Higgsfield credits in total: 3.5 for the textures, sky and title art (11 images), and 27.5 for the characters: 9 concept images at 0.5 and 9 SAM 3D conversions at 1 (the demons, two earlier assassins and a first try at the current one), and for the current assassin 2 high-resolution concept images at 1 and a Tripo conversion at 12.

### Project layout

```
index.html              page shell (canvas + UI root)
src/main.js             bootstrap
src/core/               loop (fixed timestep), input (KB/mouse/gamepad), audio, math, events
src/render/             renderer + post FX, materials, sky, particles/lights/trails, mesh builder
src/world/              collision world, procedural city, navigation grid
src/entities/           player controller + combat, rigs/models/animation, demons, projectiles
src/game/               game state, director (spawns, arenas, boss), camera, UI, touch controls, pickups, interactions
assets/textures/        processed Higgsfield textures (webp)
assets/models/          generated characters: rigged mesh (.bin), texture and glow map (webp)
tools/                  texture processing and character conversion scripts
```

### Graphics settings
Settings has Low, Medium and High graphics presets that change shadows, bloom, MSAA, resolution scale, particles and the number of dynamic lights. On slower or integrated GPUs, start with **Low**.
