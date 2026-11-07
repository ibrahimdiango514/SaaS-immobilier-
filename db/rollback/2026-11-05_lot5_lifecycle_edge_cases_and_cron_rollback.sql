-- =============================================================================
-- ROLLBACK NON-DESTRUCTIF — LOT 5 (Suspension, grâce, réactivation & cron)
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_job_id bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    SELECT jobid INTO v_job_id FROM cron.job WHERE jobname = 'sofia-subscription-lifecycle-hourly' LIMIT 1;
    IF v_job_id IS NOT NULL THEN
      PERFORM cron.unschedule(v_job_id);
    END IF;
  END IF;
END;
$$;

DROP FUNCTION IF EXISTS public.billing_automation_health();
DROP FUNCTION IF EXISTS public.admin_set_suspension_shield(uuid, integer, text);

COMMIT;
