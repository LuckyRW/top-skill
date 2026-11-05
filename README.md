# Top Skill

oss!idle add-on. After every map your character finishes, it looks at the XP each skill earned from that play and adds +1 to the skill that earned the most. Press **Ctrl+Shift+K** to show the counters; **Clear all** zeroes them.

- Source: the game's local `score_xp` table (per-skill XP of each play), polled every 3 s. Plays from before the add-on was first enabled are not counted.
- Ties: every tied skill gets +1.
- Counters live in localStorage, so they survive closing the overlay and restarting the game.

```
npm ci
npm run verify   # typecheck, tests, build -> dist/top-skill.js
```
