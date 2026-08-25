# Refactor log

Breadcrumb trail for structural changes. One entry per batch; each batch has ONE
architectural objective. Rule: **move first, improve later** — structural moves
never change logic, interfaces, or behavior in the same commit.

Template:

```text
### Change
Moved `X` from `A` to `B`.

### Reason
Why X belongs in B.

### Behavioral change
None intended.

### References checked
- imports/exports re-verified (grep for old paths)
- duplicate definitions checked
- typecheck / relevant `npm run test:*` suites run
```

---

_No structural changes yet. Audit completed 2026-08-25 (see ARCHITECTURE.md and
LEGACY_CODE.md). Refactoring will proceed lowest-risk-first per the agreed order._
