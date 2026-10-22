/**
 * Minimal Prisma schema parser used ONLY by tests to independently derive
 * FK "hard delete" edges (Restrict / NoAction / default-required) straight
 * from apps/api/prisma/schema.prisma, so wipe-order tests never rely on a
 * hand-typed edge list as their own oracle.
 *
 * Scope is intentionally narrow: it understands exactly the subset of the
 * Prisma schema language this repo uses (single-line field declarations,
 * single-line @relation(...) attributes, no relationMode override — see
 * apps/api/prisma/schema.prisma `datasource` block, which targets
 * postgresql with no `relationMode`, so Prisma's default referential
 * actions apply: mandatory relation -> Restrict, optional relation ->
 * SetNull, unless overridden by an explicit onDelete).
 */

type PrismaField = {
  name: string;
  /** Base type with `?`/`[]` stripped, e.g. "Workspace" */
  type: string;
  optional: boolean;
  isArray: boolean;
  /** Everything after the type on the field's line (attributes). */
  attrs: string;
};

type PrismaModel = {
  name: string;
  fields: PrismaField[];
};

const CLIENT_SWAP_CONNECTOR_MODEL = "ExternalDataConnector";

export type PrismaHardDeleteEdge = {
  /** Prisma Client delegate holding the FK (the row deleted by client swap). */
  child: string;
  /** Prisma Client delegate/model referenced by that FK. */
  parent: string;
  /** Relation field on `child`, used to distinguish independent FKs. */
  relationField: string;
  /** Explicit restrictive action, or Prisma's required-relation default. */
  onDelete: "Restrict" | "NoAction" | "default-required";
};

export function parsePrismaModels(
  schemaSource: string,
): Map<string, PrismaModel> {
  const models = new Map<string, PrismaModel>();
  let current: PrismaModel | null = null;

  for (const rawLine of schemaSource.split("\n")) {
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    if (!line) continue;

    const modelMatch = line.match(/^model\s+(\w+)\s*\{/);
    if (modelMatch) {
      current = { name: modelMatch[1], fields: [] };
      models.set(current.name, current);
      continue;
    }

    if (line === "}") {
      current = null;
      continue;
    }

    if (!current || line.startsWith("@@")) continue;

    const fieldMatch = line.match(/^(\w+)\s+([\w[\]?]+)(.*)$/);
    if (!fieldMatch) continue;
    const [, name, typeRaw, attrs] = fieldMatch;

    current.fields.push({
      name,
      type: typeRaw.replace(/[[\]?]/g, ""),
      optional: typeRaw.endsWith("?"),
      isArray: typeRaw.endsWith("[]"),
      attrs: attrs.trim(),
    });
  }

  return models;
}

/**
 * Derives the Prisma Client delegates that hold client data for a swap.
 *
 * The schema is the source of truth for direct workspace ownership: every
 * model with a `workspaceId` scalar is in scope unless it is named in the
 * caller's retained-model boundary. Connector cursors are the one indirect
 * child: they belong to a workspace through ExternalDataConnector and are
 * selected by connectorId in the service. This intentionally does not read
 * CLIENT_SWAP_WIPE_DELEGATES, so deleting an entry from that execution list
 * cannot reduce the expected population used by the tests.
 */
export function deriveClientSwapDelegates(
  schemaSource: string,
  retainedWorkspaceModels: readonly string[],
): string[] {
  const models = parsePrismaModels(schemaSource);
  const toDelegateName = (model: string) =>
    model.charAt(0).toLowerCase() + model.slice(1);
  const retained = new Set(retainedWorkspaceModels);

  for (const modelName of retained) {
    const model = models.get(modelName);
    if (!model) {
      throw new Error(
        `prisma-schema-fk-graph: retained client-swap model "${modelName}" no longer exists in schema.prisma`,
      );
    }
    if (!model.fields.some((field) => field.name === "workspaceId")) {
      throw new Error(
        `prisma-schema-fk-graph: retained client-swap model "${modelName}" no longer has a workspaceId field`,
      );
    }
  }

  const delegates = new Set<string>();
  for (const model of models.values()) {
    if (
      model.fields.some((field) => field.name === "workspaceId") &&
      !retained.has(model.name)
    ) {
      delegates.add(toDelegateName(model.name));
    }

    const belongsToConnector = model.fields.some(
      (field) =>
        !field.isArray &&
        field.type === CLIENT_SWAP_CONNECTOR_MODEL &&
        /@relation\([^)]*fields:\s*\[/.test(field.attrs),
    );
    if (belongsToConnector) {
      delegates.add(toDelegateName(model.name));
    }
  }

  return [...delegates];
}

/**
 * Derives every FK edge held by the given child delegates whose deletion
 * behavior matters: child rows referencing a parent via a relation that
 * Postgres will enforce with RESTRICT/NO ACTION (either explicit or
 * Prisma's implicit default for a required relation). Cascade/SetNull
 * relations are excluded since the database resolves them without
 * requiring the child to be deleted first. This deliberately retains
 * parents outside `delegateNames`; callers need those edges to make an
 * explicit client-swap boundary decision instead of silently dropping them.
 * Self-relations are excluded because a single deleteMany() statement
 * handles same-table references.
 *
 * `delegateNames` are Prisma Client delegate names (camelCase). Model
 * names are assumed to be the PascalCase form of the delegate name, which
 * holds for every model referenced by client-swap (verified in tests).
 */
export function deriveHardDeleteEdges(
  schemaSource: string,
  delegateNames: readonly string[],
): PrismaHardDeleteEdge[] {
  const models = parsePrismaModels(schemaSource);
  const toModelName = (delegate: string) =>
    delegate.charAt(0).toUpperCase() + delegate.slice(1);
  const toDelegateName = (model: string) =>
    model.charAt(0).toLowerCase() + model.slice(1);
  const modelToDelegate = new Map(
    delegateNames.map((delegate) => [toModelName(delegate), delegate]),
  );

  for (const delegate of delegateNames) {
    if (!models.has(toModelName(delegate))) {
      throw new Error(
        `prisma-schema-fk-graph: no model "${toModelName(delegate)}" found for delegate "${delegate}" — delegate name no longer maps to a PascalCase model in schema.prisma`,
      );
    }
  }

  const edges: PrismaHardDeleteEdge[] = [];

  for (const model of models.values()) {
    const childDelegate = modelToDelegate.get(model.name);
    if (!childDelegate) continue;

    for (const field of model.fields) {
      if (field.isArray) continue; // "many" side never holds the FK column(s)

      const relationMatch = field.attrs.match(/@relation\(([^)]*)\)/);
      if (!relationMatch) continue;
      const relationArgs = relationMatch[1];
      if (!/fields:\s*\[/.test(relationArgs)) continue; // back-relation side, no FK here

      if (field.type === model.name) continue; // self-relation

      const onDeleteMatch = relationArgs.match(/onDelete:\s*(\w+)/);
      const explicitOnDelete = onDeleteMatch?.[1] ?? null;

      const onDelete = explicitOnDelete
        ? explicitOnDelete === "Restrict" || explicitOnDelete === "NoAction"
          ? explicitOnDelete
          : null
        : !field.optional
          ? "default-required" // Postgres default: mandatory -> Restrict
          : null; // optional relation default is SetNull

      if (onDelete) {
        edges.push({
          child: childDelegate,
          parent: modelToDelegate.get(field.type) ?? toDelegateName(field.type),
          relationField: field.name,
          onDelete,
        });
      }
    }
  }

  return edges;
}
