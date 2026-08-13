import { ExamAccess } from "../model/examAccess.model.js";
import { ExamSubscriptionTransaction } from "../model/examSubscriptionTransaction.model.js";
import { isExamEntitlementActive } from "./examAccess.helpers.js";

export const EXAM_ACCESS_DURATION_MONTHS = 6;

export const addExamAccessMonths = (
  value,
  months = EXAM_ACCESS_DURATION_MONTHS
) => {
  const result = new Date(value);
  const day = result.getDate();
  result.setDate(1);
  result.setMonth(result.getMonth() + months);
  const lastDayOfTargetMonth = new Date(
    result.getFullYear(),
    result.getMonth() + 1,
    0
  ).getDate();
  result.setDate(Math.min(day, lastDayOfTargetMonth));
  return result;
};

export const buildLegacyExamEntitlementWindow = (purchasedAt) => {
  const purchaseDate = new Date(purchasedAt);
  const configuredMigrationDate = process.env.EXAM_SUBSCRIPTION_MIGRATION_AT
    ? new Date(process.env.EXAM_SUBSCRIPTION_MIGRATION_AT)
    : null;
  const startedAt =
    configuredMigrationDate && !Number.isNaN(configuredMigrationDate.getTime())
      ? configuredMigrationDate
      : purchaseDate;
  return { startedAt, expiresAt: addExamAccessMonths(startedAt) };
};

export const grantExamEntitlement = async ({
  userId,
  examId,
  source,
  provider,
  amount = 0,
  currency = "USD",
  startedAt = new Date(),
  expiresAt,
  externalTransactionId = "",
  originalTransactionId = "",
  productId = "",
  purchaseType = source === "initial_included" ? "plan" : "exam",
  paymentFields = {},
  metadata = {},
}) => {
  const normalizedStartedAt = new Date(startedAt);
  const normalizedExpiresAt = expiresAt
    ? new Date(expiresAt)
    : addExamAccessMonths(normalizedStartedAt);

  if (externalTransactionId) {
    const existingTransaction = await ExamSubscriptionTransaction.findOne({
      provider,
      externalTransactionId,
    }).lean();
    if (
      existingTransaction &&
      (existingTransaction.userId.toString() !== userId.toString() ||
        existingTransaction.examId.toString() !== examId.toString())
    ) {
      throw new Error("Payment transaction is already linked to another exam entitlement");
    }
  }

  const existing = await ExamAccess.findOne({ userId, examId });
  if (isExamEntitlementActive(existing, normalizedStartedAt)) {
    return { access: existing, created: false };
  }

  const access = await ExamAccess.findOneAndUpdate(
    { userId, examId },
    {
      $set: {
        userId,
        examId,
        status: "active",
        source,
        purchaseType,
        currency: currency.toString().trim().toUpperCase() || "USD",
        purchasePrice: Math.max(0, Number(amount) || 0),
        totalAmount: Math.max(0, Number(amount) || 0),
        maxQuestionsPerSession: 30,
        paymentStatus: "completed",
        purchasedAt: normalizedStartedAt,
        startedAt: normalizedStartedAt,
        accessDuration: "six_months",
        expiresAt: normalizedExpiresAt,
        ...paymentFields,
        metadata: { ...metadata, durationMonths: EXAM_ACCESS_DURATION_MONTHS },
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const transactionFilter = externalTransactionId
    ? { provider, externalTransactionId }
    : {
        userId,
        examId,
        source,
        startedAt: normalizedStartedAt,
        provider,
      };
  await ExamSubscriptionTransaction.findOneAndUpdate(
    transactionFilter,
    {
      $set: {
        examAccessId: access._id,
        status: "completed",
        amount: Math.max(0, Number(amount) || 0),
        currency: currency.toString().trim().toUpperCase() || "USD",
        startedAt: normalizedStartedAt,
        expiresAt: normalizedExpiresAt,
        originalTransactionId,
        productId,
        metadata,
      },
      $setOnInsert: {
        userId,
        examId,
        source,
        provider,
        externalTransactionId,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return { access, created: true };
};

export const recordPendingExamSubscription = async ({
  userId,
  examId,
  examAccessId,
  provider,
  externalTransactionId,
  amount,
  currency = "USD",
  productId = "",
}) =>
  ExamSubscriptionTransaction.findOneAndUpdate(
    { provider, externalTransactionId },
    {
      $setOnInsert: {
        userId,
        examId,
        examAccessId,
        source: "exam_subscription",
        provider,
        status: "pending",
        amount: Math.max(0, Number(amount) || 0),
        currency: currency.toString().trim().toUpperCase() || "USD",
        externalTransactionId,
        productId,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

export const markExamSubscriptionTransactionStatus = async ({
  provider,
  externalTransactionId,
  status,
  reason = "",
}) =>
  ExamSubscriptionTransaction.findOneAndUpdate(
    { provider, externalTransactionId },
    {
      $set: {
        status,
        ...(reason ? { "metadata.statusReason": reason } : {}),
      },
    },
    { new: true }
  );

export const revokeExamEntitlement = async ({
  userId,
  examId,
  externalTransactionId = "",
  reason = "revoked",
  transactionStatus = "revoked",
}) => {
  const access = await ExamAccess.findOneAndUpdate(
    { userId, examId },
    {
      $set: {
        status: "revoked",
        paymentStatus: "voided",
        maxQuestionsPerSession: 2,
        "metadata.revocationReason": reason,
        "metadata.revokedAt": new Date(),
      },
    },
    { new: true }
  );
  if (externalTransactionId) {
    await ExamSubscriptionTransaction.findOneAndUpdate(
      { externalTransactionId },
      { $set: { status: transactionStatus, "metadata.revocationReason": reason } }
    );
  }
  return access;
};

export const expireExamEntitlements = async ({ userId, now = new Date() } = {}) =>
  ExamAccess.updateMany(
    {
      ...(userId ? { userId } : {}),
      status: { $in: ["active", "unlocked"] },
      expiresAt: { $ne: null, $lte: now },
    },
    {
      $set: {
        status: "expired",
        maxQuestionsPerSession: 2,
        "metadata.expiredAt": now,
      },
    }
  );
