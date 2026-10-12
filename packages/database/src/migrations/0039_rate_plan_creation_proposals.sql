ALTER TABLE rate_change_requests ALTER COLUMN rate_plan_id DROP NOT NULL;
ALTER TABLE rate_change_requests ADD CONSTRAINT rate_change_creation_target_check
  CHECK (rate_plan_id IS NOT NULL OR coalesce(change->>'kind', '') = 'plan_create');
