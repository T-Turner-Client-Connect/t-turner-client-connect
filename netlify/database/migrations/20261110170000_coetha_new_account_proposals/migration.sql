-- Apply These Decisions: Coetha may propose a missing account (created only when Tabitha
-- approves it). Adds 'NEW_ACCOUNT' to the allowed proposal kinds; every existing kind and row is
-- unchanged.
ALTER TABLE "CoethaProposal" DROP CONSTRAINT IF EXISTS "CoethaProposal_kind_check";
ALTER TABLE "CoethaProposal" ADD CONSTRAINT "CoethaProposal_kind_check" CHECK ("kind" IN ('CATEGORY', 'DISCREPANCY', 'ADJUSTING_ENTRY', 'MONTH_SUMMARY', 'RECOMMENDATION', 'CLASSIFICATION', 'NEW_ACCOUNT'));
