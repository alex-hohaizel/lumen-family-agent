# Scene-specific recipe API

`recipe_engine.py` and its support `repair.py` belong to specialist.animation.
Recipe authors write only `recipes-proposed/author_a/` or
`recipes-proposed/author_b/`, plus source-review notes and exact decoded PNG
inputs in that same namespace. They must not edit the engine, staging script,
approved records, canonical media, or other authors' recipes.

The complete accepted local-mesh examples are
`approved-recipes/lumen_94-rig2.json` and
`approved-recipes/lumen_113-rig2.json`. Their approval is item-specific and only
covers the recorded frame/scene scope. It does not approve another recipe.

Run from the repository root:

```bash
python sticker-lab/production-v5/recipe_engine.py RECIPE.json EMPTY_ISOLATED_OUTPUT_DIR
```

The CLI accepts `--no-encode` for RGBA work and `--repo-root /absolute/repo` for
portable use. It refuses writes under `assets/` and nonempty output directories.
It verifies every input PNG hash and the derived bundle before rendering. It
does not read canonical WEBM, infer approval, stage, upload, or publish.

Every recipe has `schema_version: 1`, item `id`, `candidate_id`, honest
`source_provenance.kind: derived_decoded_video`, exact source-video SHA, separate
unrecovered ancestor atlas SHA, `source_frames`, `description_uk`, `semantics`,
`output`, and one of these engine modes:

| Mode | Required scene-specific fields | Eligible action |
| --- | --- | --- |
| `shared_local_mesh_v1` | `local_mesh.source_frame`, common `points_xy`, named `parts` with matching `displacement_xy_px`, each part's explicit waveform, `minimum_jacobian` | Bounded anatomical acting over one clean pose; independently pinned objects and limbs |
| `curated_shared_flow_v1` | `temporal_edit.source_order`, `action_output_frames`, `closure_output_frames`, `local_flow_limit_px` | Curated compatible actual poses with justified reversible body action or forward causal order |

Waveforms are `sin` with `repeats`, or `periodic_cubic_pulse` with `times`,
`values`, `repeats`, and optional `amplitude_modulation: {base, cosine}`.
`points_xy` are observed pixels on the 512px source. All RGBA channels use one
spatial map in premultiplied space. A positive Jacobian is numerical evidence,
not anatomical or expressive acceptance.

`source_frames` are sorted records `{index, timestamp_seconds, path, sha256}`.
The bundle hash is SHA256 of the ASCII concatenation of those exact PNG SHA256
hex strings, in source-index order. Paths are repository-relative. A derived
bundle must never be labelled an original keypose sheet. Ancestor original
hashes remain separate even when the original atlas cannot be recovered.

`output` currently requires 512x512, 84 frames, 30fps, 2.8s, VP9 alpha, no audio,
and explicit `crf`. The engine rejects output over 262144 bytes. The final CRF
must be selected by actual visual review and byte count, not assumed quality.

`expected` may contain all pre-encode RGBA PNG hashes, all final decoded PNG
hashes, and original output SHA/bytes. When provided, every rendered frame must
match; WEBM container byte equality is reported separately because muxer UIDs
can differ while the decoded frames match.

For every proposed item, notes must identify the independently upheld defect,
the exact clean source frame(s) visually inspected, retained unique emoji/core
scene, local part trajectories, object ownership/contact, loop closure, and any
omitted optional phase. Do not reverse falling objects, fluid, confetti, or
other irreversible action. Do not fit a rig to already doubled anatomy, conceal
loss of scene meaning, substitute a global canvas bob, or apply one generic
animation across unrelated scenes. Baked source defects require escalation.

The author reviews every final decoded frame and relevant native512 risks, then
freezes output/proof/recipe/generator hashes for independent per-item QA.
Native realtime, slow and device playback remain pending until actually
observed. Only an explicit approved item record can enter `stage.py`.
