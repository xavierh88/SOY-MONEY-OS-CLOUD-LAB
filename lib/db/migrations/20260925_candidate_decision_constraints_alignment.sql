-- Repair schema-local candidate decision constraints.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'soy_candidate_decisions_candidate_type_check'
      AND conrelid = 'soy_candidate_decisions'::regclass
  ) THEN
    ALTER TABLE soy_candidate_decisions
      ADD CONSTRAINT soy_candidate_decisions_candidate_type_check
      CHECK (candidate_type IN ('MONEY_LAB_CANDIDATE', 'OPPORTUNITY_CANDIDATE'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'soy_candidate_decisions_candidate_type_link_check'
      AND conrelid = 'soy_candidate_decisions'::regclass
  ) THEN
    ALTER TABLE soy_candidate_decisions
      ADD CONSTRAINT soy_candidate_decisions_candidate_type_link_check
      CHECK (
        (candidate_type = 'MONEY_LAB_CANDIDATE' AND candidate_id IS NOT NULL)
        OR
        (candidate_type = 'OPPORTUNITY_CANDIDATE' AND candidate_id IS NULL AND opportunity_id IS NOT NULL)
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'soy_external_dispatches_cycle_id_fk' AND conrelid = 'soy_external_dispatches'::regclass) THEN ALTER TABLE soy_external_dispatches ADD CONSTRAINT soy_external_dispatches_cycle_id_fk FOREIGN KEY (cycle_id) REFERENCES soy_cycles(id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'soy_external_dispatches_market_cycle_id_fk' AND conrelid = 'soy_external_dispatches'::regclass) THEN ALTER TABLE soy_external_dispatches ADD CONSTRAINT soy_external_dispatches_market_cycle_id_fk FOREIGN KEY (market_cycle_id) REFERENCES soy_market_cycles(id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'soy_external_dispatches_opportunity_id_fk' AND conrelid = 'soy_external_dispatches'::regclass) THEN ALTER TABLE soy_external_dispatches ADD CONSTRAINT soy_external_dispatches_opportunity_id_fk FOREIGN KEY (opportunity_id) REFERENCES soy_opportunities(id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'soy_external_dispatches_project_id_fk' AND conrelid = 'soy_external_dispatches'::regclass) THEN ALTER TABLE soy_external_dispatches ADD CONSTRAINT soy_external_dispatches_project_id_fk FOREIGN KEY (project_id) REFERENCES soy_projects(id); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'soy_lifecycle_events_immutable_trigger' AND tgrelid = 'soy_lifecycle_events'::regclass) THEN CREATE TRIGGER soy_lifecycle_events_immutable_trigger BEFORE UPDATE OR DELETE ON soy_lifecycle_events FOR EACH ROW EXECUTE FUNCTION soy_lifecycle_events_immutable(); END IF;
END $$;
