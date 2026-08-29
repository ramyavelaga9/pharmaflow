---
name: medication-fulfillment
description: Autonomously fulfill a detected medication supply-risk case - check real pharmacy inventory, reorder automatically if stock allows it, or propose a vetted alternative and let a pharmacist approve it. Use whenever asked to handle, fulfill, or process a case (including when started automatically with no user present).
---

# Medication Fulfillment

You may be started for this on your own, with no one in the conversation -
that's expected. A new supply-risk case was just detected, and your job is
to move it forward without waiting to be asked. You have
`check_pharmacy_inventory`, `place_refill_order`, and
`propose_alternative_supply` from the pharmacy tools, plus `list_cases` to
look up the case if you weren't given full detail.

## Procedure

1. **Identify the case.** If you weren't given the case's medication and
   patient directly, call `list_cases` and find it by id. Never guess a
   case id, a drug name, or a patient.

2. **Check real inventory before doing anything else.** Call
   `check_pharmacy_inventory` for the case's medication, passing the case
   id so the real number you checked is visible on the case itself, not
   only in this tool call. Do not assume stock is available or
   unavailable - the whole point of this workflow is to act on the real
   number.

3. **If stock is available: reorder the same drug, no approval needed.**
   Call `place_refill_order` with the case id. This is a routine
   continuation of a medication the patient is already prescribed - not a
   clinical decision - so it proceeds immediately. Report what happened in
   one or two sentences; don't ask permission first.

4. **If stock is not available: propose only a vetted alternative.**
   `propose_alternative_supply` only accepts a drug name that's already on
   the reference list for that medication - it will reject anything else,
   and you must not try to work around that by guessing at a plausible
   substitute. If there is no vetted alternative for this drug, don't call
   the tool at all: instead call `create_pharmacist_review` explaining that
   the drug is out of stock with no reference alternative, so a human
   decides what to do next.

5. **Never skip the approval step.** `propose_alternative_supply` requires
   a pharmacist's explicit approval before it does anything - notifying
   the patient and placing the order both happen only after that approval,
   automatically, as part of the same tool executing. You don't need a
   separate step to "notify" or "order" once it's approved; the tool does
   both.

6. **Never claim an action happened before the tool result confirms it.**
   If a tool call fails (e.g. stock changed between check and order), say
   so plainly and stop rather than reporting success.

## Boundaries

- Never invent an alternative drug name. The reference list exists exactly
  because that judgment belongs to a pharmacist, not to you.
- Never place an order or propose a switch for a case that isn't real
  (i.e., not found via `list_cases`).
- This skill does not diagnose, prescribe, or change dosing - it only
  continues or redirects the fulfillment of a medication the patient is
  already prescribed, within a pharmacist's sign-off where required.
