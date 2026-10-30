# Shuffull API contract fixtures

What the Shuffull API puts on the wire, copied verbatim from `MC2018/Shuffull` →
`Shuffull.Core.Tests/Contracts/Golden/` (written there by `ApiContractGoldenFilesTest`). Don't edit them here:
regenerate in Shuffull, then run the hub's `scripts/sync-contract-fixtures.sh`.

`tests/apiContract.test.ts` parses them through the app's zod schemas, and checks the request bodies `ApiClient`
sends against the ones the API binds (the `*-request` files, `user-songs-*` writes, `songs-update`). The funnel-only
files (pending tags and their hold report, YouTube ratings, replacements, the library listing, the tag write-back, song
imports and lyrics) come along because the hub script copies the whole set to every consumer. `listens.json` and
`listens-request.json` are the listen log's outcomes and the body the app sends (ShuffullApp#57). `recap.json` is
the yearly recap the December recap screen reads (ShuffullApp#116). `listens-stats.json` is the stats endpoint, which
nothing in the app reads yet (ShuffullApp#115).
