import mongoose, { Schema } from "mongoose";

const examSubscriptionTransactionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    examId: { type: Schema.Types.ObjectId, ref: "Exam", required: true, index: true },
    examAccessId: {
      type: Schema.Types.ObjectId,
      ref: "ExamAccess",
      default: null,
      index: true,
    },
    source: {
      type: String,
      enum: ["initial_included", "exam_subscription", "manual", "legacy"],
      required: true,
      index: true,
    },
    provider: {
      type: String,
      enum: ["stripe", "paypal", "apple", "google", "revenuecat", "manual", "migration"],
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "completed", "failed", "refunded", "revoked"],
      default: "pending",
      index: true,
    },
    amount: { type: Number, default: 0, min: 0 },
    currency: { type: String, trim: true, uppercase: true, default: "USD" },
    startedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    externalTransactionId: { type: String, trim: true, default: "" },
    originalTransactionId: { type: String, trim: true, default: "" },
    productId: { type: String, trim: true, default: "" },
    refundedAmount: { type: Number, default: 0, min: 0 },
    refundStatus: {
      type: String,
      enum: ["none", "partial", "full"],
      default: "none",
    },
    refundHistory: {
      type: [
        {
          refundedAt: { type: Date, default: Date.now },
          amount: { type: Number, required: true, min: 0 },
          reason: { type: String, trim: true, default: "" },
          adminId: { type: Schema.Types.ObjectId, ref: "User", default: null },
          type: { type: String, enum: ["full", "partial"], required: true },
          stripeRefundId: { type: String, trim: true, default: "" },
          paypalRefundId: { type: String, trim: true, default: "" },
          revenueCatRefundId: { type: String, trim: true, default: "" },
        },
      ],
      default: [],
    },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

examSubscriptionTransactionSchema.index(
  { provider: 1, externalTransactionId: 1 },
  {
    unique: true,
    partialFilterExpression: { externalTransactionId: { $gt: "" } },
  }
);

export const ExamSubscriptionTransaction = mongoose.model(
  "ExamSubscriptionTransaction",
  examSubscriptionTransactionSchema
);
