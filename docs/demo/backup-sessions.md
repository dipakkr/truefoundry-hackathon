# Backup sessions for stage

Open at http://localhost:8790 (TrueForge → Sessions), or in the trace viewer at http://localhost:8795.

| Tab | What it shows | Session |
|---|---|---|
| 3 | Allow path: rehearsal fail → fix → pass → approved → committed and verified (171 s to card) | `01m3dergfcbcs907wq1q2h3dqz` |
| 3b | Deny path: approval denied, prod verified unchanged (173 s to card) | `01m3dejv77v888aey93547jfsn` |
| 4 | Naive agent: `DROP TABLE orders`, human Allow → `POLICY_REFUSED` | `01m3d9cp714fqr8s9ks6pvme84` |
| – | First passing run (144 s to card) | `01m3db7zfpwm94kjtet5rqtw6c` |

These live in the local TrueForge database on the demo laptop. Don't wipe its data dir before the demo.
