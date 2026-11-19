import mongoose, { type PipelineStage } from "mongoose";
import { z } from "zod";
import { Participant } from "../models.js";
import { FEE, today } from "../../shared/domain.js";
export const filtersSchema = z.object({
  year: z.coerce
    .number()
    .int()
    .min(2000)
    .max(2100)
    .default(Number(today().slice(0, 4))),
  q: z.string().max(100).default(""),
  region: z.string().default(""),
  age: z.enum(["", "0", "1", "2", "3"]).default(""),
  status: z.enum(["", "paid", "partial", "unpaid"]).default(""),
  archived: z.enum(["true", "false"]).default("false"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(["name", "age", "paid"]).default("name"),
  direction: z.enum(["asc", "desc"]).default("asc"),
});
export type Filters = z.infer<typeof filtersSchema>;
export function normalizeParticipant(data: any) {
  return {
    ...data,
    phoneNormalized: data.phone.replace(/\D/g, ""),
    searchTokens: [data.lastName, data.firstName, data.middleName]
      .filter(Boolean)
      .flatMap((n: string) => n.toLocaleLowerCase().split(/\s+/)),
  };
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function memberPipeline(
  f: Filters,
  id?: string,
): PipelineStage.FacetPipelineStage[] {
  const match: any = {
    archivedAt: f.archived === "true" ? { $ne: null } : null,
  };
  if (id) {
    delete match.archivedAt;
    match._id = new mongoose.Types.ObjectId(id);
  }
  if (f.region) match.region = f.region;
  if (f.q.trim()) {
    const q = f.q.trim();
    match.$or = [
      {
        $and: q
          .toLocaleLowerCase()
          .split(/\s+/)
          .map((v) => ({ searchTokens: { $regex: "^" + escape(v) } })),
      },
      ...(q.replace(/\D/g, "").length >= 3
        ? [{ phoneNormalized: { $regex: "^" + escape(q.replace(/\D/g, "")) } }]
        : []),
    ];
  }
  const stages: PipelineStage.FacetPipelineStage[] = [
    { $match: match },
    {
      $addFields: {
        age: {
          $subtract: [
            {
              $subtract: [
                Number(today().slice(0, 4)),
                {
                  $convert: {
                    input: {
                      $substrBytes: [{ $ifNull: ["$birthDate", ""] }, 0, 4],
                    },
                    to: "int",
                    onError: null,
                    onNull: null,
                  },
                },
              ],
            },
            {
              $cond: [
                {
                  $gt: [
                    { $substrBytes: ["$birthDate", 5, 5] },
                    today().slice(5),
                  ],
                },
                1,
                0,
              ],
            },
          ],
        },
      },
    },
    {
      $addFields: {
        ageGroup: {
          $switch: {
            branches: [
              { case: { $eq: ["$age", null] }, then: null },
              { case: { $lt: ["$age", 25] }, then: 0 },
              { case: { $lt: ["$age", 45] }, then: 1 },
              { case: { $lt: ["$age", 65] }, then: 2 },
            ],
            default: 3,
          },
        },
      },
    },
  ];
  if (f.age !== "") stages.push({ $match: { ageGroup: Number(f.age) } });
  stages.push(
    {
      $lookup: {
        from: "membershippayments",
        let: { pid: "$_id" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$participantId", "$$pid"] },
                  { $eq: ["$year", f.year] },
                  { $eq: ["$voidedAt", null] },
                ],
              },
            },
          },
          { $group: { _id: null, total: { $sum: "$amount" } } },
        ],
        as: "paymentTotals",
      },
    },
    {
      $addFields: {
        totalPaid: { $ifNull: [{ $first: "$paymentTotals.total" }, 0] },
      },
    },
    {
      $addFields: {
        remaining: { $max: [0, { $subtract: [FEE, "$totalPaid"] }] },
        overpayment: { $max: [0, { $subtract: ["$totalPaid", FEE] }] },
        status: {
          $switch: {
            branches: [
              { case: { $eq: ["$totalPaid", 0] }, then: "unpaid" },
              { case: { $lt: ["$totalPaid", FEE] }, then: "partial" },
            ],
            default: "paid",
          },
        },
      },
    },
    { $project: { paymentTotals: 0, searchTokens: 0, phoneNormalized: 0 } },
  );
  if (f.status) stages.push({ $match: { status: f.status } });
  return stages;
}
export async function listMembers(f: Filters) {
  const field = { name: "lastName", age: "age", paid: "totalPaid" }[f.sort];
  const pipeline = memberPipeline(f);
  const sort: Record<string, 1 | -1> = {
    [field]: f.direction === "asc" ? 1 : -1,
    ...(f.sort === "name"
      ? { firstName: f.direction === "asc" ? (1 as const) : (-1 as const) }
      : {}),
    _id: 1,
  };
  // Without a payment filter/sort, only look up payments for the visible page.
  const split =
    !f.status && f.sort !== "paid"
      ? pipeline.findIndex((stage) => "$lookup" in stage)
      : pipeline.length;
  const [result] = await Participant.aggregate([
    ...pipeline.slice(0, split),
    {
      $facet: {
        items: [
          { $sort: sort },
          { $skip: (f.page - 1) * f.limit },
          { $limit: f.limit },
          ...pipeline.slice(split),
        ],
        count: [{ $count: "total" }],
      },
    },
  ]);
  return {
    items: result.items,
    total: result.count[0]?.total || 0,
    page: f.page,
    limit: f.limit,
  };
}
