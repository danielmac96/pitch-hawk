-- v4 (modeling/v4, P-009) records every candidate on its ladder, so a run's
-- status says what it was, not only whether it promoted:
--   candidate  a rung that was scored and not chosen
--   stageable  the chosen rung, and the v4 gate passed
--   held       the chosen rung, and the v4 gate held it (reasons in notes)
-- NOT VALID: existing rows already satisfy the narrower set; no rescan.
alter table model_runs drop constraint if exists model_runs_status_check;
alter table model_runs add constraint model_runs_status_check
    check (status in ('completed', 'failed', 'promoted',
                      'stageable', 'held', 'candidate')) not valid;
