# Top Skill

oss!idle add-on. After every map your character finishes, it adds +1 to the skill that earned the most XP from that play, and adds up the XP each skill earned. Press **Ctrl+Shift+K** to show the counters; **Clear all** zeroes them. Type a rate (or leave it empty / type `all` for every rate) and press **Export .xlsx** for a spreadsheet of the average XP per skill per map (plays of the current character since the last **Clear all**, or all of them if you never cleared; one row per map, rate and mod combination). Clearing never deletes anything from the game.

- Source: the game's local `score_xp` table (per-skill XP of each play), polled every 3 s. Plays from before the add-on was first enabled are not counted.
- Ties: every tied skill gets +1.
- Counters live in localStorage, so they survive closing the overlay and restarting the game.

```
npm ci
npm run verify   # typecheck, tests, build -> dist/top-skill.js
```

## The export's columns

- **Map time (s)**: the map's length at that rate. **Time per play**: that plus 3 s of autopilot between maps.
- **Avg XP** and **XP/s** for every skill, and in total. XP/s = average XP / time per play.
- **Strain before / after / drift (min)**: the add-on reads your strain (`fatigue.minutes` from the API's Get Own Data, as the signed-in player) when the play screen opens and again when the play's XP arrives, and averages the difference. Plays from before this version, as a guest, or offline have no strain reading.
