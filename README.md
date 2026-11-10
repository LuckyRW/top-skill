# Top Skill

oss!idle add-on. After every map your character finishes, it adds +1 to the skill that earned the most XP from that play, and adds up the XP each skill earned. Press **Ctrl+Shift+K** to show the counters; **Clear all** zeroes them. Type a rate (or leave it empty / type `all` for every rate) and press **Export .xlsx** for a spreadsheet of the average XP per skill per map (all your plays of the current character, one row per map, rate and mod combination).

- Source: the game's local `score_xp` table (per-skill XP of each play), polled every 3 s. Plays from before the add-on was first enabled are not counted.
- Ties: every tied skill gets +1.
- Counters live in localStorage, so they survive closing the overlay and restarting the game.

```
npm ci
npm run verify   # typecheck, tests, build -> dist/top-skill.js
```
