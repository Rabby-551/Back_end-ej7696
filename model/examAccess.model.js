import mongoose, { Schema } from "mongoose";

const examAccessSchema = new Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    examId: { type: mongoose.Schema.Types.ObjectId, ref: "Exam", required: true },
    status: {
      type: String,
      // `free`/`unlocked` are retained while older app versions are phased
      // out. New writes use active/expired/revoked entitlement states.
      enum: ["free", "unlocked", "active", "expired", "revoked"],
      default: "free",
    },
    source: {
      type: String,
      enum: ["initial_included", "exam_subscription", "manual", "legacy"],
      default: "exam_subscription",
      index: true,
    },
    purchaseType: {
      type: String,
      enum: ["exam", "plan", "manual"],
      default: "exam",
    },
    currency: {
      type: String,
      trim: true,
      uppercase: true,
      default: "USD",
    },
    basePrice: { type: Number, default: 0 },
    referralDiscountRate: {
      type: Number,
      default: 0,
      min: 0,
      max: 1,
    },
    referralDiscountAmount: { type: Number, default: 0 },
    referralCodeApplied: {
      type: String,
      trim: true,
      uppercase: true,
      default: "",
    },
    referralRelationshipId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ReferralRelationship",
      default: null,
      index: true,
    },
    addonProductId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ResourceProduct",
      default: null,
      index: true,
    },
    addonProductCode: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
    },
    addonBasePrice: { type: Number, default: 0 },
    addonFinalPrice: { type: Number, default: 0 },
    totalAmount: { type: Number, default: 0 },
    maxQuestionsPerSession: { type: Number, default: 2 },
    purchasePrice: { type: Number, default: 0 },
    paypalOrderId: { type: String, default: "" },
    stripePaymentIntentId: { type: String, default: "" },
    appleProductId: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    appleTransactionId: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    appleOriginalTransactionId: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    revenueCatProductId: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    revenueCatTransactionId: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    revenueCatOriginalTransactionId: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    paymentAccountFingerprint: {
      type: String,
      trim: true,
      default: "",
    },
    paymentStatus: {
      type: String,
      enum: ["pending", "completed", "failed", "refunded", "voided", "manual"],
      default: "pending",
    },
    purchasedAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    accessDuration: {
      type: String,
      enum: ["three_months", "six_months", "subscription", "lifetime"],
      default: "three_months",
    },
    expiresAt: { type: Date, default: null },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

examAccessSchema.index({ userId: 1, examId: 1 }, { unique: true });
examAccessSchema.index({ userId: 1, status: 1, expiresAt: 1 });

export const ExamAccess = mongoose.model("ExamAccess", examAccessSchema);
