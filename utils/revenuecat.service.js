import httpStatus from "http-status";
import mongoose from "mongoose";
import AppError from "../errors/AppError.js";
import { Exam } from "../model/exam.model.js";
import { ExamAccess } from "../model/examAccess.model.js";
import { ProfessionalPlanPurchase } from "../model/professionalPlanPurchase.model.js";
import { User } from "../model/user.model.js";
import { buildSelectedExamUnlockResponse } from "./examAccess.helpers.js";
import {
  addExamAccessMonths,
  buildLegacyExamEntitlementWindow,
  grantExamEntitlement,
  revokeExamEntitlement,
} from "./examSubscription.service.js";
import {
  internalProductIdentifierFromObject,
  isRevenueCatRefundEvent,
  productIdentifierFromObject,
  revenueCatActionSucceeded,
  revenueCatPurchaseIsUsable,
  revenueCatPurchasesIncludeProduct,
  revenueCatSubscriptionWasCancelled,
} from "./revenuecat.helpers.js";

export { isRevenueCatRefundEvent } from "./revenuecat.helpers.js";

const REVENUECAT_API_ORIGIN = "https://api.revenuecat.com";
const API_TIMEOUT_MS = 15000;
const MAX_PAGES = 20;
const productStoreIdentifierCache = new Map();

const EXAM_PRODUCT_CODES = new Map([
  ["com.inspectorspath.exam.api1184.sixmonth", "API_1184"],
  ["com.inspectorspath.exam.api510.sixmonth", "API_510"],
  ["com.inspectorspath.exam.api570.sixmonth", "API_570"],
  ["com.inspectorspath.exam.api653.sixmonth", "API_653"],
  ["com.inspectorspath.exam.api936.sixmonth", "API_936"],
  ["com.inspectorspath.exam.api1169.sixmonth", "API_1169"],
  ["com.inspectorspath.exam.siee.sixmonth", "API_SIEE"],
  ["com.inspectorspath.exam.sife.sixmonth", "API_SIFE"],
  ["com.inspectorspath.exam.sire.sixmonth", "API_SIRE"],
  ["com.inspectorspath.exam.api1184.sixmonth:api1184sixmonth", "API_1184"],
  ["com.inspectorspath.exam.api510.sixmonth:api510sixmonth", "API_510"],
  ["com.inspectorspath.exam.api570.sixmonth:api570sixmonth", "API_570"],
  ["com.inspectorspath.exam.api653.sixmonth:api653sixmonth", "API_653"],
  ["com.inspectorspath.exam.api936.sixmonth:api936sixmonth", "API_936"],
  ["com.inspectorspath.exam.api1169.sixmonth:api1169sixmonth", "API_1169"],
  ["com.inspectorspath.exam.siee.sixmonth:sieesixmonth", "API_SIEE"],
  ["com.inspectorspath.exam.sife.sixmonth:sifesixmonth", "API_SIFE"],
  ["com.inspectorspath.exam.sire.sixmonth:siresixmonth", "API_SIRE"],
  // Legacy one-time identifiers are read for migration/restore only.
  ["com.inspectorspath.exam.api1184.unlock", "API_1184"],
  ["com.inspectorspath.exam.api510.unlock", "API_510"],
  ["com.inspectorspath.exam.api570.unlock", "API_570"],
  ["com.inspectorspath.exam.api653.unlock", "API_653"],
  ["com.inspectorspath.exam.api936.unlock", "API_936"],
  ["com.inspectorspath.exam.api1169.unlock", "API_1169"],
  ["com.inspectorspath.exam.siee.unlock", "API_SIEE"],
  ["com.inspectorspath.exam.sife.unlock", "API_SIFE"],
  ["com.inspectorspath.exam.sire.unlock", "API_SIRE"],
]);

const PURCHASE_EVENT_TYPES = new Set([
  "INITIAL_PURCHASE",
  "RENEWAL",
  "UNCANCELLATION",
  "NON_RENEWING_PURCHASE",
  "SUBSCRIPTION_EXTENDED",
  "TEMPORARY_ENTITLEMENT_GRANT",
  "REFUND_REVERSED",
]);

const ACCESS_SYNC_EVENT_TYPES = new Set([
  ...PURCHASE_EVENT_TYPES,
  "CANCELLATION",
  "EXPIRATION",
  "BILLING_ISSUE",
  "PRODUCT_CHANGE",
  "SUBSCRIPTION_PAUSED",
  "TRANSFER",
]);

const clean = (value) => value?.toString().trim() || "";

const unique = (values) => [...new Set(values.map(clean).filter(Boolean))];

const dateFromMillis = (value) => {
  const millis = Number(value);
  if (!Number.isFinite(millis) || millis <= 0) return null;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? null : date;
};

const safeNumber = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const getRevenueCatConfig = () => ({
  secretKey: clean(process.env.REVENUECAT_V2_SECRET_KEY),
  projectId: clean(process.env.REVENUECAT_PROJECT_ID),
  entitlementId: clean(process.env.REVENUECAT_PRO_ENTITLEMENT_ID),
  entitlementLookupKey:
    clean(process.env.REVENUECAT_PRO_ENTITLEMENT_LOOKUP_KEY) ||
    "professional_access",
  iosProductId:
    clean(process.env.REVENUECAT_IOS_PRODUCT_ID) || "six_month_subscriptions",
  androidProductId:
    clean(process.env.REVENUECAT_ANDROID_PRODUCT_ID) ||
    "six_month_subscriptions:six-month",
});

const requireRevenueCatApiConfig = () => {
  const config = getRevenueCatConfig();
  if (!config.secretKey || !config.projectId) {
    throw new AppError(
      httpStatus.INTERNAL_SERVER_ERROR,
      "RevenueCat server API is not configured"
    );
  }
  return config;
};

const revenueCatErrorMessage = (payload, fallback) =>
  clean(payload?.message || payload?.error?.message || payload?.error) || fallback;

const revenueCatRequest = async (path, { method = "GET", body } = {}) => {
  const { secretKey } = requireRevenueCatApiConfig();
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const response = await fetch(`${REVENUECAT_API_ORIGIN}${normalizedPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const statusCode =
        response.status >= 400 && response.status < 500
          ? httpStatus.BAD_REQUEST
          : httpStatus.BAD_GATEWAY;
      throw new AppError(
        statusCode,
        revenueCatErrorMessage(
          payload,
          `RevenueCat API request failed (${response.status})`
        )
      );
    }
    return payload;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error?.name === "AbortError") {
      throw new AppError(httpStatus.GATEWAY_TIMEOUT, "RevenueCat API timed out");
    }
    throw new AppError(httpStatus.BAD_GATEWAY, "RevenueCat API is unavailable");
  } finally {
    clearTimeout(timeout);
  }
};

const revenueCatProjectPath = (suffix) => {
  const { projectId } = requireRevenueCatApiConfig();
  return `/v2/projects/${encodeURIComponent(projectId)}${suffix}`;
};

const fetchRevenueCatList = async (initialPath) => {
  const items = [];
  let path = initialPath;
  let pageCount = 0;

  while (path && pageCount < MAX_PAGES) {
    const payload = await revenueCatRequest(path);
    if (Array.isArray(payload?.items)) items.push(...payload.items);
    const nextPage = clean(payload?.next_page);
    if (!nextPage) break;
    if (!nextPage.startsWith("/v2/projects/")) {
      throw new AppError(
        httpStatus.BAD_GATEWAY,
        "RevenueCat returned an invalid pagination URL"
      );
    }
    path = nextPage;
    pageCount += 1;
  }

  return items;
};

const fetchRevenueCatStoreIdentifier = async (internalProductId) => {
  const productId = clean(internalProductId);
  if (!productId) return "";

  if (!productStoreIdentifierCache.has(productId)) {
    const request = revenueCatRequest(
      revenueCatProjectPath(`/products/${encodeURIComponent(productId)}`)
    )
      .then((payload) =>
        clean(
          payload?.store_identifier ||
            payload?.store_product_identifier ||
            payload?.product?.store_identifier
        )
      )
      .then((storeIdentifier) => {
        if (!storeIdentifier) {
          throw new AppError(
            httpStatus.BAD_GATEWAY,
            `RevenueCat product ${productId} has no store identifier`
          );
        }
        return storeIdentifier;
      })
      .catch((error) => {
        productStoreIdentifierCache.delete(productId);
        throw error;
      });
    productStoreIdentifierCache.set(productId, request);
  }

  return productStoreIdentifierCache.get(productId);
};

const resolveRevenueCatProducts = async (...groups) => {
  const internalProductIds = unique(
    groups
      .flat()
      .filter((item) => !productIdentifierFromObject(item))
      .map(internalProductIdentifierFromObject)
  );
  const resolvedEntries = await Promise.all(
    internalProductIds.map(async (productId) => [
      productId,
      await fetchRevenueCatStoreIdentifier(productId),
    ])
  );
  const resolvedByInternalId = new Map(resolvedEntries);

  return groups.map((items) =>
    items.map((item) => {
      if (productIdentifierFromObject(item)) return item;
      const internalProductId = internalProductIdentifierFromObject(item);
      const storeIdentifier = resolvedByInternalId.get(internalProductId);
      return storeIdentifier
        ? { ...item, product_store_identifier: storeIdentifier }
        : item;
    })
  );
};

const entitlementMatches = (item, config) => {
  const identifier = clean(item?.entitlement_id || item?.id || item?.lookup_key);
  return Boolean(
    identifier &&
      [config.entitlementId, config.entitlementLookupKey]
        .filter(Boolean)
        .includes(identifier)
  );
};

export const isProfessionalProduct = (
  productId,
  config = getRevenueCatConfig()
) =>
  [config.iosProductId, config.androidProductId]
    .filter(Boolean)
    .includes(clean(productId));

const maxDate = (dates) => {
  const valid = dates.filter(Boolean);
  if (!valid.length) return null;
  return new Date(Math.max(...valid.map((date) => date.getTime())));
};

export const fetchRevenueCatCustomerState = async (appUserId) => {
  const requestedAppUserId = clean(appUserId);
  if (!requestedAppUserId) {
    throw new AppError(httpStatus.BAD_REQUEST, "RevenueCat App User ID is required");
  }

  const customerSearch = new URLSearchParams({
    search: requestedAppUserId,
    limit: "10",
  });
  const matchingCustomers = await fetchRevenueCatList(
    revenueCatProjectPath(`/customers?${customerSearch.toString()}`)
  );
  const customer =
    matchingCustomers.find((item) => clean(item?.id) === requestedAppUserId) ||
    matchingCustomers[0];
  const customerId = clean(customer?.id);
  if (!customerId) {
    throw new AppError(httpStatus.NOT_FOUND, "RevenueCat customer not found");
  }

  const encodedCustomerId = encodeURIComponent(customerId);
  const [activeEntitlements, rawSubscriptions, rawPurchases] = await Promise.all([
    fetchRevenueCatList(
      revenueCatProjectPath(
        `/customers/${encodedCustomerId}/active_entitlements?limit=100`
      )
    ),
    fetchRevenueCatList(
      revenueCatProjectPath(`/customers/${encodedCustomerId}/subscriptions?limit=100`)
    ),
    fetchRevenueCatList(
      revenueCatProjectPath(`/customers/${encodedCustomerId}/purchases?limit=100`)
    ),
  ]);

  // API v2 uses internal `product_id` references. Resolve them through the
  // project product endpoint before applying subscription or exam rules.
  const [subscriptions, purchases] = await resolveRevenueCatProducts(
    rawSubscriptions,
    rawPurchases
  );

  const config = getRevenueCatConfig();
  const professionalSubscriptions = subscriptions.filter(
    (subscription) =>
      Boolean(subscription?.gives_access) &&
      isProfessionalProduct(productIdentifierFromObject(subscription), config)
  );
  const professionalEntitlements = activeEntitlements.filter((item) =>
    entitlementMatches(item, config)
  );
  const hasProfessionalAccess =
    professionalEntitlements.length > 0 || professionalSubscriptions.length > 0;
  const professionalExpiresAt = maxDate([
    ...professionalEntitlements.map((item) => dateFromMillis(item?.expires_at)),
    ...professionalSubscriptions.map((item) =>
      dateFromMillis(item?.current_period_ends_at || item?.ends_at)
    ),
  ]);
  const currentProfessionalSubscription =
    professionalSubscriptions.sort(
      (a, b) =>
        safeNumber(b?.current_period_ends_at || b?.ends_at) -
        safeNumber(a?.current_period_ends_at || a?.ends_at)
    )[0] || null;

  return {
    appUserId: requestedAppUserId,
    customerId,
    activeEntitlements,
    subscriptions,
    purchases,
    hasProfessionalAccess,
    professionalExpiresAt,
    currentProfessionalSubscription,
  };
};

const examNamePattern = (examCode) => {
  const suffix = clean(examCode).replace(/^API_/, "");
  return new RegExp(`API[\\s_-]*${suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
};

const findExamForProduct = async (productId) => {
  const examCode = EXAM_PRODUCT_CODES.get(clean(productId));
  if (!examCode) return null;
  return Exam.findOne({ name: examNamePattern(examCode), status: "active" });
};

const unlockExamFromRevenueCat = async ({
  userId,
  exam,
  productId,
  transactionId = "",
  originalTransactionId = "",
  purchaseType = "exam",
  purchasedAt = new Date(),
  currency = "USD",
  price = 0,
  accessDuration = "six_months",
  expiresAt = null,
  source = purchaseType === "plan" ? "initial_included" : "exam_subscription",
}) => {
  const result = await grantExamEntitlement({
    userId,
    examId: exam._id,
    source,
    provider: "revenuecat",
    amount: price,
    currency,
    startedAt: purchasedAt,
    expiresAt: expiresAt || addExamAccessMonths(purchasedAt),
    externalTransactionId: clean(transactionId),
    originalTransactionId: clean(originalTransactionId),
    productId: clean(productId),
    purchaseType,
    paymentFields: {
      revenueCatProductId: clean(productId),
      revenueCatTransactionId: clean(transactionId),
      revenueCatOriginalTransactionId: clean(originalTransactionId),
    },
    metadata: { provider: "revenuecat", accessDuration },
  });
  return result.access;
};

const revocationMatchesCurrentSubscription = (user, subscription) => {
  if (!user?.subscriptionRevokedAt) return false;
  const storedId = clean(user.subscriptionExternalId);
  const currentId = clean(subscription?.id);
  return !storedId || !currentId || storedId === currentId;
};

const downgradeRevenueCatSubscription = async ({ user, subscription } = {}) => {
  if (!user) return null;
  // The initial purchase permanently establishes the account tier. Individual
  // exam entitlements expire/revoke independently.
  user.subscriptionTier = "professional";
  user.subscriptionProvider = "revenuecat";
  user.subscriptionExternalId =
    clean(subscription?.id) || clean(user.subscriptionExternalId);
  user.subscriptionWillRenew = false;
  user.subscriptionRevokedAt = user.subscriptionRevokedAt || new Date();
  await user.save();
  return user;
};

export const syncRevenueCatCustomerAccess = async ({
  appUserId,
  requestedExamId = "",
  requestedProductId = "",
  forceProfessionalActivation = false,
} = {}) => {
  const customerId = clean(appUserId);
  if (!mongoose.Types.ObjectId.isValid(customerId)) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "RevenueCat App User ID is not a valid backend user ID"
    );
  }
  const user = await User.findById(customerId);
  if (!user) throw new AppError(httpStatus.NOT_FOUND, "User not found");

  const state = await fetchRevenueCatCustomerState(customerId);
  const now = new Date();
  const syncedExamIds = new Set();
  const unresolvedProductIds = new Set();
  const unmappedProductIdentifiers = new Set();
  const normalizedRequestedProductId = clean(requestedProductId);
  const requestedExamProductId = EXAM_PRODUCT_CODES.has(
    normalizedRequestedProductId
  )
    ? normalizedRequestedProductId
    : "";
  let requestedExam = null;
  let selectedExam = null;

  if (requestedExamId) {
    if (!mongoose.Types.ObjectId.isValid(requestedExamId)) {
      throw new AppError(httpStatus.BAD_REQUEST, "Invalid examId");
    }
    requestedExam = await Exam.findById(requestedExamId);
    if (!requestedExam || requestedExam.status !== "active") {
      throw new AppError(httpStatus.NOT_FOUND, "Active exam not found");
    }
  }

  if (requestedExamProductId) {
    if (!requestedExam) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "examId is required when synchronizing an exam purchase"
      );
    }
    const productExam = await findExamForProduct(requestedExamProductId);
    if (
      !productExam ||
      productExam._id.toString() !== requestedExam._id.toString()
    ) {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        "RevenueCat product does not match the selected exam"
      );
    }
    if (user.subscriptionTier !== "professional" && !state.hasProfessionalAccess) {
      throw new AppError(
        httpStatus.FORBIDDEN,
        "Complete the initial subscription before purchasing another exam"
      );
    }
  }

  const requestedProfessionalPurchase = isProfessionalProduct(
    normalizedRequestedProductId
  );
  if (requestedProfessionalPurchase && !requestedExam) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "examId is required for the initial subscription purchase"
    );
  }

  if (state.hasProfessionalAccess) {
    const subscription = state.currentProfessionalSubscription;
    const startsAt =
      dateFromMillis(subscription?.starts_at || subscription?.current_period_starts_at) ||
      user.subscriptionStartedAt ||
      now;
    const expiresAt =
      state.professionalExpiresAt ||
      (user.subscriptionExpiresAt && user.subscriptionExpiresAt > now
        ? user.subscriptionExpiresAt
        : new Date("9999-12-31T23:59:59.999Z"));
    const cancellationStillApplies =
      !forceProfessionalActivation &&
      !requestedProfessionalPurchase &&
      (revenueCatSubscriptionWasCancelled(subscription) ||
        revocationMatchesCurrentSubscription(user, subscription));

    user.subscriptionStartedAt = startsAt;
    user.subscriptionExpiresAt = expiresAt;
    user.subscriptionProvider = "revenuecat";
    user.subscriptionExternalId = clean(subscription?.id);

    if (cancellationStillApplies) {
      await downgradeRevenueCatSubscription({ user, subscription });
    } else {
      user.subscriptionTier = "professional";
      user.subscriptionWillRenew =
        clean(subscription?.auto_renewal_status).toLowerCase() === "will_renew";
      user.subscriptionRevokedAt = null;
      await user.save();
    }
  } else if (user.subscriptionProvider === "revenuecat") {
    user.subscriptionTier = "professional";
    user.subscriptionWillRenew = null;
    await user.save();
  }

  if (requestedProfessionalPurchase) {
    if (!state.hasProfessionalAccess) {
      throw new AppError(
        httpStatus.PAYMENT_REQUIRED,
        "RevenueCat has not confirmed the initial subscription"
      );
    }
    const subscription = state.currentProfessionalSubscription;
    const subscriptionId = clean(subscription?.id) || normalizedRequestedProductId;
    const existingInitialPurchase = await ProfessionalPlanPurchase.findOne({
      userId: user._id,
      provider: "revenuecat",
      status: "completed",
    });
    if (
      existingInitialPurchase?.examId &&
      existingInitialPurchase.examId.toString() !== requestedExam._id.toString()
    ) {
      throw new AppError(
        httpStatus.CONFLICT,
        "The included exam was already selected for this initial purchase"
      );
    }
    const startsAt =
      dateFromMillis(subscription?.starts_at || subscription?.current_period_starts_at) ||
      user.subscriptionStartedAt ||
      now;
    const expiresAt = state.professionalExpiresAt || addExamAccessMonths(startsAt);
    const planPurchase = await ProfessionalPlanPurchase.findOneAndUpdate(
      existingInitialPurchase ? { _id: existingInitialPurchase._id } : {
        userId: user._id,
        provider: "revenuecat",
        revenueCatSubscriptionId: subscriptionId,
      },
      {
        $set: {
          userId: user._id,
          examId: requestedExam._id,
          provider: "revenuecat",
          status: "completed",
          currency: "USD",
          planBasePrice: 199.99,
          planFinalPrice: 199.99,
          totalAmount: 199.99,
          revenueCatAppUserId: user._id.toString(),
          revenueCatProductId: normalizedRequestedProductId,
          revenueCatSubscriptionId: subscriptionId,
          purchasedAt: startsAt,
          "metadata.initialExamExpiresAt": expiresAt,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    const access = await unlockExamFromRevenueCat({
      userId: user._id,
      exam: requestedExam,
      productId: normalizedRequestedProductId,
      transactionId: subscriptionId,
      purchaseType: "plan",
      source: "initial_included",
      purchasedAt: startsAt,
      expiresAt,
      price: 0,
    });
    access.metadata = {
      ...(access.metadata || {}),
      includedWithInitialPrice: planPurchase.planFinalPrice,
      planPurchaseId: planPurchase._id,
    };
    await access.save();
    selectedExam = buildSelectedExamUnlockResponse({
      exam: requestedExam,
      access,
    });
    syncedExamIds.add(requestedExam._id.toString());
  }

  if (!requestedProfessionalPurchase && state.hasProfessionalAccess) {
    const initialPurchase = await ProfessionalPlanPurchase.findOne({
      userId: user._id,
      provider: "revenuecat",
      status: "completed",
      examId: { $ne: null },
    }).sort({ purchasedAt: 1 });
    if (initialPurchase?.examId) {
      const existingAccess = await ExamAccess.findOne({
        userId: user._id,
        examId: initialPurchase.examId,
      });
      if (!existingAccess) {
        const initialExam = await Exam.findById(initialPurchase.examId);
        if (initialExam) {
          const startsAt = initialPurchase.purchasedAt || now;
          const expiresAt = initialPurchase.metadata?.initialExamExpiresAt ||
            addExamAccessMonths(startsAt);
          await unlockExamFromRevenueCat({
            userId: user._id,
            exam: initialExam,
            productId: initialPurchase.revenueCatProductId,
            transactionId:
              initialPurchase.revenueCatSubscriptionId ||
              initialPurchase.revenueCatTransactionId,
            originalTransactionId:
              initialPurchase.revenueCatOriginalTransactionId,
            purchaseType: "plan",
            source: "initial_included",
            purchasedAt: startsAt,
            expiresAt,
            price: 0,
          });
          syncedExamIds.add(initialExam._id.toString());
        }
      }
    }
  }

  const activeExamSubscriptions = state.subscriptions.filter((subscription) => {
    const productId = productIdentifierFromObject(subscription);
    if (!EXAM_PRODUCT_CODES.has(productId) || isProfessionalProduct(productId)) {
      return false;
    }
    const end = dateFromMillis(
      subscription?.current_period_ends_at || subscription?.ends_at
    );
    return Boolean(subscription?.gives_access && end && end > now);
  });
  for (const subscription of activeExamSubscriptions) {
    if (user.subscriptionTier !== "professional") continue;
    const productId = productIdentifierFromObject(subscription);
    const exam = await findExamForProduct(productId);
    if (!exam) continue;
    const startsAt =
      dateFromMillis(subscription?.current_period_starts_at || subscription?.starts_at) || now;
    const expiresAt =
      dateFromMillis(subscription?.current_period_ends_at || subscription?.ends_at) ||
      addExamAccessMonths(startsAt);
    const subscriptionTransactionId =
      clean(subscription?.store_purchase_identifier) ||
      `${clean(subscription?.id) || productId}:${startsAt.toISOString()}`;
    const access = await unlockExamFromRevenueCat({
      userId: user._id,
      exam,
      productId,
      transactionId: subscriptionTransactionId,
      originalTransactionId: clean(subscription?.original_transaction_id),
      purchasedAt: startsAt,
      expiresAt,
    });
    syncedExamIds.add(exam._id.toString());
    if (requestedExam && productId === requestedExamProductId) {
      selectedExam = buildSelectedExamUnlockResponse({ exam, access });
    }
  }

  const usablePurchases = state.purchases.filter(revenueCatPurchaseIsUsable);
  for (const purchase of usablePurchases) {
    const productId = productIdentifierFromObject(purchase);
    if (!productId) {
      const internalProductId = internalProductIdentifierFromObject(purchase);
      if (internalProductId) unresolvedProductIds.add(internalProductId);
      continue;
    }
    if (!EXAM_PRODUCT_CODES.has(productId)) {
      unmappedProductIdentifiers.add(productId);
      continue;
    }
    const exam = await findExamForProduct(productId);
    if (!exam) {
      unmappedProductIdentifiers.add(productId);
      continue;
    }
    const legacyPurchasedAt = dateFromMillis(purchase?.purchased_at) || now;
    const legacyWindow = buildLegacyExamEntitlementWindow(legacyPurchasedAt);
    const access = await unlockExamFromRevenueCat({
      userId: user._id,
      exam,
      productId,
      transactionId: clean(purchase?.store_purchase_identifier || purchase?.id),
      purchasedAt: legacyWindow.startedAt,
      expiresAt: legacyWindow.expiresAt,
      source: "legacy",
    });
    syncedExamIds.add(exam._id.toString());
    if (
      requestedExam &&
      productId === requestedExamProductId &&
      exam._id.toString() === requestedExam._id.toString()
    ) {
      selectedExam = buildSelectedExamUnlockResponse({ exam, access });
    }
  }

  if (requestedExamProductId) {
    const ownsRequestedProduct =
      revenueCatPurchasesIncludeProduct(state.purchases, requestedExamProductId) ||
      activeExamSubscriptions.some(
        (subscription) =>
          productIdentifierFromObject(subscription) === requestedExamProductId
      );
    if (!ownsRequestedProduct || !selectedExam?.unlocked) {
      throw new AppError(
        httpStatus.PAYMENT_REQUIRED,
        "RevenueCat has not confirmed this exam purchase"
      );
    }
  }

  return {
    user,
    state,
    syncSummary: {
      ownedPurchaseCount: usablePurchases.length,
      syncedExamCount: syncedExamIds.size,
      syncedExamIds: [...syncedExamIds],
      unresolvedProductIds: [...unresolvedProductIds],
      unmappedProductIdentifiers: [...unmappedProductIdentifiers],
      subscriptionCount: state.subscriptions.length,
      hasProfessionalAccess: state.hasProfessionalAccess,
      selectedExam,
    },
  };
};

export const revenueCatUserCandidates = (event = {}) =>
  unique([
    event.app_user_id,
    event.original_app_user_id,
    ...(Array.isArray(event.aliases) ? event.aliases : []),
  ]).filter((candidate) => mongoose.Types.ObjectId.isValid(candidate));

export const findRevenueCatUser = async (event = {}) => {
  for (const candidate of revenueCatUserCandidates(event)) {
    const user = await User.findById(candidate);
    if (user) return user;
  }
  return null;
};

const eventEntitlementIds = (event) =>
  unique([
    ...(Array.isArray(event?.entitlement_ids) ? event.entitlement_ids : []),
    event?.entitlement_id,
  ]);

export const isProfessionalRevenueCatEvent = (event = {}) => {
  const config = getRevenueCatConfig();
  return (
    isProfessionalProduct(event.product_id, config) ||
    eventEntitlementIds(event).some((id) =>
      [config.entitlementId, config.entitlementLookupKey]
        .filter(Boolean)
        .includes(id)
    )
  );
};

const upsertProfessionalPurchaseFromEvent = async ({ user, event }) => {
  if (!isProfessionalRevenueCatEvent(event)) return null;
  const transactionId = clean(event.transaction_id);
  if (!transactionId) return null;

  const eventType = clean(event.type).toUpperCase();
  const isRefund = isRevenueCatRefundEvent(event);
  const price = Math.max(
    0,
    Math.abs(safeNumber(event.price_in_purchased_currency ?? event.price, 0))
  );
  const status = isRefund ? "refunded" : "completed";

  const purchase = await ProfessionalPlanPurchase.findOneAndUpdate(
    { revenueCatTransactionId: transactionId },
    {
      $set: {
        userId: user._id,
        provider: "revenuecat",
        status,
        currency: clean(event.currency).toUpperCase() || "USD",
        revenueCatAppUserId: clean(event.app_user_id) || user._id.toString(),
        revenueCatProductId: clean(event.product_id),
        revenueCatTransactionId: transactionId,
        revenueCatOriginalTransactionId: clean(event.original_transaction_id),
        revenueCatStore: clean(event.store).toUpperCase(),
        revenueCatEnvironment: clean(event.environment).toUpperCase(),
        revenueCatEventId: clean(event.id),
        purchasedAt: dateFromMillis(event.purchased_at_ms) || new Date(),
        "metadata.entitlementIds": eventEntitlementIds(event),
        "metadata.presentedOfferingId": clean(event.presented_offering_id),
        "metadata.expirationAt": dateFromMillis(event.expiration_at_ms),
        "metadata.cancelReason": clean(event.cancel_reason),
        "metadata.expirationReason": clean(event.expiration_reason),
        "metadata.lastRevenueCatEventType": eventType,
        "metadata.subscriptionLifecycleStatus": eventType,
      },
      $setOnInsert: {
        examId: null,
        planBasePrice: price,
        referralDiscountRate: 0,
        referralDiscountAmount: 0,
        planFinalPrice: price,
        totalAmount: price,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  if (isRefund && purchase.refundStatus !== "full") {
    purchase.refundedAmount = purchase.totalAmount || price;
    purchase.refundStatus = "full";
    purchase.refundHistory.push({
      refundedAt: dateFromMillis(event.event_timestamp_ms) || new Date(),
      amount: purchase.refundedAmount,
      reason: clean(event.cancel_reason || event.expiration_reason) || "Store refund",
      adminId: null,
      type: "full",
      stripeRefundId: "",
      revenueCatEventId: clean(event.id),
    });
    await purchase.save();
  } else if (eventType === "REFUND_REVERSED") {
    purchase.status = "completed";
    purchase.refundedAmount = 0;
    purchase.refundStatus = "none";
    await purchase.save();
  }

  return purchase;
};

const applyExamEvent = async ({ user, event }) => {
  const productId = clean(event.product_id);
  if (!EXAM_PRODUCT_CODES.has(productId)) return null;
  const exam = await findExamForProduct(productId);
  if (!exam) return null;

  if (isRevenueCatRefundEvent(event)) {
    return revokeExamEntitlement({
      userId: user._id,
      examId: exam._id,
      externalTransactionId: clean(event.transaction_id),
      reason: "RevenueCat refund",
      transactionStatus: "refunded",
    });
  }

  if (!PURCHASE_EVENT_TYPES.has(clean(event.type).toUpperCase())) return null;
  return unlockExamFromRevenueCat({
    userId: user._id,
    exam,
    productId,
    transactionId: clean(event.transaction_id),
    originalTransactionId: clean(event.original_transaction_id),
    purchasedAt: dateFromMillis(event.purchased_at_ms) || new Date(),
    expiresAt:
      dateFromMillis(event.expiration_at_ms) ||
      addExamAccessMonths(dateFromMillis(event.purchased_at_ms) || new Date()),
    currency: event.currency,
    price: event.price_in_purchased_currency ?? event.price,
  });
};

export const processRevenueCatEvent = async ({ event, user }) => {
  const eventType = clean(event?.type).toUpperCase();
  if (!ACCESS_SYNC_EVENT_TYPES.has(eventType)) {
    return { ignored: true, reason: `Unsupported event type: ${eventType}` };
  }
  if (!user) {
    return { ignored: true, reason: "No backend user matches the App User ID" };
  }

  const professionalEvent = isProfessionalRevenueCatEvent(event);
  const activationEvent = [
    "INITIAL_PURCHASE",
    "RENEWAL",
    "UNCANCELLATION",
    "REFUND_REVERSED",
  ].includes(eventType);
  const stateResult = await syncRevenueCatCustomerAccess({
    appUserId: user._id.toString(),
    forceProfessionalActivation: professionalEvent && activationEvent,
  });
  const [purchase, examAccess] = await Promise.all([
    upsertProfessionalPurchaseFromEvent({ user, event }),
    applyExamEvent({ user, event }),
  ]);

  if (professionalEvent && isRevenueCatRefundEvent(event)) {
    const initialPurchase = await ProfessionalPlanPurchase.findOne({
      userId: user._id,
      provider: "revenuecat",
      status: { $in: ["completed", "refunded"] },
      examId: { $ne: null },
    }).sort({ purchasedAt: 1 });
    if (initialPurchase?.examId) {
      await revokeExamEntitlement({
        userId: user._id,
        examId: initialPurchase.examId,
        externalTransactionId: clean(event.transaction_id),
        reason: "Initial purchase refunded",
        transactionStatus: "refunded",
      });
    }
  }

  return {
    ignored: false,
    user: stateResult.user,
    state: stateResult.state,
    purchase,
    examAccess,
  };
};

export const recordRevenueCatRefundRequest = async ({
  appUserId,
  productId,
  status,
} = {}) => {
  const customerId = clean(appUserId);
  const requestedProductId = clean(productId);
  if (!mongoose.Types.ObjectId.isValid(customerId)) {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid authenticated user ID");
  }
  if (!requestedProductId) {
    throw new AppError(httpStatus.BAD_REQUEST, "productId is required");
  }

  const user = await User.findById(customerId);
  if (!user) throw new AppError(httpStatus.NOT_FOUND, "User not found");
  if (!revenueCatActionSucceeded(status)) {
    return { accepted: false, kind: "none", user };
  }
  const state = await fetchRevenueCatCustomerState(customerId);
  if (EXAM_PRODUCT_CODES.has(requestedProductId)) {
    const ownsExamSubscription = state.subscriptions.some(
      (subscription) =>
        productIdentifierFromObject(subscription) === requestedProductId
    );
    if (!ownsExamSubscription) {
      throw new AppError(
        httpStatus.FORBIDDEN,
        "RevenueCat does not associate this exam subscription with the signed-in user"
      );
    }
    const exam = await findExamForProduct(requestedProductId);
    if (exam) {
      await revokeExamEntitlement({
        userId: user._id,
        examId: exam._id,
        reason: "Customer Center refund request",
        transactionStatus: "refunded",
      });
    }
    return { accepted: true, kind: "exam_subscription", user, state };
  }
  if (!isProfessionalProduct(requestedProductId)) {
    return { accepted: false, kind: "non_subscription", user };
  }

  const ownsSubscription = state.subscriptions.some(
    (subscription) =>
      productIdentifierFromObject(subscription) === requestedProductId
  );
  if (!ownsSubscription && !state.hasProfessionalAccess) {
    throw new AppError(
      httpStatus.FORBIDDEN,
      "RevenueCat does not associate this subscription with the signed-in user"
    );
  }

  await downgradeRevenueCatSubscription({
    user,
    subscription: state.currentProfessionalSubscription,
  });
  const initialPurchase = await ProfessionalPlanPurchase.findOne({
    userId: user._id,
    provider: "revenuecat",
    status: "completed",
    examId: { $ne: null },
  }).sort({ purchasedAt: 1 });
  if (initialPurchase?.examId) {
    await revokeExamEntitlement({
      userId: user._id,
      examId: initialPurchase.examId,
      reason: "Initial purchase refund requested",
      transactionStatus: "refunded",
    });
  }
  return { accepted: true, kind: "subscription", user, state };
};

export const refundRevenueCatTransaction = async (purchase) => {
  const store = clean(purchase?.revenueCatStore).toUpperCase();
  if (!["PLAY_STORE", "GOOGLE_PLAY", "GALAXY_STORE"].includes(store)) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "Automatic RevenueCat refunds are supported only for Google Play or Galaxy Store transactions; issue Apple refunds in App Store Connect, then let the webhook synchronize access"
    );
  }

  const storeSubscriptionIdentifier = clean(
    purchase?.revenueCatOriginalTransactionId || purchase?.revenueCatTransactionId
  );
  const transactionId = clean(purchase?.revenueCatTransactionId);
  if (!storeSubscriptionIdentifier || !transactionId) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "RevenueCat transaction identifiers are missing"
    );
  }

  const query = new URLSearchParams({
    store_subscription_identifier: storeSubscriptionIdentifier,
  });
  const subscriptions = await fetchRevenueCatList(
    revenueCatProjectPath(`/subscriptions?${query.toString()}`)
  );
  const subscription = subscriptions[0];
  if (!subscription?.id) {
    throw new AppError(
      httpStatus.NOT_FOUND,
      "RevenueCat subscription could not be found"
    );
  }

  const payload = await revenueCatRequest(
    revenueCatProjectPath(
      `/subscriptions/${encodeURIComponent(subscription.id)}/transactions/${encodeURIComponent(
        transactionId
      )}/actions/refund`
    ),
    { method: "POST" }
  );

  purchase.revenueCatSubscriptionId = clean(subscription.id);
  await purchase.save();
  return payload;
};

export const revenueCatInternals = {
  dateFromMillis,
  isProfessionalProduct,
  productIdentifierFromObject,
  purchaseIsUsable: revenueCatPurchaseIsUsable,
};
