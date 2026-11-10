# Flood Mod

A Mindustry mod that brings the spreading flood logic from the map "flood 55" to other maps.

## Features

- Red, blue, green, and purple flood teams
- Multiple spreading tiers and buildable Flood Seed blocks
- Force Projectors can hold back the flood
- Core-protection rules
- Damage effects around opposing flood blocks
- In-game settings and `/flood` chat commands

## Installation

1. Download the ZIP from the repository.
2. In Mindustry, open **Settings → Mods → Import Mod** (wording may vary by platform/version), or place the ZIP in the game's mods folder.
3. Restart or reload mods if requested.

## Commands

The mod's script documents these commands:

- `/flood stats`
- `/flood seed`
- `/flood team`
- `/flood corewar`
- `/flood on`
- `/flood off`

See the in-game **Flood** settings for configurable options.

## Compatibility

The current `mod.hjson` declares `minGameVersion: "146"`. Check that your Mindustry build meets this requirement.

## Credits

The metadata currently credits Makise for the original flood logic from the map "flood 55", ported to a mod. Please retain the original attribution when redistributing.

## Source layout

- `mod.hjson` — mod metadata
- `scripts/main.js` — flood behavior
- `content/blocks/` — Flood Seed block definitions
- `sprites/` — mod graphics
