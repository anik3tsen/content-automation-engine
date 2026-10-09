# Changelog

## 0.1.0

First public version.

- Thirteen-step workflow with four human gates. G2 and G3 run in parallel after the master brief is locked at G1.
- Fact slots: the model never types a fact; the system fills slots from approved data.
- Copy rules: character limits, required fields, unfilled slots, missing facts, material claims, prices and offers, CTA policy, brand spelling, banned words, rejected phrases, house style, keyword coverage.
- Automatic redraft when every variant for a placement fails the rules, up to a configured limit.
- Pre-publish QA on the staged preview before G4, and a live check after it.
- Fallback pack and deferred outputs when the content store is down. Retry when it returns.
- Incident flow: revert or take down a live entry, and list related outputs.
- Rollout modes: shadow, assisted, default. Manual path when AI drafting is off.
- Gate UI, HTTP API, demo scenarios and tests. No runtime dependencies.
