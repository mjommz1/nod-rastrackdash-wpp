-- Composite key so ProviderPurchaseClaim can reference a conversion of the same
-- workspace ("workspaceId", "id"). "id" is already the primary key, so no
-- existing row can violate it. Kept in its own migration (only this statement)
-- because it builds an index over the whole ConversionEventLog table: the build
-- is atomic (no half-built index on failure) and blocks writes to this table
-- only while it runs; reads keep working.
CREATE UNIQUE INDEX IF NOT EXISTS "ConversionEventLog_workspace_id_key" ON "ConversionEventLog"("workspaceId", "id");
