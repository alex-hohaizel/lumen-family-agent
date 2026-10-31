# Motion version 5 lineage contract

The live, complete approved-item schema is instantiated in `approved-rig2.json`.
Only its explicit authorized IDs may be staged by `stage.py`. Current approvals
are frame-sequence prototypes, with native realtime/slow/device playback and
full temporal quality still pending. They do not approve the complete pack.

For each motion5 manifest item:

1. Existing ID, emoji, unique scene and origin remain. WEBM/poster byte counts and
   SHA256 must match both canonical files and the explicit approved record.
2. `source_keyposes_sha256` equals the actual derived PNG bundle hash.
   `previous_source_keyposes_sha256` and
   `source_provenance.ancestor_original_keyposes_sha256` retain the distinct
   unrecovered original-atlas ancestor hash. These must not be conflated.
3. `source_provenance.kind` is `derived_decoded_video`. Its `source_video_path`
   points to archived exact pre-repair WEBM bytes and must match
   `source_video_sha256`. Every source-frame PNG must exist and match its SHA.
   The bundle is SHA256 of the ASCII concatenation of PNG SHA256 hex strings in
   ascending source-frame-index order. Timestamps are actual source index/30.
4. `repair_provenance.approved_record` resolves to an explicit approved item.
   The stable `proof_path` hash must equal the accepted independent QA's exact
   `proof_sha256`; output SHA and proposed Ukrainian description must likewise
   equal that candidate's accepted QA record. The QA artifact hash, actual agent,
   run ID, observed coverage, accepted scope and limitations remain present.
5. Stable `recipe_path`/`recipe_sha256` identify the source-checked recipe.
   `generator` pins engine/support paths+hashes and the original generator/support
   snapshots+hashes. The frozen proof remains unchanged; historical workspace
   paths inside it are documentary. Its exact original code is retained under
   the stable `original_*_snapshot` paths with the same hashes.
6. `reproducibility.artifact` and its hash identify an actual portable CLI run
   from approved decoded PNGs. All84 raw RGBA PNG hashes and all84 decoded VP9
   frame PNG hashes must match. The run must declare `canonical_video_read:false`.
   WEBM muxer container bytes may differ; accepted canonical file bytes remain
   frozen and independently SHA-checked. No rerender substitutes accepted bytes.
7. The proof records84 decoded frame hashes, monotonic actual PTS, stream limits,
   authored source/part lineage, scene/semantic tradeoffs and frame-review
   coverage. Metrics support technical verification, not visual acceptance.

All120 rows/IDs/unique scenes and all retained31 source media remain required.
Unlisted rows/media must remain unchanged when staging an approved subset.
No source archive, explicit recipe, numerical metric or passing test infers
approval for an unreviewed item or publication.
