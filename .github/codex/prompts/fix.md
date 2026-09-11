Fix the supplied audit, review, or verification failures in the main checkout.
Make focused corrections and add regression tests. Preserve requirements and checks.
Run the relevant tests synchronously and report blocked if a failure remains.
Do not commit or push; the controller handles Git changes and runs an independent
audit, review, and verification cycle after your fixes.
