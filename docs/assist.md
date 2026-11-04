# Assist (safe AI, MOCK)

There is **no real OCR and no real AI**. A deterministic heuristic extractor (`src/modules/assist/extractor.js`, labelled MOCK everywhere) reads pasted receipt or OCR text in English and Arabic (Arabic-Indic digits, Arabic decimal separators, Arabic keywords) and proposes supplier, date, total, VAT, currency and category, each with a confidence and a plain-language reason. It plugs in through a provider interface (`providers.js`: `{ name, mock, extract(text, opts) }`), so a real provider would use the same review queue.

## Hard rules (tested)
1. A suggestion never posts. Accepting creates a bill through `purchases.createBill` with source `assist`.
2. That bill is never auto-approved, whatever its amount; it goes to the approval rules.
3. A suggestion dated in a locked period (soft or hard) is refused at acceptance (`PERIOD_LOCKED`); edit the date instead.
4. Undo voids the bill: a pending approval is cancelled, a posted entry is reversed (never deleted). Refused once the bill has payments.
5. Missing data stays missing (confidence 0, date or total null); the reviewer must supply it. Non-EGP documents are refused with `CURRENCY_UNSUPPORTED`.

## Flow and API
`POST /api/assist/items` (assist.use) -> `GET /api/assist/items` -> `POST .../accept` (optional `edits`; needs assist.review and purchases.create, so a clerk) / `reject` (reason) / `undo` (reason). `GET /api/assist/stats`, `GET/DELETE /api/assist/rules`.

## Learning and accuracy
Only a corrected category teaches a rule (supplier -> category, applied next time at 95% confidence with the reason shown; deletable). Stats show accepted unchanged, accepted edited and rejected with the sample size; below 20 reviews a caution says the figures mean little. Undone and pending items are reported separately, not counted.

## Permissions
`assist.use` (submit, see own items), `assist.review` (queue, accept, reject, undo, stats, rules). Clerk has both, accountant `assist.use`.
