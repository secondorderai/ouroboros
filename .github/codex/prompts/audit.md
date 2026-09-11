Independently audit the current checkout against every ticket acceptance criterion.
Use the investigation and evidence rules in .agents/skills/ou-features-audit/SKILL.md,
but return this workflow's JSON schema without interactive confirmation or file edits.
You may delegate read-only investigation to up to three native Codex subagents;
wait for all of them before returning.

Return exactly one row per ticket/criterion pair. PASS requires concrete code and
regression-test evidence; partial, missing, and unverified work must be labelled
PARTIAL, FAIL, or UNVERIFIED. Check the implementation paths, not just matching text.
Do not mark a criterion PASS solely because a teammate said it was done.

Include implicit project requirements in the assessment of the relevant criteria:
automated coverage, protocol contracts, permission and sandbox preservation, Electron
context isolation, and desktop design fidelity. Do not claim a runtime check ran if
you only inspected its test source. This is a read-only audit; report gaps for the
separate fix phase.
