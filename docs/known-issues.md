# Known issues and remaining gaps

Updated 2026-10-05.

## Recipe and opening-stock completeness

Recipe coverage in the production catalog is still incomplete. Sales for
these products cannot deduct recipe ingredients. Opening stock, units, thresholds and
par levels must be verified with each branch. Use Recipe health and Menu costing to
track recipe completion; do not invent operational quantities.

## QR recovery limitations

Claims created before checkout tracking cannot be matched reliably to past sales and
are not automatically reopened. New claims can be resumed or returned to the queue.
Resume restores the submitted order, not unsaved cashier edits made before a refresh.

## Operational features still to scope

Receipt printing, cash tender/change, shift reconciliation and offline checkout have
no complete workflows.

## Resolved in the October review

- S1: server authentication now reloads current account access. Deactivation and
  password resets invalidate existing sessions.
- D1: Next's tracing root is explicitly set to the project directory.
- QR claim/cancel/checkout races and concurrent sale voids now use transaction locks.
