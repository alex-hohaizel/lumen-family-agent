# Local diagnostics

Run from the repository root with Node 24 and installed dependencies. `npm run build` prepares `dist/src` for browser, office, resource, and model diagnostics. `npm run build:test` prepares `.test-build/src` and `.test-build/test` for recall controls and the calendar sandbox. These tools are separate from the functional test suite.

```sh
node tools/diagnostics/recall-controls.mjs
node tools/diagnostics/browser-smoke.mjs
node tools/diagnostics/office-smoke.mjs
node tools/diagnostics/resource-pilot.mjs
python tools/diagnostics/resource-pilot.py
python -m pip install radicale
node tools/diagnostics/calendar-sandbox.mjs
```

Reports print to stdout. To retain JSON, add `--output-dir /path/outside/the/repository`. Temporary media, calendar storage, and test runtimes are removed when the tool finishes. The Python resource wrapper needs Linux `/proc`; its summed RSS can count shared pages more than once. The calendar sandbox starts its own loopback Radicale server and uses fixture credentials.

`node --test tools/diagnostics/*.test.mjs` checks output isolation, including symlinks and directories that do not exist yet.

The model benchmark requires explicit opt-in, a selected existing ChatGPT session directory, and model IDs available to that session. It makes live requests, may refresh session credentials, and checks synthetic plans without executing actions. `--help` and invocation without `--run` make no model requests; there are no default models or runtime credentials.

```sh
node tools/diagnostics/benchmark-models.mjs --run --runtime-dir /path/to/owned/session --model MODEL_ID --output-dir /external/reports
```
