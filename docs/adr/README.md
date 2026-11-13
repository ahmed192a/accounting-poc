# Architecture decision records

One file per decision, as listed in [section 5.9 of the design plan](../DESIGN_PLAN.md). Each records the context, the proposed
decision and its consequences. All eight are **proposed — awaiting owner confirmation**: nothing here is settled until the owner confirms it, and the status
line of a record changes (to accepted, rejected or superseded) in the same pull request that confirms it.

| Id | Decision | Proposed outcome | Status |
| --- | --- | --- | --- |
| [D1](D1-database-through-the-pilot.md) | Database through the pilot | SQLite per company | proposed — awaiting owner confirmation |
| [D2](D2-tenancy-model.md) | Tenancy model | File per company (built); schema-per-tenant if ported | proposed — awaiting owner confirmation |
| [D3](D3-front-end-approach.md) | Front-end approach | No build step, ES modules, two shells | proposed — awaiting owner confirmation |
| [D4](D4-sync-model.md) | Sync model | Operation log | proposed — awaiting owner confirmation |
| [D5](D5-dependency-policy.md) | Dependency policy | Zero by default; a named, reviewed exception list | proposed — awaiting owner confirmation |
| [D6](D6-ai-provider.md) | AI provider | Pluggable, company-supplied key, propose-only default | proposed — awaiting owner confirmation |
| [D7](D7-hosting-and-residency.md) | Hosting and residency | Open until counsel answers | proposed — awaiting owner confirmation |
| [D8](D8-api-versioning.md) | API versioning | `/api/v1` now; unversioned paths kept as aliases through the pilot | proposed — awaiting owner confirmation |

To add a record: copy the shape of an existing file, number it `D9`, `D10`, ..., and add a row here.
