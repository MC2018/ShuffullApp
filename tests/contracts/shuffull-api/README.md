# Shuffull API contract fixtures

What the Shuffull API puts on the wire, copied verbatim from `MC2018/Shuffull` →
`Shuffull.Core.Tests/Contracts/Golden/` (written there by `ApiContractGoldenFilesTest`). Don't edit them here:
regenerate in Shuffull, then run the hub's `scripts/sync-contract-fixtures.sh`.

`tests/apiContract.test.ts` parses them through the app's zod schemas. The funnel-only files (pending tags,
YouTube ratings, replacements) come along because the hub script copies the whole set to every consumer.
