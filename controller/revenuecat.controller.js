import httpStatus from "http-status";
import mongoose from "mongoose";
import AppError from "../errors/AppError.js";
import catchAsync from "../utils/catchAsync.js";
import sendResponse from "../utils/sendResponse.js";
import { RevenueCatWebhookEvent } from "../model/revenueCatWebhookEvent.model.js";
import { User } from "../model/user.model.js";
import {
  findRevenueCatUser,
  processRevenueCatEvent,
  recordRevenueCatRefundRequest,
  syncRevenueCatCustomerAccess,
} from "../utils/revenuecat.service.js";
import {
  isValidRevenueCatAuthorization,
  isValidRevenueCatSignature,
} from "../utils/revenuecat.webhook.js";

const clean = (value) => value?.toString().trim() || "";

const requireWebhookAuthorization = (req) => {
  const configuredToken = clean(process.env.REVENUECAT_WEBHOOK_AUTH_TOKEN);
  if (!configuredToken) {
    throw new AppError(
      httpStatus.INTERNAL_SERVER_ERROR,
      "RevenueCat webhook authorization is not configured"
    );
  }
  if (!isValidRevenueCatAuthorization(req.get("authorization"), configuredToken)) {
    throw new AppError(httpStatus.UNAUTHORIZED, "Invalid RevenueCat webhook token");
  }
};

const requireWebhookSignatureWhenConfigured = (req) => {
  const signingSecret = clean(process.env.REVENUECAT_WEBHOOK_SIGNING_SECRET);
  if (!signingSecret) return;
  const toleranceSeconds = Math.max(
    1,
    Number(process.env.REVENUECAT_WEBHOOK_SIGNATURE_TOLERANCE_SECONDS) || 300
  );
  if (
    !isValidRevenueCatSignature({
      rawBody: req.rawBody,
      signatureHeader: req.get("x-revenuecat-webhook-signature"),
      signingSecret,
      toleranceSeconds,
    })
  ) {
    throw new AppError(
      httpStatus.UNAUTHORIZED,
      "Invalid RevenueCat webhook signature"
    );
  }
};

const normalizeEnvironment = (value) => {
  const environment = clean(value).toUpperCase();
  return ["SANDBOX", "PRODUCTION"].includes(environment)
    ? environment
    : "UNKNOWN";
};

const claimWebhookEvent = async (payload, event) => {
  const eventId = clean(event.id);
  let storedEvent;
  try {
    storedEvent = await RevenueCatWebhookEvent.create({
      eventId,
      eventType: clean(event.type).toUpperCase(),
      appUserId: clean(event.app_user_id),
      originalAppUserId: clean(event.original_app_user_id),
      appId: clean(event.app_id),
      environment: normalizeEnvironment(event.environment),
      store: clean(event.store).toUpperCase(),
      productId: clean(event.product_id),
      transactionId: clean(event.transaction_id),
      originalTransactionId: clean(event.original_transaction_id),
      payload,
    });
    return { storedEvent, duplicate: false };
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }

  storedEvent = await RevenueCatWebhookEvent.findOne({ eventId });
  if (!storedEvent) {
    throw new AppError(
      httpStatus.CONFLICT,
      "RevenueCat webhook event could not be claimed"
    );
  }
  if (["processed", "ignored"].includes(storedEvent.status)) {
    return { storedEvent, duplicate: true };
  }
  if (storedEvent.status === "processing") {
    const ageMs = Date.now() - new Date(storedEvent.updatedAt).getTime();
    if (ageMs < 5 * 60 * 1000) return { storedEvent, duplicate: true };
  }

  storedEvent.status = "processing";
  storedEvent.processingAttempts += 1;
  storedEvent.lastError = "";
  storedEvent.payload = payload;
  await storedEvent.save();
  return { storedEvent, duplicate: false };
};

const transferUserIds = (event) => [
  ...(Array.isArray(event?.transferred_to) ? event.transferred_to : []),
  ...(Array.isArray(event?.transferred_from) ? event.transferred_from : []),
];

const findTransferUsers = async (event) => {
  const ids = [
    ...new Set(
      transferUserIds(event)
        .map(clean)
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
    ),
  ];
  return ids.length ? User.find({ _id: { $in: ids } }) : [];
};

export const handleRevenueCatWebhook = catchAsync(async (req, res) => {
  requireWebhookAuthorization(req);
  requireWebhookSignatureWhenConfigured(req);

  const payload = req.body;
  const event = payload?.event;
  if (!payload || typeof payload !== "object" || !event || typeof event !== "object") {
    throw new AppError(httpStatus.BAD_REQUEST, "Invalid RevenueCat webhook payload");
  }
  if (!clean(event.id) || !clean(event.type)) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      "RevenueCat event id and type are required"
    );
  }

  const { storedEvent, duplicate } = await claimWebhookEvent(payload, event);
  if (duplicate) {
    return sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "RevenueCat webhook already accepted",
      data: { eventId: storedEvent.eventId, status: storedEvent.status },
    });
  }

  try {
    if (clean(event.type).toUpperCase() === "TEST") {
      storedEvent.status = "ignored";
      storedEvent.processedAt = new Date();
      await storedEvent.save();
      return sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: "RevenueCat test webhook accepted",
        data: { eventId: storedEvent.eventId },
      });
    }

    const users =
      clean(event.type).toUpperCase() === "TRANSFER"
        ? await findTransferUsers(event)
        : [await findRevenueCatUser(event)].filter(Boolean);

    if (!users.length) {
      storedEvent.status = "ignored";
      storedEvent.lastError = "No backend user matches the RevenueCat App User ID";
      storedEvent.processedAt = new Date();
      await storedEvent.save();
      return sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: "RevenueCat webhook ignored because no user matched",
        data: { eventId: storedEvent.eventId },
      });
    }

    let ignored = true;
    for (const user of users) {
      const result = await processRevenueCatEvent({ event, user });
      ignored = ignored && result.ignored;
    }

    storedEvent.userId = users[0]._id;
    storedEvent.status = ignored ? "ignored" : "processed";
    storedEvent.processedAt = new Date();
    await storedEvent.save();

    return sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: ignored
        ? "RevenueCat webhook accepted and ignored"
        : "RevenueCat webhook processed",
      data: { eventId: storedEvent.eventId, status: storedEvent.status },
    });
  } catch (error) {
    storedEvent.status = "failed";
    storedEvent.lastError = clean(error?.message).slice(0, 2000);
    await storedEvent.save();
    throw error;
  }
});

export const syncMyRevenueCatAccess = catchAsync(async (req, res) => {
  const userId = req.user?._id?.toString();
  if (!userId) throw new AppError(httpStatus.UNAUTHORIZED, "User not authenticated");

  const { user, state, syncSummary } = await syncRevenueCatCustomerAccess({
    appUserId: userId,
    requestedExamId: clean(req.body?.examId || req.body?.selectedExamId),
    requestedProductId: clean(req.body?.productId),
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: syncSummary.selectedExam?.unlocked
      ? "RevenueCat subscription confirmed and selected exam unlocked"
      : "RevenueCat access synchronized",
    data: {
      subscriptionTier: user.subscriptionTier,
      subscriptionStartedAt: user.subscriptionStartedAt,
      subscriptionExpiresAt: user.subscriptionExpiresAt,
      subscriptionWillRenew: user.subscriptionWillRenew,
      hasProfessionalAccess: state.hasProfessionalAccess,
      ...syncSummary,
    },
  });
});

export const recordMyRevenueCatRefundRequest = catchAsync(async (req, res) => {
  const userId = req.user?._id?.toString();
  if (!userId) throw new AppError(httpStatus.UNAUTHORIZED, "User not authenticated");

  const result = await recordRevenueCatRefundRequest({
    appUserId: userId,
    productId: clean(req.body?.productId),
    status: clean(req.body?.status),
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: result.accepted
      ? "Purchase-linked exam access was revoked"
      : "No subscription change was required",
    data: {
      accepted: result.accepted,
      kind: result.kind,
      subscriptionTier: result.user.subscriptionTier,
      subscriptionWillRenew: result.user.subscriptionWillRenew,
    },
  });
});
