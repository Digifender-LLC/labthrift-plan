-- Capacity / ops: services list + lab UPS sketch fields
ALTER TABLE labs ADD COLUMN services_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE labs ADD COLUMN capacity_json TEXT NOT NULL DEFAULT '{}';
