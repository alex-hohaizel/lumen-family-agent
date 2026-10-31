# Final 1.13 integration — Motion5 contract addendum

This is the current integration guide for the prepared 1.13 artwork. The earlier
`MOTION5_CONTRACT.md` remains an immutable historical description of the first
`approved-rig2.json` trial. Its statements that the complete schema has only
`derived_decoded_video`, or that rig2 is the only approval record, describe that
trial. They are **not** an exhaustive description of the final 71 repairs.

The final manifest has 67 derived-source repairs, two generated corrected-anchor
repairs and two generated component-layer repairs. Each item has its own explicit
approval record, exact candidate/output/proof/recipe and independent QA binding.
No approval of one item permits staging another one. All 120 IDs, emoji, scenes
and order remain; all 50 legacy sticker/preview pairs stay bytewise unchanged.

| Source kind | Actual inputs and bundle |
|---|---|
| `derived_decoded_video` | Archived exact pre-repair WEBM; selected decoded PNGs with original index0–83 and timestamp index/30. Bundle is SHA256 of the ASCII concatenation of PNG SHA strings sorted by frame index. |
| `generated_corrected_anchor` | Preserved actual baseline target frame and identity reference, literal prompts/input chain, actual imagegen raw output with its measured dimensions and a512px animation anchor. Anchors are generated edits, with no original video timestamp. Bundle sorts anchor SHA strings by key. |
| `generated_layer_components` | Preserved actual raw imagegen outputs, literal operation prompts and actual inputs; stable `generation.input_references` maps every input SHA to an archived path. Variable-size component PNGs are exact declared rectangular crops, without resizing or padding. Generated anchors have no original-frame index/timestamp. Bundle sorts component SHA strings by key. |

Every new bundle remains distinct from the unrecovered original-keypose ancestor
hash in `previous_source_keyposes_sha256`. A derived frame, corrected image or
component atlas must never be described as a recovered original animation atlas.
Generated metadata/history corrections identify the changed declaration and
preserve prior metadata rather than silently rewriting the tool history.

`repair_provenance` identifies the stable source, recipe, generator/support and
original snapshots, immutable accepted proof, exact independent QA artifact and
actual reviewer/scope. Hash-bound source-contract descriptions are allowed when
the original recipe lacks a description; the field must actually exist in the
bound artifact. Normal/slowed review-copy receipts are mapped by the final
`docs/qa-1-13/portable-review-video-index-71.json`; an unavailable historical scratch
path is not a claim that its copy was newly reviewed. Superseding review files
require their own explicit independent closure.

For a fresh replay, use the item's pinned `repair.generator.engine_path` with its
`repair.recipe_path` and a new empty output directory. Both current scene engines
and the explicit layer renderer accept that recipe/output interface. The higher
level `rerender_approved.py` takes `prepared` and `approved` records; use its
`--help` and the actual archived record instead of inventing command arguments.
The replay must read archived approved inputs, never use the canonical output as
its source. Check all84 raw RGBA/decoded-frame hashes against the bound proof.
Fresh WebM container UIDs can differ; accepted canonical WEBM bytes remain fixed.

`TOOLCHAIN_FINAL_1_13.json` records the observed Python, NumPy, SciPy, Pillow and
FFmpeg/ffprobe versions and binary hashes used locally. This is an observed
successful environment, not a guarantee of bit-exact replay on arbitrary future
hardware or dependency versions. These are offline artwork tools; the running
Node bot's dependencies remain pinned separately by `package-lock.json`.

All71 final candidates received independent source/ordered-frame/scene review.
Technical decode, FPS, metrics, contact sheets and recorded hashes do not prove
native real-time/slowed playback, human perception or physical-device quality.
Those boundaries remain unknown. Scenes125/130/139 remain unchanged with a native
perception hold. There is no1.13 live Telegram/publication receipt in this package.
