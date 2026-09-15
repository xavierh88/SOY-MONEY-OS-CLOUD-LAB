-- Additive, idempotent rollout for Operational Control Tower observability.
ALTER TABLE soy_opportunities ADD COLUMN IF NOT EXISTS detected_at timestamptz;
ALTER TABLE soy_opportunities ADD COLUMN IF NOT EXISTS valid_from timestamptz;
ALTER TABLE soy_opportunities ADD COLUMN IF NOT EXISTS valid_until timestamptz;
ALTER TABLE soy_opportunities ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE soy_opportunities ADD COLUMN IF NOT EXISTS expiration_reason text;
ALTER TABLE soy_opportunities ADD COLUMN IF NOT EXISTS expired_at timestamptz;
ALTER TABLE soy_opportunities ADD COLUMN IF NOT EXISTS expiration_outcome text;

ALTER TABLE soy_human_actions ADD COLUMN IF NOT EXISTS opportunity_id integer;
ALTER TABLE soy_human_actions ADD COLUMN IF NOT EXISTS project_id integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'soy_human_actions_opportunity_id_soy_opportunities_id_fk') THEN
    ALTER TABLE soy_human_actions
      ADD CONSTRAINT soy_human_actions_opportunity_id_soy_opportunities_id_fk
      FOREIGN KEY (opportunity_id) REFERENCES soy_opportunities(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'soy_human_actions_project_id_soy_projects_id_fk') THEN
    ALTER TABLE soy_human_actions
      ADD CONSTRAINT soy_human_actions_project_id_soy_projects_id_fk
      FOREIGN KEY (project_id) REFERENCES soy_projects(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS soy_opportunities_expires_at_idx ON soy_opportunities(expires_at);
CREATE INDEX IF NOT EXISTS soy_human_actions_project_id_idx ON soy_human_actions(project_id);