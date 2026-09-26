# Backup sessions for stage

Open at http://localhost:8790 (TrueForge → Sessions), or in the trace viewer at http://localhost:8795.

| Tab | What it shows | Session |
|---|---|---|
| 3 | Allow path (final version, 163 s to card): `01m3ebva01g7y0eef7wyexh4ka` · older Allow run: rehearsal fail → fix → pass → approved → committed and verified (171 s to card) | `01m3dergfcbcs907wq1q2h3dqz` |

| 3b | Deny path (final version), prod unchanged | `01m3ec0mxw1vq47n7phvg6xyvh` |
| 3c | CI-started run denied with a typed reason ("Not before the release freeze"), PR status flipped to ❌ | `01m3e84jyt7703nwarzj3sahe2` |

Removed on request: the saved Deny, first-pass and naive-refusal sessions. For those moments, run them live (naive refusal takes ~35 s) or use stage/backup-demo-full.mp4.

These live in the local TrueForge database on the demo laptop. Don't wipe its data dir before the demo.
