import httpStatus from "http-status";
import AppError from "../errors/AppError.js";
import catchAsync from "../utils/catchAsync.js";
import sendResponse from "../utils/sendResponse.js";
import { Exam } from "../model/exam.model.js";
import { ExamAccess } from "../model/examAccess.model.js";
import { User } from "../model/user.model.js";
import { AppSetting } from "../model/appSetting.model.js";
import { ResourceProduct } from "../model/resourceProduct.model.js";
import { ResourcePurchase } from "../model/resourcePurchase.model.js";
import { ProfessionalPlanPurchase } from "../model/professionalPlanPurchase.model.js";
import { ExamSubscriptionTransaction } from "../model/examSubscriptionTransaction.model.js";
import { ReferralRelationship } from "../model/referralRelationship.model.js";
import Stripe from "stripe";
import mongoose from "mongoose";
import {
  applyResourceUnlocksToUser,
  getUpgradeCheckoutPrice,
  getUpgradeAddOnOptions,
  getUnlockCodesForProduct,
  normalizeProductCode,
  persistUserResourceUnlockCodes,
  resolveResourceRevenueTag,
  roundCurrency,
} from "../utils/resource.service.js";
import {
  REFERRAL_DISCOUNT_RATE,
  createPendingReferralReward,
  markRelationshipDisqualified,
  runUpgradeFraudChecks,
  voidReferralRewardsForExamAccess,
  voidReferralRewardsForPlanPurchase,
} from "../utils/referral.service.js";
import { refundRevenueCatTransaction } from "../utils/revenuecat.service.js";
import {
  addExamAccessMonths,
  buildLegacyExamEntitlementWindow,
  grantExamEntitlement,
  markExamSubscriptionTransactionStatus,
  recordPendingExamSubscription,
  revokeExamEntitlement,
} from "../utils/examSubscription.service.js";
import { isExamEntitlementActive } from "../utils/examAccess.helpers.js";

const PAYPAL_BASE_URL =
  process.env.PAYPAL_BASE_URL || "https://api-m.sandbox.paypal.com";
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || "";
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || "";
const DEFAULT_EXAM_PRICE = Number(process.env.EXAM_PRICE_PER_EXAM) || 150;
const DEFAULT_PRO_PLAN_PRICE =
  Number(process.env.PROFESSIONAL_PLAN_PRICE) || 199.99;
const DEFAULT_CURRENCY = process.env.EXAM_PRICE_CURRENCY || "USD";
const DEFAULT_PRO_PLAN_INTERVAL_COUNT = 6;
const DEFAULT_PRO_PLAN_INTERVAL_UNIT = "months";
const DEFAULT_PRO_PLAN_DESCRIPTION = "What's included in your plan";
const APPLE_PROFESSIONAL_PRODUCT_ID = "six_month_subscriptions";
const EXAM_IAP_PRODUCT_IDS = {
  API_1184: "com.inspectorspath.exam.api1184.sixmonth",
  API_510: "com.inspectorspath.exam.api510.sixmonth",
  API_570: "com.inspectorspath.exam.api570.sixmonth",
  API_653: "com.inspectorspath.exam.api653.sixmonth",
  API_936: "com.inspectorspath.exam.api936.sixmonth",
  API_1169: "com.inspectorspath.exam.api1169.sixmonth",
  API_SIEE: "com.inspectorspath.exam.siee.sixmonth",
  API_SIFE: "com.inspectorspath.exam.sife.sixmonth",
  API_SIRE: "com.inspectorspath.exam.sire.sixmonth",
};
const LEGACY_EXAM_IAP_PRODUCT_IDS = {
  API_1184: "com.inspectorspath.exam.api1184.unlock",
  API_510: "com.inspectorspath.exam.api510.unlock",
  API_570: "com.inspectorspath.exam.api570.unlock",
  API_653: "com.inspectorspath.exam.api653.unlock",
  API_936: "com.inspectorspath.exam.api936.unlock",
  API_1169: "com.inspectorspath.exam.api1169.unlock",
  API_SIEE: "com.inspectorspath.exam.siee.unlock",
  API_SIFE: "com.inspectorspath.exam.sife.unlock",
  API_SIRE: "com.inspectorspath.exam.sire.unlock",
};
const APPLE_VERIFY_PRODUCTION_URL =
  "https://buy.itunes.apple.com/verifyReceipt";
const APPLE_VERIFY_SANDBOX_URL =
  "https://sandbox.itunes.apple.com/verifyReceipt";
const DEFAULT_PRO_PLAN_FEATURES = [
  "One selected exam included for 6 months",
  "Full-length mock exams",
  "Timed & full simulation modes",
  "Interactive study mode",
  "Progress tracking, performance dashboard & exam history",
  "Detailed explanations with code references",
  "All smart study tools",
];
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";

const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

const parseObjectIdList = (value, fieldName) => {
  const rawItems = Array.isArray(value) ? value : [value];
  const ids = [...new Set(rawItems.map((item) => item?.toString().trim()).filter(Boolean))];

  if (!ids.length) {
    throw new AppError(httpStatus.BAD_REQUEST, `${fieldName} is required`);
  }

  const invalidIds = ids.filter((id) => !mongoose.Types.ObjectId.isValid(id));
  if (invalidIds.length) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `Invalid ${fieldName}: ${invalidIds.join(", ")}`
    );
  }

  return ids;
};

const getPricing = async () => {
  const settings = await AppSetting.findOne().lean();
  const referralCommissionRate = Number(settings?.referralCommissionRate);
  const safeReferralCommissionRate =
    Number.isFinite(referralCommissionRate) &&
    referralCommissionRate >= 0 &&
    referralCommissionRate <= 1
      ? referralCommissionRate
      : REFERRAL_DISCOUNT_RATE;

  return {
    examUnlockPrice: settings?.examUnlockPrice ?? DEFAULT_EXAM_PRICE,
    professionalPlanPrice:
      settings?.professionalPlanPrice ?? DEFAULT_PRO_PLAN_PRICE,
    currency: settings?.currency ?? DEFAULT_CURRENCY,
    referralCommissionRate: safeReferralCommissionRate,
  };
};

const getPlanSettings = async () => {
  const settings = await AppSetting.findOne().lean();
  return {
    professionalPlanIntervalCount:
      settings?.professionalPlanIntervalCount ?? DEFAULT_PRO_PLAN_INTERVAL_COUNT,
    professionalPlanIntervalUnit:
      settings?.professionalPlanIntervalUnit ?? DEFAULT_PRO_PLAN_INTERVAL_UNIT,
    professionalPlanDescription:
      settings?.professionalPlanDescription ?? DEFAULT_PRO_PLAN_DESCRIPTION,
    professionalPlanFeatures:
      settings?.professionalPlanFeatures ?? DEFAULT_PRO_PLAN_FEATURES,
  };
};

const getStripeClient = () => {
  if (!STRIPE_SECRET_KEY) {
    throw new AppError(
      httpStatus.INTERNAL_SERVER_ERROR,
      "Stripe credentials not configured"
    );
  }
  return new Stripe(STRIPE_SECRET_KEY);
};

const buildStripePaymentAccountFingerprint = (paymentIntent) => {
  const token = paymentIntent?.payment_method || paymentIntent?.customer || paymentIntent?.id;
  return token ? `stripe:${token}` : "";
};

const buildPayPalPaymentAccountFingerprint = (captureData) => {
  const payerId = captureData?.payer?.payer_id;
  const payerEmail = captureData?.payer?.email_address;
  const fallback =
    captureData?.payment_source?.paypal?.account_id ||
    captureData?.payment_source?.paypal?.email_address;
  const token = payerId || payerEmail || fallback || "";
  return token ? `paypal:${token}` : "";
};

const formatCardBrand = (value) => {
  const text = value?.toString().trim() || "";
  if (!text) return "";
  return text
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
};

const buildStripePaymentMethodLabel = (paymentIntent) => {
  const paymentMethod = paymentIntent?.payment_method;
  const latestCharge = paymentIntent?.latest_charge;
  const paymentMethodCard = paymentMethod?.card;
  const chargeCard = latestCharge?.payment_method_details?.card;
  const card = paymentMethodCard || chargeCard;
  if (!card) return "Card";

  const brand = formatCardBrand(card.brand);
  const last4 = card.last4?.toString().trim() || "";
  if (brand && last4) return `${brand} ending in ${last4}`;
  if (last4) return `Card ending in ${last4}`;
  return brand || "Card";
};

const buildStripeReceiptNumber = (paymentIntent) => {
  const latestCharge = paymentIntent?.latest_charge;
  return (
    latestCharge?.receipt_number?.toString().trim() ||
    latestCharge?.id?.toString().trim() ||
    paymentIntent?.id?.toString().trim() ||
    ""
  );
};

const buildStripeTransactionReference = (paymentIntent) =>
  paymentIntent?.id?.toString().trim() || "";

const buildPayPalPaymentMethodLabel = () => "PayPal";

const buildPayPalReceiptNumber = (captureData, orderId = "") =>
  captureData?.purchase_units?.[0]?.payments?.captures?.[0]?.id?.toString().trim() ||
  orderId?.toString().trim() ||
  "";

const buildPayPalTransactionReference = (captureData, orderId = "") =>
  captureData?.id?.toString().trim() ||
  captureData?.purchase_units?.[0]?.payments?.captures?.[0]?.id?.toString().trim() ||
  orderId?.toString().trim() ||
  "";

const getUpgradeAddonProduct = async (addonProductCodeOrId) => {
  if (!addonProductCodeOrId) return null;

  const normalizedCode = normalizeProductCode(addonProductCodeOrId);
  const orFilters = [{ code: normalizedCode }];
  if (mongoose.Types.ObjectId.isValid(addonProductCodeOrId)) {
    orFilters.push({ _id: addonProductCodeOrId });
  }

  const product = await ResourceProduct.findOne({
    $or: orFilters,
    isActive: true,
    showInUpgradeAddOn: true,
  });

  if (!product) {
    throw new AppError(httpStatus.NOT_FOUND, "Upgrade add-on product not found");
  }
  return product;
};

const toNormalizedAddonList = (value, normalizer = (item) => item) => {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizer).filter(Boolean))];
};

const getRequestedAddonSelections = (body = {}) => {
  const addonProductIds = toNormalizedAddonList(body?.addonProductIds, (item) =>
    item?.toString().trim()
  );
  const addonProductCodes = toNormalizedAddonList(
    body?.addonProductCodes,
    (item) => normalizeProductCode(item)
  );
  const addonProductId = body?.addonProductId?.toString().trim() || "";
  const addonProductCode = normalizeProductCode(body?.addonProductCode);

  const selections = [
    ...addonProductIds,
    ...addonProductCodes,
    ...(addonProductId ? [addonProductId] : []),
    ...(addonProductCode ? [addonProductCode] : []),
  ];

  return [...new Set(selections.filter(Boolean))];
};

const getUpgradeAddonProducts = async (addonSelections) => {
  const selections = Array.isArray(addonSelections)
    ? addonSelections
    : addonSelections
    ? [addonSelections]
    : [];
  const products = [];
  const seenProductIds = new Set();

  for (const selection of selections) {
    const product = await getUpgradeAddonProduct(selection);
    if (!product) continue;
    const productId = product._id.toString();
    if (seenProductIds.has(productId)) continue;
    seenProductIds.add(productId);
    products.push(product);
  }

  return products;
};

const getStoredAddonSelectionsFromDoc = (doc) => {
  if (!doc) return [];

  const metadataAddonIds = toNormalizedAddonList(
    doc?.metadata?.selectedAddonProductIds,
    (item) => item?.toString().trim()
  );
  const metadataAddonCodes = toNormalizedAddonList(
    doc?.metadata?.selectedAddonProductCodes,
    (item) => normalizeProductCode(item)
  );
  const legacyAddonProductId = doc?.addonProductId?.toString?.().trim?.() || "";
  const legacyAddonProductCode = normalizeProductCode(doc?.addonProductCode);

  return [
    ...metadataAddonIds,
    ...metadataAddonCodes,
    ...(legacyAddonProductId ? [legacyAddonProductId] : []),
    ...(legacyAddonProductCode ? [legacyAddonProductCode] : []),
  ];
};

const getActiveReferralRelationshipForUser = async (userId) => {
  if (!userId) return null;
  return ReferralRelationship.findOne({
    referredUserId: userId,
    status: "active",
  });
};

const buildReferrerName = (referrer) => {
  if (!referrer) return "Inspector";
  return (
    referrer.name ||
    [referrer.firstName, referrer.lastName].filter(Boolean).join(" ") ||
    "Inspector"
  );
};

const buildProfessionalUpgradeReferralState = async (user) => {
  if (!user?._id) {
    return {
      relationship: null,
      alreadyCompletedUpgrade: false,
      referralEligible: false,
      referralDiscountAmount: 0,
      referralDiscountRate: 0,
      referralOffer: null,
    };
  }

  const pricing = await getPricing();
  const planBasePrice = roundCurrency(pricing.professionalPlanPrice);
  const [relationship, alreadyCompletedUpgrade] = await Promise.all([
    getActiveReferralRelationshipForUser(user._id),
    hasCompletedProfessionalPurchase(user._id),
  ]);
  const referralEligible = Boolean(relationship) && !alreadyCompletedUpgrade;
  const referralDiscountRate = referralEligible
    ? pricing.referralCommissionRate
    : 0;
  const referralDiscountAmount = referralEligible
    ? roundCurrency(planBasePrice * referralDiscountRate)
    : 0;

  let referralOffer = null;
  if (referralEligible && relationship) {
    const referrer = await User.findById(relationship.referrerUserId).select(
      "name firstName lastName"
    );
    referralOffer = {
      referralCode: relationship.referralCode || "",
      referrerName: buildReferrerName(referrer),
      discountPercent: Math.round(referralDiscountRate * 100),
      appliesTo: "professional_plan_upgrade",
    };
  }

  return {
    relationship,
    alreadyCompletedUpgrade,
    referralEligible,
    referralDiscountAmount,
    referralDiscountRate,
    referralOffer,
  };
};

const splitProfessionalPlanCheckoutPricing = ({
  planBasePrice,
  addonCheckoutPrice,
  referralDiscountRate,
}) => {
  const safePlanBasePrice = roundCurrency(planBasePrice || 0);
  const safeAddonCheckoutPrice = roundCurrency(addonCheckoutPrice || 0);
  const subtotalBeforeReferral = roundCurrency(
    safePlanBasePrice + safeAddonCheckoutPrice
  );

  if (subtotalBeforeReferral <= 0 || referralDiscountRate <= 0) {
    return {
      subtotalBeforeReferral,
      referralDiscountAmount: 0,
      planFinalPrice: safePlanBasePrice,
      addonFinalPrice: safeAddonCheckoutPrice,
      totalAmount: subtotalBeforeReferral,
    };
  }

  const referralDiscountAmount = roundCurrency(
    subtotalBeforeReferral * referralDiscountRate
  );
  const addonReferralDiscountAmount = roundCurrency(
    (safeAddonCheckoutPrice / subtotalBeforeReferral) * referralDiscountAmount
  );
  const planReferralDiscountAmount = roundCurrency(
    referralDiscountAmount - addonReferralDiscountAmount
  );

  let planFinalPrice = roundCurrency(
    Math.max(safePlanBasePrice - planReferralDiscountAmount, 0)
  );
  let addonFinalPrice = roundCurrency(
    Math.max(safeAddonCheckoutPrice - addonReferralDiscountAmount, 0)
  );
  const totalAmount = roundCurrency(
    Math.max(subtotalBeforeReferral - referralDiscountAmount, 0)
  );
  const totalDifference = roundCurrency(
    totalAmount - (planFinalPrice + addonFinalPrice)
  );

  if (totalDifference !== 0) {
    const adjustedPlanFinalPrice = roundCurrency(planFinalPrice + totalDifference);
    if (adjustedPlanFinalPrice >= 0) {
      planFinalPrice = adjustedPlanFinalPrice;
    } else {
      addonFinalPrice = roundCurrency(
        Math.max(addonFinalPrice + totalDifference, 0)
      );
    }
  }

  return {
    subtotalBeforeReferral,
    referralDiscountAmount,
    planFinalPrice,
    addonFinalPrice,
    totalAmount,
  };
};

const hasCompletedProfessionalPurchase = async (userId) => {
  if (!userId) return false;
  const hit = await ProfessionalPlanPurchase.exists({
    userId,
    status: "completed",
  });
  return Boolean(hit);
};

const hasCompletedExamUnlockPurchase = async (userId) => {
  if (!userId) return false;
  const hit = await ExamAccess.exists({
    userId,
    purchaseType: "exam",
    status: { $in: ["active", "unlocked"] },
    paymentStatus: "completed",
  });
  return Boolean(hit);
};

const assertCanPurchaseAdditionalExam = (user) => {
  if (user?.subscriptionTier !== "professional") {
    throw new AppError(
      httpStatus.FORBIDDEN,
      "Complete the initial $199.99 subscription and select an included exam first"
    );
  }
};

const upsertExamAccessSafely = async (filter, update, options = {}) => {
  const upsertOptions = {
    new: true,
    upsert: true,
    setDefaultsOnInsert: true,
    ...options,
  };

  try {
    return await ExamAccess.findOneAndUpdate(filter, update, upsertOptions);
  } catch (error) {
    if (error?.code !== 11000) {
      throw error;
    }

    return ExamAccess.findOneAndUpdate(filter, update, { new: true });
  }
};

const normalizeExamIapCode = (value = "") => {
  const normalized = value
    .toString()
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (EXAM_IAP_PRODUCT_IDS[normalized]) return normalized;
  const match = normalized.match(/API_?(1184|510|570|653|936|1169|SIEE|SIFE|SIRE)/);
  return match ? `API_${match[1]}` : "";
};

const resolveExamAppleProductId = (exam) => {
  const code =
    normalizeExamIapCode(exam?.code) ||
    normalizeExamIapCode(exam?.examCode) ||
    normalizeExamIapCode(exam?.slug) ||
    normalizeExamIapCode(exam?.name);
  return code ? EXAM_IAP_PRODUCT_IDS[code] : "";
};

const resolveLegacyExamAppleProductId = (exam) => {
  const code =
    normalizeExamIapCode(exam?.code) ||
    normalizeExamIapCode(exam?.examCode) ||
    normalizeExamIapCode(exam?.slug) ||
    normalizeExamIapCode(exam?.name);
  return code ? LEGACY_EXAM_IAP_PRODUCT_IDS[code] : "";
};

const appleReceiptPassword = () =>
  process.env.APPLE_SHARED_SECRET ||
  process.env.APP_STORE_SHARED_SECRET ||
  process.env.APPLE_APP_SHARED_SECRET ||
  "";

const postAppleReceipt = async (url, receiptData) => {
  const body = {
    "receipt-data": receiptData,
    "exclude-old-transactions": false,
  };
  const password = appleReceiptPassword();
  if (password) body.password = password;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.json().catch(() => null);
};

const verifyAppleReceipt = async (receiptData) => {
  if (!receiptData || !receiptData.toString().trim()) {
    throw new AppError(httpStatus.BAD_REQUEST, "Apple receipt data is required");
  }

  let data = await postAppleReceipt(APPLE_VERIFY_PRODUCTION_URL, receiptData);
  if (data?.status === 21007) {
    data = await postAppleReceipt(APPLE_VERIFY_SANDBOX_URL, receiptData);
  } else if (data?.status === 21008) {
    data = await postAppleReceipt(APPLE_VERIFY_PRODUCTION_URL, receiptData);
  }

  if (!data || data.status !== 0) {
    throw new AppError(
      httpStatus.BAD_GATEWAY,
      `Apple receipt verification failed${data?.status ? ` (${data.status})` : ""}`
    );
  }

  return data;
};

const appleTransactionsFromReceipt = (verification) => {
  const receiptItems = Array.isArray(verification?.receipt?.in_app)
    ? verification.receipt.in_app
    : [];
  const latestItems = Array.isArray(verification?.latest_receipt_info)
    ? verification.latest_receipt_info
    : [];
  return [...latestItems, ...receiptItems];
};

const findAppleTransaction = ({ verification, productId, transactionId }) => {
  const expectedTransactionId = transactionId?.toString().trim() || "";
  const matches = appleTransactionsFromReceipt(verification).filter(
    (item) => item?.product_id === productId
  );
  if (!matches.length) return null;
  if (!expectedTransactionId) return matches[0];
  return (
    matches.find(
      (item) =>
        item?.transaction_id === expectedTransactionId ||
        item?.original_transaction_id === expectedTransactionId
    ) || matches[0]
  );
};

const assertAppleTransactionActive = (transaction) => {
  if (!transaction) {
    throw new AppError(httpStatus.BAD_REQUEST, "Apple transaction not found");
  }
  if (transaction.cancellation_date || transaction.cancellation_date_ms) {
    throw new AppError(httpStatus.BAD_REQUEST, "Apple transaction was cancelled");
  }
  if (transaction.expires_date_ms) {
    const expiresAt = new Date(Number(transaction.expires_date_ms));
    if (Number.isFinite(expiresAt.getTime()) && expiresAt <= new Date()) {
      throw new AppError(httpStatus.BAD_REQUEST, "Apple subscription is expired");
    }
  }
};

const appleVerificationPayload = (body = {}) => {
  const verificationData = body.verificationData || {};
  return {
    productId: body.productId?.toString().trim() || "",
    transactionId:
      body.transactionId?.toString().trim() ||
      body.purchaseID?.toString().trim() ||
      "",
    receiptData:
      verificationData.serverVerificationData?.toString().trim() ||
      verificationData.localVerificationData?.toString().trim() ||
      "",
    source: verificationData.source?.toString().trim() || "app_store",
    purchaseStatus: body.purchaseStatus?.toString().trim() || "",
  };
};

const buildExamCheckoutContext = async ({ user, addonSelection }) => {
  const pricing = await getPricing();
  const examBasePrice = roundCurrency(pricing.examUnlockPrice);
  const alreadyCompletedExamUnlock = await hasCompletedExamUnlockPurchase(
    user._id
  );
  const relationship = null;
  const referralEligible = false;
  const referralDiscountAmount = 0;
  const referralDiscountRate = 0;
  const examFinalPrice = roundCurrency(examBasePrice - referralDiscountAmount);

  const addonProducts = await getUpgradeAddonProducts(addonSelection);
  const addonBasePrice = roundCurrency(
    addonProducts.reduce(
      (sum, product) =>
        sum + Number(product.originalPrice ?? product.price ?? 0),
      0
    )
  );
  const addonFinalPrice = roundCurrency(
    addonProducts.reduce((sum, product) => sum + getUpgradeCheckoutPrice(product), 0)
  );
  const totalAmount = roundCurrency(examFinalPrice + addonFinalPrice);

  return {
    pricing,
    relationship,
    addonProducts,
    examBasePrice,
    referralDiscountRate,
    referralDiscountAmount,
    examFinalPrice,
    addonBasePrice,
    addonFinalPrice,
    totalAmount,
    referralEligible,
    alreadyCompletedExamUnlock,
  };
};

const unlockAddonProductFromExamAccess = async ({
  userId,
  addonProduct,
  examAccess,
  paymentFingerprint,
}) => {
  if (!addonProduct || !examAccess) return null;

  const purchaseType = "exam_unlock_addon";
  const basePrice = roundCurrency(addonProduct.originalPrice ?? addonProduct.price ?? 0);
  const finalPrice = roundCurrency(
    getUpgradeCheckoutPrice(addonProduct)
  );
  const discountAmount = roundCurrency(Math.max(basePrice - finalPrice, 0));

  const existingPurchase = await ResourcePurchase.findOne({
    userId,
    productId: addonProduct._id,
    purchaseType,
    "metadata.examAccessId": examAccess._id,
  });
  if (existingPurchase) {
    return existingPurchase;
  }

  const resourcePurchase = await ResourcePurchase.create({
    userId,
    categoryId: addonProduct.categoryId,
    productId: addonProduct._id,
    productCode: addonProduct.code,
    purchaseType,
    provider: examAccess.stripePaymentIntentId ? "stripe" : "paypal",
    status: "completed",
    revenueTag: resolveResourceRevenueTag(purchaseType, addonProduct.code),
    currency: examAccess.currency || addonProduct.currency || DEFAULT_CURRENCY,
    basePrice,
    finalPrice,
    discountAmount,
    stripePaymentIntentId: examAccess.stripePaymentIntentId || "",
    paypalOrderId: examAccess.paypalOrderId || "",
    paymentAccountFingerprint: paymentFingerprint || "",
    metadata: {
      source: "exam_unlock_addon",
      examAccessId: examAccess._id,
      examId: examAccess.examId,
    },
    purchasedAt: new Date(),
  });

  await applyResourceUnlocksToUser({
    userId,
    product: addonProduct,
  });

  return resourcePurchase;
};

const unlockAddonProductsFromExamAccess = async ({
  userId,
  addonProducts,
  examAccess,
  paymentFingerprint,
}) => {
  const purchases = [];
  const products = Array.isArray(addonProducts) ? addonProducts : [];

  for (const addonProduct of products) {
    const purchase = await unlockAddonProductFromExamAccess({
      userId,
      addonProduct,
      examAccess,
      paymentFingerprint,
    });
    if (purchase) purchases.push(purchase);
  }

  return purchases;
};

const buildProfessionalPlanCheckoutContext = async ({
  user,
  examId,
  provider,
  addonSelection,
}) => {
  const pricing = await getPricing();
  const planBasePrice = roundCurrency(pricing.professionalPlanPrice);
  const {
    relationship,
    alreadyCompletedUpgrade,
    referralEligible,
    referralDiscountRate,
  } = await buildProfessionalUpgradeReferralState(user);

  const addonProducts = await getUpgradeAddonProducts(addonSelection);
  const addonBasePrice = roundCurrency(
    addonProducts.reduce(
      (sum, product) =>
        sum + Number(product.originalPrice ?? product.price ?? 0),
      0
    )
  );
  const addonCheckoutPrice = roundCurrency(
    addonProducts.reduce((sum, product) => sum + getUpgradeCheckoutPrice(product), 0)
  );
  const {
    subtotalBeforeReferral,
    referralDiscountAmount,
    planFinalPrice,
    addonFinalPrice,
    totalAmount,
  } = splitProfessionalPlanCheckoutPricing({
    planBasePrice,
    addonCheckoutPrice,
    referralDiscountRate,
  });

  const revenueTags = ["professional_plan"];
  for (const addonProduct of addonProducts) {
    revenueTags.push(`pro_upgrade_addon:${addonProduct.code}`);
  }

  const singleAddonProduct = addonProducts.length === 1 ? addonProducts[0] : null;

  const planPurchase = await ProfessionalPlanPurchase.create({
    userId: user._id,
    examId,
    provider,
    status: "pending",
    currency: pricing.currency || DEFAULT_CURRENCY,
    planBasePrice,
    referralDiscountRate,
    referralDiscountAmount,
    planFinalPrice,
    addonProductId: singleAddonProduct?._id || null,
    addonProductCode: singleAddonProduct?.code || "",
    addonBasePrice,
    addonFinalPrice,
    totalAmount,
    revenueTags,
    referralCodeApplied: relationship?.referralCode || "",
    referralRelationshipId: relationship?._id || null,
    metadata: {
      referralEligible,
      alreadyCompletedUpgrade,
      subtotalBeforeReferral,
      selectedAddonProductIds: addonProducts.map((product) => product._id),
      selectedAddonProductCodes: addonProducts.map((product) => product.code),
    },
  });

  return {
    pricing,
    addonProducts,
    planPurchase,
    referralEligible,
  };
};

const distributePlanAddonFinalPrices = ({ addonProducts, totalAddonFinalPrice }) => {
  const products = Array.isArray(addonProducts) ? addonProducts : [];
  const allocations = new Map();
  if (products.length === 0) {
    return allocations;
  }

  const safeTotalAddonFinalPrice = roundCurrency(totalAddonFinalPrice || 0);
  if (safeTotalAddonFinalPrice <= 0) {
    for (const addonProduct of products) {
      allocations.set(addonProduct._id.toString(), 0);
    }
    return allocations;
  }

  const weightedProducts = products.map((addonProduct, index) => ({
    addonProduct,
    index,
    checkoutPrice: roundCurrency(getUpgradeCheckoutPrice(addonProduct)),
  }));
  const totalCheckoutCents = weightedProducts.reduce(
    (sum, entry) => sum + Math.round(entry.checkoutPrice * 100),
    0
  );

  if (totalCheckoutCents <= 0) {
    const equalShare = roundCurrency(safeTotalAddonFinalPrice / products.length);
    let runningTotal = 0;
    products.forEach((addonProduct, index) => {
      const isLast = index === products.length - 1;
      const finalPrice = isLast
        ? roundCurrency(Math.max(safeTotalAddonFinalPrice - runningTotal, 0))
        : equalShare;
      allocations.set(addonProduct._id.toString(), finalPrice);
      runningTotal = roundCurrency(runningTotal + finalPrice);
    });
    return allocations;
  }

  const totalFinalCents = Math.round(safeTotalAddonFinalPrice * 100);
  const allocationCandidates = weightedProducts.map((entry) => {
    const exactCents =
      (Math.round(entry.checkoutPrice * 100) / totalCheckoutCents) *
      totalFinalCents;
    const floorCents = Math.floor(exactCents);
    return {
      ...entry,
      allocatedCents: floorCents,
      remainder: exactCents - floorCents,
    };
  });

  let remainingCents =
    totalFinalCents -
    allocationCandidates.reduce((sum, entry) => sum + entry.allocatedCents, 0);

  allocationCandidates
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index)
    .forEach((entry) => {
      if (remainingCents <= 0) return;
      entry.allocatedCents += 1;
      remainingCents -= 1;
    });

  allocationCandidates.forEach((entry) => {
    allocations.set(
      entry.addonProduct._id.toString(),
      roundCurrency(entry.allocatedCents / 100)
    );
  });

  return allocations;
};

const unlockAddonProductFromPlanPurchase = async ({
  userId,
  addonProduct,
  planPurchase,
  paymentFingerprint,
  finalPriceOverride,
}) => {
  if (!addonProduct || !planPurchase) return null;

  const purchaseType = "professional_upgrade_addon";
  const basePrice = roundCurrency(addonProduct.originalPrice ?? addonProduct.price ?? 0);
  const finalPrice = roundCurrency(
    finalPriceOverride ?? getUpgradeCheckoutPrice(addonProduct)
  );
  const discountAmount = roundCurrency(Math.max(basePrice - finalPrice, 0));

  const existingPurchase = await ResourcePurchase.findOne({
    userId,
    productId: addonProduct._id,
    purchaseType,
    "metadata.professionalPlanPurchaseId": planPurchase._id,
  });
  if (existingPurchase) {
    return existingPurchase;
  }

  const resourcePurchase = await ResourcePurchase.create({
    userId,
    categoryId: addonProduct.categoryId,
    productId: addonProduct._id,
    productCode: addonProduct.code,
    purchaseType,
    provider: planPurchase.provider || "manual",
    status: "completed",
    revenueTag: resolveResourceRevenueTag(purchaseType, addonProduct.code),
    currency: planPurchase.currency || addonProduct.currency || DEFAULT_CURRENCY,
    basePrice,
    finalPrice,
    discountAmount,
    stripePaymentIntentId: planPurchase.stripePaymentIntentId || "",
    paypalOrderId: planPurchase.paypalOrderId || "",
    paymentAccountFingerprint: paymentFingerprint || "",
    metadata: {
      source: "professional_plan_upgrade",
      professionalPlanPurchaseId: planPurchase._id,
    },
    purchasedAt: new Date(),
  });

  await applyResourceUnlocksToUser({
    userId,
    product: addonProduct,
  });

  return resourcePurchase;
};

const unlockAddonProductsFromPlanPurchase = async ({
  userId,
  addonProducts,
  planPurchase,
  paymentFingerprint,
}) => {
  const purchases = [];
  const products = Array.isArray(addonProducts) ? addonProducts : [];
  const addonFinalPriceMap = distributePlanAddonFinalPrices({
    addonProducts: products,
    totalAddonFinalPrice: planPurchase?.addonFinalPrice,
  });

  for (const addonProduct of products) {
    const purchase = await unlockAddonProductFromPlanPurchase({
      userId,
      addonProduct,
      planPurchase,
      paymentFingerprint,
      finalPriceOverride: addonFinalPriceMap.get(addonProduct._id.toString()),
    });
    if (purchase) purchases.push(purchase);
  }

  return purchases;
};

const processReferralRewardForCompletedUpgrade = async ({
  user,
  planPurchase,
  paymentFingerprint,
}) => {
  if (!user || !planPurchase) return null;
  if ((planPurchase.referralDiscountAmount || 0) <= 0) return null;

  const relationship = planPurchase.referralRelationshipId
    ? await ReferralRelationship.findById(planPurchase.referralRelationshipId)
    : await ReferralRelationship.findOne({
        referredUserId: user._id,
        status: "active",
      });
  if (!relationship || relationship.status !== "active") {
    return null;
  }
  if (relationship.upgradedAt) {
    return null;
  }

  if (!planPurchase.referralRelationshipId) {
    planPurchase.referralRelationshipId = relationship._id;
  }
  if (!planPurchase.referralCodeApplied) {
    planPurchase.referralCodeApplied = relationship.referralCode || "";
  }
  await planPurchase.save();

  const referrer = await User.findById(relationship.referrerUserId).select(
    "_id email activeInstallationId"
  );
  if (!referrer) return null;

  const { fraudChecks, hasFraud } = await runUpgradeFraudChecks({
    referredUser: user,
    referrer,
    paymentAccountFingerprint: paymentFingerprint,
  });

  if (hasFraud) {
    await markRelationshipDisqualified({
      relationship,
      fraudChecks,
      reason: "Referral disqualified by fraud checks",
    });
    return null;
  }

  const reward = await createPendingReferralReward({
    relationship,
    planPurchase,
    commissionAmount: planPurchase.referralDiscountAmount,
    commissionRate: planPurchase.referralDiscountRate || REFERRAL_DISCOUNT_RATE,
    currency: planPurchase.currency || DEFAULT_CURRENCY,
  });

  relationship.upgradedAt = reward?.createdAt || new Date();
  await relationship.save();

  return reward;
};

const markPlanPurchaseStatusAndRewards = async ({ planPurchase, status, reason }) => {
  if (!planPurchase) return;
  planPurchase.status = status;
  await planPurchase.save();

  if (["cancelled", "failed", "refunded"].includes(status)) {
    await voidReferralRewardsForPlanPurchase({
      planPurchaseId: planPurchase._id,
      reason: reason || `Payment ${status}`,
    });
  }
};

const markExamAccessStatusAndRewards = async ({ examAccess, status, reason }) => {
  if (!examAccess) return;
  examAccess.paymentStatus = status;
  await examAccess.save();

  if (["cancelled", "failed", "refunded", "voided"].includes(status)) {
    await voidReferralRewardsForExamAccess({
      examAccessId: examAccess._id,
      reason: reason || `Payment ${status}`,
    });
  }
};

const addMonths = (date, months) => {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
};

const normalizePlanIntervalUnit = (unit) => {
  const value = unit?.toString().trim().toLowerCase();
  if (!value) return DEFAULT_PRO_PLAN_INTERVAL_UNIT;
  if (["month", "months"].includes(value)) return "months";
  if (["year", "years"].includes(value)) return "years";
  if (["week", "weeks"].includes(value)) return "weeks";
  if (["day", "days"].includes(value)) return "days";
  return DEFAULT_PRO_PLAN_INTERVAL_UNIT;
};

const addInterval = (date, count, unit) => {
  const normalizedUnit = normalizePlanIntervalUnit(unit);
  const result = new Date(date);

  if (normalizedUnit === "years") {
    result.setFullYear(result.getFullYear() + count);
    return result;
  }

  if (normalizedUnit === "weeks") {
    result.setDate(result.getDate() + count * 7);
    return result;
  }

  if (normalizedUnit === "days") {
    result.setDate(result.getDate() + count);
    return result;
  }

  return addMonths(result, count);
};

const formatIntervalLabel = (count, unit) => {
  const normalizedUnit = normalizePlanIntervalUnit(unit);
  const unitLabel =
    count === 1 ? normalizedUnit.replace(/s$/, "") : normalizedUnit;
  return `${count} ${unitLabel}`;
};

const getProfessionalPlanIntervalSettings = async () => {
  const settings = await AppSetting.findOne()
    .select("professionalPlanIntervalCount professionalPlanIntervalUnit")
    .lean();
  const count = Number(settings?.professionalPlanIntervalCount);

  return {
    count:
      Number.isFinite(count) && count > 0
        ? Math.ceil(count)
        : DEFAULT_PRO_PLAN_INTERVAL_COUNT,
    unit: normalizePlanIntervalUnit(settings?.professionalPlanIntervalUnit),
  };
};

const buildProfessionalSubscriptionWindow = async (startDate = new Date()) => {
  const { count, unit } = await getProfessionalPlanIntervalSettings();
  const subscriptionStartedAt = new Date(startDate);
  const subscriptionExpiresAt = addInterval(subscriptionStartedAt, count, unit);
  return {
    subscriptionStartedAt,
    subscriptionExpiresAt,
    intervalCount: count,
    intervalUnit: unit,
    intervalLabel: formatIntervalLabel(count, unit),
  };
};

const toStripeAmount = (amount, currency) => {
  const normalized = currency?.toString().trim().toUpperCase() || "USD";
  if (ZERO_DECIMAL_CURRENCIES.has(normalized)) {
    return Math.round(amount);
  }
  return Math.round(amount * 100);
};

const getPayPalAccessToken = async () => {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    throw new AppError(
      httpStatus.INTERNAL_SERVER_ERROR,
      "PayPal credentials not configured"
    );
  }
  const credentials = Buffer.from(
    `${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`
  ).toString("base64");
  const res = await fetch(`${PAYPAL_BASE_URL}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.access_token) {
    throw new AppError(httpStatus.BAD_GATEWAY, "Failed to authenticate with PayPal");
  }
  return data.access_token;
};

const refundPayPalTransaction = async ({ transaction, amount, currency }) => {
  if (!transaction.paypalOrderId) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "PayPal order ID is missing from this transaction"
    );
  }
  const token = await getPayPalAccessToken();
  const orderResponse = await fetch(
    `${PAYPAL_BASE_URL}/v2/checkout/orders/${encodeURIComponent(
      transaction.paypalOrderId
    )}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const order = await orderResponse.json().catch(() => null);
  if (!orderResponse.ok) {
    throw new AppError(
      httpStatus.BAD_GATEWAY,
      order?.message || "Failed to retrieve the PayPal transaction"
    );
  }
  const captureId =
    order?.purchase_units?.[0]?.payments?.captures?.[0]?.id?.toString().trim() ||
    "";
  if (!captureId) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "PayPal capture ID is missing from this transaction"
    );
  }

  const refundResponse = await fetch(
    `${PAYPAL_BASE_URL}/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: {
          value: roundCurrency(amount).toFixed(2),
          currency_code: currency?.toString().trim().toUpperCase() || "USD",
        },
      }),
    }
  );
  const refund = await refundResponse.json().catch(() => null);
  if (!refundResponse.ok || !refund?.id) {
    throw new AppError(
      httpStatus.BAD_GATEWAY,
      refund?.message || "PayPal refund failed"
    );
  }
  return refund;
};

const rebuildUserResourceAccess = async (userId) => {
  const completedPurchases = await ResourcePurchase.find({
    userId,
    status: "completed",
  }).populate("productId");
  const unlockCodes = new Set();
  for (const purchase of completedPurchases) {
    for (const code of getUnlockCodesForProduct(purchase.productId)) {
      unlockCodes.add(code);
    }
  }
  await persistUserResourceUnlockCodes({ userId, unlockCodes });
};

const shouldRevokeCurrentSubscription = (user, provider) => {
  const currentProvider = user?.subscriptionProvider
    ?.toString()
    .trim()
    .toLowerCase();
  // Legacy subscriptions predate provider tracking and retain the previous
  // behavior. Once a provider is known, refunding an old transaction from a
  // different provider must not revoke the user's current plan.
  return !currentProvider || currentProvider === provider;
};

export const createExamStripePaymentIntent = catchAsync(async (req, res) => {
  const userId = req.user?._id;
  const examId = req.params.examId;
  const addonSelection = getRequestedAddonSelections(req.body);
  if (!userId) throw new AppError(httpStatus.UNAUTHORIZED, "User not authenticated");
  if (!examId) throw new AppError(httpStatus.BAD_REQUEST, "examId is required");

  const [user, exam] = await Promise.all([
    User.findById(userId),
    Exam.findById(examId).lean(),
  ]);
  if (!user) throw new AppError(httpStatus.NOT_FOUND, "User not found");
  if (!exam) throw new AppError(httpStatus.NOT_FOUND, "Exam not found");
  assertCanPurchaseAdditionalExam(user);

  const existingAccess = await ExamAccess.findOne({ userId, examId });
  if (isExamEntitlementActive(existingAccess)) {
    throw new AppError(httpStatus.CONFLICT, "Exam subscription is already active");
  }

  const {
    pricing,
    relationship,
    addonProducts,
    examBasePrice,
    referralDiscountRate,
    referralDiscountAmount,
    examFinalPrice,
    addonBasePrice,
    addonFinalPrice,
    totalAmount,
    referralEligible,
    alreadyCompletedExamUnlock,
  } = await buildExamCheckoutContext({
    user,
    addonSelection,
  });

  const accessDoc = await ExamAccess.findOneAndUpdate(
    { userId, examId },
    {
      userId,
      examId,
      status: "free",
      paymentStatus: "pending",
      purchaseType: "exam",
      currency: pricing.currency || DEFAULT_CURRENCY,
      basePrice: examBasePrice,
      purchasePrice: examFinalPrice,
      referralDiscountRate,
      referralDiscountAmount,
      referralCodeApplied: relationship?.referralCode || "",
      referralRelationshipId: relationship?._id || null,
      addonProductId: addonProducts.length === 1 ? addonProducts[0]._id : null,
      addonProductCode: addonProducts.length === 1 ? addonProducts[0].code : "",
      addonBasePrice,
      addonFinalPrice,
      totalAmount,
      maxQuestionsPerSession: 2,
      metadata: {
        referralEligible,
        alreadyCompletedExamUnlock,
        selectedAddonProductIds: addonProducts.map((product) => product._id),
        selectedAddonProductCodes: addonProducts.map((product) => product.code),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const stripe = getStripeClient();
  const stripeCurrency = pricing.currency.toLowerCase();
  const amount = toStripeAmount(totalAmount, pricing.currency);

  const paymentIntent = await stripe.paymentIntents.create({
    amount,
    currency: stripeCurrency,
    description: `Unlock exam: ${exam.name}`,
    metadata: {
      userId: userId.toString(),
      examId: examId.toString(),
      purchaseType: "exam",
      examAccessId: accessDoc._id.toString(),
      referralCodeApplied: relationship?.referralCode || "",
      addonProductCodes: addonProducts.map((product) => product.code).join(","),
    },
  });

  await ExamAccess.findOneAndUpdate(
    { _id: accessDoc._id },
    {
      stripePaymentIntentId: paymentIntent.id,
      paypalOrderId: "",
    },
    { new: true }
  );
  await recordPendingExamSubscription({
    userId,
    examId,
    examAccessId: accessDoc._id,
    provider: "stripe",
    externalTransactionId: paymentIntent.id,
    amount: totalAmount,
    currency: pricing.currency,
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Stripe payment intent created",
    data: {
      paymentIntentId: paymentIntent.id,
      clientSecret: paymentIntent.client_secret,
      amount: totalAmount,
      currency: stripeCurrency,
      breakdown: {
        examBasePrice,
        referralDiscountAmount,
        examFinalPrice,
        addonProductCode:
          addonProducts.length === 1 ? addonProducts[0].code : null,
        addonProductCodes: addonProducts.map((product) => product.code),
        addonFinalPrice,
        totalAmount,
      },
      referral: {
        applied: referralDiscountAmount > 0,
        referralCode: relationship?.referralCode || "",
      },
    },
  });
});

export const confirmExamStripePayment = catchAsync(async (req, res) => {
  const userId = req.user?._id;
  const examId = req.params.examId;
  const { paymentIntentId } = req.body;

  if (!userId) throw new AppError(httpStatus.UNAUTHORIZED, "User not authenticated");
  if (!examId || !paymentIntentId) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "examId and paymentIntentId are required"
    );
  }

  const accessDoc = await ExamAccess.findOne({ userId, examId });
  if (isExamEntitlementActive(accessDoc)) {
    return sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "Exam already unlocked",
      data: { unlocked: true },
    });
  }

  const stripe = getStripeClient();
  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId, {
    expand: ["latest_charge", "payment_method"],
  });

  if (paymentIntent?.metadata?.examId !== examId.toString()) {
    throw new AppError(httpStatus.BAD_REQUEST, "Payment intent does not match exam");
  }
  if (paymentIntent?.metadata?.userId !== userId.toString()) {
    throw new AppError(httpStatus.BAD_REQUEST, "Payment intent does not match user");
  }

  if (paymentIntent.status !== "succeeded") {
    await markExamAccessStatusAndRewards({
      examAccess: accessDoc,
      status: "failed",
      reason: "Stripe payment not completed",
    });
    await markExamSubscriptionTransactionStatus({
      provider: "stripe",
      externalTransactionId: paymentIntentId,
      status: "failed",
      reason: "Stripe payment not completed",
    });
    throw new AppError(httpStatus.BAD_GATEWAY, "Stripe payment not completed");
  }

  const paymentFingerprint = buildStripePaymentAccountFingerprint(paymentIntent);

  const startedAt = new Date();
  const { access: updatedAccess } = await grantExamEntitlement({
    userId,
    examId,
    source: "exam_subscription",
    provider: "stripe",
    amount: accessDoc?.purchasePrice || accessDoc?.totalAmount || DEFAULT_EXAM_PRICE,
    currency: accessDoc?.currency || DEFAULT_CURRENCY,
    startedAt,
    externalTransactionId: paymentIntentId,
    paymentFields: {
      stripePaymentIntentId: paymentIntentId,
      paymentAccountFingerprint: paymentFingerprint,
    },
  });

  let addonPurchase = null;
  let addonPurchases = [];
  const addonSelections = getStoredAddonSelectionsFromDoc(updatedAccess);
  if (addonSelections.length > 0) {
    const addonProducts = await getUpgradeAddonProducts(addonSelections);
    addonPurchases = await unlockAddonProductsFromExamAccess({
      userId,
      addonProducts,
      examAccess: updatedAccess,
      paymentFingerprint,
    });
    addonPurchase = addonPurchases[0] || null;
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Exam unlocked",
    data: {
      unlocked: true,
      purchaseType: "exam",
      title: "Exam Unlock",
      amountPaid: updatedAccess.purchasePrice || updatedAccess.totalAmount || 0,
      currency: updatedAccess.currency || DEFAULT_CURRENCY,
      paymentMethodLabel: buildStripePaymentMethodLabel(paymentIntent),
      receiptNumber: buildStripeReceiptNumber(paymentIntent),
      transactionReference: buildStripeTransactionReference(paymentIntent),
      paidAt: updatedAccess.purchasedAt,
      provider: "stripe",
      startedAt: updatedAccess.startedAt,
      expiresAt: updatedAccess.expiresAt,
      durationMonths: 6,
      access: updatedAccess,
      addonPurchase,
      addonPurchases,
    },
  });
});

export const createProfessionalPlanStripePaymentIntent = catchAsync(
  async (req, res) => {
    const userId = req.user?._id;
    const { examId } = req.body;
    const addonSelection = getRequestedAddonSelections(req.body);

    if (!userId) {
      throw new AppError(httpStatus.UNAUTHORIZED, "User not authenticated");
    }
    if (!examId) {
      throw new AppError(httpStatus.BAD_REQUEST, "examId is required");
    }

    const user = await User.findById(userId);
    if (!user) throw new AppError(httpStatus.NOT_FOUND, "User not found");
    if (await hasCompletedProfessionalPurchase(userId)) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "Initial subscription has already been purchased"
      );
    }

    const exam = await Exam.findById(examId).lean();
    if (!exam) throw new AppError(httpStatus.NOT_FOUND, "Exam not found");

    const {
      pricing,
      addonProducts,
      planPurchase,
    } = await buildProfessionalPlanCheckoutContext({
      user,
      examId,
      provider: "stripe",
      addonSelection,
    });

    const stripe = getStripeClient();
    const stripeCurrency = pricing.currency.toLowerCase();
    const amount = toStripeAmount(planPurchase.totalAmount, pricing.currency);

    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: stripeCurrency,
      description: `Professional plan upgrade: ${exam.name}`,
      metadata: {
        userId: userId.toString(),
        examId: examId.toString(),
        purchaseType: "plan",
        planPurchaseId: planPurchase._id.toString(),
        addonProductCodes: addonProducts.map((product) => product.code).join(","),
      },
    });

    planPurchase.stripePaymentIntentId = paymentIntent.id;
    await planPurchase.save();

    await upsertExamAccessSafely(
      { userId, examId },
      {
        userId,
        examId,
        status: "free",
        paymentStatus: "pending",
        stripePaymentIntentId: paymentIntent.id,
        purchaseType: "plan",
        purchasePrice: planPurchase.planFinalPrice,
        maxQuestionsPerSession: 2,
      }
    );

    sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "Professional plan payment intent created",
      data: {
        paymentIntentId: paymentIntent.id,
        clientSecret: paymentIntent.client_secret,
        amount: planPurchase.totalAmount,
        currency: stripeCurrency,
        examId,
        pendingSelectionReference: planPurchase._id,
        breakdown: {
          planBasePrice: planPurchase.planBasePrice,
          subtotalBeforeReferral:
            planPurchase.metadata?.subtotalBeforeReferral ??
            roundCurrency(
              (planPurchase.planBasePrice || 0) + (planPurchase.addonFinalPrice || 0)
            ),
          referralDiscountAmount: planPurchase.referralDiscountAmount,
          planFinalPrice: planPurchase.planFinalPrice,
          addonProductCode: planPurchase.addonProductCode || null,
          addonProductCodes:
            planPurchase.metadata?.selectedAddonProductCodes || [],
          addonFinalPrice: planPurchase.addonFinalPrice || 0,
          totalAmount: planPurchase.totalAmount,
        },
      },
    });
  }
);

export const confirmProfessionalPlanStripePayment = catchAsync(
  async (req, res) => {
    const userId = req.user?._id;
    const { paymentIntentId } = req.body;
    if (!userId) {
      throw new AppError(httpStatus.UNAUTHORIZED, "User not authenticated");
    }
    if (!paymentIntentId) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "paymentIntentId is required"
      );
    }

    const user = await User.findById(userId);
    if (!user) throw new AppError(httpStatus.NOT_FOUND, "User not found");

    const planPurchase = await ProfessionalPlanPurchase.findOne({
      userId,
      stripePaymentIntentId: paymentIntentId,
    });
    if (!planPurchase) {
      throw new AppError(httpStatus.NOT_FOUND, "Pending plan purchase not found");
    }

    if (planPurchase.status === "completed") {
      return sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: "Professional plan already activated",
        data: {
          unlocked: true,
          planPurchaseId: planPurchase._id,
          subscriptionTier: "professional",
          subscriptionStartedAt: user.subscriptionStartedAt,
          subscriptionExpiresAt: user.subscriptionExpiresAt,
        },
      });
    }

    const stripe = getStripeClient();
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ["latest_charge", "payment_method"],
    });

    if (paymentIntent?.metadata?.userId !== userId.toString()) {
      throw new AppError(httpStatus.BAD_REQUEST, "Payment intent does not match user");
    }
    if (paymentIntent?.metadata?.planPurchaseId !== planPurchase._id.toString()) {
      throw new AppError(httpStatus.BAD_REQUEST, "Payment intent does not match purchase");
    }

    if (paymentIntent.status !== "succeeded") {
      await markPlanPurchaseStatusAndRewards({
        planPurchase,
        status: "failed",
        reason: "Stripe payment not completed",
      });
      throw new AppError(httpStatus.BAD_GATEWAY, "Stripe payment not completed");
    }

    const examId = planPurchase.examId || paymentIntent?.metadata?.examId;
    if (!examId) {
      throw new AppError(httpStatus.BAD_REQUEST, "Payment intent missing examId");
    }

    const { subscriptionStartedAt, subscriptionExpiresAt, intervalLabel } =
      await buildProfessionalSubscriptionWindow();

    const { access: updatedAccess } = await grantExamEntitlement({
      userId,
      examId,
      source: "initial_included",
      provider: "stripe",
      amount: 0,
      currency: planPurchase.currency || DEFAULT_CURRENCY,
      startedAt: subscriptionStartedAt,
      expiresAt: subscriptionExpiresAt,
      externalTransactionId: paymentIntentId,
      purchaseType: "plan",
      paymentFields: { stripePaymentIntentId: paymentIntentId },
      metadata: {
        includedWithInitialPrice: planPurchase.planFinalPrice,
        planPurchaseId: planPurchase._id,
      },
    });

    await User.findByIdAndUpdate(userId, {
      subscriptionTier: "professional",
      subscriptionStartedAt,
      subscriptionExpiresAt,
      subscriptionProvider: "stripe",
      subscriptionExternalId: paymentIntentId,
      subscriptionWillRenew: false,
    });

    planPurchase.status = "completed";
    planPurchase.paymentAccountFingerprint =
      buildStripePaymentAccountFingerprint(paymentIntent);
    planPurchase.purchasedAt = new Date();
    await planPurchase.save();

    const addonSelections = getStoredAddonSelectionsFromDoc(planPurchase);
    const addonProducts = await getUpgradeAddonProducts(addonSelections);
    const addonResourcePurchases = await unlockAddonProductsFromPlanPurchase({
      userId,
      addonProducts,
      planPurchase,
      paymentFingerprint: planPurchase.paymentAccountFingerprint,
    });
    const addonResourcePurchase = addonResourcePurchases[0] || null;

    await processReferralRewardForCompletedUpgrade({
      user,
      planPurchase,
      paymentFingerprint: planPurchase.paymentAccountFingerprint,
    });

    const refreshedUser = await User.findById(userId).select(
      "has_api510_inspection_guide has_api510_report_guide has_api510_bundle resourceUnlocks"
    );

    sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "Professional plan activated",
      data: {
        unlocked: true,
        purchaseType: "plan",
        title: "Professional Plan",
        amountPaid: planPurchase.totalAmount,
        currency: planPurchase.currency || DEFAULT_CURRENCY,
        billingCycleLabel: intervalLabel,
        nextBillingDate: subscriptionExpiresAt,
        paymentMethodLabel: buildStripePaymentMethodLabel(paymentIntent),
        receiptNumber: buildStripeReceiptNumber(paymentIntent),
        transactionReference: buildStripeTransactionReference(paymentIntent),
        paidAt: planPurchase.purchasedAt,
        provider: "stripe",
        access: updatedAccess,
        planPurchaseId: planPurchase._id,
        pricingBreakdown: {
          planBasePrice: planPurchase.planBasePrice,
          subtotalBeforeReferral:
            planPurchase.metadata?.subtotalBeforeReferral ??
            roundCurrency(
              (planPurchase.planBasePrice || 0) + (planPurchase.addonFinalPrice || 0)
            ),
          referralDiscountAmount: planPurchase.referralDiscountAmount,
          planFinalPrice: planPurchase.planFinalPrice,
          addonProductCode: planPurchase.addonProductCode || null,
          addonProductCodes:
            planPurchase.metadata?.selectedAddonProductCodes || [],
          addonFinalPrice: planPurchase.addonFinalPrice || 0,
          totalAmount: planPurchase.totalAmount,
        },
        addonUnlocked: addonResourcePurchases.length > 0,
        addonUnlockedCount: addonResourcePurchases.length,
        addonProductCode:
          addonProducts.length === 1 ? addonProducts[0].code : null,
        addonProductCodes: addonProducts.map((product) => product.code),
        addonPurchases: addonResourcePurchases,
        userResourceFlags: {
          has_api510_inspection_guide: Boolean(
            refreshedUser?.has_api510_inspection_guide
          ),
          has_api510_report_guide: Boolean(refreshedUser?.has_api510_report_guide),
          has_api510_bundle: Boolean(refreshedUser?.has_api510_bundle),
        },
        subscriptionTier: "professional",
        subscriptionStartedAt,
        subscriptionExpiresAt,
      },
    });
  }
);

export const verifyAppleExamPurchase = catchAsync(async (req, res) => {
  const userId = req.user?._id;
  const examId = req.params.examId;
  if (!userId) throw new AppError(httpStatus.UNAUTHORIZED, "User not authenticated");
  if (!examId) throw new AppError(httpStatus.BAD_REQUEST, "examId is required");

  const [user, exam] = await Promise.all([
    User.findById(userId),
    Exam.findById(examId).lean(),
  ]);
  if (!user) throw new AppError(httpStatus.NOT_FOUND, "User not found");
  if (!exam) throw new AppError(httpStatus.NOT_FOUND, "Exam not found");

  const expectedProductId = resolveExamAppleProductId(exam);
  const legacyProductId = resolveLegacyExamAppleProductId(exam);
  const payload = appleVerificationPayload(req.body);
  if (!expectedProductId) {
    throw new AppError(httpStatus.BAD_REQUEST, "Apple product is not configured for this exam");
  }
  if (
    payload.productId !== expectedProductId &&
    payload.productId !== legacyProductId
  ) {
    throw new AppError(httpStatus.BAD_REQUEST, "Apple product does not match exam");
  }
  if (payload.productId !== legacyProductId) {
    assertCanPurchaseAdditionalExam(user);
  }

  const verification = await verifyAppleReceipt(payload.receiptData);
  const transaction = findAppleTransaction({
    verification,
    productId: payload.productId,
    transactionId: payload.transactionId,
  });
  assertAppleTransactionActive(transaction);

  const appleTransactionId =
    transaction.transaction_id?.toString().trim() || payload.transactionId;
  const appleOriginalTransactionId =
    transaction.original_transaction_id?.toString().trim() || appleTransactionId;

  const duplicate = await ExamAccess.findOne({
    appleTransactionId,
    userId: { $ne: userId },
  }).lean();
  if (duplicate) {
    throw new AppError(httpStatus.CONFLICT, "Apple transaction already belongs to another account");
  }

  const pricing = await getPricing();
  const storePurchasedAt = transaction.purchase_date_ms
    ? new Date(Number(transaction.purchase_date_ms))
    : new Date();
  const isLegacyProduct = payload.productId === legacyProductId;
  const legacyWindow = isLegacyProduct
    ? buildLegacyExamEntitlementWindow(storePurchasedAt)
    : null;
  const startedAt = legacyWindow?.startedAt || storePurchasedAt;
  const storeExpiresAt = legacyWindow?.expiresAt || (transaction.expires_date_ms
    ? new Date(Number(transaction.expires_date_ms))
    : addExamAccessMonths(startedAt));
  const { access: updatedAccess } = await grantExamEntitlement({
    userId,
    examId,
    source: isLegacyProduct ? "legacy" : "exam_subscription",
    provider: "apple",
    amount: pricing.examUnlockPrice ?? DEFAULT_EXAM_PRICE,
    currency: pricing.currency || DEFAULT_CURRENCY,
    startedAt,
    expiresAt: storeExpiresAt,
    externalTransactionId: appleTransactionId,
    originalTransactionId: appleOriginalTransactionId,
    productId: payload.productId,
    paymentFields: {
      appleProductId: payload.productId,
      appleTransactionId,
      appleOriginalTransactionId,
      paymentAccountFingerprint: appleOriginalTransactionId
        ? `apple:${appleOriginalTransactionId}`
        : "",
    },
    metadata: {
      appleEnvironment: verification.environment || "",
      appleReceiptStatus: verification.status,
      purchaseStatus: payload.purchaseStatus,
      verificationSource: payload.source,
    },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Apple exam purchase verified",
    data: {
      unlocked: true,
      purchaseType: "exam",
      title: exam.name || "Exam Unlock",
      amountPaid: updatedAccess.purchasePrice || 0,
      currency: updatedAccess.currency || DEFAULT_CURRENCY,
      paymentMethodLabel: "Apple In-App Purchase",
      receiptNumber: appleTransactionId,
      transactionReference: appleTransactionId,
      paidAt: updatedAccess.purchasedAt,
      provider: "apple",
      startedAt: updatedAccess.startedAt,
      expiresAt: updatedAccess.expiresAt,
      durationMonths: 6,
      access: updatedAccess,
    },
  });
});

export const verifyAppleProfessionalPlanPurchase = catchAsync(async (req, res) => {
  const userId = req.user?._id;
  if (!userId) throw new AppError(httpStatus.UNAUTHORIZED, "User not authenticated");

  const payload = appleVerificationPayload(req.body);
  if (payload.productId !== APPLE_PROFESSIONAL_PRODUCT_ID) {
    throw new AppError(httpStatus.BAD_REQUEST, "Apple product does not match Professional Plan");
  }

  const user = await User.findById(userId);
  if (!user) throw new AppError(httpStatus.NOT_FOUND, "User not found");

  const examId = req.body?.examId?.toString().trim() || "";
  if (!examId) throw new AppError(httpStatus.BAD_REQUEST, "examId is required");
  const exam = await Exam.findOne({ _id: examId, status: "active" }).lean();
  if (!exam) throw new AppError(httpStatus.NOT_FOUND, "Active exam not found");
  const existingInitialPurchase = await ProfessionalPlanPurchase.findOne({
    userId,
    status: "completed",
  }).lean();
  if (
    existingInitialPurchase?.examId &&
    existingInitialPurchase.examId.toString() !== examId
  ) {
    throw new AppError(
      httpStatus.CONFLICT,
      "The included exam was already selected for the initial purchase"
    );
  }

  const verification = await verifyAppleReceipt(payload.receiptData);
  const transaction = findAppleTransaction({
    verification,
    productId: APPLE_PROFESSIONAL_PRODUCT_ID,
    transactionId: payload.transactionId,
  });
  assertAppleTransactionActive(transaction);

  const appleTransactionId =
    transaction.transaction_id?.toString().trim() || payload.transactionId;
  const appleOriginalTransactionId =
    transaction.original_transaction_id?.toString().trim() || appleTransactionId;
  const duplicate = await ProfessionalPlanPurchase.findOne({
    appleTransactionId,
    userId: { $ne: userId },
  }).lean();
  if (duplicate) {
    throw new AppError(httpStatus.CONFLICT, "Apple transaction already belongs to another account");
  }

  const pricing = await getPricing();
  const { subscriptionStartedAt, subscriptionExpiresAt, intervalLabel } =
    await buildProfessionalSubscriptionWindow();

  const planPurchase = await ProfessionalPlanPurchase.findOneAndUpdate(
    { userId, appleTransactionId },
    {
      userId,
      examId,
      provider: "apple",
      status: "completed",
      currency: pricing.currency || DEFAULT_CURRENCY,
      planBasePrice: pricing.professionalPlanPrice ?? DEFAULT_PRO_PLAN_PRICE,
      referralDiscountRate: 0,
      referralDiscountAmount: 0,
      planFinalPrice: pricing.professionalPlanPrice ?? DEFAULT_PRO_PLAN_PRICE,
      totalAmount: pricing.professionalPlanPrice ?? DEFAULT_PRO_PLAN_PRICE,
      appleProductId: APPLE_PROFESSIONAL_PRODUCT_ID,
      appleTransactionId,
      appleOriginalTransactionId,
      paymentAccountFingerprint: appleOriginalTransactionId
        ? `apple:${appleOriginalTransactionId}`
        : "",
      purchasedAt: transaction.purchase_date_ms
        ? new Date(Number(transaction.purchase_date_ms))
        : new Date(),
      metadata: {
        provider: "apple",
        appleEnvironment: verification.environment || "",
        appleReceiptStatus: verification.status,
        purchaseStatus: payload.purchaseStatus,
        verificationSource: payload.source,
        expiresDateMs: transaction.expires_date_ms || "",
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  const { access: updatedAccess } = await grantExamEntitlement({
    userId,
    examId,
    source: "initial_included",
    provider: "apple",
    amount: 0,
    currency: pricing.currency || DEFAULT_CURRENCY,
    startedAt: subscriptionStartedAt,
    expiresAt: subscriptionExpiresAt,
    externalTransactionId: appleTransactionId,
    originalTransactionId: appleOriginalTransactionId,
    productId: APPLE_PROFESSIONAL_PRODUCT_ID,
    purchaseType: "plan",
    paymentFields: {
      appleProductId: APPLE_PROFESSIONAL_PRODUCT_ID,
      appleTransactionId,
      appleOriginalTransactionId,
      paymentAccountFingerprint: planPurchase.paymentAccountFingerprint,
    },
    metadata: { planPurchaseId: planPurchase._id },
  });

  await User.findByIdAndUpdate(userId, {
    subscriptionTier: "professional",
    subscriptionStartedAt,
    subscriptionExpiresAt,
    subscriptionProvider: "apple",
    subscriptionExternalId: appleOriginalTransactionId,
    subscriptionWillRenew: true,
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Apple Professional Plan purchase verified",
    data: {
      unlocked: true,
      purchaseType: "plan",
      title: "Professional Plan",
      amountPaid: planPurchase.totalAmount,
      currency: planPurchase.currency || DEFAULT_CURRENCY,
      billingCycleLabel: intervalLabel,
      nextBillingDate: subscriptionExpiresAt,
      paymentMethodLabel: "Apple In-App Purchase",
      receiptNumber: appleTransactionId,
      transactionReference: appleTransactionId,
      paidAt: planPurchase.purchasedAt,
      provider: "apple",
      access: updatedAccess,
      planPurchaseId: planPurchase._id,
      subscriptionTier: "professional",
      subscriptionStartedAt,
      subscriptionExpiresAt,
    },
  });
});

export const createExamPayPalOrder = catchAsync(async (req, res) => {
  const userId = req.user?._id;
  const examId = req.params.examId;
  const addonSelection = getRequestedAddonSelections(req.body);
  if (!userId) throw new AppError(httpStatus.UNAUTHORIZED, "User not authenticated");
  if (!examId) throw new AppError(httpStatus.BAD_REQUEST, "examId is required");

  const [user, exam] = await Promise.all([
    User.findById(userId),
    Exam.findById(examId).lean(),
  ]);
  if (!user) throw new AppError(httpStatus.NOT_FOUND, "User not found");
  if (!exam) throw new AppError(httpStatus.NOT_FOUND, "Exam not found");
  assertCanPurchaseAdditionalExam(user);

  const existingAccess = await ExamAccess.findOne({ userId, examId });
  if (isExamEntitlementActive(existingAccess)) {
    throw new AppError(httpStatus.CONFLICT, "Exam subscription is already active");
  }

  const {
    pricing,
    relationship,
    addonProducts,
    examBasePrice,
    referralDiscountRate,
    referralDiscountAmount,
    examFinalPrice,
    addonBasePrice,
    addonFinalPrice,
    totalAmount,
    referralEligible,
    alreadyCompletedExamUnlock,
  } = await buildExamCheckoutContext({
    user,
    addonSelection,
  });

  const accessDoc = await ExamAccess.findOneAndUpdate(
    { userId, examId },
    {
      userId,
      examId,
      status: "free",
      paymentStatus: "pending",
      purchaseType: "exam",
      currency: pricing.currency || DEFAULT_CURRENCY,
      basePrice: examBasePrice,
      purchasePrice: examFinalPrice,
      referralDiscountRate,
      referralDiscountAmount,
      referralCodeApplied: relationship?.referralCode || "",
      referralRelationshipId: relationship?._id || null,
      addonProductId: addonProducts.length === 1 ? addonProducts[0]._id : null,
      addonProductCode: addonProducts.length === 1 ? addonProducts[0].code : "",
      addonBasePrice,
      addonFinalPrice,
      totalAmount,
      maxQuestionsPerSession: 2,
      metadata: {
        referralEligible,
        alreadyCompletedExamUnlock,
        selectedAddonProductIds: addonProducts.map((product) => product._id),
        selectedAddonProductCodes: addonProducts.map((product) => product.code),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const token = await getPayPalAccessToken();

  const orderRes = await fetch(`${PAYPAL_BASE_URL}/v2/checkout/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: {
            currency_code: pricing.currency,
            value: totalAmount.toFixed(2),
          },
          description: `Unlock exam: ${exam.name}`,
          custom_id: accessDoc._id.toString(),
        },
      ],
      application_context: {
        brand_name: "Exam Unlock",
        landing_page: "NO_PREFERENCE",
        user_action: "PAY_NOW",
      },
    }),
  });

  const orderData = await orderRes.json().catch(() => null);
  if (!orderRes.ok || !orderData?.id) {
    throw new AppError(httpStatus.BAD_GATEWAY, "Failed to create PayPal order");
  }

  await ExamAccess.findOneAndUpdate(
    { _id: accessDoc._id },
    {
      paypalOrderId: orderData.id,
      stripePaymentIntentId: "",
    },
    { new: true }
  );
  await recordPendingExamSubscription({
    userId,
    examId,
    examAccessId: accessDoc._id,
    provider: "paypal",
    externalTransactionId: orderData.id,
    amount: totalAmount,
    currency: pricing.currency,
  });

  const approvalLink =
    orderData.links?.find((l) => l.rel === "approve")?.href || null;

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "PayPal order created",
    data: {
      orderId: orderData.id,
      approvalLink,
      amount: totalAmount,
      currency: pricing.currency,
      breakdown: {
        examBasePrice,
        referralDiscountAmount,
        examFinalPrice,
        addonProductCode:
          addonProducts.length === 1 ? addonProducts[0].code : null,
        addonProductCodes: addonProducts.map((product) => product.code),
        addonFinalPrice,
        totalAmount,
      },
      referral: {
        applied: referralDiscountAmount > 0,
        referralCode: relationship?.referralCode || "",
      },
    },
  });
});

export const captureExamPayPalOrder = catchAsync(async (req, res) => {
  const userId = req.user?._id;
  const examId = req.params.examId;
  const { orderId } = req.body;

  if (!userId) throw new AppError(httpStatus.UNAUTHORIZED, "User not authenticated");
  if (!examId || !orderId) {
    throw new AppError(httpStatus.BAD_REQUEST, "examId and orderId are required");
  }

  const accessDoc = await ExamAccess.findOne({ userId, examId });
  if (isExamEntitlementActive(accessDoc)) {
    return sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "Exam already unlocked",
      data: { unlocked: true },
    });
  }

  const token = await getPayPalAccessToken();

  const captureRes = await fetch(
    `${PAYPAL_BASE_URL}/v2/checkout/orders/${orderId}/capture`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    }
  );

  const captureData = await captureRes.json().catch(() => null);
  if (!captureRes.ok) {
    throw new AppError(
      httpStatus.BAD_GATEWAY,
      "Failed to capture PayPal order"
    );
  }

  const purchaseState =
    captureData?.status ||
    captureData?.purchase_units?.[0]?.payments?.captures?.[0]?.status;

  if (!["COMPLETED"].includes(purchaseState)) {
    await markExamAccessStatusAndRewards({
      examAccess: accessDoc,
      status: "failed",
      reason: "PayPal capture not completed",
    });
    await markExamSubscriptionTransactionStatus({
      provider: "paypal",
      externalTransactionId: orderId,
      status: "failed",
      reason: "PayPal capture not completed",
    });
    throw new AppError(httpStatus.BAD_GATEWAY, "PayPal capture not completed");
  }

  const paymentFingerprint = buildPayPalPaymentAccountFingerprint(captureData);

  const { access: updatedAccess } = await grantExamEntitlement({
    userId,
    examId,
    source: "exam_subscription",
    provider: "paypal",
    amount: accessDoc?.purchasePrice || accessDoc?.totalAmount || DEFAULT_EXAM_PRICE,
    currency: accessDoc?.currency || DEFAULT_CURRENCY,
    externalTransactionId: orderId,
    paymentFields: {
      paypalOrderId: orderId,
      paymentAccountFingerprint: paymentFingerprint,
    },
  });

  let addonPurchase = null;
  let addonPurchases = [];
  const addonSelections = getStoredAddonSelectionsFromDoc(updatedAccess);
  if (addonSelections.length > 0) {
    const addonProducts = await getUpgradeAddonProducts(addonSelections);
    addonPurchases = await unlockAddonProductsFromExamAccess({
      userId,
      addonProducts,
      examAccess: updatedAccess,
      paymentFingerprint,
    });
    addonPurchase = addonPurchases[0] || null;
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Exam unlocked",
    data: {
      unlocked: true,
      purchaseType: "exam",
      title: "Exam Unlock",
      amountPaid: updatedAccess.purchasePrice || updatedAccess.totalAmount || 0,
      currency: updatedAccess.currency || DEFAULT_CURRENCY,
      paymentMethodLabel: buildPayPalPaymentMethodLabel(),
      receiptNumber: buildPayPalReceiptNumber(captureData, orderId),
      transactionReference: buildPayPalTransactionReference(captureData, orderId),
      paidAt: updatedAccess.purchasedAt,
      provider: "paypal",
      startedAt: updatedAccess.startedAt,
      expiresAt: updatedAccess.expiresAt,
      durationMonths: 6,
      access: updatedAccess,
      addonPurchase,
      addonPurchases,
    },
  });
});

export const createProfessionalPlanOrder = catchAsync(async (req, res) => {
  const userId = req.user?._id;
  const { examId } = req.body;
  const addonSelection = getRequestedAddonSelections(req.body);
  if (!userId) throw new AppError(httpStatus.UNAUTHORIZED, "User not authenticated");
  if (!examId) throw new AppError(httpStatus.BAD_REQUEST, "examId is required");

  const user = await User.findById(userId);
  if (!user) throw new AppError(httpStatus.NOT_FOUND, "User not found");
  if (await hasCompletedProfessionalPurchase(userId)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Initial subscription has already been purchased");
  }

  const exam = await Exam.findById(examId).lean();
  if (!exam) throw new AppError(httpStatus.NOT_FOUND, "Exam not found");

  const {
    pricing,
    addonProducts,
    planPurchase,
  } = await buildProfessionalPlanCheckoutContext({
    user,
    examId,
    provider: "paypal",
    addonSelection,
  });

  const token = await getPayPalAccessToken();

  const orderRes = await fetch(`${PAYPAL_BASE_URL}/v2/checkout/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: {
            currency_code: pricing.currency,
            value: planPurchase.totalAmount.toFixed(2),
          },
          description: `Professional plan upgrade: ${exam.name}`,
        },
      ],
      application_context: {
        brand_name: "Professional Plan",
        landing_page: "NO_PREFERENCE",
        user_action: "PAY_NOW",
      },
    }),
  });

  const orderData = await orderRes.json().catch(() => null);
  if (!orderRes.ok || !orderData?.id) {
    throw new AppError(httpStatus.BAD_GATEWAY, "Failed to create PayPal order");
  }

  planPurchase.paypalOrderId = orderData.id;
  await planPurchase.save();

  await upsertExamAccessSafely(
    { userId, examId },
    {
      userId,
      examId,
      status: "free",
      paymentStatus: "pending",
      paypalOrderId: orderData.id,
      purchaseType: "plan",
      purchasePrice: planPurchase.planFinalPrice,
      maxQuestionsPerSession: 2,
    }
  );

  const approvalLink =
    orderData.links?.find((l) => l.rel === "approve")?.href || null;

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Professional plan order created",
    data: {
      orderId: orderData.id,
      approvalLink,
      amount: planPurchase.totalAmount,
      currency: pricing.currency,
      examId,
      pendingSelectionReference: planPurchase._id,
      breakdown: {
        planBasePrice: planPurchase.planBasePrice,
        referralDiscountAmount: planPurchase.referralDiscountAmount,
        planFinalPrice: planPurchase.planFinalPrice,
        addonProductCode:
          addonProducts.length === 1 ? addonProducts[0].code : null,
        addonProductCodes:
          planPurchase.metadata?.selectedAddonProductCodes || [],
        addonFinalPrice: planPurchase.addonFinalPrice || 0,
        totalAmount: planPurchase.totalAmount,
      },
    },
  });
});

export const captureProfessionalPlanOrder = catchAsync(async (req, res) => {
  const userId = req.user?._id;
  const { orderId } = req.body;
  if (!userId) throw new AppError(httpStatus.UNAUTHORIZED, "User not authenticated");
  if (!orderId) {
    throw new AppError(httpStatus.BAD_REQUEST, "orderId is required");
  }

  const user = await User.findById(userId);
  if (!user) throw new AppError(httpStatus.NOT_FOUND, "User not found");

  const planPurchase = await ProfessionalPlanPurchase.findOne({
    userId,
    paypalOrderId: orderId,
  });
  if (!planPurchase) {
    throw new AppError(httpStatus.NOT_FOUND, "Pending plan order not found");
  }

  if (planPurchase.status === "completed") {
    return sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "Professional plan already activated",
      data: {
        unlocked: true,
        planPurchaseId: planPurchase._id,
        subscriptionTier: user.subscriptionTier,
        subscriptionStartedAt: user.subscriptionStartedAt,
        subscriptionExpiresAt: user.subscriptionExpiresAt,
      },
    });
  }

  const token = await getPayPalAccessToken();
  const captureRes = await fetch(
    `${PAYPAL_BASE_URL}/v2/checkout/orders/${orderId}/capture`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    }
  );

  const captureData = await captureRes.json().catch(() => null);
  if (!captureRes.ok) {
    await markPlanPurchaseStatusAndRewards({
      planPurchase,
      status: "failed",
      reason: "Failed to capture PayPal order",
    });
    console.log(captureData);
    throw new AppError(
      httpStatus.BAD_GATEWAY,
      "Failed to capture PayPal order"
    );
  }

  const purchaseState =
    captureData?.status ||
    captureData?.purchase_units?.[0]?.payments?.captures?.[0]?.status;

  if (!["COMPLETED"].includes(purchaseState)) {
    await markPlanPurchaseStatusAndRewards({
      planPurchase,
      status: "failed",
      reason: "PayPal capture not completed",
    });
    throw new AppError(httpStatus.BAD_GATEWAY, "PayPal capture not completed");
  }

  const { subscriptionStartedAt, subscriptionExpiresAt, intervalLabel } =
    await buildProfessionalSubscriptionWindow();

  const { access: updatedAccess } = await grantExamEntitlement({
    userId,
    examId: planPurchase.examId,
    source: "initial_included",
    provider: "paypal",
    amount: 0,
    currency: planPurchase.currency || DEFAULT_CURRENCY,
    startedAt: subscriptionStartedAt,
    expiresAt: subscriptionExpiresAt,
    externalTransactionId: orderId,
    purchaseType: "plan",
    paymentFields: { paypalOrderId: orderId },
    metadata: {
      includedWithInitialPrice: planPurchase.planFinalPrice,
      planPurchaseId: planPurchase._id,
    },
  });

  await User.findByIdAndUpdate(userId, {
    subscriptionTier: "professional",
    subscriptionStartedAt,
    subscriptionExpiresAt,
    subscriptionProvider: "paypal",
    subscriptionExternalId: orderId,
    subscriptionWillRenew: false,
  });

  planPurchase.status = "completed";
  planPurchase.paymentAccountFingerprint =
    buildPayPalPaymentAccountFingerprint(captureData);
  planPurchase.purchasedAt = new Date();
  await planPurchase.save();

  const addonSelections = getStoredAddonSelectionsFromDoc(planPurchase);
  const addonProducts = await getUpgradeAddonProducts(addonSelections);
  const addonResourcePurchases = await unlockAddonProductsFromPlanPurchase({
    userId,
    addonProducts,
    planPurchase,
    paymentFingerprint: planPurchase.paymentAccountFingerprint,
  });
  const addonResourcePurchase = addonResourcePurchases[0] || null;

  await processReferralRewardForCompletedUpgrade({
    user,
    planPurchase,
    paymentFingerprint: planPurchase.paymentAccountFingerprint,
  });

  const refreshedUser = await User.findById(userId).select(
    "has_api510_inspection_guide has_api510_report_guide has_api510_bundle resourceUnlocks"
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Professional plan activated",
    data: {
      unlocked: true,
      purchaseType: "plan",
      title: "Professional Plan",
      amountPaid: planPurchase.totalAmount,
      currency: planPurchase.currency || DEFAULT_CURRENCY,
      billingCycleLabel: intervalLabel,
      nextBillingDate: subscriptionExpiresAt,
      paymentMethodLabel: buildPayPalPaymentMethodLabel(),
      receiptNumber: buildPayPalReceiptNumber(captureData, orderId),
      transactionReference: buildPayPalTransactionReference(captureData, orderId),
      paidAt: planPurchase.purchasedAt,
      provider: "paypal",
      access: updatedAccess,
      planPurchaseId: planPurchase._id,
      pricingBreakdown: {
        planBasePrice: planPurchase.planBasePrice,
        subtotalBeforeReferral:
          planPurchase.metadata?.subtotalBeforeReferral ??
          roundCurrency(
            (planPurchase.planBasePrice || 0) + (planPurchase.addonFinalPrice || 0)
          ),
        referralDiscountAmount: planPurchase.referralDiscountAmount,
        planFinalPrice: planPurchase.planFinalPrice,
        addonProductCode: planPurchase.addonProductCode || null,
        addonProductCodes:
          planPurchase.metadata?.selectedAddonProductCodes || [],
        addonFinalPrice: planPurchase.addonFinalPrice || 0,
        totalAmount: planPurchase.totalAmount,
      },
      addonUnlocked: addonResourcePurchases.length > 0,
      addonUnlockedCount: addonResourcePurchases.length,
      addonProductCode:
        addonProducts.length === 1 ? addonProducts[0].code : null,
      addonProductCodes: addonProducts.map((product) => product.code),
      addonPurchases: addonResourcePurchases,
      userResourceFlags: {
        has_api510_inspection_guide: Boolean(
          refreshedUser?.has_api510_inspection_guide
        ),
        has_api510_report_guide: Boolean(refreshedUser?.has_api510_report_guide),
        has_api510_bundle: Boolean(refreshedUser?.has_api510_bundle),
      },
      subscriptionTier: "professional",
      subscriptionStartedAt,
      subscriptionExpiresAt,
    },
  });
});

export const updateProfessionalPlanPurchaseStatus = catchAsync(async (req, res) => {
  const { purchaseId } = req.params;
  const status = req.body?.status?.toString().trim().toLowerCase();
  const reason = req.body?.reason?.toString().trim() || "";

  if (!purchaseId || !status) {
    throw new AppError(httpStatus.BAD_REQUEST, "purchaseId and status are required");
  }

  const allowedStatuses = ["pending", "completed", "failed", "cancelled", "refunded"];
  if (!allowedStatuses.includes(status)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid status");
  }

  const purchase = await ProfessionalPlanPurchase.findById(purchaseId);
  if (!purchase) {
    throw new AppError(httpStatus.NOT_FOUND, "Professional plan purchase not found");
  }

  await markPlanPurchaseStatusAndRewards({
    planPurchase: purchase,
    status,
    reason,
  });

  if (["cancelled", "failed", "refunded"].includes(status)) {
    await ExamAccess.findOneAndUpdate(
      { userId: purchase.userId, examId: purchase.examId },
      {
        paymentStatus: status === "failed" ? "failed" : status === "refunded" ? "refunded" : "voided",
      }
    );

    await ResourcePurchase.updateMany(
      {
        userId: purchase.userId,
        "metadata.professionalPlanPurchaseId": purchase._id,
      },
      {
        $set: {
          status,
        },
      }
    );

    if (["cancelled", "refunded"].includes(status) && purchase.examId) {
      await revokeExamEntitlement({
        userId: purchase.userId,
        examId: purchase.examId,
        reason: reason || `Initial purchase ${status}`,
        transactionStatus: status === "refunded" ? "refunded" : "revoked",
      });
    }
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Professional plan purchase status updated",
    data: purchase,
  });
});

export const getUserTransactions = catchAsync(async (req, res) => {
  const { userId } = req.params;
  if (!userId) throw new AppError(httpStatus.BAD_REQUEST, "userId is required");

  const [planPurchases, examSubscriptions, resourcePurchases] = await Promise.all([
    ProfessionalPlanPurchase.find({ userId })
      .populate("examId", "name")
      .sort({ createdAt: -1 })
      .lean(),
    ExamSubscriptionTransaction.find({ userId })
      .populate("examId", "name")
      .sort({ createdAt: -1 })
      .lean(),
    ResourcePurchase.find({ userId })
      .populate("productId", "title productCode")
      .sort({ createdAt: -1 })
      .lean(),
  ]);

  const transactions = [
    ...planPurchases.map((p) => ({ ...p, transactionType: "plan" })),
    ...examSubscriptions.map((p) => ({ ...p, transactionType: "exam" })),
    ...resourcePurchases.map((p) => ({ ...p, transactionType: "resource" })),
  ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "User transactions fetched",
    data: transactions,
  });
});

export const processRefund = catchAsync(async (req, res) => {
  const { transactionId } = req.params;
  const type = req.body?.type?.toString().trim().toLowerCase();
  const amount = req.body?.amount;
  const reason = req.body?.reason?.toString().trim();
  const transactionType = req.body?.transactionType
    ?.toString()
    .trim()
    .toLowerCase();
  const adminId = req.user?._id;

  if (!transactionId || !type || !reason || !transactionType) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "transactionId, type, reason, and transactionType are required"
    );
  }
  if (!["full", "partial"].includes(type)) {
    throw new AppError(httpStatus.BAD_REQUEST, "type must be 'full' or 'partial'");
  }
  if (!["plan", "exam", "resource"].includes(transactionType)) {
    throw new AppError(httpStatus.BAD_REQUEST, "transactionType must be 'plan', 'exam', or 'resource'");
  }

  const Model = transactionType === "plan"
    ? ProfessionalPlanPurchase
    : transactionType === "exam"
      ? ExamSubscriptionTransaction
      : ResourcePurchase;
  const transaction = await Model.findById(transactionId);

  if (!transaction) {
    throw new AppError(httpStatus.NOT_FOUND, "Transaction not found");
  }

  const paidAmount =
    transaction.totalAmount ?? transaction.finalPrice ?? transaction.amount ?? 0;
  const alreadyRefunded = transaction.refundedAmount || 0;
  const refundable = paidAmount - alreadyRefunded;

  if (refundable <= 0) {
    throw new AppError(httpStatus.BAD_REQUEST, "This transaction has no remaining refundable amount");
  }

  const provider = transaction.provider?.toString().trim().toLowerCase() || "manual";
  if (provider === "revenuecat" && type !== "full") {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "RevenueCat store transactions support full refunds only"
    );
  }
  if (provider === "revenuecat" && transactionType === "exam") {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Refund this exam subscription through RevenueCat or the store; the webhook will revoke only that exam"
    );
  }
  if (provider === "apple") {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Apple refunds must be issued in App Store Connect; RevenueCat will synchronize the refund through the webhook"
    );
  }

  let refundAmount;
  if (type === "full") {
    refundAmount = refundable;
  } else {
    const parsed = Number(amount);
    if (!parsed || parsed <= 0) {
      throw new AppError(httpStatus.BAD_REQUEST, "A valid amount is required for partial refund");
    }
    if (parsed > refundable) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        `Refund amount ($${parsed}) exceeds remaining refundable amount ($${refundable.toFixed(2)})`
      );
    }
    refundAmount = parsed;
  }

  // Issue the provider refund before touching local state so provider failures
  // cannot create false refund records in MongoDB.
  let stripeRefundId = "";
  let paypalRefundId = "";
  let revenueCatRefundId = "";
  if (provider === "stripe") {
    const stripePaymentIntentId =
      transaction.stripePaymentIntentId ||
      (transactionType === "exam" ? transaction.externalTransactionId : "");
    if (!stripePaymentIntentId) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "Stripe payment intent ID is missing from this transaction"
      );
    }
    const stripe = getStripeClient();
    const currency = transaction.currency ?? "USD";
    const stripeRefund = await stripe.refunds.create({
      payment_intent: stripePaymentIntentId,
      amount: toStripeAmount(refundAmount, currency),
      reason: "requested_by_customer",
    });
    stripeRefundId = stripeRefund.id;
  } else if (provider === "paypal") {
    const paypalRefund = await refundPayPalTransaction({
      transaction:
        transactionType === "exam"
          ? { ...transaction.toObject(), paypalOrderId: transaction.externalTransactionId }
          : transaction,
      amount: refundAmount,
      currency: transaction.currency,
    });
    paypalRefundId = paypalRefund.id;
  } else if (provider === "revenuecat") {
    const revenueCatRefund = await refundRevenueCatTransaction(transaction);
    revenueCatRefundId =
      revenueCatRefund?.id?.toString().trim() ||
      transaction.revenueCatTransactionId ||
      "";
  }

  const newRefundedAmount = alreadyRefunded + refundAmount;
  const isFullyRefunded = newRefundedAmount >= paidAmount;

  transaction.refundedAmount = newRefundedAmount;
  transaction.refundStatus = isFullyRefunded ? "full" : "partial";
  transaction.refundHistory.push({
    refundedAt: new Date(),
    amount: refundAmount,
    reason,
    adminId: adminId || null,
    type,
    stripeRefundId,
    paypalRefundId,
    revenueCatRefundId,
  });

  if (isFullyRefunded) {
    transaction.status = "refunded";
  }

  if (isFullyRefunded && transactionType === "plan") {
    await markPlanPurchaseStatusAndRewards({
      planPurchase: transaction,
      status: "refunded",
      reason,
    });
    await ResourcePurchase.updateMany(
      { userId: transaction.userId, "metadata.professionalPlanPurchaseId": transaction._id },
      { $set: { status: "refunded" } }
    );
  } else {
    await transaction.save();
  }

  if (isFullyRefunded && transactionType === "exam") {
    await revokeExamEntitlement({
      userId: transaction.userId,
      examId: transaction.examId,
      externalTransactionId: transaction.externalTransactionId,
      reason,
      transactionStatus: "refunded",
    });
  }

  const subscribedUser =
    transactionType === "plan" && isFullyRefunded
      ? await User.findById(transaction.userId)
      : null;
  const revokeCurrentPlan =
    transactionType === "plan" &&
    isFullyRefunded &&
    shouldRevokeCurrentSubscription(subscribedUser, provider);

  if (revokeCurrentPlan) {
    if (transaction.examId) {
      await revokeExamEntitlement({
        userId: transaction.userId,
        examId: transaction.examId,
        reason: "Initial purchase refunded",
      });
    }
    await User.findByIdAndUpdate(transaction.userId, {
      subscriptionTier: "professional",
      subscriptionWillRenew: false,
      subscriptionRevokedAt: new Date(),
    });
  }

  if (isFullyRefunded) {
    await rebuildUserResourceAccess(transaction.userId);
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: `Refund of $${refundAmount.toFixed(2)} processed successfully`,
    data: transaction,
  });
});

export const getTransactionRefunds = catchAsync(async (req, res) => {
  const { transactionId } = req.params;
  const { transactionType } = req.query;

  if (!transactionId || !transactionType) {
    throw new AppError(httpStatus.BAD_REQUEST, "transactionId and transactionType are required");
  }

  const Model = transactionType === "plan"
    ? ProfessionalPlanPurchase
    : transactionType === "exam"
      ? ExamSubscriptionTransaction
      : ResourcePurchase;
  const transaction = await Model.findById(transactionId)
    .populate("refundHistory.adminId", "firstName lastName email")
    .lean();

  if (!transaction) {
    throw new AppError(httpStatus.NOT_FOUND, "Transaction not found");
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Refund history fetched",
    data: {
      transactionId,
      transactionType,
      totalAmount:
        transaction.totalAmount ?? transaction.finalPrice ?? transaction.amount ?? 0,
      refundedAmount: transaction.refundedAmount || 0,
      refundStatus: transaction.refundStatus || "none",
      refundHistory: transaction.refundHistory || [],
    },
  });
});

export const manualUnlockExam = catchAsync(async (req, res) => {
  const { userId } = req.body;
  const examId = req.params.examId;
  if (!userId || !examId) {
    throw new AppError(httpStatus.BAD_REQUEST, "userId and examId are required");
  }

  const user = await User.findById(userId);
  if (!user) throw new AppError(httpStatus.NOT_FOUND, "User not found");

  const exam = await Exam.findById(examId).lean();
  if (!exam) throw new AppError(httpStatus.NOT_FOUND, "Exam not found");

  const { access: updatedAccess } = await grantExamEntitlement({
    userId,
    examId,
    source: "manual",
    provider: "manual",
    amount: 0,
    purchaseType: "manual",
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Exam unlocked manually",
    data: updatedAccess,
  });
});

export const manualUnlockExamsBulk = catchAsync(async (req, res) => {
  const { userId } = req.body;
  const examIds = parseObjectIdList(req.body?.examIds, "examIds");

  if (!userId) {
    throw new AppError(httpStatus.BAD_REQUEST, "userId is required");
  }

  const user = await User.findById(userId).select("_id").lean();
  if (!user) throw new AppError(httpStatus.NOT_FOUND, "User not found");

  const exams = await Exam.find({ _id: { $in: examIds } }).select("_id name").lean();
  if (exams.length !== examIds.length) {
    const foundIds = new Set(exams.map((exam) => exam._id.toString()));
    const missingIds = examIds.filter((examId) => !foundIds.has(examId));
    throw new AppError(
      httpStatus.NOT_FOUND,
      `Exam not found: ${missingIds.join(", ")}`
    );
  }

  await Promise.all(
    examIds.map((examId) =>
      grantExamEntitlement({
        userId,
        examId,
        source: "manual",
        provider: "manual",
        amount: 0,
        purchaseType: "manual",
      })
    )
  );

  const unlockedAccesses = await ExamAccess.find({
    userId,
    examId: { $in: examIds },
  }).lean();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Exams unlocked manually",
    data: {
      userId,
      examIds,
      count: unlockedAccesses.length,
      unlocks: unlockedAccesses,
    },
  });
});

export const manualLockExam = catchAsync(async (req, res) => {
  const { userId } = req.body;
  const examId = req.params.examId;
  if (!userId || !examId) {
    throw new AppError(httpStatus.BAD_REQUEST, "userId and examId are required");
  }

  const user = await User.findById(userId);
  if (!user) throw new AppError(httpStatus.NOT_FOUND, "User not found");

  const exam = await Exam.findById(examId).lean();
  if (!exam) throw new AppError(httpStatus.NOT_FOUND, "Exam not found");

  const existingAccess = await ExamAccess.findOne({
    userId,
    examId,
    status: { $in: ["active", "unlocked"] },
  });
  if (!existingAccess) {
    return sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "Exam already locked",
      data: { locked: true },
    });
  }

  existingAccess.status = "revoked";
  existingAccess.maxQuestionsPerSession = 2;
  existingAccess.metadata = {
    ...(existingAccess.metadata || {}),
    revocationReason: "Manual lock",
  };
  await existingAccess.save();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Exam locked manually",
    data: existingAccess,
  });
});

export const manualLockExamsBulk = catchAsync(async (req, res) => {
  const { userId } = req.body;
  const examIds = parseObjectIdList(req.body?.examIds, "examIds");

  if (!userId) {
    throw new AppError(httpStatus.BAD_REQUEST, "userId is required");
  }

  const user = await User.findById(userId).select("_id").lean();
  if (!user) throw new AppError(httpStatus.NOT_FOUND, "User not found");

  const exams = await Exam.find({ _id: { $in: examIds } }).select("_id name").lean();
  if (exams.length !== examIds.length) {
    const foundIds = new Set(exams.map((exam) => exam._id.toString()));
    const missingIds = examIds.filter((examId) => !foundIds.has(examId));
    throw new AppError(
      httpStatus.NOT_FOUND,
      `Exam not found: ${missingIds.join(", ")}`
    );
  }

  await ExamAccess.bulkWrite(
    examIds.map((examId) => ({
      updateOne: {
        filter: { userId, examId, status: { $in: ["active", "unlocked"] } },
        update: {
          $set: {
            status: "revoked",
            maxQuestionsPerSession: 2,
            "metadata.revocationReason": "Manual lock",
          },
        },
      },
    }))
  );

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Exams locked manually",
    data: {
      userId,
      examIds,
      count: examIds.length,
      locked: true,
    },
  });
});

export const updatePricingSettings = catchAsync(async (req, res) => {
  const updates = {};
  if (req.body.professionalPlanPrice !== undefined) {
    const price = Number(req.body.professionalPlanPrice);
    if (Number.isNaN(price) || price <= 0) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "professionalPlanPrice must be a positive number"
      );
    }
    updates.professionalPlanPrice = price;
  }
  if (req.body.examUnlockPrice !== undefined) {
    const price = Number(req.body.examUnlockPrice);
    if (Number.isNaN(price) || price <= 0) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "examUnlockPrice must be a positive number"
      );
    }
    updates.examUnlockPrice = price;
  }
  if (
    req.body.referralCommissionRate !== undefined ||
    req.body.referralCommissionPercent !== undefined
  ) {
    let rate =
      req.body.referralCommissionPercent !== undefined
        ? Number(req.body.referralCommissionPercent) / 100
        : Number(req.body.referralCommissionRate);

    // Accept percentage-style values on referralCommissionRate as a convenience.
    if (rate > 1 && rate <= 100) {
      rate = rate / 100;
    }

    if (Number.isNaN(rate) || rate < 0 || rate > 1) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "referralCommissionRate must be between 0 and 1 (or 0-100 via referralCommissionPercent)"
      );
    }
    updates.referralCommissionRate = Math.round(rate * 10000) / 10000;
  }
  if (req.body.currency !== undefined) {
    const currency = req.body.currency?.toString().trim().toUpperCase();
    if (!currency) {
      throw new AppError(httpStatus.BAD_REQUEST, "currency is required");
    }
    updates.currency = currency;
  }
  if (req.body.professionalPlanIntervalCount !== undefined) {
    const count = Number(req.body.professionalPlanIntervalCount);
    if (Number.isNaN(count) || count <= 0) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "professionalPlanIntervalCount must be a positive number"
      );
    }
    updates.professionalPlanIntervalCount = Math.ceil(count);
  }
  if (req.body.professionalPlanIntervalUnit !== undefined) {
    const unit = req.body.professionalPlanIntervalUnit
      ?.toString()
      .trim()
      .toLowerCase();
    if (!unit) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "professionalPlanIntervalUnit is required"
      );
    }
    updates.professionalPlanIntervalUnit = unit;
  }
  if (req.body.professionalPlanDescription !== undefined) {
    const description = req.body.professionalPlanDescription
      ?.toString()
      .trim();
    if (!description) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "professionalPlanDescription is required"
      );
    }
    updates.professionalPlanDescription = description;
  }
  if (req.body.professionalPlanFeatures !== undefined) {
    const raw = req.body.professionalPlanFeatures;
    let parsed = [];
    if (typeof raw === "string") {
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        throw new AppError(
          httpStatus.BAD_REQUEST,
          "professionalPlanFeatures must be valid JSON"
        );
      }
    } else if (Array.isArray(raw)) {
      parsed = raw;
    }
    const features = parsed
      .map((item) => item?.toString().trim())
      .filter(Boolean);
    if (!features.length) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "professionalPlanFeatures must be a non-empty array"
      );
    }
    updates.professionalPlanFeatures = features;
  }

  const settings = await AppSetting.findOneAndUpdate({}, updates, {
    upsert: true,
    new: true,
    setDefaultsOnInsert: true,
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Pricing updated",
    data: settings,
  });
});

export const getPricingSettings = catchAsync(async (req, res) => {
  const pricing = await getPricing();
  const plan = await getPlanSettings();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Pricing settings fetched",
    data: {
      ...pricing,
      ...plan,
    },
  });
});

export const getProfessionalPlan = catchAsync(async (req, res) => {
  const settings = await AppSetting.findOne().lean();
  const addOnOptions = await getUpgradeAddOnOptions();
  const price = settings?.professionalPlanPrice ?? DEFAULT_PRO_PLAN_PRICE;
  const unlockExamPrice = settings?.examUnlockPrice ?? DEFAULT_EXAM_PRICE;
  const currency = settings?.currency ?? DEFAULT_CURRENCY;
  const intervalCount =
    settings?.professionalPlanIntervalCount ?? DEFAULT_PRO_PLAN_INTERVAL_COUNT;
  const intervalUnit =
    settings?.professionalPlanIntervalUnit ?? DEFAULT_PRO_PLAN_INTERVAL_UNIT;
  const description =
    settings?.professionalPlanDescription ?? DEFAULT_PRO_PLAN_DESCRIPTION;
  const features =
    settings?.professionalPlanFeatures ?? DEFAULT_PRO_PLAN_FEATURES;
  const referralState = req.user
    ? await buildProfessionalUpgradeReferralState(req.user)
    : {
        referralEligible: false,
        referralOffer: null,
      };

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Professional plan fetched",
    data: {
      plan: {
        id: "professional",
        name: "Professional Plan",
        price,
        unlockExamPrice,
        currency,
        interval: {
          count: intervalCount,
          unit: intervalUnit,
          label: formatIntervalLabel(intervalCount, intervalUnit),
        },
        description,
        features,
        initialPrice: price,
        examSubscriptionPrice: unlockExamPrice,
        durationMonths: 6,
        renewalMode: "manual",
        referralEligible: referralState.referralEligible,
        referralOffer: referralState.referralOffer,
      },
      prePurchaseAddOnOptions: addOnOptions,
    },
  });
});

export const getRevenueSummary = catchAsync(async (req, res) => {
  const [examRevenueAgg] = await ExamSubscriptionTransaction.aggregate([
    {
      $match: {
        status: "completed",
        source: "exam_subscription",
      },
    },
    {
      $group: {
        _id: null,
        totalRevenue: {
          $sum: { $subtract: ["$amount", { $ifNull: ["$refundedAmount", 0] }] },
        },
        totalUnlockedExams: { $sum: 1 },
      },
    },
  ]);

  const [planRevenueAgg, resourceRevenueAgg] = await Promise.all([
    ProfessionalPlanPurchase.aggregate([
      { $match: { status: "completed" } },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: "$totalAmount" },
          totalUpgrades: { $sum: 1 },
        },
      },
    ]),
    ResourcePurchase.aggregate([
      { $match: { status: "completed" } },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: "$finalPrice" },
          totalPurchases: { $sum: 1 },
        },
      },
    ]),
  ]);

  const examRevenue = examRevenueAgg?.totalRevenue || 0;
  const planRevenue = planRevenueAgg?.[0]?.totalRevenue || 0;
  const resourceRevenue = resourceRevenueAgg?.[0]?.totalRevenue || 0;
  const totalRevenue = roundCurrency(examRevenue + planRevenue + resourceRevenue);
  const totalUnlockedExams = examRevenueAgg?.totalUnlockedExams || 0;
  const totalProfessionalUpgrades = planRevenueAgg?.[0]?.totalUpgrades || 0;
  const totalResourcePurchases = resourceRevenueAgg?.[0]?.totalPurchases || 0;

  const totalFreeExams = await ExamAccess.countDocuments({ status: "free" });

  const today = new Date();
  const startDate = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - 6
  );

  const examDailyRevenue = await ExamSubscriptionTransaction.aggregate([
    {
      $match: {
        status: "completed",
        source: "exam_subscription",
        createdAt: { $gte: startDate },
      },
    },
    {
      $group: {
        _id: {
          $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
        },
        revenue: {
          $sum: { $subtract: ["$amount", { $ifNull: ["$refundedAmount", 0] }] },
        },
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const planDailyRevenue = await ProfessionalPlanPurchase.aggregate([
    {
      $match: {
        status: "completed",
        createdAt: { $gte: startDate },
      },
    },
    {
      $group: {
        _id: {
          $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
        },
        revenue: { $sum: "$totalAmount" },
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const resourceDailyRevenue = await ResourcePurchase.aggregate([
    {
      $match: {
        status: "completed",
        createdAt: { $gte: startDate },
      },
    },
    {
      $group: {
        _id: {
          $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
        },
        revenue: { $sum: "$finalPrice" },
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const mergeDaily = (target, item, sourceKey) => {
    if (!target[item._id]) {
      target[item._id] = {
        date: item._id,
        revenue: 0,
        examRevenue: 0,
        planRevenue: 0,
        resourceRevenue: 0,
        count: 0,
        examCount: 0,
        planCount: 0,
        resourceCount: 0,
      };
    }

    target[item._id].revenue = roundCurrency(target[item._id].revenue + Number(item.revenue || 0));
    target[item._id].count += Number(item.count || 0);
    target[item._id][`${sourceKey}Revenue`] = roundCurrency(
      target[item._id][`${sourceKey}Revenue`] + Number(item.revenue || 0)
    );
    target[item._id][`${sourceKey}Count`] += Number(item.count || 0);
  };

  const dailyMap = {};
  examDailyRevenue.forEach((item) => mergeDaily(dailyMap, item, "exam"));
  planDailyRevenue.forEach((item) => mergeDaily(dailyMap, item, "plan"));
  resourceDailyRevenue.forEach((item) => mergeDaily(dailyMap, item, "resource"));

  const dailyRevenue = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Revenue summary fetched",
    data: {
      totalRevenue,
      totalUnlockedExams,
      totalProfessionalUpgrades,
      totalResourcePurchases,
      totalFreeExams,
      breakdown: {
        examRevenue: roundCurrency(examRevenue),
        planRevenue: roundCurrency(planRevenue),
        resourceRevenue: roundCurrency(resourceRevenue),
      },
      dailyRevenue,
    },
  });
});

export const listPurchases = catchAsync(async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.max(parseInt(req.query.limit, 10) || 10, 1);
  const skip = (page - 1) * limit;

  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.paymentStatus) filter.paymentStatus = req.query.paymentStatus;
  if (req.query.purchaseType) filter.purchaseType = req.query.purchaseType;
  if (req.query.examId) filter.examId = req.query.examId;
  if (req.query.userId) filter.userId = req.query.userId;

  const [items, total] = await Promise.all([
    ExamAccess.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    ExamAccess.countDocuments(filter),
  ]);

  const userIds = [
    ...new Set(items.map((i) => i.userId?.toString()).filter(Boolean)),
  ];
  const examIds = [
    ...new Set(items.map((i) => i.examId?.toString()).filter(Boolean)),
  ];

  const [users, exams] = await Promise.all([
    userIds.length
      ? User.find({ _id: { $in: userIds } })
          .select("name email firstName lastName")
          .lean()
      : [],
    examIds.length
      ? Exam.find({ _id: { $in: examIds } }).select("name").lean()
      : [],
  ]);

  const userMap = {};
  users.forEach((u) => {
    userMap[u._id.toString()] = {
      name: u.name || `${u.firstName || ""} ${u.lastName || ""}`.trim(),
      email: u.email,
    };
  });

  const examMap = {};
  exams.forEach((e) => {
    examMap[e._id.toString()] = e.name;
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Purchases fetched",
    data: {
      purchases: items.map((i) => ({
        id: i._id,
        user: userMap[i.userId?.toString()] || null,
        examName: examMap[i.examId?.toString()] || null,
        examId: i.examId,
        status: i.status,
        purchaseType: i.purchaseType,
        paymentStatus: i.paymentStatus,
        price: i.purchasePrice,
        maxQuestionsPerSession: i.maxQuestionsPerSession,
        purchasedAt: i.purchasedAt,
        createdAt: i.createdAt,
      })),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    },
  });
});

export const listProfessionalPlanPurchases = catchAsync(async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.max(parseInt(req.query.limit, 10) || 10, 1);
  const skip = (page - 1) * limit;

  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.userId) filter.userId = req.query.userId;
  if (req.query.provider) filter.provider = req.query.provider;
  if (req.query.examId) filter.examId = req.query.examId;

  const [items, total] = await Promise.all([
    ProfessionalPlanPurchase.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("userId", "name firstName lastName email")
      .populate("examId", "name")
      .populate("addonProductId", "title code")
      .lean(),
    ProfessionalPlanPurchase.countDocuments(filter),
  ]);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Professional plan purchases fetched",
    data: {
      purchases: items,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    },
  });
});
