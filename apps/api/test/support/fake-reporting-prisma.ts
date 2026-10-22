/**
 * Minimal in-memory stand-in for the Prisma delegates touched by
 * MetaReportingService.syncWorkspaceMetaStructure. `where` filters are
 * evaluated for real (equality, in, not, gte/lte, OR) so scoping bugs surface.
 */

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

function matches(row: Row, where: Where | undefined): boolean {
  if (!where) return true;

  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") {
      return (condition as Where[]).some((entry) => matches(row, entry));
    }

    const value = row[key];

    if (
      condition !== null &&
      typeof condition === "object" &&
      !Array.isArray(condition) &&
      !(condition instanceof Date)
    ) {
      const operators = condition as Record<string, unknown>;

      return Object.entries(operators).every(([operator, operand]) => {
        switch (operator) {
          case "in":
            return (operand as unknown[]).includes(value);
          case "not":
            return operand === null
              ? value !== null && value !== undefined
              : value !== operand;
          case "gte":
            return (value as string) >= (operand as string);
          case "lte":
            return (value as string) <= (operand as string);
          default:
            throw new Error(`Unsupported operator ${operator}`);
        }
      });
    }

    return (value ?? null) === condition;
  });
}

function project(row: Row, select?: Record<string, boolean>): Row {
  if (!select) return { ...row };

  return Object.fromEntries(
    Object.keys(select)
      .filter((key) => select[key])
      .map((key) => [key, row[key] ?? null]),
  );
}

export class FakeTable {
  rows: Row[] = [];
  findManyCalls: Array<{ where?: Where; select?: Record<string, boolean> }> =
    [];
  private sequence = 0;

  constructor(private readonly name: string) {}

  async findMany(
    args: { where?: Where; select?: Record<string, boolean> } = {},
  ) {
    this.findManyCalls.push(args);
    return this.rows
      .filter((row) => matches(row, args.where))
      .map((row) => project(row, args.select));
  }

  async findFirst(args: { where?: Where } = {}) {
    return this.rows.find((row) => matches(row, args.where)) ?? null;
  }

  async findUnique(args: { where: Where }) {
    return this.rows.find((row) => matches(row, args.where)) ?? null;
  }

  async create(args: { data: Row }) {
    const row = { id: `${this.name}_${++this.sequence}`, ...args.data };
    this.rows.push(row);
    return row;
  }

  async createMany(args: { data: Row[] }) {
    for (const data of args.data) {
      this.rows.push({ id: `${this.name}_${++this.sequence}`, ...data });
    }
    return { count: args.data.length };
  }

  async update(args: { where: Where; data: Row }) {
    const row = this.rows.find((candidate) => matches(candidate, args.where));
    if (!row) throw new Error(`${this.name}.update: row not found`);
    Object.assign(row, args.data);
    return row;
  }

  async updateMany(args: { where: Where; data: Row }) {
    const rows = this.rows.filter((row) => matches(row, args.where));
    rows.forEach((row) => Object.assign(row, args.data));
    return { count: rows.length };
  }

  async deleteMany(args: { where: Where }) {
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => !matches(row, args.where));
    return { count: before - this.rows.length };
  }

  async upsert(args: {
    where: Record<string, Where>;
    create: Row;
    update: Row;
  }) {
    const compound = Object.values(args.where)[0] as Where;
    const row = this.rows.find((candidate) => matches(candidate, compound));

    if (row) {
      Object.assign(row, args.update);
      return row;
    }

    return this.create({ data: args.create });
  }
}

export function createFakeReportingPrisma() {
  return {
    metaIntegration: new FakeTable("metaIntegration"),
    metaReportingAccount: new FakeTable("metaReportingAccount"),
    metaBusinessConnection: new FakeTable("metaBusinessConnection"),
    metaCampaign: new FakeTable("metaCampaign"),
    metaAdSet: new FakeTable("metaAdSet"),
    metaAd: new FakeTable("metaAd"),
    metaCampaignDailyInsight: new FakeTable("metaCampaignDailyInsight"),
    metaAdSetDailyInsight: new FakeTable("metaAdSetDailyInsight"),
    metaAdDailyInsight: new FakeTable("metaAdDailyInsight"),
    lead: new FakeTable("lead"),
    conversionEventLog: new FakeTable("conversionEventLog"),
    integrationLog: new FakeTable("integrationLog"),
    diagnosticEvent: new FakeTable("diagnosticEvent"),
  };
}

export type FakeReportingPrisma = ReturnType<typeof createFakeReportingPrisma>;
