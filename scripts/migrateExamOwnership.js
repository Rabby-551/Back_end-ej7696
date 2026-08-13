import dotenv from "dotenv";
import mongoose from "mongoose";
import { ExamAccess } from "../model/examAccess.model.js";
import { ExamSubscriptionTransaction } from "../model/examSubscriptionTransaction.model.js";
import { AppSetting } from "../model/appSetting.model.js";
import { addExamAccessMonths } from "../utils/examSubscription.service.js";

dotenv.config();

if (!process.env.MONGO_DB_URL) {
  throw new Error("MONGO_DB_URL is not configured");
}

await mongoose.connect(process.env.MONGO_DB_URL);

try {
  const migrationStartedAt = process.env.EXAM_SUBSCRIPTION_MIGRATION_AT
    ? new Date(process.env.EXAM_SUBSCRIPTION_MIGRATION_AT)
    : new Date();
  if (Number.isNaN(migrationStartedAt.getTime())) {
    throw new Error("EXAM_SUBSCRIPTION_MIGRATION_AT is not a valid date");
  }
  const migrationExpiresAt = addExamAccessMonths(migrationStartedAt);
  await AppSetting.findOneAndUpdate(
    {},
    {
      $set: {
        professionalPlanPrice: 199.99,
        examUnlockPrice: 150,
        professionalPlanIntervalCount: 6,
        professionalPlanIntervalUnit: "months",
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  const candidates = await ExamAccess.find({
    status: "unlocked",
    "metadata.sixMonthMigrationAt": { $exists: false },
  }).lean();
  const result = await ExamAccess.updateMany(
    {
      status: "unlocked",
      "metadata.sixMonthMigrationAt": { $exists: false },
    },
    {
      $set: {
        status: "active",
        source: "legacy",
        accessDuration: "six_months",
        startedAt: migrationStartedAt,
        expiresAt: migrationExpiresAt,
        "metadata.sixMonthMigrationAt": migrationStartedAt,
        "metadata.previousAccessDuration": "lifetime",
      },
    }
  );

  if (candidates.length) {
    await ExamSubscriptionTransaction.bulkWrite(
      candidates.map((access) => ({
        updateOne: {
          filter: {
            userId: access.userId,
            examId: access.examId,
            source: "legacy",
            provider: "migration",
          },
          update: {
            $setOnInsert: {
              userId: access.userId,
              examId: access.examId,
              examAccessId: access._id,
              source: "legacy",
              provider: "migration",
              status: "completed",
              amount: 0,
              currency: access.currency || "USD",
              startedAt: migrationStartedAt,
              expiresAt: migrationExpiresAt,
              metadata: { previousStatus: access.status },
            },
          },
          upsert: true,
        },
      }))
    );
  }

  console.log(
    `Six-month entitlement migration complete: matched=${result.matchedCount} modified=${result.modifiedCount} expiresAt=${migrationExpiresAt.toISOString()}`
  );
} finally {
  await mongoose.disconnect();
}
